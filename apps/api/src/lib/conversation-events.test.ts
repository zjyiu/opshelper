import assert from "node:assert/strict";
import test from "node:test";

import { ConversationTextProjector, readRuntimeEvents, safeStreamText } from "./conversation-events";

const sessionID = "ses-owned";
const messageID = "msg-answer";
const partID = "part-answer";
function event(type: string, properties: object, id?: string) {
  return { type, properties, ...(id ? { id } : {}) };
}
const info = (role = "assistant") => event("message.updated", { info: { id: messageID, role, sessionID } });
const part = (type = "text", text = "", end?: number) => event("message.part.updated", {
  part: { id: partID, messageID, sessionID, type, text, time: { start: 20, ...(end ? { end } : {}) } },
});
const delta = (text: string, id?: string) => event("message.part.delta", {
  messageID, partID, sessionID, field: "text", delta: text,
}, id);

test("真实增量在终态前输出累计正文，重复事件和最终全文不会重复拼接", () => {
  const projector = new ConversationTextProjector(sessionID, [], 10);
  projector.apply(info());
  projector.apply(part());
  assert.deepEqual(projector.apply(delta("你", "evt-1")), [{ messageId: messageID, partId: partID, text: "你" }]);
  assert.deepEqual(projector.apply(delta("你", "evt-1")), []);
  assert.equal(projector.apply(delta("好", "evt-2"))[0].text, "你好");
  assert.deepEqual(projector.apply(part("text", "你好", 30)), []);
  assert.deepEqual(projector.apply(delta("好", "evt-late")), []);
});

test("先到增量后到part或message元数据时不丢字，也不提前暴露未知类型", () => {
  const projector = new ConversationTextProjector(sessionID, [], 10);
  assert.deepEqual(projector.apply(delta("先到文字")), []);
  assert.deepEqual(projector.apply(part()), []);
  assert.equal(projector.apply(info())[0].text, "先到文字");
});

test("跨会话、用户提示和reasoning不进入正文事件", () => {
  const projector = new ConversationTextProjector(sessionID, [], 10);
  projector.apply(info("user"));
  projector.apply(part());
  assert.deepEqual(projector.apply(delta("内部提示")), []);
  projector.apply(info());
  projector.apply(part("reasoning"));
  assert.deepEqual(projector.apply(delta("内部推理")), []);
  assert.deepEqual(projector.apply(event("message.part.updated", {
    part: { id: "foreign-part", messageID, sessionID: "ses-other", type: "text", text: "他人内容", time: { end: 99 } },
  })), []);
});

test("执行范围未确认时缓存正文，确认后只释放属于该执行的消息", () => {
  const allowed = new Set<string>();
  const projector = new ConversationTextProjector(sessionID, [], 10, (id) => allowed.has(id));
  projector.apply(info());
  projector.apply(part());
  assert.deepEqual(projector.apply(delta("当前回答")), []);
  projector.seed([{
    info: { id: "old", sessionID, role: "assistant", time: { completed: 30 } },
    parts: [{ id: "old-part", type: "text", text: "历史回答", time: { end: 30 } }],
  }]);
  allowed.add(messageID);
  assert.deepEqual(projector.textEvents(), [{ messageId: messageID, partId: partID, text: "当前回答" }]);
  assert.deepEqual(projector.textEvents(), []);
});

test("连接建立期间已持久化的全文不被缓冲增量重复追加", () => {
  const projector = new ConversationTextProjector(sessionID, [], 10);
  projector.seed([{
    info: { id: messageID, sessionID, role: "assistant", time: { completed: 30 } },
    parts: [{ id: partID, type: "text", text: "完整正文", time: { start: 20, end: 30 } }],
  }]);
  assert.deepEqual(projector.apply(part()), []);
  assert.deepEqual(projector.apply(delta("完整正文")), []);
  assert.deepEqual(projector.apply(part("text", "完整正文", 30)), []);
});

test("中途重连不把缺失前缀的增量当成完整正文，最终快照补齐", () => {
  const projector = new ConversationTextProjector(sessionID, [], 25);
  projector.seed([{
    info: { id: messageID, sessionID, role: "assistant" },
    parts: [{ id: partID, type: "text", text: "", time: { start: 20 } }],
  }]);
  assert.deepEqual(projector.apply(delta("剩余后半段")), []);
  assert.equal(projector.apply(part("text", "前半段和剩余后半段", 30))[0].text, "前半段和剩余后半段");
});

test("流式分块不会短暂泄露执行路径或内部标记", () => {
  const raw = "报告：/workspace/outputs/agent1/execution-secret/report.md\n<!-- opshelper-execution:private-marker -->完成";
  for (let end = 1; end <= raw.length; end++) {
    const visible = safeStreamText(raw.slice(0, end), ["execution-secret"], false);
    assert.doesNotMatch(visible, /outputs\/|execution-secret|opshelper-execution|private-marker/);
  }
  assert.equal(safeStreamText(raw, ["execution-secret"], true), "报告：结果文件/report.md完成");
  assert.equal(safeStreamText("正常 ends with out", [], true), "正常 ends with out");
});

test("实时输出保留 Markdown 图片和下载链接路径", () => {
  const path = "/workspace/outputs/network/execution-secret/pagefault.png";
  const text = `[下载 PNG](${path})\n![流程图](${path})\n保存于 ${path}`;
  assert.equal(
    safeStreamText(text, ["execution-secret"], true),
    `[下载 PNG](${path})\n![流程图](${path})\n保存于 结果文件/pagefault.png`,
  );
});

test("实时 Markdown 链接目标在括号闭合前不会被部分脱敏", () => {
  const text = "[下载 PNG](/workspace/outputs/network/execution-secret/pagefault.png)";
  for (let end = 1; end < text.length; end += 1) {
    assert.doesNotMatch(safeStreamText(text.slice(0, end), ["execution-secret"], false), /outputs\//);
  }
  assert.equal(safeStreamText(text, ["execution-secret"], false), text);
});

test("SSE解析支持UTF8及CRLF分块、忽略心跳与坏JSON、退出时取消上游", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"type":"你好"}\r\n\r\ndata: invalid\n\ndata: {"type":"next"}\n\n');
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    },
    cancel() { cancelled = true; },
  });
  const events = [];
  for await (const item of readRuntimeEvents(body)) {
    events.push(item.type);
    if (events.length === 2) break;
  }
  assert.deepEqual(events, ["你好", "next"]);
  assert.equal(cancelled, true);
});
