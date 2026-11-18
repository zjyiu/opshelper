import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionStatus } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ConversationServiceError,
  createConversation,
  enqueueExecution,
  openConversationEvents,
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
  autoApprovePermissions: z.boolean().default(false),
  stream: z.boolean().default(false),
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
  enqueueExecution(input: Parameters<typeof enqueueExecution>[0]): Promise<{ id: string; promptMarker: string }>;
  getExecution(userId: string, executionId: string): Promise<{
    id: string;
    userId: string;
    conversationId: string;
    promptMarker: string;
    status: ExecutionStatus;
    error: string | null;
  } | null>;
  readExecutionAnswer: typeof readExecutionAnswer;
  openConversationEvents: typeof openConversationEvents;
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
  openConversationEvents,
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
  const streams = new Set<AbortController>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.abort();
  });
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

  async function executionResult(userId: string, executionId: string, request: FastifyRequest, includeAnswer = true) {
    const execution = await api.getExecution(userId, executionId);
    if (!execution) return { code: 404, body: { message: "Execution not found" } };
    const base = {
      conversationId: execution.conversationId,
      executionId: execution.id,
      status: execution.status.toLowerCase(),
    };
    if (execution.status === "SUCCEEDED") {
      if (!includeAnswer) return { code: 200, body: base };
      let answer: string | null;
      try {
        answer = await api.readExecutionAnswer(userId, execution, Number.POSITIVE_INFINITY);
      } catch (error) {
        request.log.error({ error, executionId }, "Failed to read integration execution answer");
        return { code: 503, body: { ...base, message: "Failed to read execution answer; retry the execution query" } };
      }
      if (answer === null) return { code: 502, body: { ...base, message: "Execution completed without a text answer" } };
      return { code: 200, body: { ...base, answer } };
    }
    if (execution.status === "WAITING_INPUT") {
      return { code: 409, body: { ...base, message: "Execution requires user input or permission in the workspace" } };
    }
    if (["FAILED", "CANCELLED", "INTERRUPTED"].includes(execution.status)) {
      return { code: 502, body: { ...base, message: execution.error ?? "Execution did not complete successfully" } };
    }
    return { code: 202, body: base };
  }

  async function executionResponse(userId: string, executionId: string, request: FastifyRequest, reply: FastifyReply) {
    const result = await executionResult(userId, executionId, request);
    return reply.code(result.code).send(result.body);
  }

  function streamExecution(
    userId: string,
    conversationId: string,
    executionId: string,
    request: FastifyRequest,
    reply: FastifyReply,
    controller: AbortController,
    close: () => void,
    events: AsyncIterable<string>,
  ) {
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const responseMessageId = `assistant-${randomUUID()}`;
    const stream = async function* () {
      const upstream = events[Symbol.asyncIterator]();
      let reading = false;
      let nextResult: { value: IteratorResult<string> } | { error: unknown } | undefined;
      let wake: (() => void) | undefined;
      const textSnapshots = new Map<string, string>();
      const responsePartIds = new Map<string, string>();
      const chunkIds = new Map<string, number>();
      let lastKeepalive = api.now();
      const responsePartId = (sourceKey: string) => {
        let partId = responsePartIds.get(sourceKey);
        if (!partId) {
          partId = `text:${responsePartIds.size}`;
          responsePartIds.set(sourceKey, partId);
        }
        return partId;
      };
      const nextChunkId = (key: string) => {
        const chunkId = (chunkIds.get(key) ?? 0) + 1;
        chunkIds.set(key, chunkId);
        return chunkId;
      };
      const readNext = () => {
        reading = true;
        void upstream.next().then(
          (value) => { nextResult = { value }; wake?.(); },
          (error: unknown) => { nextResult = { error }; wake?.(); },
        );
      };
      try {
        yield frame("accepted", { conversationId, executionId });
        while (!controller.signal.aborted) {
          const current = await api.getExecution(userId, executionId);
          if (!current) {
            yield frame("error", { conversationId, executionId, message: "Execution not found; retry the execution query" });
            return;
          }
          if (!["QUEUED", "DISPATCHING", "RUNNING"].includes(current.status)) {
            const result = await executionResult(userId, executionId, request, false);
            yield frame("result", { conversationId, executionId, ...result.body, httpStatus: result.code });
            return;
          }
          if (!reading) readNext();
          const deadline = api.wait(pollMs, controller.signal).then(() => ({ kind: "poll" as const }));
          while (!controller.signal.aborted) {
            const eventReady = new Promise<{ kind: "event" }>((resolve) => {
              wake = () => resolve({ kind: "event" });
              if (nextResult) wake();
            });
            const outcome = await Promise.race([deadline, eventReady]);
            wake = undefined;
            if (outcome.kind === "poll") {
              if (api.now() - lastKeepalive >= 15_000) {
                lastKeepalive = api.now();
                yield ": keepalive\n\n";
              }
              break;
            }
            const result = nextResult;
            nextResult = undefined;
            reading = false;
            if (!result) throw new Error("Runtime event stream returned no result");
            if ("error" in result) throw result.error;
            if (result.value.done) throw new Error("Runtime event stream ended");
            const value = result.value.value;
            if (value.startsWith("event: text\n")) {
              const payloadLine = value.split("\n").find((line) => line.startsWith("data: "));
              if (payloadLine) {
                const payload = JSON.parse(payloadLine.slice(6)) as { messageId?: unknown; partId?: unknown; text?: unknown };
                if (typeof payload.messageId === "string" && typeof payload.partId === "string" && typeof payload.text === "string") {
                  const sourceKey = `${payload.messageId}:${payload.partId}`;
                  const previous = textSnapshots.get(sourceKey) ?? "";
                  if (payload.text.startsWith(previous)) {
                    const delta = payload.text.slice(previous.length);
                    if (delta) {
                      const partId = responsePartId(sourceKey);
                      const chunkKey = `${responseMessageId}:${partId}`;
                      yield frame("text", {
                        messageId: responseMessageId,
                        partId,
                        chunkId: nextChunkId(chunkKey),
                        delta,
                      });
                    }
                  } else {
                    const partId = responsePartId(sourceKey);
                    const chunkKey = `${responseMessageId}:${partId}`;
                    yield frame("text_replace", {
                      messageId: responseMessageId,
                      partId,
                      chunkId: nextChunkId(chunkKey),
                      text: payload.text,
                    });
                  }
                  textSnapshots.set(sourceKey, payload.text);
                }
              }
            } else if (value.startsWith("event: operation\n")) {
              yield value;
            }
            readNext();
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          request.log.error({ error, executionId }, "Failed to stream integration execution");
          yield frame("error", { conversationId, executionId, message: "Stream interrupted; retry the execution query" });
        }
      } finally {
        controller.abort();
        streams.delete(controller);
        reply.raw.off("close", close);
        if (upstream.return) await upstream.return();
      }
    };
    reply.header("Content-Type", "text/event-stream; charset=utf-8");
    reply.header("Cache-Control", "no-store, no-transform");
    reply.header("X-Accel-Buffering", "no");
    return reply.send(Readable.from(stream()));
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
      const controller = new AbortController();
      const disconnected = () => controller.abort();
      let handedOff = false;
      reply.raw.once("close", disconnected);
      if (parsed.data.stream) streams.add(controller);
      let execution: { id: string; promptMarker: string } | undefined;
      try {
        const scope: { current: { id: string; promptMarker: string } | null } = { current: null };
        const events = parsed.data.stream
          ? await api.openConversationEvents(userId, conversationId, controller.signal, scope)
          : null;
        if (controller.signal.aborted) return;
        execution = await api.enqueueExecution({
          userId,
          conversationId,
          requestKey: randomUUID(),
          leadAgentKey: parsed.data.agentKey,
          text: parsed.data.text,
          attachments: [],
          autoApprovePermissions: parsed.data.autoApprovePermissions,
        });
        if (events) {
          scope.current = execution;
          handedOff = true;
          return streamExecution(userId, conversationId, execution.id, request, reply, controller, disconnected, events);
        }
      } finally {
        if (!handedOff && (parsed.data.stream || controller.signal.aborted || !execution)) {
          controller.abort();
          streams.delete(controller);
          reply.raw.off("close", disconnected);
        }
      }
      if (!execution) return;
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
