import assert from "node:assert/strict";
import test from "node:test";

import { moveAgentOrder, reconcileAgentOrder } from "./agent-order";

test("initial order follows recent conversations and appends agents without conversations", () => {
  assert.deepEqual(
    reconcileAgentOrder([], ["agent-a", "agent-b", "agent-c"], ["agent-b", "agent-a"]),
    ["agent-b", "agent-a", "agent-c"],
  );
});

test("saved order is kept, removed agents are dropped, and new agents are appended", () => {
  assert.deepEqual(
    reconcileAgentOrder(["agent-b", "removed", "agent-a"], ["agent-a", "agent-b", "agent-c"], ["agent-a", "agent-b"]),
    ["agent-b", "agent-a", "agent-c"],
  );
});

test("dragging an agent moves it before the target without changing other items", () => {
  assert.deepEqual(moveAgentOrder(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveAgentOrder(["a", "b", "c"], "a", "a"), ["a", "b", "c"]);
});
