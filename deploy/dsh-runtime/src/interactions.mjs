import { randomUUID } from "node:crypto";

import { mapQuestionAnswersToDsh, normalizeQuestionRequest } from "./normalizer.mjs";

/**
 * Manages in-flight DSH human-in-the-loop interactions (`approval/request` and
 * `user-questions/request` Cordis waterfalls) and exposes query/reply/cancel
 * operations to the HTTP bridge.
 */
export class InteractionManager {
  #permissions = new Map();
  #questions = new Map();
  #onChange;

  constructor(options = {}) {
    this.#onChange = typeof options.onChange === "function" ? options.onChange : () => undefined;
  }

  /**
   * Attach Cordis waterfall listeners to intercept all approval and user
   * question requests across all sessions and in-process subagents.
   */
  attach(ctx) {
    const offApproval = ctx.on("approval/request", (req) => this.handleApprovalRequest(req));
    const offQuestion = ctx.on("user-questions/request", (req) => this.handleQuestionRequest(req));
    return () => {
      offApproval?.();
      offQuestion?.();
      this.disposeAll();
    };
  }

  handleApprovalRequest(req) {
    const id = typeof req?.id === "string" && req.id ? req.id : randomUUID();
    const sessionId = String(req?.agent?.id ?? req?.sessionId ?? "");
    const toolName = typeof req?.toolName === "string" ? req.toolName : "tool";
    const reason = typeof req?.reason === "string" && req.reason.trim() ? req.reason.trim() : undefined;

    if (req?.signal?.aborted) {
      return Promise.resolve("cancelled");
    }

    return new Promise((resolve) => {
      const cleanup = () => {
        if (req?.signal) {
          req.signal.removeEventListener("abort", onAbort);
        }
        this.#permissions.delete(id);
      };

      const settle = (outcome) => {
        if (!this.#permissions.has(id)) return;
        cleanup();
        this.#onChange({
          type: "permission.updated",
          properties: { sessionID: sessionId, id, outcome },
        });
        resolve(outcome);
      };

      const onAbort = () => settle("cancelled");
      if (req?.signal) {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#permissions.set(id, {
        id,
        sessionID: sessionId,
        permission: toolName,
        action: toolName,
        patterns: reason ? [reason] : [],
        resources: reason ? [reason] : [],
        metadata: {
          description: reason ?? toolName,
          ...(req?.callId ? { callId: String(req.callId) } : {}),
        },
        createdAt: Date.now(),
        settle,
      });

      this.#onChange({
        type: "permission.updated",
        properties: { sessionID: sessionId, id },
      });
    });
  }

  handleQuestionRequest(req) {
    const id = typeof req?.id === "string" && req.id
      ? req.id
      : typeof req?.callId === "string" && req.callId
        ? req.callId
        : randomUUID();
    const sessionId = String(req?.agent?.id ?? req?.sessionId ?? "");
    const rawQuestions = Array.isArray(req?.questions) ? req.questions : [];
    const normalized = normalizeQuestionRequest(id, sessionId, rawQuestions);

    if (req?.signal?.aborted) {
      const error = new Error("Question aborted");
      error.code = "ASK_ABORTED";
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (req?.signal) {
          req.signal.removeEventListener("abort", onAbort);
        }
        this.#questions.delete(id);
      };

      const settleAnswer = (dshAnswer) => {
        if (!this.#questions.has(id)) return;
        cleanup();
        this.#onChange({
          type: "question.replied",
          properties: { sessionID: sessionId, id },
        });
        resolve(dshAnswer);
      };

      const settleAbort = (message = "Question cancelled") => {
        if (!this.#questions.has(id)) return;
        cleanup();
        this.#onChange({
          type: "question.cancelled",
          properties: { sessionID: sessionId, id },
        });
        const error = new Error(message);
        error.code = "ASK_ABORTED";
        reject(error);
      };

      const onAbort = () => settleAbort("Question aborted by signal");
      if (req?.signal) {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#questions.set(id, {
        id,
        sessionID: sessionId,
        rawQuestions,
        normalized,
        createdAt: Date.now(),
        settleAnswer,
        settleAbort,
      });

      this.#onChange({
        type: "question.asked",
        properties: { sessionID: sessionId, id },
      });
    });
  }

  listPermissions() {
    return Array.from(this.#permissions.values()).map(({ settle: _settle, ...publicItem }) => publicItem);
  }

  replyPermission(sessionId, permissionId, decision) {
    const entry = this.#permissions.get(permissionId);
    if (!entry || (sessionId && entry.sessionID !== sessionId)) {
      return false;
    }
    const normalized = String(decision ?? "").toLowerCase();
    const outcome = normalized === "once" || normalized === "allow" || normalized === "allowed-once"
      ? "allowed-once"
      : "rejected";
    entry.settle(outcome);
    return true;
  }

  listQuestions() {
    return Array.from(this.#questions.values()).map((entry) => entry.normalized);
  }

  replyQuestion(sessionId, requestId, answers) {
    const entry = this.#questions.get(requestId);
    if (!entry || (sessionId && entry.sessionID !== sessionId)) {
      return false;
    }
    const dshAnswer = mapQuestionAnswersToDsh(entry.rawQuestions, answers);
    entry.settleAnswer(dshAnswer);
    return true;
  }

  cancelQuestion(sessionId, requestId) {
    const entry = this.#questions.get(requestId);
    if (!entry || (sessionId && entry.sessionID !== sessionId)) {
      return false;
    }
    entry.settleAbort("Question cancelled by user");
    return true;
  }

  cancelSessionInteractions(sessionId) {
    for (const entry of [...this.#permissions.values()]) {
      if (entry.sessionID === sessionId) {
        entry.settle("rejected");
      }
    }
    for (const entry of [...this.#questions.values()]) {
      if (entry.sessionID === sessionId) {
        entry.settleAbort("Session cancelled");
      }
    }
  }

  disposeAll() {
    for (const entry of [...this.#permissions.values()]) {
      entry.settle("cancelled");
    }
    for (const entry of [...this.#questions.values()]) {
      entry.settleAbort("Runtime shutting down");
    }
  }
}
