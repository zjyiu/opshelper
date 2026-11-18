import assert from "node:assert/strict";
import test from "node:test";

import { ConversationOperationProjector } from "./conversation-operations";

test("工具快照只输出精简操作摘要，并在状态变化时更新稳定的操作 ID", () => {
  const projector = new ConversationOperationProjector();
  const command = `deploy --flag value\n${"x".repeat(200)}`;
  const messages = [{
    info: { id: "assistant-1", role: "assistant" },
    parts: [
      { id: "read-1", type: "tool", tool: "read", state: { status: "running", input: { filePath: "/workspace/docs/guide.md" }, output: "private file contents" } },
      { id: "shell-1", type: "tool", tool: "bash", state: { status: "completed", input: { command }, output: "private command output" } },
    ],
  }];
  const first = projector.update(messages);
  assert.deepEqual(first, [
    { id: "operation-1", label: "查看文件", target: "/workspace/docs/guide.md", status: "running" },
    { id: "operation-2", label: "执行命令", target: `${command.slice(0, 159)}…`, status: "completed" },
  ]);
  assert.equal(first[1].target?.length, 160);
  assert.ok(first[1].target?.startsWith("deploy --flag value\n"));
  assert.doesNotMatch(JSON.stringify(first), /private file contents|private command output/);
  assert.deepEqual(projector.update(messages), []);
  messages[0].parts[0].state.status = "completed";
  assert.deepEqual(projector.update(messages), [
    { id: "operation-1", label: "查看文件", target: "/workspace/docs/guide.md", status: "completed" },
  ]);
});
