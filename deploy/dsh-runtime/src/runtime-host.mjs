import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import yaml from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { boot } from "@deepseek-ai/dsh-app-boot";

import { InteractionManager } from "./interactions.mjs";
import {
  buildDshPromptContent,
  createStreamNormalizer,
  findForkTargetSeq,
  normalizeDshEventsToMessages,
} from "./normalizer.mjs";

const require = createRequire(import.meta.url);
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class RuntimeHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Host-level hardening overlay applied over `@deepseek-ai/dsh-base`:
 * - disables telemetry, DeepSeek cloud account, HMR, plugin manager, and
 *   host-plane agent tools (tools/skills/persona are composed per AgentPreset);
 * - enables SessionController + Workspace + AgentPresetRegistry.
 */
export function buildHostBaseOverlay(defaultAgentKey) {
  return [
    { id: "session-telemetry-otel", disabled: true },
    { id: "deepseek-account", disabled: true },
    { id: "llm-deepseek", disabled: true },
    { id: "llm-deepseek-account", disabled: true },
    { id: "hmr", disabled: true },
    { id: "plugin-manager", disabled: true },
    { id: "tool-plugin-manager", disabled: true },
    { id: "session-title-llm", disabled: true },
    { id: "web-search-deepseek", disabled: true },
    { id: "web-deepseek-api", disabled: true },
    // Move agent-plane tools behind per-agent presets (matches dsh-web-app pattern).
    { id: "tool-bash", disabled: true },
    { id: "tool-pwsh", disabled: true },
    { id: "tool-jobs", disabled: true },
    { id: "tool-fs", disabled: true },
    { id: "tool-fs-search", disabled: true },
    { id: "skill-filesystem", disabled: true },
    { id: "tool-skill", disabled: true },
    { id: "command-goal", disabled: true },
    { id: "tool-goal", disabled: true },
    { id: "plan-mode", disabled: true },
    { id: "compaction-basic", disabled: true },
    { id: "command-compact", disabled: true },
    { id: "tool-result-pruner", disabled: true },
    { id: "tool-subagent-control", disabled: true },
    { id: "tool-subagent", disabled: true },
    { id: "tool-subagent-fork", disabled: true },
    { id: "workflow-ptc", disabled: true },
    { id: "tool-workflow", disabled: true },
    { id: "agent-instructions", disabled: true },
    { id: "tool-todo", disabled: true },
    { id: "tool-web", disabled: true },
    {
      insert: [
        { id: "connection", name: "@deepseek-ai/dsh-client-connection" },
        { id: "file-upload", name: "@deepseek-ai/dsh-client-file-upload" },
        { id: "workspace", name: "@deepseek-ai/dsh-workspace" },
        { id: "session-controller", name: "@deepseek-ai/dsh-api-session-controller" },
        {
          id: "agent-preset-registry",
          name: "@deepseek-ai/dsh-agent-preset-registry",
          config: { default: defaultAgentKey },
        },
      ],
    },
  ];
}

function readPackageVersion(pkgName) {
  try {
    return require(`${pkgName}/package.json`).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export class DshRuntimeHost {
  #ctx = null;
  #manifest = null;
  #workspaceDir;
  #dshHome;
  #interactions;
  #streamNormalizer;
  #subscribers = new Set();
  #runningSessions = new Set();
  #deletedSessionIds = new Set();
  #disposers = [];
  #eventSeq = 0;
  #dshVersion = readPackageVersion("@deepseek-ai/dsh");

  constructor(options = {}) {
    this.#workspaceDir = path.resolve(options.workspaceDir ?? process.env.RUNTIME_WORKING_DIR ?? "/workspace");
    this.#dshHome = path.resolve(options.dshHome ?? process.env.DSH_HOME ?? "/state/dsh-v1");
    this.#streamNormalizer = createStreamNormalizer();
    this.#interactions = new InteractionManager({
      onChange: (event) => this.#broadcast({ id: `dsh-int-${++this.#eventSeq}`, ...event }),
    });
  }

  async start(options = {}) {
    process.env.DSH_HOME = this.#dshHome;
    process.env.DSH_TELEMETRY_DISABLED = "1";

    const managedDir = path.resolve(options.managedDir ?? process.env.OPSHELPER_MANAGED_DIR ?? "/opt/opshelper");
    const overlayPath = options.overlayPath ?? path.join(managedDir, "config", "dsh", "overlay.patch.yml");
    const credentialsSourcePath = options.credentialsPath ?? path.join(managedDir, "config", "dsh", "credentials.yaml");
    const manifestPath = options.manifestPath ?? path.join(managedDir, "manifest.json");

    // Sync read-only managed credentials into writable $DSH_HOME/.credentials.yaml (mode 0600)
    // so dsh-credentials-local & dsh-client-connection can lock/read under ReadonlyRootfs.
    await mkdir(this.#dshHome, { recursive: true });
    const managedCredentials = await readFile(credentialsSourcePath, "utf8").catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (managedCredentials !== null) {
      const writableCredsPath = path.join(this.#dshHome, ".credentials.yaml");
      await writeFile(writableCredsPath, managedCredentials, { mode: 0o600 });
      await chmod(writableCredsPath, 0o600);
    }

    const manifestRaw = options.manifest ?? JSON.parse(await readFile(manifestPath, "utf8"));
    this.#manifest = manifestRaw;

    const defaultAgentKey =
      options.defaultAgentKey ??
      manifestRaw.defaultAgentKey ??
      manifestRaw.agentKeys?.[0];
    if (!defaultAgentKey) {
      throw new Error("受管清单缺少可用的默认智能体");
    }

    const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
    const basePatch = yaml.load(await readFile(basePatchPath, "utf8"), { schema: entryListSchema });
    const managedPatch = options.managedPatch ?? yaml.load(
      await readFile(overlayPath, "utf8"),
      { schema: entryListSchema },
    );
    const hostOverlay = buildHostBaseOverlay(defaultAgentKey);

    const cordisConfigPath = path.join(runtimeRoot, "cordis.yml");
    const bareModuleBaseUrl = pathToFileURL(path.join(runtimeRoot, "package.json")).href;

    const ctx = await boot(
      "opshelper-dsh-runtime",
      cordisConfigPath,
      [
        ...(Array.isArray(basePatch) ? basePatch : []),
        ...hostOverlay,
        ...(Array.isArray(managedPatch) ? managedPatch : []),
      ],
      undefined,
      bareModuleBaseUrl,
    );
    this.#ctx = ctx;

    const sessionController = ctx.get("sessionController");
    const agentPresets = ctx.get("agentPresets");
    if (!sessionController || !agentPresets) {
      throw new Error("DSH 核心服务 (sessionController / agentPresets) 未就绪");
    }

    // Wire Cordis live listeners for SSE streaming, status tracking, and HITL interactions.
    this.#disposers.push(this.#interactions.attach(ctx));

    this.#disposers.push(
      ctx.on("agent/assistant-stream", ({ agent, frame }) => {
        const sessionId = String(agent?.id ?? "");
        if (!sessionId) return;
        const normalizedEvents = this.#streamNormalizer.handleFrame(sessionId, frame);
        for (const evt of normalizedEvents) {
          this.#broadcast(evt);
        }
      }),
    );

    this.#disposers.push(
      ctx.on("agent/status", ({ agent, status }) => {
        const sessionId = String(agent?.id ?? "");
        if (!sessionId) return;
        if (status === "running") {
          this.#runningSessions.add(sessionId);
        } else {
          this.#runningSessions.delete(sessionId);
        }
        this.#broadcast({
          id: `dsh-status-${++this.#eventSeq}`,
          type: status === "running" ? "session.busy" : "session.idle",
          properties: { sessionID: sessionId },
        });
      }),
    );

    this.#disposers.push(
      ctx.on("session/event", (session, event) => {
        const sessionId = String(session?.id ?? "");
        if (!sessionId || !event) return;
        if (
          event.type === "tool/call" ||
          event.type === "tool/result" ||
          event.type === "turn/end" ||
          event.type === "assistant/message"
        ) {
          this.#broadcast({
            id: `dsh-log-${++this.#eventSeq}`,
            type: event.type === "turn/end" ? "session.idle" : "session.updated",
            properties: { sessionID: sessionId, eventType: event.type },
          });
        }
      }),
    );
  }

  async stop() {
    for (const dispose of this.#disposers.splice(0).reverse()) {
      try {
        dispose?.();
      } catch {
        // ignore listener cleanup errors during shutdown
      }
    }
    this.#subscribers.clear();
    if (this.#ctx) {
      const persistence = this.#ctx.get("sessionPersistence");
      await persistence?.flush?.().catch(() => undefined);
      await this.#ctx.root?.fiber?.dispose?.().catch(() => undefined);
      this.#ctx = null;
    }
  }

  #requireServices() {
    if (!this.#ctx) {
      throw new RuntimeHttpError(503, "DSH 运行环境尚未就绪");
    }
    const sessionController = this.#ctx.get("sessionController");
    const agentPresets = this.#ctx.get("agentPresets");
    const sessionPersistence = this.#ctx.get("sessionPersistence");
    const agents = this.#ctx.get("agents");
    if (!sessionController || !agentPresets || !sessionPersistence) {
      throw new RuntimeHttpError(503, "DSH 核心服务不可用");
    }
    return { sessionController, agentPresets, sessionPersistence, agents };
  }

  #broadcast(event) {
    for (const listener of this.#subscribers) {
      try {
        listener(event);
      } catch {
        // isolate broken SSE subscribers
      }
    }
  }

  subscribeEvents(listener) {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  async getInfo() {
    const presets = await this.listAgents();
    return {
      engine: "dsh",
      version: this.#dshVersion,
      generation: this.#manifest?.generation ?? null,
      ready: true,
      agentCount: presets.length,
    };
  }

  async listAgents() {
    const { agentPresets } = this.#requireServices();
    const listed = await agentPresets.list();
    return listed
      .filter((preset) => !preset.error)
      .map((preset) => ({
        name: preset.id,
        id: preset.id,
        displayName: preset.name ?? preset.id,
        description: preset.description ?? "",
        native: false,
        hidden: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getAgent(key) {
    const agents = await this.listAgents();
    const found = agents.find((item) => item.name === key);
    if (!found) {
      throw new RuntimeHttpError(404, `智能体不存在：${key}`);
    }
    return found;
  }

  async listSessions() {
    const { sessionController, sessionPersistence } = this.#requireServices();
    const ac = new AbortController();
    const [listed, stored] = await Promise.all([
      sessionController.list({}, ac.signal),
      sessionPersistence.list({ signal: ac.signal }),
    ]);

    const storedById = new Map(stored.map((item) => [String(item.header.id), item]));
    const items = Array.isArray(listed?.items) ? listed.items : [];
    const seen = new Set();
    const result = [];

    for (const summary of items) {
      const id = String(summary.sessionId);
      if (this.#deletedSessionIds.has(id)) continue;
      seen.add(id);
      const snapshot = storedById.get(id);
      const header = snapshot?.header;
      const titleProjection = summary.projections?.values?.sessionTitle;
      const title = typeof titleProjection === "string"
        ? titleProjection
        : typeof titleProjection?.title === "string"
          ? titleProjection.title
          : undefined;
      result.push({
        id,
        ...(title ? { title } : {}),
        ...(summary.parentSessionId
          ? { parentID: String(summary.parentSessionId) }
          : header?.parentSession
            ? { parentID: String(header.parentSession) }
            : {}),
        ...(header?.agentPreset ? { agent: header.agentPreset } : {}),
        ...(header?.origin ? { origin: header.origin } : {}),
        time: {
          created: header?.createdAt ?? summary.updatedAt ?? 0,
          updated: summary.updatedAt ?? header?.createdAt ?? 0,
        },
        running: Boolean(summary.running || this.#runningSessions.has(id)),
      });
    }

    // Include any persisted sessions not returned in visible list (e.g., subagent children).
    for (const snapshot of stored) {
      const id = String(snapshot.header.id);
      if (seen.has(id) || this.#deletedSessionIds.has(id)) continue;
      result.push({
        id,
        ...(snapshot.header.parentSession ? { parentID: String(snapshot.header.parentSession) } : {}),
        ...(snapshot.header.agentPreset ? { agent: snapshot.header.agentPreset } : {}),
        ...(snapshot.header.origin ? { origin: snapshot.header.origin } : {}),
        time: {
          created: snapshot.header.createdAt ?? 0,
          updated: snapshot.header.createdAt ?? 0,
        },
        running: this.#runningSessions.has(id),
      });
    }

    return result;
  }

  async listActiveSessions() {
    const { sessionController } = this.#requireServices();
    const ac = new AbortController();
    const listed = await sessionController.list({}, ac.signal).catch(() => ({ items: [] }));
    const active = {};
    for (const id of this.#runningSessions) {
      active[id] = { type: "busy" };
    }
    for (const item of listed?.items ?? []) {
      if (item.running) {
        active[String(item.sessionId)] = { type: "busy" };
      }
    }
    return active;
  }

  async createSession(input = {}) {
    const { sessionController } = this.#requireServices();
    const cwd = typeof input.directory === "string" && input.directory.trim()
      ? input.directory.trim()
      : typeof input.location?.directory === "string" && input.location.directory.trim()
        ? input.location.directory.trim()
        : this.#workspaceDir;
    const agentPreset = typeof input.agent === "string" && input.agent.trim()
      ? input.agent.trim()
      : undefined;

    const created = await sessionController.create({
      cwd,
      ...(agentPreset ? { agentPreset } : {}),
    });
    const sessionId = String(created.sessionId);

    if (typeof input.title === "string" && input.title.trim()) {
      await sessionController.rename({
        sessionId,
        title: input.title.trim(),
      });
    }

    return {
      id: sessionId,
      ...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim() } : {}),
      ...(created.agentPreset ? { agent: created.agentPreset } : {}),
    };
  }

  async updateSession(sessionId, input = {}) {
    const { sessionController } = this.#requireServices();
    if (typeof input.title === "string" && input.title.trim()) {
      await sessionController.rename({
        sessionId,
        title: input.title.trim(),
      });
    }
    return { id: sessionId };
  }

  async setSessionAgent(sessionId, agentKey) {
    const { agentPresets, agents, sessionPersistence } = this.#requireServices();
    await this.getAgent(agentKey);
    const snapshot = await sessionPersistence.stat(sessionId);
    const currentPreset = snapshot?.header?.agentPreset;
    if (currentPreset && currentPreset !== agentKey) {
      const liveAgent = agents?.get?.(sessionId);
      const isBlank = (snapshot?.eventCount ?? 0) === 0;
      if (liveAgent && isBlank) {
        await agentPresets.select(liveAgent, agentKey);
      }
    }
    return { id: sessionId, agent: agentKey };
  }

  async setSessionModel(sessionId, input = {}) {
    const { sessionController } = this.#requireServices();
    const provider = typeof input.provider === "string"
      ? input.provider
      : typeof input.model?.providerID === "string"
        ? input.model.providerID
        : "";
    const model = typeof input.model === "string"
      ? input.model
      : typeof input.model?.id === "string"
        ? input.model.id
        : "";
    if (!provider || !model) {
      throw new RuntimeHttpError(400, "缺少有效的模型 provider 与 model");
    }
    const result = await sessionController.selectModel({
      sessionId,
      provider,
      model,
    });
    return result.selected;
  }

  async #readRawSession(sessionId) {
    if (this.#deletedSessionIds.has(sessionId)) {
      throw new RuntimeHttpError(404, `会话不存在：${sessionId}`);
    }
    const { sessionPersistence, sessionController } = this.#requireServices();
    const snapshot = await sessionPersistence.stat(sessionId);
    if (!snapshot) {
      throw new RuntimeHttpError(404, `会话不存在：${sessionId}`);
    }
    const handle = await sessionPersistence.open(sessionId, "read");
    try {
      const loaded = await handle.read();
      return {
        header: loaded.meta ?? snapshot.header,
        events: Array.isArray(loaded.events) ? loaded.events : [],
      };
    } catch {
      // Fallback to sessionController.events() if a session requires format read adapter.
      const ac = new AbortController();
      const page = await sessionController.events(
        { address: { kind: "session", sessionId }, maxMessages: 10000 },
        ac.signal,
      );
      return {
        header: snapshot.header,
        events: (page.records ?? []).map((record) => record.event).filter(Boolean),
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async getSessionMessages(sessionId) {
    const { header, events } = await this.#readRawSession(sessionId);
    return normalizeDshEventsToMessages(events, {
      sessionId,
      agentKey: header?.agentPreset,
      isSubagent: header?.origin === "subagent",
    });
  }

  async promptSession(sessionId, payload) {
    const { sessionController } = this.#requireServices();
    const content = await buildDshPromptContent(payload, this.#workspaceDir);
    if (content.length === 0) {
      throw new RuntimeHttpError(400, "发送内容不能为空");
    }
    const requestId = typeof payload?.id === "string" && payload.id.trim()
      ? payload.id.trim()
      : randomUUID();
    const ac = new AbortController();
    return sessionController.prompt(
      {
        requestId,
        sessionId,
        mode: "queue",
        content,
      },
      ac.signal,
    );
  }

  async cancelSession(sessionId) {
    const { sessionController } = this.#requireServices();
    this.#interactions.cancelSessionInteractions(sessionId);
    const result = sessionController.cancel({ sessionId });
    return { accepted: Boolean(result?.accepted ?? true) };
  }

  async forkSession(sessionId, input = {}) {
    const { sessionController } = this.#requireServices();
    const { header, events } = await this.#readRawSession(sessionId);
    const before = typeof input.before === "string" && input.before.trim()
      ? input.before.trim()
      : undefined;
    const target = findForkTargetSeq(events, before, header?.origin === "subagent");

    if (target.kind === "blank") {
      return this.createSession({
        directory: header?.cwd ?? this.#workspaceDir,
        agent: header?.agentPreset,
      });
    }

    const forked = await sessionController.fork({
      sessionId,
      ...(target.kind === "atSeq" ? { atSeq: target.atSeq } : {}),
    });
    return {
      id: String(forked.sessionId),
      ...(header?.agentPreset ? { agent: header.agentPreset } : {}),
    };
  }

  async deleteSession(sessionId) {
    if (this.#deletedSessionIds.has(sessionId)) {
      throw new RuntimeHttpError(404, `会话不存在：${sessionId}`);
    }
    const { sessionPersistence } = this.#requireServices();
    const allStored = await sessionPersistence.list();
    const byId = new Map(allStored.map((item) => [String(item.header.id), item]));
    if (!byId.has(sessionId)) {
      throw new RuntimeHttpError(404, `会话不存在：${sessionId}`);
    }

    // Collect the target session and all its persisted descendants.
    const toDelete = new Set([sessionId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of allStored) {
        const id = String(item.header.id);
        const parent = item.header.parentSession ? String(item.header.parentSession) : null;
        if (parent && toDelete.has(parent) && !toDelete.has(id)) {
          toDelete.add(id);
          grew = true;
        }
      }
    }

    const active = await this.listActiveSessions();
    for (const id of toDelete) {
      if (active[id]) {
        throw new RuntimeHttpError(409, `会话仍在运行，无法删除：${id}`);
      }
    }

    await sessionPersistence.flush().catch(() => undefined);
    const sessionsRoot = path.resolve(this.#dshHome, "sessions");
    for (const id of toDelete) {
      this.#deletedSessionIds.add(id);
      this.#interactions.cancelSessionInteractions(id);
      const snapshot = await sessionPersistence.stat(id).catch(() => byId.get(id));
      const artifactPath = snapshot?.location?.path;
      if (typeof artifactPath !== "string" || !artifactPath) continue;
      const resolvedArtifact = path.resolve(artifactPath);
      if (!resolvedArtifact.startsWith(`${sessionsRoot}${path.sep}`)) continue;
      // Remove the per-session directory when artifact lives under `<sessionsRoot>/<project>/<sessionId>/<file>`,
      // otherwise remove the artifact file itself.
      const parentDir = path.dirname(resolvedArtifact);
      const targetPath = path.basename(parentDir) === id && parentDir.startsWith(`${sessionsRoot}${path.sep}`)
        ? parentDir
        : resolvedArtifact;
      await rm(targetPath, { recursive: true, force: true });
    }

    return { deleted: Array.from(toDelete) };
  }

  listPermissions() {
    return this.#interactions.listPermissions();
  }

  replyPermission(sessionId, permissionId, decision) {
    const ok = this.#interactions.replyPermission(sessionId, permissionId, decision);
    if (!ok) {
      throw new RuntimeHttpError(404, "确认请求不存在或已失效");
    }
    return { ok: true };
  }

  listQuestions() {
    return this.#interactions.listQuestions();
  }

  replyQuestion(sessionId, requestId, answers) {
    const ok = this.#interactions.replyQuestion(sessionId, requestId, answers);
    if (!ok) {
      throw new RuntimeHttpError(404, "提问请求不存在或已失效");
    }
    return { ok: true };
  }

  cancelQuestion(sessionId, requestId) {
    const ok = this.#interactions.cancelQuestion(sessionId, requestId);
    if (!ok) {
      throw new RuntimeHttpError(404, "提问请求不存在或已失效");
    }
    return { ok: true };
  }
}
