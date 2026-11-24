import type { ConversationAgent, ConversationSummary } from "@opshelper/shared";

export interface ConversationGroup {
  agentKey: string;
  agentName: string;
  agentDescription: string;
  conversations: ConversationSummary[];
}

export function getActiveConversationGroupKey(
  groups: readonly ConversationGroup[],
  activeConversationId: string | null,
  activeAgentKey: string | null,
) {
  return groups.find((group) =>
    group.conversations.some((conversation) => conversation.id === activeConversationId))?.agentKey
    ?? groups.find((group) => group.agentKey === activeAgentKey)?.agentKey
    ?? null;
}

function updatedAtTime(conversation: ConversationSummary) {
  const timestamp = Date.parse(conversation.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function groupConversationsByAgent(
  conversations: readonly ConversationSummary[],
  agents: readonly ConversationAgent[],
  searchTerm = "",
  agentOrder: readonly string[] = [],
): ConversationGroup[] {
  const agentDetails = new Map(agents.map((agent) => [agent.key, agent]));
  const term = searchTerm.trim().toLowerCase();
  const sortedConversations = [...conversations].sort(
    (left, right) => updatedAtTime(right) - updatedAtTime(left),
  );
  const groups = new Map<string, ConversationGroup>();

  for (const conversation of sortedConversations) {
    let group = groups.get(conversation.leadAgentKey);
    if (!group) {
      const agent = agentDetails.get(conversation.leadAgentKey);
      group = {
        agentKey: conversation.leadAgentKey,
        agentName: agent?.name ?? conversation.leadAgentKey,
        agentDescription: agent?.description ?? "",
        conversations: [],
      };
      groups.set(conversation.leadAgentKey, group);
    }
    group.conversations.push(conversation);
  }

  const agentPositions = new Map(agentOrder.map((key, index) => [key, index]));
  return [...groups.values()]
    .map((group) => ({
      ...group,
      conversations: (term
        ? group.conversations.filter((conversation) => conversation.title.toLowerCase().includes(term))
        : group.conversations).sort((left, right) => {
          if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
          if (left.pinnedAt && right.pinnedAt) return Date.parse(right.pinnedAt) - Date.parse(left.pinnedAt);
          return updatedAtTime(right) - updatedAtTime(left);
        }),
    }))
    .filter((group) => group.conversations.length > 0)
    .sort((left, right) =>
      (agentPositions.get(left.agentKey) ?? Number.MAX_SAFE_INTEGER)
      - (agentPositions.get(right.agentKey) ?? Number.MAX_SAFE_INTEGER));
}
