import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";

import { ConversationServiceError } from "../lib/conversation-service";
import { registerIntegrationRoutes, type IntegrationServices } from "./integration";

function mockServices(overrides: Partial<IntegrationServices> = {}): IntegrationServices {
  let time = 0;
  return {
    requireSession: async (request, reply) => {
      if (request.headers.authorization !== "Bearer session") {
        await reply.code(401).send({ message: "Unauthorized" });
        return null;
      }
      return { id: "alice", username: "alice", name: "Alice", role: "user" };
    },
    listTokens: async () => [],
    createToken: async (_userId, name) => ({ id: "token-id", name, createdAt: new Date(0), token: "secret" }),
    deleteToken: async (userId, id) => userId === "alice" && id === "token-id",
    authenticate: async (token) => token === "api-token" ? "alice" : null,
    createConversation: async () => ({ id: "conversation" }),
    enqueueExecution: async () => ({ id: "execution", promptMarker: "marker" }),
    getExecution: async (userId, id) => userId === "alice" && id === "execution"
      ? { id, userId, conversationId: "conversation", promptMarker: "marker", status: "SUCCEEDED", error: null }
      : null,
    readExecutionAnswer: async () => "完整回答",
    openConversationEvents: async () => (async function* () {})(),
    wait: async (ms) => { time += ms; },
    now: () => time,
    ...overrides,
  };
}

test("API token 管理使用登录会话并按用户撤销，创建时只返回一次密钥", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    createToken: async (userId, name) => {
      calls.push([userId, name]);
      return { id: "token-id", name, createdAt: new Date(0), token: "secret" };
    },
  }));
  try {
    const url = "/v1/users/me/api-tokens";
    assert.equal((await app.inject({ method: "POST", url, headers: { authorization: "Bearer api-token" }, payload: { name: "a" } })).statusCode, 401);
    const created = await app.inject({ method: "POST", url, headers: { authorization: "Bearer session" }, payload: { name: " external " } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers["cache-control"], "no-store");
    assert.equal(created.json().token, "secret");
    assert.deepEqual(calls, [["alice", "external"]]);
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: "Bearer session" } })).json().tokens.length, 0);
    assert.equal((await app.inject({ method: "DELETE", url: `${url}/foreign`, headers: { authorization: "Bearer session" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `${url}/token-id`, headers: { authorization: "Bearer session" } })).statusCode, 204);
  } finally { await app.close(); }
});

test("自动授权可显式启用，其他类型被拒绝", async () => {
  const choices: boolean[] = [];
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    enqueueExecution: async (input) => { choices.push(input.autoApprovePermissions === true); return { id: "execution", promptMarker: "marker" }; },
  }));
  try {
    const headers = { authorization: "Bearer api-token" };
    const url = "/v1/integration/chat";
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { agentKey: "ops", text: "hi", autoApprovePermissions: true } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { agentKey: "ops", text: "hi", autoApprovePermissions: "true" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { agentKey: "ops", text: "hi", stream: "true" } })).statusCode, 400);
    assert.deepEqual(choices, [true]);
  } finally { await app.close(); }
});

test("外部 SSE 在完成前输出本次执行正文并返回最终结果", async () => {
  let status: "QUEUED" | "RUNNING" | "SUCCEEDED" = "QUEUED";
  let stopped = false;
  const calls: unknown[] = [];
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    enqueueExecution: async (input) => { calls.push(input); return { id: "execution", promptMarker: "marker" }; },
    getExecution: async (userId, id) => ({ id, userId, conversationId: "conversation", promptMarker: "marker", status, error: null }),
    wait: async (_ms, signal) => { await delay(20, undefined, { signal }); },
    openConversationEvents: async (userId, conversationId, signal, executionScope) => {
      assert.equal(executionScope?.current, null);
      calls.push({ userId, conversationId, executionScope });
      return (async function* () {
        try {
          yield "event: ready\ndata: {}\n\n";
          yield 'event: text\ndata: {"messageId":"m1","partId":"text:0","text":"你"}\n\n';
          yield 'event: text\ndata: {"messageId":"m1","partId":"text:0","text":"你好"}\n\n';
          yield 'event: text\ndata: {"messageId":"m1","partId":"text:0","text":"你好"}\n\n';
          yield 'event: text\ndata: {"messageId":"m1","partId":"text:0","text":"改写"}\n\n';
          yield 'event: text\ndata: {"messageId":"m2","partId":"text:0","text":"另一段"}\n\n';
          yield 'event: operation\ndata: {"id":"operation-1","label":"读取文件","target":"README.md","status":"completed"}\n\n';
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        } finally { stopped = true; }
      })();
    },
  }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const response = await fetch(`${app.listeningOrigin}/v1/integration/chat`, {
      method: "POST",
      headers: { authorization: "Bearer api-token", "content-type": "application/json" },
      body: JSON.stringify({ agentKey: "ops", text: "hi", stream: true, autoApprovePermissions: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    async function readUntil(value: string) {
      while (!frames.includes(value)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        frames += decoder.decode(chunk.value, { stream: true });
      }
    }
    await readUntil("event: accepted");
    assert.match(frames, /event: accepted\ndata: {"conversationId":"conversation","executionId":"execution"}/);
    status = "RUNNING";
    await readUntil('"delta":"好"');
    await readUntil("event: operation");
    assert.equal((frames.match(/"delta":"你"/g) ?? []).length, 1);
    assert.equal((frames.match(/"delta":"好"/g) ?? []).length, 1);
    const textFrames = [...frames.matchAll(/^event: (text|text_replace)\ndata: (.+)$/gm)]
      .map(([, event, data]) => ({ event, ...JSON.parse(data) as { messageId: string; partId: string; chunkId: number } }));
    assert.equal(new Set(textFrames.map((event) => event.messageId)).size, 1);
    assert.notEqual(textFrames[0].messageId, "m1");
    assert.deepEqual(textFrames.map(({ partId, chunkId }) => [partId, chunkId]), [
      ["text:0", 1],
      ["text:0", 2],
      ["text:0", 3],
      ["text:1", 1],
    ]);
    assert.equal(textFrames[2].event, "text_replace");
    assert.equal((frames.match(/event: operation/g) ?? []).length, 1);
    assert.doesNotMatch(frames, /"text":"你好"/);
    assert.doesNotMatch(frames, /event: status|keepalive/);
    assert.equal(frames.includes("event: result"), false);
    assert.deepEqual(calls[0], { userId: "alice", conversationId: "conversation", executionScope: {
      current: { id: "execution", promptMarker: "marker" },
    } });
    assert.equal((calls[1] as { autoApprovePermissions: boolean }).autoApprovePermissions, true);
    status = "SUCCEEDED";
    await readUntil("event: result");
    assert.match(frames, /"status":"succeeded","httpStatus":200/);
    assert.doesNotMatch(frames, /"answer"/);
    assert.equal((await reader.read()).done, true);
    assert.equal(stopped, true);
  } finally { await app.close(); }
});

test("流连接建立失败不会提交执行", async () => {
  let enqueued = false;
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    openConversationEvents: async () => { throw new ConversationServiceError("实时连接暂不可用", 503); },
    enqueueExecution: async () => { enqueued = true; return { id: "execution", promptMarker: "marker" }; },
  }));
  try {
    const response = await app.inject({
      method: "POST", url: "/v1/integration/chat", headers: { authorization: "Bearer api-token" },
      payload: { agentKey: "ops", text: "hi", stream: true },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(enqueued, false);
  } finally { await app.close(); }
});

test("客户端断开会关闭订阅，但不会取消已受理的执行", async () => {
  let enqueued = false;
  let aborted = false;
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    enqueueExecution: async () => { enqueued = true; return { id: "execution", promptMarker: "marker" }; },
    getExecution: async (userId, id) => ({ id, userId, conversationId: "conversation", promptMarker: "marker", status: "RUNNING", error: null }),
    wait: async (_ms, signal) => { await delay(20, undefined, { signal }); },
    openConversationEvents: async (_userId, _conversationId, signal) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return (async function* () {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })();
    },
  }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const controller = new AbortController();
    const response = await fetch(`${app.listeningOrigin}/v1/integration/chat`, {
      method: "POST",
      headers: { authorization: "Bearer api-token", "content-type": "application/json" },
      body: JSON.stringify({ agentKey: "ops", text: "hi", stream: true }),
      signal: controller.signal,
    });
    assert.match(new TextDecoder().decode((await response.body!.getReader().read()).value), /event: accepted/);
    controller.abort();
    for (let i = 0; i < 100 && !aborted; i++) await delay(10);
    assert.equal(aborted, true);
    assert.equal(enqueued, true);
    const result = await app.inject({ url: "/v1/integration/executions/execution", headers: { authorization: "Bearer api-token" } });
    assert.equal(result.statusCode, 202);
  } finally { await app.close(); }
});

test("外部 SSE 等待交互或流异常时返回执行标识，不伪装成成功", async () => {
  for (const failStream of [false, true]) {
    const app = Fastify();
    await registerIntegrationRoutes(app, mockServices({
      getExecution: async (userId, id) => ({
        id, userId, conversationId: "conversation", promptMarker: "marker",
        status: failStream ? "RUNNING" : "WAITING_INPUT", error: null,
      }),
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); },
      openConversationEvents: async () => (async function* () { throw new Error("offline"); yield ""; })(),
    }));
    try {
      const response = await app.inject({
        method: "POST", url: "/v1/integration/chat", headers: { authorization: "Bearer api-token" },
        payload: { agentKey: "ops", text: "hi", stream: true },
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /"executionId":"execution"/);
      assert.match(response.body, failStream ? /event: error/ : /"status":"waiting_input".*"httpStatus":409/);
    } finally { await app.close(); }
  }
});

test("外部对话以 token 用户创建或续接会话并返回完整回答", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    createConversation: async (input) => { calls.push(["create", input]); return { id: "conversation" }; },
    enqueueExecution: async (input) => { calls.push(["enqueue", input]); return { id: "execution", promptMarker: "marker" }; },
    readExecutionAnswer: async (userId, execution, limit) => {
      calls.push(["answer", userId, execution.id, limit]);
      return "答".repeat(9000);
    },
  }));
  try {
    const url = "/v1/integration/chat";
    const headers = { authorization: "Bearer api-token" };
    assert.equal((await app.inject({ method: "POST", url, payload: { agentKey: "ops", text: "hi" } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { userId: "bob", agentKey: "ops", text: "hi" } })).statusCode, 400);
    const response = await app.inject({ method: "POST", url, headers, payload: { agentKey: "ops", text: " hi " } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().answer.length, 9000);
    assert.equal(response.json().conversationId, "conversation");
    assert.deepEqual(calls[0], ["create", { userId: "alice", leadAgentKey: "ops" }]);
    const enqueue = calls[1] as [string, { userId: string; leadAgentKey: string; autoApprovePermissions: boolean; requestKey: string }];
    assert.equal(enqueue[1].userId, "alice");
    assert.equal(enqueue[1].leadAgentKey, "ops");
    assert.equal(enqueue[1].autoApprovePermissions, false);
    assert.match(enqueue[1].requestKey, /^[a-f0-9-]{36}$/);
    assert.deepEqual(calls[2], ["answer", "alice", "execution", Infinity]);
    calls.length = 0;
    await app.inject({ method: "POST", url, headers, payload: { agentKey: "ops", text: "hi", conversationId: "existing" } });
    assert.equal((calls[0] as [string])[0], "enqueue");
  } finally { await app.close(); }
});

test("超时返回执行 ID 供查询，等待交互和失败不会伪装成成功", async () => {
  let status: "RUNNING" | "WAITING_INPUT" | "FAILED" | "SUCCEEDED" = "RUNNING";
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    getExecution: async (userId, id) => userId === "alice" && id === "execution"
      ? { id, userId, conversationId: "conversation", promptMarker: "marker", status, error: "failed" }
      : null,
    readExecutionAnswer: async () => null,
  }));
  try {
    const headers = { authorization: "Bearer api-token" };
    const response = await app.inject({ method: "POST", url: "/v1/integration/chat", headers, payload: { agentKey: "ops", text: "hi" } });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().executionId, "execution");
    const url = "/v1/integration/executions/execution";
    status = "WAITING_INPUT";
    assert.equal((await app.inject({ url, headers })).statusCode, 409);
    status = "FAILED";
    assert.equal((await app.inject({ url, headers })).statusCode, 502);
    status = "SUCCEEDED";
    assert.equal((await app.inject({ url, headers })).statusCode, 502);
    assert.equal((await app.inject({ url: "/v1/integration/executions/foreign", headers })).statusCode, 404);
    assert.equal((await app.inject({ url, headers: { authorization: "Bearer revoked" } })).statusCode, 401);
  } finally { await app.close(); }
});

test("回答暂不可读时返回执行标识，供客户端安全查询重试", async () => {
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    readExecutionAnswer: async () => { throw new Error("runtime unavailable"); },
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/integration/chat",
      headers: { authorization: "Bearer api-token" },
      payload: { agentKey: "ops", text: "hi" },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().executionId, "execution");
    assert.equal(response.json().conversationId, "conversation");
  } finally { await app.close(); }
});

test("等待期间状态查询失败时返回已受理的执行标识", async () => {
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    getExecution: async () => { throw new Error("database unavailable"); },
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/integration/chat",
      headers: { authorization: "Bearer api-token" },
      payload: { agentKey: "ops", text: "hi" },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().executionId, "execution");
    assert.equal(response.json().conversationId, "conversation");
  } finally { await app.close(); }
});

test("未授权智能体和其他用户的会话沿用现有服务拒绝", async () => {
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    enqueueExecution: async () => { throw new ConversationServiceError("对话不存在", 404); },
    createConversation: async () => { throw new ConversationServiceError("该智能体当前未分配给你", 403); },
  }));
  try {
    const headers = { authorization: "Bearer api-token" };
    const url = "/v1/integration/chat";
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { agentKey: "ops", text: "hi" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { agentKey: "ops", text: "hi", conversationId: "foreign" } })).statusCode, 404);
  } finally { await app.close(); }
});
