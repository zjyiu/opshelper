import assert from "node:assert/strict";
import test from "node:test";

import { InteractionManager } from "./interactions.mjs";

test("InteractionManager queues approvals and settles once / reject / abort cleanly", async () => {
  const changes = [];
  const manager = new InteractionManager({ onChange: (evt) => changes.push(evt) });

  const allowPromise = manager.handleApprovalRequest({
    id: "perm-1",
    agent: { id: "sess-1" },
    toolName: "bash",
    reason: "Run uname -a",
  });
  assert.equal(manager.listPermissions().length, 1);
  assert.equal(manager.listPermissions()[0].permission, "bash");
  assert.equal(manager.replyPermission("sess-1", "perm-1", "once"), true);
  assert.equal(await allowPromise, "allowed-once");
  assert.equal(manager.listPermissions().length, 0);

  const ac = new AbortController();
  const abortPromise = manager.handleApprovalRequest({
    id: "perm-2",
    agent: { id: "sess-1" },
    toolName: "write",
    signal: ac.signal,
  });
  assert.equal(manager.listPermissions().length, 1);
  ac.abort();
  assert.equal(await abortPromise, "cancelled");
  assert.equal(manager.listPermissions().length, 0);
  assert.ok(changes.length >= 4);
});

test("InteractionManager queues user questions and maps replies or cancellations", async () => {
  const manager = new InteractionManager();

  const qPromise = manager.handleQuestionRequest({
    id: "q-req-1",
    agent: { id: "sess-2" },
    questions: [
      { id: "env", question: "Target?", options: [{ label: "prod" }, { label: "staging" }] },
    ],
  });
  assert.equal(manager.listQuestions().length, 1);
  assert.equal(manager.replyQuestion("sess-2", "q-req-1", [["staging"]]), true);
  const answer = await qPromise;
  assert.deepEqual(answer, { answers: [{ id: "env", selected: ["staging"] }] });

  const cancelPromise = manager.handleQuestionRequest({
    id: "q-req-2",
    agent: { id: "sess-2" },
    questions: [{ id: "confirm", question: "Proceed?" }],
  });
  assert.equal(manager.cancelQuestion("sess-2", "q-req-2"), true);
  await assert.rejects(cancelPromise, (err) => err.code === "ASK_ABORTED");
  assert.equal(manager.listQuestions().length, 0);
});
