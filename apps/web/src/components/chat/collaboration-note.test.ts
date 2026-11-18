import assert from "node:assert/strict";
import test from "node:test";

import { collaborationNote, nextCollaborationPanelOpen } from "./collaboration-note";

test("collaborationNote returns null when nothing is collaborating", () => {
  assert.equal(collaborationNote([]), null);
});

test("collaborationNote reports a running count while children work", () => {
  assert.deepEqual(
    collaborationNote([{ status: "running" }, { status: "completed" }]),
    { tone: "running", label: "1 项执行中" },
  );
});

test("collaborationNote prefers failures over running work", () => {
  assert.deepEqual(
    collaborationNote([{ status: "running" }, { status: "failed" }, { status: "failed" }]),
    { tone: "failed", label: "2 项失败" },
  );
});

test("collaborationNote surfaces waiting children ahead of running ones", () => {
  assert.deepEqual(
    collaborationNote([{ status: "waiting_input" }, { status: "running" }]),
    { tone: "waiting", label: "1 项等待回答" },
  );
});

test("collaborationNote distinguishes simultaneous questions and permissions", () => {
  assert.deepEqual(
    collaborationNote([{ status: "waiting_input" }, { status: "waiting_permission" }, { status: "running" }]),
    { tone: "waiting", label: "1 项等待回答，1 项等待授权" },
  );
});

test("collaborationNote reports completion when every child settled", () => {
  assert.deepEqual(
    collaborationNote([{ status: "completed" }, { status: "completed" }]),
    { tone: "completed", label: "全部已完成" },
  );
});

test("collaboration panel expands during work, collapses when work settles, and reopens for a new child", () => {
  assert.equal(nextCollaborationPanelOpen(null, ["child-1"], false), true);
  assert.equal(nextCollaborationPanelOpen(["child-1"], [], true), false);
  assert.equal(nextCollaborationPanelOpen([], ["child-2"], false), true);
});

test("collaboration panel preserves a manual collapse until another child starts", () => {
  assert.equal(nextCollaborationPanelOpen(["child-1"], ["child-1"], false), false);
  assert.equal(nextCollaborationPanelOpen(["child-1"], ["child-1", "child-2"], false), true);
});

test("refreshing settled collaborations preserves a manually reopened panel", () => {
  assert.equal(nextCollaborationPanelOpen([], [], true), true);
  assert.equal(nextCollaborationPanelOpen([], [], false), false);
});

test("completion does not close the panel while the user is scrolling its contents", () => {
  assert.equal(nextCollaborationPanelOpen(["child-1"], [], true, true), true);
  assert.equal(nextCollaborationPanelOpen([], [], true, true), true);
  assert.equal(nextCollaborationPanelOpen([], ["child-2"], false), true);
  assert.equal(nextCollaborationPanelOpen(["child-2"], [], true), false);
});
