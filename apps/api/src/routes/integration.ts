import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionStatus } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ConversationServiceError,
  createConversation,
  enqueueExecution,
  readExecutionAnswer,
} from "../lib/conversation-service";
import { prisma } from "../lib/prisma";
import { extractBearerToken, requireSession } from "../lib/session";
import { authenticateUserApiToken, createUserApiToken } from "../lib/user-api-token";

const tokenSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const chatSchema = z.object({
  agentKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  text: z.string().trim().min(1).max(100_000),
  conversationId: z.string().min(1).max(128).optional(),
}).strict();
const identifier = z.string().min(1).max(128);
const waitMs = 45_000;
const pollMs = 1_000;

export interface IntegrationServices {
  requireSession: typeof requireSession;
  listTokens(userId: string): Promise<Array<{ id: string; name: string; createdAt: Date }>>;
  createToken(userId: string, name: string): Promise<{ id: string; name: string; createdAt: Date; token: string }>;
  deleteToken(userId: string, id: string): Promise<boolean>;
  authenticate(token: string): Promise<string | null>;
  createConversation(input: Parameters<typeof createConversation>[0]): Promise<{ id: string }>;
  enqueueExecution(input: Parameters<typeof enqueueExecution>[0]): Promise<{ id: string }>;
  getExecution(userId: string, executionId: string): Promise<{
    id: string;
    userId: string;
    conversationId: string;
    promptMarker: string;
    status: ExecutionStatus;
    error: string | null;
  } | null>;
  readExecutionAnswer: typeof readExecutionAnswer;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

const services: IntegrationServices = {
  requireSession,
  async listTokens(userId: string) {
    return prisma.userApiToken.findMany({
      where: { userId },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  },
  createToken: createUserApiToken,
  async deleteToken(userId: string, id: string) {
    return (await prisma.userApiToken.deleteMany({ where: { id, userId } })).count > 0;
  },
  authenticate: authenticateUserApiToken,
  createConversation,
  enqueueExecution,
  async getExecution(userId: string, executionId: string) {
    return prisma.execution.findFirst({
      where: { id: executionId, userId },
      select: { id: true, userId: true, conversationId: true, promptMarker: true, status: true, error: true },
    });
  },
  readExecutionAnswer,
  wait: (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }),
  now: () => Date.now(),
};

async function tokenUser(request: FastifyRequest, reply: FastifyReply, api: IntegrationServices) {
  const token = extractBearerToken(request.headers.authorization);
  const userId = token ? await api.authenticate(token) : null;
  if (!userId) {
    await reply.code(401).send({ message: "Invalid or revoked API token" });
    return null;
  }
  return userId;
}

function serviceError(error: unknown, reply: FastifyReply) {
  if (error instanceof ConversationServiceError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  throw error;
}

export async function registerIntegrationRoutes(app: FastifyInstance, api: IntegrationServices = services) {
  app.get("/v1/users/me/api-tokens", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await api.requireSession(request, reply);
    if (!user) return;
    return { tokens: await api.listTokens(user.id) };
  });

  app.post("/v1/users/me/api-tokens", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await api.requireSession(request, reply);
    if (!user) return;
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Invalid token name" });
    return reply.code(201).send(await api.createToken(user.id, parsed.data.name));
  });

  app.delete<{ Params: { tokenId: string } }>("/v1/users/me/api-tokens/:tokenId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await api.requireSession(request, reply);
    if (!user) return;
    if (!identifier.safeParse(request.params.tokenId).success) return reply.code(400).send({ message: "Invalid token ID" });
    if (!await api.deleteToken(user.id, request.params.tokenId)) {
      return reply.code(404).send({ message: "Token not found" });
    }
    return reply.code(204).send();
  });

  async function executionResponse(userId: string, executionId: string, request: FastifyRequest, reply: FastifyReply) {
    const execution = await api.getExecution(userId, executionId);
    if (!execution) return reply.code(404).send({ message: "Execution not found" });
    const base = {
      conversationId: execution.conversationId,
      executionId: execution.id,
      status: execution.status.toLowerCase(),
    };
    if (execution.status === "SUCCEEDED") {
      let answer: string | null;
      try {
        answer = await api.readExecutionAnswer(userId, execution, Number.POSITIVE_INFINITY);
      } catch (error) {
        request.log.error({ error, executionId }, "Failed to read integration execution answer");
        return reply.code(503).send({ ...base, message: "Failed to read execution answer; retry the execution query" });
      }
      if (answer === null) return reply.code(502).send({ ...base, message: "Execution completed without a text answer" });
      return reply.send({ ...base, answer });
    }
    if (execution.status === "WAITING_INPUT") {
      return reply.code(409).send({ ...base, message: "Execution requires user input or permission in the workspace" });
    }
    if (["FAILED", "CANCELLED", "INTERRUPTED"].includes(execution.status)) {
      return reply.code(502).send({ ...base, message: execution.error ?? "Execution did not complete successfully" });
    }
    return reply.code(202).send(base);
  }

  app.post("/v1/integration/chat", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = await tokenUser(request, reply, api);
    if (!userId) return;
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Invalid chat payload" });
    try {
      const conversationId = parsed.data.conversationId ?? (await api.createConversation({
        userId,
        leadAgentKey: parsed.data.agentKey,
      })).id;
      const execution = await api.enqueueExecution({
        userId,
        conversationId,
        requestKey: randomUUID(),
        leadAgentKey: parsed.data.agentKey,
        text: parsed.data.text,
        attachments: [],
        autoApprovePermissions: false,
      });
      const controller = new AbortController();
      const disconnected = () => controller.abort();
      reply.raw.once("close", disconnected);
      try {
        const deadline = api.now() + waitMs;
        while (!controller.signal.aborted && api.now() < deadline) {
          const current = await api.getExecution(userId, execution.id);
          if (!current) return reply.code(404).send({ message: "Execution not found" });
          if (!["QUEUED", "DISPATCHING", "RUNNING"].includes(current.status)) {
            return await executionResponse(userId, execution.id, request, reply);
          }
          await api.wait(Math.min(pollMs, deadline - api.now()), controller.signal);
        }
        if (controller.signal.aborted) return;
        return await executionResponse(userId, execution.id, request, reply);
      } catch (error) {
        if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") return;
        request.log.error({ error, executionId: execution.id }, "Failed to wait for integration execution");
        return reply.code(503).send({
          conversationId,
          executionId: execution.id,
          message: "Failed to check execution; retry the execution query",
        });
      } finally {
        reply.raw.off("close", disconnected);
      }
    } catch (error) {
      return serviceError(error, reply);
    }
  });

  app.get<{ Params: { executionId: string } }>("/v1/integration/executions/:executionId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = await tokenUser(request, reply, api);
    if (!userId) return;
    if (!identifier.safeParse(request.params.executionId).success) return reply.code(400).send({ message: "Invalid execution ID" });
    try {
      return await executionResponse(userId, request.params.executionId, request, reply);
    } catch (error) {
      return serviceError(error, reply);
    }
  });
}
