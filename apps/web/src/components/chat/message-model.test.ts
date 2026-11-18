import assert from "node:assert/strict";
import test from "node:test";
import { fromInitialMessages } from "./message-model";

test("snapshot refreshes retain identities for parts without runtime IDs", () => {
  const snapshot = [
    { info: { id: "first", role: "assistant" }, parts: [
      { type: "text", text: "answer" },
      { type: "text", text: "another part" },
      { id: "runtime-part", type: "text", text: "identified part" },
    ] },
    { info: { id: "second", role: "assistant" }, parts: [{ type: "text", text: "other message" }] },
  ];
  const partIds = () => [...fromInitialMessages(snapshot).values()].map((message) =>
    message.parts.map((part) => part.id));
  const first = partIds();
  assert.deepEqual(partIds(), first);
  assert.equal(first[0][2], "runtime-part");
  assert.equal(new Set(first.flat()).size, 4);
});
