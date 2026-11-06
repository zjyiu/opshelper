import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationAgent, ConversationSummary } from "@opshelper/shared";

import { groupConversationsByAgent } from "./conversation-groups";

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
    createdAt: updatedAt,
    updatedAt,
  };
}

test("groups every conversation and orders agents by their most recently used conversation", () => {
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
