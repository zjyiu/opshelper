import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getAssignedRuntimeDefinition, type AgentMcpServer, type AssignedRuntimeDefinition } from "./agent-service";
import {
  getPlatformInstructions,
  getRuntimeModelConfiguration,
  type RuntimeModelConfiguration,
} from "./admin-config-service";
import { loadConfig, type AppConfig } from "./config";
import { assertSafeUserId, getUserPaths } from "./data-paths";

const agentKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

function runtimeSkillName(agent: string, skill: string) {
  return `${agent}-${skill}`;
}

function rewriteSkillName(content: string, name: string) {
  const matched = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
  if (!matched) throw new Error(`技能 ${name} 缺少有效 frontmatter`);
  const lines = matched[2].split(/\r?\n/);
  const index = lines.findIndex((line) => /^name:\s*/.test(line));
  if (index < 0) throw new Error(`技能 ${name} 缺少 name`);
  lines[index] = `name: ${name}`;
  return `${matched[1]}${lines.join("\n")}${matched[3]}${content.slice(matched[0].length)}`;
}

function dshMcpServerName(agent: string, mcpKey: string) {
  const raw = `${agent}-${mcpKey}`.replace(/[^A-Za-z0-9_-]/g, "-");
  if (raw.length <= 32) return raw;
  const suffix = createHash("sha256").update(`${agent}:${mcpKey}`).digest("hex").slice(0, 8);
  return `${raw.slice(0, 23)}-${suffix}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function splitModelId(fullModel: string) {
  const slash = fullModel.indexOf("/");
  if (slash <= 0) {
    return { provider: "custom", model: fullModel };
  }
  return {
    provider: fullModel.slice(0, slash),
    model: fullModel.slice(slash + 1),
  };
}

function buildDshProviderProjection(modelConfiguration: RuntimeModelConfiguration) {
  const providers: Record<string, unknown> = {};
  const credentialRefs: Record<string, string> = {};

  for (const [providerKey, rawProvider] of Object.entries(asRecord(modelConfiguration.provider))) {
    const providerObj = asRecord(rawProvider);
    const options = asRecord(providerObj.options);
    const rawModels = asRecord(providerObj.models);
    const baseURL = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
    const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    const models = Object.entries(rawModels).map(([id, raw]) => {
      const name = asRecord(raw).name;
      return {
        id,
        name: typeof name === "string" && name.trim() ? name.trim() : id,
      };
    });
    if (!models.length) continue;

    const envKey = providerKey === "custom"
      ? "OPSHELPER_LLM_API_KEY"
      : `OPSHELPER_LLM_${providerKey.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    if (apiKey) {
      credentialRefs[envKey] = apiKey;
    }

    providers[providerKey] = {
      displayName: typeof providerObj.name === "string" && providerObj.name.trim()
        ? providerObj.name.trim()
        : providerKey,
      api: "openai-completions",
      ...(baseURL ? { baseURL } : {}),
      ...(apiKey ? { apiKeyEnv: envKey } : {}),
      models,
    };
  }

  return { providers, credentialRefs };
}

function buildDshMcpPlugin(agentKeyValue: string, mcpKey: string, cfg: AgentMcpServer) {
  const serverName = dshMcpServerName(agentKeyValue, mcpKey);
  const pluginId = `mcp-${serverName}`;
  const disabled = cfg.enabled === false;
  if (cfg.type === "local") {
    return {
      id: pluginId,
      name: "@deepseek-ai/dsh-mcp-client",
      ...(disabled ? { disabled: true } : {}),
      config: {
        transport: "stdio",
        serverName,
        command: cfg.command[0],
        args: cfg.command.slice(1),
        env: cfg.environment ?? {},
        cwd: cfg.cwd ?? "/workspace",
        toolCallTimeoutMs: cfg.timeout ?? 30_000,
        failOnStartupError: false,
      },
    };
  }
  return {
    id: pluginId,
    name: "@deepseek-ai/dsh-mcp-client",
    ...(disabled ? { disabled: true } : {}),
    config: {
      transport: "streamable-http",
      serverName,
      url: cfg.url,
      headers: cfg.headers ?? {},
      toolCallTimeoutMs: cfg.timeout ?? 30_000,
      failOnStartupError: false,
    },
  };
}

function buildAgentPresetPlugins(input: {
  agentKey: string;
  prompt: string;
  instructions: string;
  skills: string[];
  taskAgentKeys: string[];
  mcp: Record<string, AgentMcpServer>;
}) {
  const combinedPrompt = input.instructions.trim()
    ? `${input.prompt.trim()}\n\n${input.instructions.trim()}`
    : input.prompt.trim();

  const plugins: unknown[] = [
    {
      id: "persona",
      name: "@deepseek-ai/dsh-persona",
      config: {
        prefix: combinedPrompt,
        complete: true,
        includeRuntimeContext: false,
      },
    },
    { id: "time-context", name: "@deepseek-ai/dsh-time-context" },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" },
    { id: "tool-jobs", name: "@deepseek-ai/dsh-tool-jobs" },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs", config: { applyPatch: false } },
    { id: "tool-fs-search", name: "@deepseek-ai/dsh-tool-fs-search", config: { sampleOverCapGlobResults: false } },
    { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
    { id: "tool-todo", name: "@deepseek-ai/dsh-tool-todo", config: { allowParallelInProgress: true } },
    { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { fetch: true, searchTimeoutMs: 60_000 } },
    {
      id: "compaction",
      name: "cordis:group",
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        {
          id: "tool-result-pruner",
          name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
  ];

  if (input.skills.length > 0) {
    plugins.push(
      {
        id: "skill-filesystem",
        name: "@deepseek-ai/dsh-skill-filesystem",
        config: {
          includeDefaultRoots: false,
          customSkillDirs: [`/opt/opshelper/config/dsh/skills/${input.agentKey}`],
          watch: false,
        },
      },
      { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
    );
  }

  if (input.taskAgentKeys.length > 0) {
    plugins.push({
      id: "tool-subagent",
      name: "@deepseek-ai/dsh-tool-subagent",
      config: {
        provider: "spawn",
        toolName: "subagent",
        allowedAgentPresets: input.taskAgentKeys,
      },
    });
  }

  for (const [mcpKey, cfg] of Object.entries(input.mcp)) {
    plugins.push(buildDshMcpPlugin(input.agentKey, mcpKey, cfg));
  }

  return plugins;
}

export class RuntimeNotConfiguredError extends Error {
  statusCode = 503;
  constructor() {
    super("用户尚未获配可用智能体，运行环境无法启动。");
  }
}

export interface ManagedRuntime {
  generation: string;
  defaultAgentKey?: string;
  agentKeys: string[];
  taskAgentKeys?: string[];
  model: string;
  configuredModels?: string[];
  password: string;
  desiredGeneration: number;
}

export interface ManagedRuntimeServices {
  assignedRuntime: (userId: string) => Promise<AssignedRuntimeDefinition>;
  modelConfiguration: () => Promise<RuntimeModelConfiguration>;
  platformInstructions: () => Promise<string>;
}

const defaultServices: ManagedRuntimeServices = {
  assignedRuntime: getAssignedRuntimeDefinition,
  modelConfiguration: getRuntimeModelConfiguration,
  platformInstructions: getPlatformInstructions,
};

// Managed sources must be ordinary files/directories. Never follow a symlink
// into another user's data or credentials when assembling the user's subset.
async function assertPlainTree(filename: string, digest?: ReturnType<typeof createHash>, relative = "") {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error("受管配置不允许符号链接或特殊文件");
  }
  if (info.isDirectory()) {
    for (const name of (await readdir(filename)).sort()) {
      await assertPlainTree(path.join(filename, name), digest, `${relative}/${name}`);
    }
  } else if (digest) {
    if (info.size > 16 * 1024 * 1024) throw new Error("受管文件超过 16 MiB");
    digest.update(relative).update("\0").update(await readFile(filename));
  }
}

export async function getRuntimePassword(userId: string, config: AppConfig = loadConfig()) {
  const { managed } = getUserPaths(userId, config);
  await mkdir(managed, { recursive: true, mode: 0o700 });
  const secretPath = path.join(managed, "server-password");
  try {
    await writeFile(secretPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(secretPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("无效的运行环境认证文件");
  await chmod(secretPath, 0o600);
  const secret = (await readFile(secretPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("无效的运行环境认证文件");
  return secret;
}

export function runtimeAuthorization(password: string) {
  return `Basic ${Buffer.from(`opshelper:${password}`).toString("base64")}`;
}

export async function readManagedRuntime(
  userId: string,
  generation: string,
  config: AppConfig = loadConfig(),
): Promise<ManagedRuntime> {
  if (!/^[a-f0-9]{24}$/.test(generation)) throw new RuntimeNotConfiguredError();
  const manifest = z.object({
    generation: z.literal(generation),
    defaultAgentKey: agentKey.optional(),
    agentKeys: z.array(agentKey),
    taskAgentKeys: z.array(agentKey).optional(),
    model: z.string(),
    configuredModels: z.array(z.string()).optional(),
    desiredGeneration: z.number().int().nonnegative().default(0),
  }).strict().parse(
    JSON.parse(await readFile(path.join(getUserPaths(userId, config).managed, "releases", generation, "manifest.json"), "utf8")),
  );
  return { ...manifest, password: await getRuntimePassword(userId, config) };
}

export async function prepareManagedRuntime(
  userId: string,
  config: AppConfig = loadConfig(),
  services: ManagedRuntimeServices = defaultServices,
): Promise<ManagedRuntime> {
  assertSafeUserId(userId);
  const [definition, modelConfiguration, instructions] = await Promise.all([
    services.assignedRuntime(userId),
    services.modelConfiguration(),
    services.platformInstructions(),
  ]);
  if (!definition.agents.length) throw new RuntimeNotConfiguredError();
  const agentKeys = definition.agents.map((agent) => agent.key).sort();
  const defaultAgentKey = definition.agents.find((agent) => agent.mode !== "subagent")?.key;
  if (!defaultAgentKey) {
    throw new Error("用户至少需要一个 primary 或 all 模式的主智能体");
  }
  const taskAgentKeys = definition.agents
    .filter((agent) => agent.mode !== "primary")
    .map((agent) => agent.key)
    .sort();
  const configuredModels = new Set(modelConfiguration.configuredModels);
  for (const agent of definition.agents) {
    if (agent.model && !configuredModels.has(agent.model)) {
      throw new Error(`智能体 ${agent.key} 引用的模型未配置：${agent.model}`);
    }
  }
  const user = getUserPaths(userId, config);
  const digest = createHash("sha256").update(JSON.stringify({
    engine: "dsh",
    version: 1,
    desiredGeneration: definition.desiredGeneration,
    agents: definition.agents.map((agent) => ({
      key: agent.key,
      displayName: agent.displayName,
      hash: agent.contentHash,
      description: agent.description,
      mode: agent.mode,
      model: agent.model,
      tools: agent.tools,
      skills: agent.skills,
      mcp: agent.mcp,
    })),
    model: modelConfiguration.model,
    configuredModels: modelConfiguration.configuredModels,
    provider: modelConfiguration.provider,
    instructions,
  }));
  const prompts: Record<string, string> = {};
  for (const definitionAgent of definition.agents) {
    const key = definitionAgent.key;
    const source = definitionAgent.sourceDir;
    await assertPlainTree(source, digest, key);
    prompts[key] = await readFile(path.join(source, "agent.md"), "utf8");
    if (!prompts[key].trim()) throw new Error(`智能体 ${key} 的 agent.md 为空`);
  }
  const generation = digest.digest("hex").slice(0, 24);
  const releases = path.join(user.managed, "releases");
  const destination = path.join(releases, generation);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  for (const directory of [user.workspace, "outputs", "chat-uploads"].map((value, index) => index ? path.join(user.workspace, value) : value)) {
    await mkdir(directory, { recursive: true });
  }
  await mkdir(path.join(user.state, "dsh-v1"), { recursive: true });

  const runtime: ManagedRuntime = {
    generation,
    defaultAgentKey,
    agentKeys,
    taskAgentKeys,
    model: modelConfiguration.model,
    configuredModels: modelConfiguration.configuredModels,
    password: await getRuntimePassword(userId, config),
    desiredGeneration: definition.desiredGeneration,
  };

  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    // Releases are atomically published and mounted read-only in the runtime.
    // Revalidate sources above, and reject altered/symlinked releases before
    // reusing one; a cache hit must not bypass the assignment boundary.
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("无效的受管运行环境目录");
    }
    await assertPlainTree(destination);
    const cached = await readManagedRuntime(userId, generation, config);
    const overlayFile = await lstat(path.join(destination, "config", "dsh", "overlay.patch.yml"));
    const cachedInstructions = await readFile(
      path.join(destination, "config", "dsh", "INSTRUCTIONS.md"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const cachedAgents = (await readdir(path.join(destination, "agents"))).sort();
    if (!overlayFile.isFile() || overlayFile.isSymbolicLink() ||
      cachedInstructions !== (instructions.trim() ? instructions : null) ||
      cached.model !== runtime.model ||
      cached.defaultAgentKey !== runtime.defaultAgentKey ||
      cached.desiredGeneration !== runtime.desiredGeneration ||
      JSON.stringify(cached.agentKeys) !== JSON.stringify(agentKeys) ||
      JSON.stringify(cached.taskAgentKeys) !== JSON.stringify(taskAgentKeys) ||
      JSON.stringify(cachedAgents) !== JSON.stringify(agentKeys) ||
      JSON.stringify(cached.configuredModels) !== JSON.stringify(runtime.configuredModels)) {
      throw new Error("受管运行环境清单与当前配置不一致");
    }
    return runtime;
  }

  const staging = path.join(releases, `.staging-${randomUUID()}`);
  await mkdir(path.join(staging, "config", "dsh"), { recursive: true });
  try {
    const { providers, credentialRefs } = buildDshProviderProjection(modelConfiguration);
    const defaultModel = splitModelId(modelConfiguration.model);
    const presetRows: unknown[] = [];

    for (const definitionAgent of definition.agents) {
      const key = definitionAgent.key;
      const source = definitionAgent.sourceDir;
      await cp(source, path.join(staging, "agents", key), { recursive: true, dereference: false });

      for (const skill of definitionAgent.skills) {
        const runtimeName = runtimeSkillName(key, skill);
        const sourceSkill = path.join(source, "skills", skill);
        const destinationSkill = path.join(staging, "config", "dsh", "skills", key, runtimeName);
        await cp(sourceSkill, destinationSkill, { recursive: true, dereference: false });
        const skillDocument = path.join(destinationSkill, "SKILL.md");
        await writeFile(
          skillDocument,
          rewriteSkillName(await readFile(skillDocument, "utf8"), runtimeName),
        );
      }

      presetRows.push({
        id: `preset-${key}`,
        name: "@deepseek-ai/dsh-agent-preset",
        config: {
          id: key,
          name: definitionAgent.displayName || key,
          description: definitionAgent.description,
          plugins: buildAgentPresetPlugins({
            agentKey: key,
            prompt: prompts[key],
            instructions,
            skills: definitionAgent.skills,
            taskAgentKeys,
            mcp: definitionAgent.mcp,
          }),
        },
      });
    }

    // DSH credentials file mounted read-only; never exposed in process.env.
    // dsh-credentials-local strictly enforces mode 0600 (owner-only).
    const credentialsPath = path.join(staging, "config", "dsh", "credentials.yaml");
    const credentialsDoc = {
      version: 1,
      refs: credentialRefs,
    };
    await writeFile(credentialsPath, `${JSON.stringify(credentialsDoc, null, 2)}\n`, { mode: 0o600 });
    await chmod(credentialsPath, 0o600);

    // JSON is a strict subset of YAML 1.2 and parsed cleanly by js-yaml + entryListSchema.
    // Note: `credentials.yaml` is synced into writable `$DSH_HOME/.credentials.yaml` by
    // the runtime entrypoint before Cordis boot so `dsh-client-connection` can lock it
    // under a read-only root filesystem.
    const overlayPatch: unknown[] = [
      ...(Object.keys(providers).length > 0
        ? [{ id: "llm-pi-ai", config: { providers } }]
        : []),
      {
        id: "agent-default-model",
        config: {
          provider: defaultModel.provider,
          model: defaultModel.model,
        },
      },
      { insert: presetRows },
    ];
    await writeFile(
      path.join(staging, "config", "dsh", "overlay.patch.yml"),
      `${JSON.stringify(overlayPatch, null, 2)}\n`,
    );

    if (instructions.trim()) {
      await writeFile(path.join(staging, "config", "dsh", "INSTRUCTIONS.md"), instructions);
    }

    await writeFile(path.join(staging, "manifest.json"), JSON.stringify({
      generation,
      defaultAgentKey,
      agentKeys,
      taskAgentKeys,
      model: modelConfiguration.model,
      configuredModels: modelConfiguration.configuredModels,
      desiredGeneration: definition.desiredGeneration,
    }));

    try {
      await rename(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return runtime;
}
