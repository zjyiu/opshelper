import { readFile } from "node:fs/promises";
import path from "node:path";

const row = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const SUPPORTED_INLINE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * Normalize DSH tool names to the canonical names expected by OpsHelper UI
 * and operation projectors (`bash`, `task`, `skill`, `read`, `write`, `edit`, etc.).
 */
export function normalizeToolName(name) {
  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return "tool";
  const lower = raw.toLowerCase();
  if (lower === "shell" || lower === "bash" || lower === "bash_persistent" || lower === "terminal_bash") {
    return "bash";
  }
  if (lower === "subagent" || lower === "subagent_fork") {
    return "task";
  }
  if (lower === "web_search" || lower === "websearch") {
    return "websearch";
  }
  if (lower === "web_fetch" || lower === "webfetch") {
    return "webfetch";
  }
  return raw;
}

/**
 * Only genuine human prompts (or parent delegation messages for subagent child
 * sessions) should appear as visible user messages in the normalized transcript.
 */
export function isVisibleUserMessageEvent(event, isSubagent = false) {
  if (!event || event.type !== "user/message") return false;
  const sourceKind = row(event.data?.source).kind;
  if (sourceKind === "user") return true;
  if (isSubagent && sourceKind === "agent-message") return true;
  return false;
}

export function assistantMessageId(turn, step) {
  return `assistant:${turn}:${step}`;
}

function parseToolInput(rawArguments, normalizedTool) {
  let parsed = {};
  if (typeof rawArguments === "string" && rawArguments.trim()) {
    try {
      const candidate = JSON.parse(rawArguments);
      parsed = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : { value: candidate };
    } catch {
      parsed = { raw: rawArguments };
    }
  } else if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    parsed = { ...rawArguments };
  }
  if (normalizedTool === "skill" && typeof parsed.name !== "string") {
    const candidateName = parsed.skill ?? parsed.skillName ?? parsed.id;
    if (typeof candidateName === "string" && candidateName) {
      parsed = { ...parsed, name: candidateName };
    }
  }
  if (typeof parsed.file_path === "string" && typeof parsed.filePath !== "string") {
    parsed = { ...parsed, filePath: parsed.file_path };
  }
  return parsed;
}

function extractTextFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function extractSubagentChildSessionId(meta, outputText) {
  const metaObj = row(meta);
  for (const key of ["childSessionId", "sessionId", "sessionID", "agentId"]) {
    if (typeof metaObj[key] === "string" && metaObj[key].trim()) {
      return metaObj[key].trim();
    }
  }
  if (typeof outputText === "string" && outputText) {
    const match = /session-[0-9a-f-]{8,}/i.exec(outputText);
    if (match) return match[0];
  }
  return undefined;
}

function normalizeUserParts(messageId, content) {
  if (!Array.isArray(content)) return [];
  const parts = [];
  content.forEach((block, index) => {
    if (!block || typeof block !== "object") return;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ id: `${messageId}:${index}`, type: "text", text: block.text });
      return;
    }
    if (block.type === "image") {
      const att = row(block.attachment);
      parts.push({
        id: `${messageId}:file:${index}`,
        type: "file",
        filename: typeof att.name === "string" ? att.name : `image-${index}`,
        mime: typeof att.mediaType === "string" ? att.mediaType : "image/png",
        url: typeof att.path === "string" ? `file://${att.path}` : "",
      });
      return;
    }
    if (block.type === "file") {
      const att = row(block.attachment);
      parts.push({
        id: `${messageId}:file:${index}`,
        type: "file",
        filename: typeof att.name === "string" ? att.name : `file-${index}`,
        mime: typeof att.mediaType === "string" ? att.mediaType : "application/octet-stream",
        url: typeof att.path === "string" ? `file://${att.path}` : "",
      });
    }
  });
  return parts;
}

/**
 * Convert DSH durable SessionEvents into OpsHelper's platform-owned message
 * transcript structure (consumed by execution-observation, conversation-service,
 * conversation-operations, and the web UI).
 */
export function normalizeDshEventsToMessages(events, options) {
  const {
    sessionId,
    agentKey,
    isSubagent = false,
  } = options;

  const sorted = [...(Array.isArray(events) ? events : [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const messages = [];
  const toolPartsByCallId = new Map();
  const lastAssistantByTurn = new Map();
  let currentParentId;
  let currentTurn = 0;

  for (const event of sorted) {
    if (!event || typeof event !== "object") continue;
    const data = row(event.data);
    const time = typeof event.time === "number" ? event.time : Date.now();

    if (event.type === "turn/start") {
      if (typeof data.turn === "number") currentTurn = data.turn;
      continue;
    }

    if (isVisibleUserMessageEvent(event, isSubagent)) {
      const id = typeof data.id === "string" && data.id ? data.id : `user:${event.seq ?? messages.length}`;
      currentParentId = id;
      messages.push({
        info: {
          id,
          sessionID: sessionId,
          role: "user",
          time: { created: time },
        },
        parts: normalizeUserParts(id, data.content),
      });
      continue;
    }

    if (event.type === "assistant/message") {
      const turn = typeof data.turn === "number" ? data.turn : currentTurn;
      const step = typeof data.step === "number" ? data.step : 1;
      const msg = row(data.message);
      const id = assistantMessageId(turn, step);
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      let textOrdinal = 0;
      let hasToolCalls = false;

      const parts = [];
      blocks.forEach((block, index) => {
        if (!block || typeof block !== "object") return;
        if (block.type === "text") {
          parts.push({
            id: `text:${textOrdinal++}`,
            sessionID: sessionId,
            messageID: id,
            type: "text",
            text: typeof block.text === "string" ? block.text : "",
            time: { start: time, end: time },
          });
          return;
        }
        if (block.type === "reasoning") {
          parts.push({
            id: `${id}:r:${index}`,
            sessionID: sessionId,
            messageID: id,
            type: "reasoning",
            text: typeof block.text === "string" ? block.text : "",
            time: { start: time, end: time },
          });
          return;
        }
        if (block.type === "tool-call") {
          hasToolCalls = true;
          const normalizedTool = normalizeToolName(block.name);
          const callId = typeof block.id === "string" && block.id ? block.id : `${id}:call:${index}`;
          const part = {
            id: callId,
            sessionID: sessionId,
            messageID: id,
            type: "tool",
            tool: normalizedTool,
            state: {
              status: "running",
              input: parseToolInput(block.arguments, normalizedTool),
              metadata: {},
              time: { start: time },
            },
          };
          toolPartsByCallId.set(callId, part);
          parts.push(part);
        }
      });

      const entry = {
        info: {
          id,
          sessionID: sessionId,
          role: "assistant",
          parentID: currentParentId,
          ...(agentKey ? { agent: agentKey } : {}),
          time: { created: time, completed: time },
          finish: data.interrupted ? "error" : hasToolCalls ? "tool-calls" : "stop",
          ...(data.interrupted ? { error: { message: "Execution interrupted" } } : {}),
          runtimeVersion: 2,
          terminal: false,
        },
        parts,
      };
      messages.push(entry);
      lastAssistantByTurn.set(turn, entry);
      continue;
    }

    if (event.type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : "";
      const existing = callId ? toolPartsByCallId.get(callId) : undefined;
      if (existing) {
        existing.state.status = "running";
        existing.state.time = { ...existing.state.time, start: time };
      }
      continue;
    }

    if (event.type === "tool/result") {
      const resultMsg = row(data.message);
      const callId = typeof resultMsg.toolCallId === "string"
        ? resultMsg.toolCallId
        : typeof row(resultMsg.source).callId === "string"
          ? row(resultMsg.source).callId
          : "";
      const part = callId ? toolPartsByCallId.get(callId) : undefined;
      if (!part) continue;

      const outputText = extractTextFromBlocks(resultMsg.content);
      const isError = Boolean(resultMsg.isError || data.error);
      const errObj = row(data.error);
      const errorText = isError
        ? String(errObj.reason ?? errObj.message ?? (outputText || "Tool execution failed"))
        : undefined;
      const meta = row(data.meta);
      const childSessionId = part.tool === "task"
        ? extractSubagentChildSessionId(meta, outputText)
        : undefined;

      part.state = {
        ...part.state,
        status: isError ? "error" : "completed",
        metadata: {
          ...row(part.state.metadata),
          ...meta,
          ...(childSessionId ? { sessionId: childSessionId } : {}),
        },
        ...(outputText ? { output: outputText } : {}),
        ...(errorText ? { error: errorText } : {}),
        time: { ...row(part.state.time), end: time },
      };
      continue;
    }

    if (event.type === "step/end") {
      const turn = typeof data.turn === "number" ? data.turn : currentTurn;
      const entry = lastAssistantByTurn.get(turn);
      if (entry) {
        entry.info.time = { ...row(entry.info.time), completed: time };
      }
      continue;
    }

    if (event.type === "turn/end") {
      const turn = typeof data.turn === "number" ? data.turn : currentTurn;
      const reason = row(data.reason);
      const kind = typeof reason.kind === "string" ? reason.kind : "completed";
      const succeeded = kind === "completed" || kind === "max-tokens";
      let entry = lastAssistantByTurn.get(turn);

      if (!entry && currentParentId) {
        entry = {
          info: {
            id: assistantMessageId(turn, 0),
            sessionID: sessionId,
            role: "assistant",
            parentID: currentParentId,
            ...(agentKey ? { agent: agentKey } : {}),
            time: { created: time, completed: time },
            runtimeVersion: 2,
            terminal: false,
          },
          parts: [],
        };
        messages.push(entry);
        lastAssistantByTurn.set(turn, entry);
      }

      if (entry) {
        // Close any dangling running tool parts when the turn terminates.
        for (const part of entry.parts) {
          if (part.type === "tool" && part.state?.status === "running") {
            part.state.status = succeeded ? "completed" : "error";
            part.state.time = { ...row(part.state.time), end: time };
          }
        }
        entry.info.terminal = true;
        entry.info.time = { ...row(entry.info.time), completed: time };
        entry.info.finish = succeeded ? "stop" : "error";
        if (!succeeded) {
          const failure = row(reason.error);
          entry.info.error = {
            message: typeof failure.message === "string" && failure.message
              ? failure.message
              : `Execution ${kind}`,
            ...(typeof failure.code === "string" ? { code: failure.code } : {}),
          };
        }
      }
    }
  }

  return messages;
}

/**
 * Stateful mapper that translates live `agent/assistant-stream` frames into
 * OpsHelper's normalized SSE events (`message.updated`, `message.part.updated`,
 * `message.part.delta`), preserving identical `messageID` and `text:<ordinal>`
 * identifiers as `normalizeDshEventsToMessages`.
 */
export function createStreamNormalizer() {
  let seq = 0;
  // Key: `${sessionId}:${attemptId}` -> { messageId, nextTextOrdinal, blockOrdinals: Map<number, number> }
  const attempts = new Map();
  const nextId = () => `dsh-evt-${++seq}`;

  return {
    handleFrame(sessionId, frame) {
      if (!sessionId || !frame || typeof frame !== "object") return [];
      const key = `${sessionId}:${frame.attemptId ?? "default"}`;
      const events = [];

      if (frame.type === "start") {
        const messageId = assistantMessageId(frame.turn ?? 0, frame.step ?? 1);
        attempts.set(key, {
          messageId,
          nextTextOrdinal: 0,
          blockOrdinals: new Map(),
        });
        events.push({
          id: nextId(),
          type: "message.updated",
          properties: {
            sessionID: sessionId,
            info: { id: messageId, sessionID: sessionId, role: "assistant" },
          },
        });
        return events;
      }

      const state = attempts.get(key);
      if (!state) return [];

      if (frame.type === "chunk" && frame.chunk && typeof frame.chunk === "object") {
        const chunk = frame.chunk;
        const ts = typeof frame.time === "number" ? frame.time : Date.now();

        if (chunk.type === "block-start" && chunk.blockType === "text") {
          const ordinal = state.nextTextOrdinal++;
          state.blockOrdinals.set(chunk.index, ordinal);
          events.push({
            id: nextId(),
            type: "message.part.updated",
            properties: {
              sessionID: sessionId,
              part: {
                id: `text:${ordinal}`,
                messageID: state.messageId,
                sessionID: sessionId,
                type: "text",
                text: "",
                time: { start: ts },
              },
            },
          });
          return events;
        }

        if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text.length > 0) {
          let ordinal = state.blockOrdinals.get(chunk.index);
          if (ordinal === undefined) {
            ordinal = state.nextTextOrdinal++;
            state.blockOrdinals.set(chunk.index, ordinal);
            events.push({
              id: nextId(),
              type: "message.part.updated",
              properties: {
                sessionID: sessionId,
                part: {
                  id: `text:${ordinal}`,
                  messageID: state.messageId,
                  sessionID: sessionId,
                  type: "text",
                  text: "",
                  time: { start: ts },
                },
              },
            });
          }
          events.push({
            id: nextId(),
            type: "message.part.delta",
            properties: {
              sessionID: sessionId,
              messageID: state.messageId,
              partID: `text:${ordinal}`,
              field: "text",
              delta: chunk.text,
            },
          });
          return events;
        }

        if (chunk.type === "block-end" && chunk.block?.type === "text") {
          let ordinal = state.blockOrdinals.get(chunk.index);
          if (ordinal === undefined) {
            ordinal = state.nextTextOrdinal++;
            state.blockOrdinals.set(chunk.index, ordinal);
          }
          events.push({
            id: nextId(),
            type: "message.part.updated",
            properties: {
              sessionID: sessionId,
              part: {
                id: `text:${ordinal}`,
                messageID: state.messageId,
                sessionID: sessionId,
                type: "text",
                text: typeof chunk.block.text === "string" ? chunk.block.text : "",
                time: { end: ts },
              },
            },
          });
          return events;
        }

        if (chunk.type === "block-start" && chunk.blockType === "tool-call") {
          events.push({
            id: nextId(),
            type: "session.tool.updated",
            properties: { sessionID: sessionId },
          });
          return events;
        }
      }

      if (frame.type === "end") {
        attempts.delete(key);
        events.push({
          id: nextId(),
          type: "session.step.ended",
          properties: { sessionID: sessionId },
        });
        return events;
      }

      return events;
    },
  };
}

/**
 * Resolve the DSH inclusive `atSeq` boundary to fork strictly BEFORE a given
 * normalized user message ID (`beforeMessageId`).
 *
 * Returns:
 * - `{ kind: "full" }` when `beforeMessageId` is omitted (fork entire history)
 * - `{ kind: "blank" }` when `beforeMessageId` is the first visible user message
 * - `{ kind: "atSeq", atSeq }` for any later user message
 */
export function findForkTargetSeq(events, beforeMessageId, isSubagent = false) {
  if (!beforeMessageId) {
    return { kind: "full" };
  }
  const sorted = [...(Array.isArray(events) ? events : [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  let visibleUserIndex = 0;
  let lastTurnStartSeq = null;
  let sawUserSinceTurnStart = false;

  for (const event of sorted) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "turn/start") {
      lastTurnStartSeq = event.seq;
      sawUserSinceTurnStart = false;
      continue;
    }
    if (isVisibleUserMessageEvent(event, isSubagent)) {
      const id = typeof event.data?.id === "string" && event.data.id
        ? event.data.id
        : `user:${event.seq ?? visibleUserIndex}`;
      if (id === beforeMessageId) {
        if (visibleUserIndex === 0) {
          return { kind: "blank" };
        }
        const cutBefore = !sawUserSinceTurnStart && lastTurnStartSeq !== null
          ? lastTurnStartSeq
          : event.seq;
        const atSeq = cutBefore - 1;
        return atSeq < 0 ? { kind: "blank" } : { kind: "atSeq", atSeq };
      }
      visibleUserIndex += 1;
      sawUserSinceTurnStart = true;
    }
  }

  throw new Error(`找不到要分支的消息标识：${beforeMessageId}`);
}

/**
 * Convert DSH `AskUserQuestionItem[]` to the platform-normalized question shape
 * expected by `conversation-service.ts` and `apps/web`.
 */
export function normalizeQuestionRequest(requestId, sessionId, rawQuestions) {
  const items = Array.isArray(rawQuestions) ? rawQuestions : [];
  return {
    id: String(requestId),
    sessionID: String(sessionId),
    questions: items.map((item) => {
      const options = Array.isArray(item.options)
        ? item.options.map((opt) => ({
            label: String(opt.label),
            ...(typeof opt.description === "string" ? { description: opt.description } : {}),
          }))
        : [];
      return {
        id: String(item.id),
        ...(typeof item.header === "string" ? { header: item.header } : {}),
        question: String(item.question ?? item.header ?? "请确认"),
        options,
        multiple: Boolean(item.multiSelect),
        // Allow free-text custom input unless an approval intent forbids it.
        custom: item.intent?.kind !== "approval",
      };
    }),
  };
}

/**
 * Map OpsHelper's `string[][]` answer matrix back to DSH's `AskUserQuestionAnswer`.
 */
export function mapQuestionAnswersToDsh(rawQuestions, answers) {
  const items = Array.isArray(rawQuestions) ? rawQuestions : [];
  if (!Array.isArray(answers) || answers.length !== items.length) {
    throw new Error("问题回答数量与当前提问不匹配，请刷新后重试");
  }
  return {
    answers: items.map((item, index) => {
      const provided = Array.isArray(answers[index])
        ? answers[index].map((v) => String(v).trim()).filter(Boolean)
        : [];
      const optionLabels = new Set(
        Array.isArray(item.options) ? item.options.map((o) => String(o.label)) : [],
      );
      const selected = [];
      const customParts = [];
      for (const value of provided) {
        if (optionLabels.has(value)) {
          selected.push(value);
        } else {
          customParts.push(value);
        }
      }
      return {
        id: String(item.id),
        selected,
        ...(customParts.length > 0 ? { custom: customParts.join("\n") } : {}),
      };
    }),
  };
}

function inferImageMime(explicitMime, fileNameOrUri) {
  if (typeof explicitMime === "string" && SUPPORTED_INLINE_IMAGE_MIMES.has(explicitMime.toLowerCase())) {
    return explicitMime.toLowerCase();
  }
  const ext = path.extname(String(fileNameOrUri ?? "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "";
}

/**
 * Convert an OpsHelper prompt request payload into DSH `PromptContentPart[]`.
 * Inline raster images under `workspaceRoot` are loaded as base64 image blocks;
 * non-image workspace files are already referenced in the prompt text by OpsHelper.
 */
export async function buildDshPromptContent(payload, workspaceRoot = "/workspace") {
  const body = row(payload);
  const parts = [];
  const textPieces = [];

  if (typeof body.text === "string" && body.text.trim()) {
    textPieces.push(body.text);
  }
  if (Array.isArray(body.parts)) {
    for (const part of body.parts) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        textPieces.push(part.text);
      }
    }
  }
  if (textPieces.length > 0) {
    parts.push({ type: "text", text: textPieces.join("\n\n") });
  }

  const files = Array.isArray(body.files)
    ? body.files
    : Array.isArray(body.parts)
      ? body.parts.filter((part) => part?.type === "file")
      : [];

  const resolvedRoot = path.resolve(workspaceRoot);
  for (const file of files) {
    const uri = typeof file?.uri === "string" ? file.uri : typeof file?.url === "string" ? file.url : "";
    const mime = inferImageMime(file?.mime, file?.name ?? file?.filename ?? uri);
    if (!mime || !uri.startsWith("file://")) continue;

    const candidatePath = path.resolve(decodeURIComponent(uri.slice(7)));
    if (candidatePath !== resolvedRoot && !candidatePath.startsWith(`${resolvedRoot}${path.sep}`)) {
      continue;
    }
    try {
      const bytes = await readFile(candidatePath);
      if (bytes.byteLength > 10 * 1024 * 1024) continue;
      parts.push({
        type: "image",
        mediaType: mime,
        data: bytes.toString("base64"),
        ...(typeof file.name === "string"
          ? { name: file.name }
          : typeof file.filename === "string"
            ? { name: file.filename }
            : {}),
      });
    } catch {
      // Fall back to text reference when file is unreadable.
    }
  }

  return parts;
}
