import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DshRuntimeHost } from "../src/runtime-host.mjs";
import { createRuntimeServer } from "../src/server.mjs";

function authHeader(password, username = "opshelper") {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function requestJson(baseUrl, password, method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      authorization: authHeader(password),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function waitForIdle(baseUrl, password, sessionId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ json: active }, { json: msgs }] = await Promise.all([
      requestJson(baseUrl, password, "GET", "/runtime/sessions/active"),
      requestJson(baseUrl, password, "GET", `/runtime/sessions/${sessionId}/messages`),
    ]);
    const list = msgs?.data ?? [];
    const last = list.at(-1);
    if (!active?.data?.[sessionId] && last?.info?.role === "assistant" && last?.info?.terminal === true) {
      return list;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become idle`);
}

test("full DSH runtime HTTP + SSE bridge lifecycle against offline mock OpenAI server", async () => {
  // 1. Start mock OpenAI-compatible SSE server (zero external network).
  const recordedRequests = [];
  let callIndex = 0;
  const mockOpenAi = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    callIndex += 1;
    recordedRequests.push({
      model: body.model,
      toolNames: (body.tools ?? []).map((t) => t.function?.name ?? t.name),
      messages: body.messages,
    });

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const emit = (delta, finishReason = null) => {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-int-${callIndex}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
    };

    const lastMsg = body.messages?.at(-1);
    const isToolReply = lastMsg?.role === "tool";

    if (callIndex === 1 && !isToolReply) {
      // Turn 1 Step 1: call `read` tool on /workspace/hello.txt
      emit({
        role: "assistant",
        reasoning_content: "Reading workspace file first.",
        tool_calls: [{
          index: 0,
          id: "call_read_1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ file_path: "hello.txt" }) },
        }],
      });
      emit({}, "tool_calls");
    } else if (isToolReply) {
      // Turn 1 Step 2: stream final answer
      emit({ role: "assistant", content: "File says: " });
      emit({ content: "OPSHELPER_OK" });
      emit({}, "stop");
    } else {
      // Subsequent turns
      emit({ role: "assistant", content: `Direct reply #${callIndex}` });
      emit({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise((resolve) => mockOpenAi.listen(0, "127.0.0.1", resolve));
  const mockBaseURL = `http://127.0.0.1:${mockOpenAi.address().port}/v1`;

  // 2. Prepare isolated workspace, DSH_HOME, and per-agent skill directories.
  const root = await mkdtemp(path.join(tmpdir(), "dsh-rt-int-"));
  const workspace = process.env.INTEGRATION_WORKSPACE || path.join(root, "workspace");
  const dshHome = process.env.DSH_HOME || path.join(root, "dsh-home");
  const leadSkillsDir = path.join(root, "skills", "ops-lead");
  const helperSkillsDir = path.join(root, "skills", "ops-helper");
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  await mkdir(path.join(leadSkillsDir, "alpha"), { recursive: true });
  await mkdir(path.join(helperSkillsDir, "beta"), { recursive: true });
  await writeFile(path.join(workspace, "hello.txt"), "OPSHELPER_OK\n");
  await writeFile(
    path.join(leadSkillsDir, "alpha", "SKILL.md"),
    "---\nname: ops-lead-alpha\ndescription: Lead-only skill\n---\nLead skill body.\n",
  );
  await writeFile(
    path.join(helperSkillsDir, "beta", "SKILL.md"),
    "---\nname: ops-helper-beta\ndescription: Helper-only skill\n---\nHelper skill body.\n",
  );

  process.env.OPSHELPER_LLM_API_KEY = "test-secret-key";

  const managedPatch = [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          custom: {
            displayName: "测试模型",
            api: "openai-completions",
            baseURL: mockBaseURL,
            apiKeyEnv: "OPSHELPER_LLM_API_KEY",
            models: [
              { id: "model-a", name: "Model A" },
              { id: "model-b", name: "Model B" },
            ],
          },
        },
      },
    },
    {
      id: "agent-default-model",
      config: { provider: "custom", model: "model-a" },
    },
    {
      insert: [
        {
          id: "preset-ops-lead",
          name: "@deepseek-ai/dsh-agent-preset",
          config: {
            id: "ops-lead",
            name: "主智能体",
            description: "Lead ops agent",
            plugins: [
              {
                id: "persona",
                name: "@deepseek-ai/dsh-persona",
                config: { prefix: "You are ops-lead.", complete: true, includeRuntimeContext: false },
              },
              { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs", config: { applyPatch: false } },
              {
                id: "skill-filesystem",
                name: "@deepseek-ai/dsh-skill-filesystem",
                config: { includeDefaultRoots: false, customSkillDirs: [leadSkillsDir], watch: false },
              },
              { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
              {
                id: "tool-subagent",
                name: "@deepseek-ai/dsh-tool-subagent",
                config: { provider: "spawn", toolName: "subagent", allowedAgentPresets: ["ops-helper"] },
              },
            ],
          },
        },
        {
          id: "preset-ops-helper",
          name: "@deepseek-ai/dsh-agent-preset",
          config: {
            id: "ops-helper",
            name: "子智能体",
            description: "Helper subagent",
            plugins: [
              {
                id: "persona",
                name: "@deepseek-ai/dsh-persona",
                config: { prefix: "You are ops-helper.", complete: true, includeRuntimeContext: false },
              },
              {
                id: "skill-filesystem",
                name: "@deepseek-ai/dsh-skill-filesystem",
                config: { includeDefaultRoots: false, customSkillDirs: [helperSkillsDir], watch: false },
              },
              { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
            ],
          },
        },
      ],
    },
  ];

  const host = new DshRuntimeHost({ workspaceDir: workspace, dshHome });
  const password = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  await host.start({
    manifest: {
      generation: "aaaaaaaaaaaaaaaaaaaaaaaa",
      defaultAgentKey: "ops-lead",
      agentKeys: ["ops-helper", "ops-lead"],
    },
    managedPatch,
  });

  const server = createRuntimeServer(host, { password });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sseAbort = new AbortController();

  try {
    // 3. Auth check
    const unauth = await fetch(`${baseUrl}/runtime/health`);
    assert.equal(unauth.status, 401);

    // 4. Health & agents check
    const health = await requestJson(baseUrl, password, "GET", "/runtime/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.data.engine, "dsh");
    assert.equal(health.json.data.ready, true);

    const agents = await requestJson(baseUrl, password, "GET", "/runtime/agents");
    assert.deepEqual(agents.json.data.map((a) => a.name), ["ops-helper", "ops-lead"]);

    // 5. Subscribe to SSE before prompting
    const sseEvents = [];
    const sseRes = await fetch(`${baseUrl}/runtime/events`, {
      headers: { authorization: authHeader(password), accept: "text/event-stream" },
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const pumpSse = (async () => {
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (dataLine) sseEvents.push(JSON.parse(dataLine.slice(5).trim()));
          }
        }
      } catch {
        // expected on abort
      }
    })();

    // 6. Create session for ops-lead & run a 2-step tool-calling turn
    const created = await requestJson(baseUrl, password, "POST", "/runtime/sessions", {
      title: "opshelper:conv-1",
      agent: "ops-lead",
    });
    assert.equal(created.status, 200);
    const sessionId = created.json.data.id;
    assert.ok(sessionId);

    const prompt1 = await requestJson(baseUrl, password, "POST", `/runtime/sessions/${sessionId}/prompt`, {
      text: "Read hello.txt <!-- opshelper-execution:exec-1 -->",
    });
    assert.equal(prompt1.status, 200);

    const msgs1 = await waitForIdle(baseUrl, password, sessionId);
    assert.equal(msgs1.length, 3);
    assert.equal(msgs1[0].info.role, "user");
    assert.equal(msgs1[1].info.role, "assistant");
    assert.equal(msgs1[1].info.terminal, false);
    assert.equal(msgs1[1].info.finish, "tool-calls");
    const readPart = msgs1[1].parts.find((p) => p.type === "tool");
    assert.equal(readPart?.tool, "read");
    assert.equal(readPart?.state?.status, "completed");
    assert.equal(readPart?.state?.input?.filePath, "hello.txt");
    assert.match(readPart?.state?.output ?? "", /OPSHELPER_OK/);
    assert.equal(msgs1[2].info.role, "assistant");
    assert.equal(msgs1[2].info.terminal, true);
    assert.equal(msgs1[2].info.finish, "stop");
    assert.equal(msgs1[2].parts.find((p) => p.type === "text")?.text, "File says: OPSHELPER_OK");

    // Verify SSE streamed live deltas with matching messageID and text:0
    assert.ok(sseEvents.some((e) => e.type === "server.connected"));
    assert.ok(
      sseEvents.some(
        (e) =>
          e.type === "message.part.delta" &&
          e.properties?.sessionID === sessionId &&
          e.properties?.messageID === msgs1[2].info.id &&
          e.properties?.partID === "text:0",
      ),
      "Expected live text delta matching persisted assistant messageID and partID",
    );

    // 7. Send Turn 2 so we can test both fork boundaries (before u1 => 0 msgs, before u2 => 3 msgs)
    await requestJson(baseUrl, password, "POST", `/runtime/sessions/${sessionId}/prompt`, {
      text: "Second question <!-- opshelper-execution:exec-2 -->",
    });
    // Wait for Turn 2 to finish
    let msgs2 = msgs1;
    const deadline2 = Date.now() + 15_000;
    while (Date.now() < deadline2) {
      msgs2 = await waitForIdle(baseUrl, password, sessionId);
      if (msgs2.length >= 5) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(msgs2.length, 5);
    const user1Id = msgs2[0].info.id;
    const user2Id = msgs2[3].info.id;

    // Fork before user2Id -> preserves exact Turn 1 (3 messages)
    const forkTurn1 = await requestJson(baseUrl, password, "POST", `/runtime/sessions/${sessionId}/fork`, {
      before: user2Id,
    });
    assert.equal(forkTurn1.status, 200);
    const fork1Msgs = await requestJson(baseUrl, password, "GET", `/runtime/sessions/${forkTurn1.json.data.id}/messages`);
    assert.equal(fork1Msgs.json.data.length, 3);

    // Fork before user1Id -> blank session (0 messages)
    const forkBlank = await requestJson(baseUrl, password, "POST", `/runtime/sessions/${sessionId}/fork`, {
      before: user1Id,
    });
    assert.equal(forkBlank.status, 200);
    const forkBlankMsgs = await requestJson(baseUrl, password, "GET", `/runtime/sessions/${forkBlank.json.data.id}/messages`);
    assert.equal(forkBlankMsgs.json.data.length, 0);

    // 8. Second agent (`ops-helper`) + model switch (`model-b`) + skill/tool isolation
    const created2 = await requestJson(baseUrl, password, "POST", "/runtime/sessions", {
      title: "opshelper:conv-2",
      agent: "ops-helper",
    });
    const session2Id = created2.json.data.id;
    const modelSwitch = await requestJson(baseUrl, password, "POST", `/runtime/sessions/${session2Id}/model`, {
      model: { providerID: "custom", id: "model-b" },
    });
    assert.equal(modelSwitch.status, 200);
    await requestJson(baseUrl, password, "POST", `/runtime/sessions/${session2Id}/prompt`, {
      text: "Hello helper",
    });
    await waitForIdle(baseUrl, password, session2Id);

    const leadReq = recordedRequests[0];
    const helperReq = recordedRequests.at(-1);
    assert.equal(leadReq.model, "model-a");
    assert.ok(leadReq.toolNames.includes("read"));
    assert.ok(leadReq.toolNames.includes("subagent"));
    assert.ok(JSON.stringify(leadReq.messages).includes("ops-lead-alpha"));
    assert.ok(!JSON.stringify(leadReq.messages).includes("ops-helper-beta"));

    assert.equal(helperReq.model, "model-b");
    assert.ok(!helperReq.toolNames.includes("read"));
    assert.ok(!helperReq.toolNames.includes("subagent"));
    assert.ok(JSON.stringify(helperReq.messages).includes("ops-helper-beta"));
    assert.ok(!JSON.stringify(helperReq.messages).includes("ops-lead-alpha"));

    // 9. Cancel & Delete session
    const cancelRes = await requestJson(baseUrl, password, "POST", `/runtime/sessions/${session2Id}/cancel`);
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json.data.accepted, true);

    const delRes = await requestJson(baseUrl, password, "DELETE", `/runtime/sessions/${forkBlank.json.data.id}`);
    assert.equal(delRes.status, 200);
    const delMatRes = await requestJson(baseUrl, password, "DELETE", `/runtime/sessions/${forkTurn1.json.data.id}`);
    assert.equal(delMatRes.status, 200);
    const sessionsAfterDelete = await requestJson(baseUrl, password, "GET", "/runtime/sessions");
    assert.ok(!sessionsAfterDelete.json.data.some((s) => s.id === forkBlank.json.data.id));
    assert.ok(!sessionsAfterDelete.json.data.some((s) => s.id === forkTurn1.json.data.id));
    const readDeleted = await requestJson(baseUrl, password, "GET", `/runtime/sessions/${forkTurn1.json.data.id}/messages`);
    assert.equal(readDeleted.status, 404);

    sseAbort.abort();
    await pumpSse;
  } finally {
    sseAbort.abort();
    await new Promise((resolve) => server.close(() => resolve()));
    await host.stop();
    mockOpenAi.close();
  }
});
