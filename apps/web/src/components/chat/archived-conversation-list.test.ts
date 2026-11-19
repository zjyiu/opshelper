import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSummary } from "@opshelper/shared";

import { filterAndSortArchivedConversations } from "./archived-conversation-list";

function conversation(id: string, leadAgentKey: string, archivedAt: string, title = id): ConversationSummary {
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
    archivedAt,
    createdAt: archivedAt,
    updatedAt: archivedAt,
  };
}

test("archive list searches titles, filters by agent, and sorts by archive time", () => {
  const conversations = [
    conversation("older", "network", "2026-01-01T10:00:00.000Z", "网络检查"),
    conversation("newer", "network", "2026-01-03T10:00:00.000Z", "网络修复"),
    conversation("other-agent", "system", "2026-01-02T10:00:00.000Z", "网络检查"),
  ];

  assert.deepEqual(
    filterAndSortArchivedConversations(conversations, { query: " 网络 ", agentKey: "network" })
      .map((item) => item.id),
    ["newer", "older"],
  );
  assert.deepEqual(
    filterAndSortArchivedConversations(conversations, { query: "", agentKey: "" })
      .map((item) => item.id),
    ["newer", "other-agent", "older"],
  );
});
