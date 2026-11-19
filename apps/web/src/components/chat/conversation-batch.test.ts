import assert from "node:assert/strict";
import test from "node:test";
import { runConversationBatch, toggleConversationSelection } from "./conversation-batch";

test("agent and all selection include conversations outside the currently open group", () => {
  let selected = toggleConversationSelection(new Set(["a1"]), ["a1", "a2"]);
  assert.deepEqual([...selected], ["a1", "a2"]);
  selected = toggleConversationSelection(selected, ["a1", "a2", "b1"]);
  assert.deepEqual([...selected], ["a1", "a2", "b1"]);
  selected = toggleConversationSelection(selected, ["a1", "a2"]);
  assert.deepEqual([...selected], ["b1"]);
  selected = toggleConversationSelection(selected, ["a1", "a2", "b1"]);
  selected = toggleConversationSelection(selected, ["a1", "a2", "b1"]);
  assert.equal(selected.size, 0);
});

test("batch continues past busy or failed conversations and retains their errors", async () => {
  const visited: string[] = [];
  const items = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];
  const failures = await runConversationBatch(items, async (id) => {
    visited.push(id);
    if (id === "b") throw new Error("正在执行");
  });
  assert.deepEqual(visited, ["a", "b", "c"]);
  assert.deepEqual(failures, [{ id: "b", title: "B", message: "正在执行" }]);
});
