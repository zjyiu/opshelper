export type ConversationAuthorizations = Record<string, boolean>;

export function conversationAuthorizationStorageKey(userKey: string) {
  return `opshelper:chat-authorization:${encodeURIComponent(userKey)}`;
}

export function parseConversationAuthorizations(raw: string | null): ConversationAuthorizations {
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid conversation authorization settings");
  }
  const entries = Object.entries(parsed);
  if (entries.some(([key, value]) =>
    (!key.startsWith("conversation:") && !key.startsWith("new:")) || typeof value !== "boolean")) {
    throw new Error("Invalid conversation authorization settings");
  }
  return Object.fromEntries(entries);
}

export function moveConversationAuthorization(
  settings: ConversationAuthorizations,
  from: string,
  to: string,
): ConversationAuthorizations {
  const next = { ...settings, [to]: settings[from] ?? true };
  if (from !== to) delete next[from];
  return next;
}
