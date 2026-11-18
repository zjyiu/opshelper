"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { toast } from "sonner";

import {
  conversationAuthorizationStorageKey,
  moveConversationAuthorization,
  parseConversationAuthorizations,
  type ConversationAuthorizations,
} from "./conversation-authorization";
import {
  conversationDraftStorageKey,
  EMPTY_DRAFT,
  moveConversationDraft,
  parseConversationDrafts,
  serializeConversationDrafts,
  updateConversationDraft,
  type ConversationDraft,
  type ConversationDrafts,
} from "./conversation-drafts";
import type { Attachment } from "./types";

type DraftStore = {
  drafts: ConversationDrafts;
  ready: boolean;
  updateDraft: (key: string, update: (draft: ConversationDraft) => ConversationDraft) => void;
  setDraft: (key: string, draft: ConversationDraft) => void;
  moveDraft: (from: string, to: string) => void;
  authorizations: ConversationAuthorizations;
  setAuthorization: (key: string, enabled: boolean) => void;
  moveAuthorization: (from: string, to: string) => void;
};
const DraftContext = createContext<DraftStore | null>(null);

export function ConversationDraftProvider({ userKey, children }: { userKey: string; children: ReactNode }) {
  const [drafts, setDrafts] = useState<ConversationDrafts>({});
  const [authorizations, setAuthorizations] = useState<ConversationAuthorizations>({});
  const authorizationsRef = useRef<ConversationAuthorizations>({});
  const [ready, setReady] = useState(false);
  const storageKey = conversationDraftStorageKey(userKey);
  const authorizationStorageKey = conversationAuthorizationStorageKey(userKey);
  useEffect(() => {
    try {
      setDrafts(parseConversationDrafts(sessionStorage.getItem(storageKey)));
    } catch {
      // Keep drafts in memory when storage is unavailable.
    }
    try {
      const saved = parseConversationAuthorizations(sessionStorage.getItem(authorizationStorageKey));
      authorizationsRef.current = saved;
      setAuthorizations(saved);
    } catch {
      toast.error("无法读取自动授权设置，请检查当前对话的授权状态。");
    }
    setReady(true);
  }, [authorizationStorageKey, storageKey]);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(storageKey, serializeConversationDrafts(drafts));
    } catch {
      // Quota and private-mode failures must not interrupt editing.
    }
  }, [drafts, ready, storageKey]);

  const updateDraft = useCallback((key: string, update: (draft: ConversationDraft) => ConversationDraft) => {
    setDrafts((current) => updateConversationDraft(current, key, update));
  }, []);
  const setDraft = useCallback((key: string, draft: ConversationDraft) => {
    updateDraft(key, () => draft);
  }, [updateDraft]);
  const moveDraft = useCallback((from: string, to: string) => {
    setDrafts((current) => moveConversationDraft(current, from, to));
  }, []);
  const saveAuthorizations = useCallback((next: ConversationAuthorizations) => {
    authorizationsRef.current = next;
    setAuthorizations(next);
    try {
      sessionStorage.setItem(authorizationStorageKey, JSON.stringify(next));
    } catch {
      toast.error("无法保存自动授权设置，刷新后请重新检查。");
    }
  }, [authorizationStorageKey]);
  const setAuthorization = useCallback((key: string, enabled: boolean) => {
    saveAuthorizations({ ...authorizationsRef.current, [key]: enabled });
  }, [saveAuthorizations]);
  const moveAuthorization = useCallback((from: string, to: string) => {
    saveAuthorizations(moveConversationAuthorization(authorizationsRef.current, from, to));
  }, [saveAuthorizations]);
  const value = useMemo(
    () => ({ drafts, ready, updateDraft, setDraft, moveDraft, authorizations, setAuthorization, moveAuthorization }),
    [drafts, ready, updateDraft, setDraft, moveDraft, authorizations, setAuthorization, moveAuthorization],
  );
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useConversationDraftStore() {
  const store = useContext(DraftContext);
  if (!store) throw new Error("ConversationDraftProvider is required");
  return store;
}

export function useConversationDraft(key: string) {
  const { drafts, updateDraft, ready } = useConversationDraftStore();
  const setInput = useCallback((value: SetStateAction<string>) => {
    updateDraft(key, (draft) => ({ ...draft, input: typeof value === "function" ? value(draft.input) : value }));
  }, [key, updateDraft]);
  const setAttachments = useCallback((value: SetStateAction<Attachment[]>) => {
    updateDraft(key, (draft) => ({ ...draft, attachments: typeof value === "function" ? value(draft.attachments) : value }));
  }, [key, updateDraft]);
  const draft = drafts[key] ?? EMPTY_DRAFT;
  return { ...draft, setInput, setAttachments, ready };
}
