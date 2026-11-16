import assert from "node:assert/strict";
import test from "node:test";
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
    enqueueExecution: async () => ({ id: "execution" }),
    getExecution: async (userId, id) => userId === "alice" && id === "execution"
      ? { id, userId, conversationId: "conversation", promptMarker: "marker", status: "SUCCEEDED", error: null }
      : null,
    readExecutionAnswer: async () => "完整回答",
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

test("外部对话以 token 用户创建或续接会话并返回完整回答", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerIntegrationRoutes(app, mockServices({
    createConversation: async (input) => { calls.push(["create", input]); return { id: "conversation" }; },
    enqueueExecution: async (input) => { calls.push(["enqueue", input]); return { id: "execution" }; },
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
