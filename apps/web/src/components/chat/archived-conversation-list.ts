import type { ConversationSummary } from "@opshelper/shared";

export function filterAndSortArchivedConversations(
  conversations: readonly ConversationSummary[],
  filters: { query: string; agentKey: string },
) {
  const query = filters.query.trim().toLocaleLowerCase();
  return conversations
    .filter((conversation) =>
      (!filters.agentKey || conversation.leadAgentKey === filters.agentKey)
      && (!query || conversation.title.toLocaleLowerCase().includes(query)),
    )
    .sort((left, right) =>
      Date.parse(right.archivedAt ?? right.updatedAt) - Date.parse(left.archivedAt ?? left.updatedAt),
    );
}
