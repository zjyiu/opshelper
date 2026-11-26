import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantMessageId,
  createStreamNormalizer,
  findForkTargetSeq,
  mapQuestionAnswersToDsh,
  normalizeDshEventsToMessages,
  normalizeQuestionRequest,
  normalizeToolName,
} from "./normalizer.mjs";

test("normalizeToolName maps DSH tool names to platform canonical names", () => {
  assert.equal(normalizeToolName("bash"), "bash");
  assert.equal(normalizeToolName("shell"), "bash");
  assert.equal(normalizeToolName("subagent"), "task");
  assert.equal(normalizeToolName("subagent_fork"), "task");
  assert.equal(normalizeToolName("web_search"), "websearch");
  assert.equal(normalizeToolName("web_fetch"), "webfetch");
  assert.equal(normalizeToolName("skill"), "skill");
  assert.equal(normalizeToolName("read"), "read");
});

test("normalizeDshEventsToMessages ignores injected reminders and pairs tool calls with results", () => {
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 1,
      time: 1001,
      data: {
        id: "u1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Check logs <!-- opshelper-execution:exec-1 -->" }],
      },
    },
    {
      type: "user/message",
      seq: 2,
      time: 1002,
      data: {
        id: "sys-rem-1",
        role: "user",
        source: { kind: "runtime-context", form: "catalog" },
        content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }],
      },
    },
    {
      type: "assistant/message",
      seq: 3,
      time: 1010,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "a1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Need to inspect logs" },
            { type: "tool-call", id: "call-1", name: "subagent", arguments: "{\"prompt\":\"inspect\"}" },
          ],
        },
      },
    },
    {
      type: "tool/result",
      seq: 4,
      time: 1020,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          toolCallId: "call-1",
          content: [{ type: "text", text: "Subagent done" }],
          isError: false,
        },
        meta: { childSessionId: "session-child-99" },
      },
    },
    {
      type: "assistant/message",
      seq: 5,
      time: 1030,
      data: {
        turn: 1,
        step: 2,
        message: {
          id: "a2",
          role: "assistant",
          content: [{ type: "text", text: "All logs look healthy." }],
        },
      },
    },
    {
      type: "turn/end",
      seq: 6,
      time: 1040,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];

  const messages = normalizeDshEventsToMessages(events, {
    sessionId: "session-root-1",
    agentKey: "ops-lead",
  });

  assert.equal(messages.length, 3);
  assert.equal(messages[0].info.role, "user");
  assert.equal(messages[0].info.id, "u1");

  // Step 1: intermediate tool call, non-terminal
  assert.equal(messages[1].info.id, assistantMessageId(1, 1));
  assert.equal(messages[1].info.parentID, "u1");
  assert.equal(messages[1].info.terminal, false);
  assert.equal(messages[1].info.finish, "tool-calls");
  assert.equal(messages[1].parts[0].type, "reasoning");
  assert.equal(messages[1].parts[1].type, "tool");
  assert.equal(messages[1].parts[1].tool, "task");
  assert.equal(messages[1].parts[1].state.status, "completed");
  assert.equal(messages[1].parts[1].state.metadata.sessionId, "session-child-99");
  assert.equal(messages[1].parts[1].state.output, "Subagent done");

  // Step 2: final answer, terminal = true
  assert.equal(messages[2].info.id, assistantMessageId(1, 2));
  assert.equal(messages[2].info.parentID, "u1");
  assert.equal(messages[2].info.terminal, true);
  assert.equal(messages[2].info.finish, "stop");
  assert.equal(messages[2].parts[0].id, "text:0");
  assert.equal(messages[2].parts[0].text, "All logs look healthy.");
});

test("normalizeDshEventsToMessages synthesizes terminal error message when turn fails before assistant output", () => {
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 1,
      time: 1001,
      data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Hello" }] },
    },
    {
      type: "turn/end",
      seq: 2,
      time: 1005,
      data: { turn: 1, reason: { kind: "error", error: { message: "Upstream 502", code: "UPSTREAM" } } },
    },
  ];

  const messages = normalizeDshEventsToMessages(events, { sessionId: "s1", agentKey: "ops" });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].info.role, "assistant");
  assert.equal(messages[1].info.terminal, true);
  assert.equal(messages[1].info.finish, "error");
  assert.equal(messages[1].info.error.message, "Upstream 502");
});

test("createStreamNormalizer produces messageID and text ordinals matching persisted history", () => {
  const normalizer = createStreamNormalizer();
  const s1 = normalizer.handleFrame("sess-1", { type: "start", attemptId: "att-1", turn: 2, step: 3 });
  assert.equal(s1[0].type, "message.updated");
  assert.equal(s1[0].properties.info.id, "assistant:2:3");

  // Reasoning block (index 0) should be ignored for text ordinals
  const r1 = normalizer.handleFrame("sess-1", {
    type: "chunk",
    attemptId: "att-1",
    time: 100,
    chunk: { type: "block-start", index: 0, blockType: "reasoning" },
  });
  assert.equal(r1.length, 0);

  // Text block (index 1) gets ordinal 0
  const tStart = normalizer.handleFrame("sess-1", {
    type: "chunk",
    attemptId: "att-1",
    time: 101,
    chunk: { type: "block-start", index: 1, blockType: "text" },
  });
  assert.equal(tStart[0].type, "message.part.updated");
  assert.equal(tStart[0].properties.part.id, "text:0");

  const tDelta = normalizer.handleFrame("sess-1", {
    type: "chunk",
    attemptId: "att-1",
    time: 102,
    chunk: { type: "text-delta", index: 1, text: "Hello " },
  });
  assert.equal(tDelta[0].type, "message.part.delta");
  assert.equal(tDelta[0].properties.messageID, "assistant:2:3");
  assert.equal(tDelta[0].properties.partID, "text:0");
  assert.equal(tDelta[0].properties.delta, "Hello ");

  const tEnd = normalizer.handleFrame("sess-1", {
    type: "chunk",
    attemptId: "att-1",
    time: 103,
    chunk: { type: "block-end", index: 1, block: { type: "text", text: "Hello world" } },
  });
  assert.equal(tEnd[0].type, "message.part.updated");
  assert.equal(tEnd[0].properties.part.text, "Hello world");
  assert.equal(tEnd[0].properties.part.time.end, 103);
});

test("findForkTargetSeq computes blank vs exact inclusive atSeq boundaries", () => {
  const events = [
    { type: "turn/start", seq: 2, data: { turn: 1 } },
    { type: "user/message", seq: 3, data: { id: "u1", source: { kind: "user" }, content: [] } },
    { type: "assistant/message", seq: 4, data: { turn: 1, step: 1, message: { content: [] } } },
    { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", seq: 6, data: { turn: 2 } },
    { type: "user/message", seq: 7, data: { id: "u2", source: { kind: "user" }, content: [] } },
    { type: "turn/end", seq: 8, data: { turn: 2, reason: { kind: "completed" } } },
  ];

  assert.deepEqual(findForkTargetSeq(events, undefined), { kind: "full" });
  assert.deepEqual(findForkTargetSeq(events, "u1"), { kind: "blank" });
  assert.deepEqual(findForkTargetSeq(events, "u2"), { kind: "atSeq", atSeq: 5 });
});

test("question request normalization and answer mapping handle options and custom input", () => {
  const rawQuestions = [
    {
      id: "q1",
      header: "环境",
      question: "选择目标环境",
      options: [{ label: "预发", description: "staging" }, { label: "生产" }],
      multiSelect: false,
    },
    {
      id: "q2",
      question: "补充说明",
      options: [],
      multiSelect: true,
    },
  ];

  const normalized = normalizeQuestionRequest("req-1", "sess-1", rawQuestions);
  assert.equal(normalized.id, "req-1");
  assert.equal(normalized.questions[0].multiple, false);
  assert.equal(normalized.questions[0].custom, true);
  assert.equal(normalized.questions[1].multiple, true);

  const mapped = mapQuestionAnswersToDsh(rawQuestions, [["预发"], ["自定义原因"]]);
  assert.deepEqual(mapped, {
    answers: [
      { id: "q1", selected: ["预发"] },
      { id: "q2", selected: [], custom: "自定义原因" },
    ],
  });
});
