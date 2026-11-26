import assert from "node:assert/strict";
import { BUILTIN_INSTRUCTIONS, withBuiltinInstructions } from "./builtin-instructions";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config";
import type { AgentMcpServer } from "./agent-service";
import {
  type ManagedRuntimeServices,
  prepareManagedRuntime,
  readManagedRuntime,
  RuntimeNotConfiguredError,
} from "./managed-runtime";

test("装配只包含获配智能体并投影为 DSH AgentPreset，同一内容复用代次，重建保留密码与用户文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opshelper-managed-"));
  const config = { ...loadConfig(), dataRoot: root, dataRootHost: root };
  try {
    for (const key of ["network", "system", "secret-agent"]) {
      await mkdir(path.join(root, "agents", key), { recursive: true });
      await writeFile(path.join(root, "agents", key, "agent.md"), `${key}: fixture prompt`);
    }
    await mkdir(path.join(root, "agents", "network", "skills", "diagnose"), { recursive: true });
    await writeFile(
      path.join(root, "agents", "network", "skills", "diagnose", "SKILL.md"),
      "---\nname: diagnose\ndescription: Diagnose the network\n---\nUse evidence.\n",
    );
    const contentHashes: Record<string, string> = {
      network: "network-source-v1",
      system: "system-source-v1",
    };
    const assignments: Record<string, string[]> = {
      alice: ["network", "system"],
      bob: ["network"],
    };
    const services: ManagedRuntimeServices = {
      assignedRuntime: async (userId) => ({
        desiredGeneration: 7,
        appliedGeneration: 6,
        applyStatus: "APPLYING",
        agents: (assignments[userId] ?? []).map((key) => ({
          id: `${key}-id`,
          key,
          displayName: key,
          description: `${key} fixture agent`,
          mode: key === "network" ? "primary" : "subagent",
          contentHash: contentHashes[key],
          model: null,
          tools: key === "system" ? ["execute"] : [],
          skills: key === "network" ? ["diagnose"] : [],
          scripts: [],
          mcp: key === "network" ? {
            observer: {
              type: "remote",
              url: "https://mcp.example.com/mcp",
              enabled: true,
              oauth: false,
            },
          } as Record<string, AgentMcpServer> : {},
          sourceDir: path.join(root, "agents", key),
        })),
      }),
      modelConfiguration: async () => ({
        model: "custom/fixture-model",
        provider: {
          custom: {
            name: "测试模型",
            options: { baseURL: "http://127.0.0.1:8080/v1", apiKey: "sk-fixture" },
            models: { "fixture-model": { name: "Fixture Model" } },
          },
        },
        configuredModels: ["custom/fixture-model"],
      }),
      platformInstructions: async () => withBuiltinInstructions("所有交付文件必须保存在 /workspace。\n"),
    };

    const first = await prepareManagedRuntime("alice", config, services);
    await writeFile(path.join(root, "users", "alice", "workspace", "keep.txt"), "keep");
    const releases = path.join(root, "users", "alice", "managed", "releases");
    const previousTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(releases, previousTime, previousTime);
    const again = await prepareManagedRuntime("alice", config, services);
    assert.deepEqual(again, first);
    assert.equal((await stat(releases)).mtime.toISOString(), previousTime.toISOString(), "cache hits do not create staging directories");
    assert.equal(first.desiredGeneration, 7);
    assert.equal(first.defaultAgentKey, "network");
    assert.equal(await readFile(path.join(root, "users", "alice", "workspace", "keep.txt"), "utf8"), "keep");

    const release = path.join(root, "users", "alice", "managed", "releases", first.generation);
    assert.deepEqual((await readdir(path.join(release, "agents"))).sort(), ["network", "system"]);

    const overlay = JSON.parse(await readFile(path.join(release, "config", "dsh", "overlay.patch.yml"), "utf8")) as Array<Record<string, any>>;
    const credentials = JSON.parse(await readFile(path.join(release, "config", "dsh", "credentials.yaml"), "utf8")) as { version: number; refs: Record<string, string> };
    assert.equal(credentials.version, 1);
    assert.equal(credentials.refs.OPSHELPER_LLM_API_KEY, "sk-fixture");

    const instructions = await readFile(path.join(release, "config", "dsh", "INSTRUCTIONS.md"), "utf8");
    assert.equal(instructions, withBuiltinInstructions("所有交付文件必须保存在 /workspace。\n", BUILTIN_INSTRUCTIONS));
    assert.match(instructions, /pele-render/);
    assert.match(instructions, /默认将 `\/workspace` 作为文件操作范围/);

    const piAiRow = overlay.find((row) => row.id === "llm-pi-ai");
    assert.equal(piAiRow?.config?.providers?.custom?.baseURL, "http://127.0.0.1:8080/v1");
    assert.equal(piAiRow?.config?.providers?.custom?.apiKeyEnv, "OPSHELPER_LLM_API_KEY");
    assert.equal(piAiRow?.config?.providers?.custom?.api, "openai-completions");

    const defaultModelRow = overlay.find((row) => row.id === "agent-default-model");
    assert.deepEqual(defaultModelRow?.config, { provider: "custom", model: "fixture-model" });

    const insertRow = overlay.find((row) => Array.isArray(row.insert));
    const presets = (insertRow?.insert ?? []) as Array<{ id: string; config: { id: string; plugins: Array<Record<string, any>> } }>;
    const networkPreset = presets.find((p) => p.config.id === "network");
    const systemPreset = presets.find((p) => p.config.id === "system");
    assert.ok(networkPreset);
    assert.ok(systemPreset);
    assert.equal(presets.find((p) => p.config.id === "secret-agent"), undefined);

    // Network preset gets isolated skills dir, isolated MCP server, and allowedAgentPresets: ["system"]
    const netSkillFs = networkPreset.config.plugins.find((p) => p.id === "skill-filesystem");
    assert.deepEqual(netSkillFs?.config?.customSkillDirs, ["/opt/opshelper/config/dsh/skills/network"]);
    assert.equal(netSkillFs?.config?.includeDefaultRoots, false);
    const netSubagent = networkPreset.config.plugins.find((p) => p.id === "tool-subagent");
    assert.deepEqual(netSubagent?.config?.allowedAgentPresets, ["system"]);
    const netMcp = networkPreset.config.plugins.find((p) => p.name === "@deepseek-ai/dsh-mcp-client");
    assert.equal(netMcp?.config?.transport, "streamable-http");
    assert.equal(netMcp?.config?.url, "https://mcp.example.com/mcp");

    // System preset has no skill-filesystem and no MCP server
    assert.equal(systemPreset.config.plugins.find((p) => p.id === "skill-filesystem"), undefined);
    assert.equal(systemPreset.config.plugins.find((p) => p.name === "@deepseek-ai/dsh-mcp-client"), undefined);

    assert.match(
      await readFile(path.join(release, "config", "dsh", "skills", "network", "network-diagnose", "SKILL.md"), "utf8"),
      /name: network-diagnose/,
    );

    const bob = await prepareManagedRuntime("bob", config, services);
    assert.notEqual(first.password, bob.password);
    assert.deepEqual(bob.agentKeys, ["network"]);
    assert.deepEqual(await readManagedRuntime("alice", first.generation, config), first);

    const changedModelServices: ManagedRuntimeServices = {
      ...services,
      modelConfiguration: async () => ({
        model: "custom/fixture-model",
        provider: {},
        configuredModels: ["custom/fixture-model", "custom/second"],
      }),
    };
    const changedModels = await prepareManagedRuntime("alice", config, changedModelServices);
    assert.notEqual(changedModels.generation, first.generation);
    assert.deepEqual(changedModels.configuredModels, ["custom/fixture-model", "custom/second"]);

    const changedInstructions = await prepareManagedRuntime("alice", config, {
      ...services,
      platformInstructions: async () => "# 可编辑的平台规则\n",
    });
    assert.notEqual(changedInstructions.generation, first.generation);
    assert.equal(
      await readFile(path.join(
        root,
        "users",
        "alice",
        "managed",
        "releases",
        changedInstructions.generation,
        "config",
        "dsh",
        "INSTRUCTIONS.md",
      ), "utf8"),
      "# 可编辑的平台规则\n",
    );

    await symlink(path.join(root, "agents", "secret-agent", "agent.md"), path.join(release, "escape"));
    await assert.rejects(prepareManagedRuntime("alice", config, services), /符号链接/);
    await rm(path.join(release, "escape"));

    const manifestPath = path.join(release, "manifest.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), agentKeys: ["secret-agent"] }));
    await assert.rejects(prepareManagedRuntime("alice", config, services), /清单与当前配置不一致/);
    await writeFile(manifestPath, originalManifest);

    await writeFile(path.join(root, "agents", "network", "agent.md"), "updated prompt");
    contentHashes.network = "network-source-v2";
    assert.notEqual(
      (await prepareManagedRuntime("alice", config, services)).generation,
      first.generation,
    );

    await assert.rejects(
      prepareManagedRuntime("unknown", config, services),
      RuntimeNotConfiguredError,
    );
    await symlink(path.join(root, "agents", "secret-agent", "agent.md"), path.join(root, "agents", "system", "escape"));
    await assert.rejects(prepareManagedRuntime("alice", config, services), /符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
