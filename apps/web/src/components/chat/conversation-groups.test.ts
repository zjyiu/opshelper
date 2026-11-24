import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationAgent, ConversationSummary } from "@opshelper/shared";

import { getActiveConversationGroupKey, groupConversationsByAgent } from "./conversation-groups";

const agents: ConversationAgent[] = [
  { key: "agent-a", name: "智能体 A", description: "", mode: "all" },
  { key: "agent-b", name: "智能体 B", description: "", mode: "all" },
  { key: "agent-empty", name: "空智能体", description: "", mode: "all" },
];

function conversation(
  id: string,
  leadAgentKey: string,
  updatedAt: string,
  title = id,
): ConversationSummary {
  return {
    id,
    title,
    leadAgentKey,
    recoveryRequired: false,
    recoveryReason: null,
    latestExecutionStatus: null,
    queuePosition: null,
    source: null,
    scheduleName: null,
    pinnedAt: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

test("groups every conversation and defaults to most recently used agent order", () => {
  const groups = groupConversationsByAgent([
    conversation("a-old", "agent-a", "2026-01-01T10:00:00.000Z"),
    conversation("b-latest", "agent-b", "2026-01-03T10:00:00.000Z"),
    conversation("a-latest", "agent-a", "2026-01-02T10:00:00.000Z"),
  ], agents);

  assert.deepEqual(groups.map((group) => group.agentKey), ["agent-b", "agent-a"]);
  assert.deepEqual(groups[0].conversations.map((item) => item.id), ["b-latest"]);
  assert.deepEqual(groups[1].conversations.map((item) => item.id), ["a-latest", "a-old"]);
  assert.equal(groups.some((group) => group.agentKey === "agent-empty"), false);
});

test("uses a saved agent order instead of conversation recency", () => {
  const groups = groupConversationsByAgent([
    conversation("a-old", "agent-a", "2026-01-01T10:00:00.000Z"),
    conversation("b-latest", "agent-b", "2026-01-03T10:00:00.000Z"),
    conversation("a-latest", "agent-a", "2026-01-02T10:00:00.000Z"),
  ], agents, "", ["agent-a", "agent-b"]);

  assert.deepEqual(groups.map((group) => group.agentKey), ["agent-a", "agent-b"]);
});

test("keeps all agent groups collapsed when the active agent has no conversations", () => {
  const groups = groupConversationsByAgent([
    conversation("a-old", "agent-a", "2026-01-01T10:00:00.000Z"),
  ], agents);

  assert.equal(getActiveConversationGroupKey(groups, null, "agent-empty"), null);
});

test("pinned conversations move only within their agent group", () => {
  const pinned = { ...conversation("a-pinned", "agent-a", "2026-01-01T10:00:00.000Z"), pinnedAt: "2026-01-05T10:00:00.000Z" };
  const groups = groupConversationsByAgent([
    pinned,
    conversation("a-new", "agent-a", "2026-01-03T10:00:00.000Z"),
    conversation("b-new", "agent-b", "2026-01-04T10:00:00.000Z"),
  ], agents);
  assert.deepEqual(groups.map((group) => group.agentKey), ["agent-b", "agent-a"]);
  assert.deepEqual(groups[1].conversations.map((item) => item.id), ["a-pinned", "a-new"]);
});

test("filters conversation titles and keeps only groups with matching conversations", () => {
  const groups = groupConversationsByAgent([
    conversation("a-match", "agent-a", "2026-01-01T10:00:00.000Z", "部署检查"),
    conversation("a-latest", "agent-a", "2026-01-04T10:00:00.000Z", "网络巡检"),
    conversation("b-match", "agent-b", "2026-01-03T10:00:00.000Z", "部署发布"),
  ], agents, "部署");

  assert.deepEqual(groups.map((group) => group.agentKey), ["agent-a", "agent-b"]);
  assert.deepEqual(groups.flatMap((group) => group.conversations.map((item) => item.id)), [
    "a-match",
    "b-match",
  ]);
});
