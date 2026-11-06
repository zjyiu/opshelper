import type { ConversationAgent, ConversationSummary } from "@opshelper/shared";

export interface ConversationGroup {
  agentKey: string;
  agentName: string;
  agentDescription: string;
  conversations: ConversationSummary[];
}

function updatedAtTime(conversation: ConversationSummary) {
  const timestamp = Date.parse(conversation.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function groupConversationsByAgent(
  conversations: readonly ConversationSummary[],
  agents: readonly ConversationAgent[],
  searchTerm = "",
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

  return [...groups.values()]
    .map((group) => ({
      ...group,
      conversations: term
        ? group.conversations.filter((conversation) => conversation.title.toLowerCase().includes(term))
        : group.conversations,
    }))
    .filter((group) => group.conversations.length > 0);
}
