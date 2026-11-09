"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatModelOption,
  ConversationAgent,
  ConversationSnapshot,
  ExecutionSummary,
} from "@opshelper/shared";

import {
  abortExecution,
  createConversation,
  createExecution,
  forkConversation,
  getChatModels,
  getConversation,
  reconcileExecution,
  replyExecutionPermission,
  replyExecutionQuestion,
} from "@/lib/browser-api";
import { useWorkspace, WorkspaceMenuButton } from "../workspace-shell";
import { uploadFile, type FileInfo } from "../file-manager/utils";
import { AgentMark, type Assistant } from "./assistant";
import { AttachmentPanel } from "./attachment-panel";
import { CollaborationBar } from "./collaboration-bar";
import { Composer } from "./composer";
import { Conversation } from "./conversation";
import { useConversationDraft, useConversationDraftStore } from "./conversation-draft-provider";
import { conversationDraftKey } from "./conversation-drafts";
import { resolveConversationSurface } from "./conversation-surface";
import {
  createConversationStreamState,
  mergeStreamMessages,
  receiveStreamText,
  settleStreamSnapshot,
} from "./conversation-stream";
import { guessMime, messageSignature } from "./format";
import { IconClose } from "./icons";
import { PermissionCard, QuestionCard } from "./interaction-cards";
import { fromInitialMessages, sortedMessages, type ChatMessage } from "./message-model";
import { resolveNewConversationRequest } from "./new-conversation-request";
import {
  nextExpectedMatchCount,
  pendingOptimisticMessages,
  pruneConfirmedOptimisticMessages,
  type OptimisticMessage,
} from "./optimistic-messages";
import type { Attachment, MentionFile } from "./types";

const ACTIVE_STATUSES: ExecutionSummary["status"][] = [
  "queued",
  "dispatching",
  "running",
  "waiting_input",
];
const CHAT_MODEL_KEY = "opshelper:model";
const CHAT_UPLOAD_DIR = "chat-uploads";

function createClientId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  if (typeof webCrypto?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    webCrypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(36)).join("-");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export interface ChatAppProps {
  directory: string;
  defaultModel: string;
  models?: ChatModelOption[];
}

function asAssistant(agent: ConversationAgent): Assistant {
  return {
    id: agent.key,
    agent: agent.key,
    name: agent.name,
    description: agent.description,
  };
}

function requestSignature(
  conversationId: string,
  agentKey: string,
  text: string,
  attachments: Attachment[],
  model: string,
  autoApprovePermissions: boolean,
) {
  return JSON.stringify({
    conversationId,
    agentKey,
    text,
    attachments: attachments
      .filter((item) => item.status === "ready")
      .map((item) => [item.path, item.filename, item.mime]),
    model,
    autoApprovePermissions,
  });
}

function optimisticMessage(
  clientId: string,
  text: string,
  attachments: Attachment[],
): ChatMessage {
  return {
    id: `optimistic-${clientId}`,
    role: "user",
    order: Number.MAX_SAFE_INTEGER,
    parts: [
      ...(text.trim() ? [{
        id: `optimistic-text-${clientId}`,
        type: "text",
        text,
        raw: { type: "text", text },
      }] : []),
      ...attachments.map((attachment, index) => ({
        id: `optimistic-file-${clientId}-${index}`,
        type: "file",
        text: "",
        raw: {
          type: "file",
          filename: attachment.filename,
          mime: attachment.mime,
          url: `file://${attachment.path}`,
        },
      })),
    ],
  };
}

export function ChatApp({ directory, defaultModel, models = [] }: ChatAppProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    activeAgent,
    activeConversationId,
    loading,
    executionBlockedReason,
    newConversationRequest,
    acknowledgeNewConversationRequest,
    refreshHome,
    activateConversation,
    updateConversation,
  } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const requestedConversationId = searchParams.get("conversation");
  const navigating = requestedConversationId
    ? requestedConversationId !== activeConversationId
    : searchParams.has("new") && activeConversationId !== null;
  const draftKey = conversationDraftKey(activeConversationId, activeAgent?.key ?? null);
  const { input, attachments, setInput, setAttachments, ready: draftsReady } = useConversationDraft(draftKey);
  const { drafts, setDraft, updateDraft, moveDraft } = useConversationDraftStore();
  const failedDraftPrefix = `${conversationDraftKey(null, activeAgent?.key ?? null)}:failed:`;
  const failedDrafts = Object.entries(drafts).filter(([key]) => key.startsWith(failedDraftPrefix));
  const [availableModels, setAvailableModels] = useState(models);
  const [model, setModel] = useState(defaultModel);
  const [notice, setNotice] = useState<string | null>(null);
  const [referenceFilesOpen, setReferenceFilesOpen] = useState(false);
  const closeReferenceFiles = useCallback(() => setReferenceFilesOpen(false), []);
  // 首屏示例只能把文字放进草稿，输入框得自己抬起来；每次点击递增一次信号。
  const [composerFocus] = useState(0);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false);
  const [failedConversationId, setFailedConversationId] = useState<string | null>(null);
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [streamState, setStreamState] = useState(() => createConversationStreamState(null));
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<{ conversationId: string; cleanupWarning?: string } | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const activeConversationRef = useRef<string | null>(null);
  const pendingRequestRef = useRef<{ signature: string; requestKey: string } | null>(null);
  const optimisticMessagesRef = useRef<OptimisticMessage[]>([]);
  const sendingRef = useRef(false);
  const forkingRef = useRef(false);
  const conversationGenerationRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const appliedRefreshSequenceRef = useRef(0);
  const streamStateRef = useRef(streamState);
  const streamConnectionRef = useRef<{
    conversationId: string;
    source: EventSource;
    ready: boolean;
  } | null>(null);
  const streamReadyWaitersRef = useRef(new Set<{
    conversationId: string;
    finish: () => void;
  }>());

  const updateOptimisticMessages = useCallback((
    update: (current: OptimisticMessage[]) => OptimisticMessage[],
  ) => {
    setOptimisticMessages((current) => {
      const next = update(current);
      optimisticMessagesRef.current = next;
      return next;
    });
  }, []);

  const refreshConversation = useCallback(async (conversationId: string, quiet = false) => {
    const generation = conversationGenerationRef.current;
    const sequence = ++refreshSequenceRef.current;
    const requestRevision = streamStateRef.current.revision;
    try {
      const next = await getConversation(conversationId);
      if (activeConversationRef.current !== conversationId ||
          generation !== conversationGenerationRef.current ||
          sequence < appliedRefreshSequenceRef.current) return null;
      appliedRefreshSequenceRef.current = sequence;
      const settled = settleStreamSnapshot(
        streamStateRef.current,
        conversationId,
        sortedMessages(fromInitialMessages(next.messages)),
        requestRevision,
        !sendingRef.current && next.executions.length > 0 &&
          !next.executions.some((execution) => ACTIVE_STATUSES.includes(execution.status)),
      );
      streamStateRef.current = settled;
      setStreamState(settled);
      setSnapshot(next);
      setFailedConversationId(null);
      updateConversation(next.conversation);
      setSnapshotUnavailable(false);
      return next;
    } catch (error) {
      if (activeConversationRef.current !== conversationId ||
          generation !== conversationGenerationRef.current ||
          sequence < appliedRefreshSequenceRef.current) return null;
      if (!quiet) setNotice(error instanceof Error ? error.message : "对话加载失败");
      if (!quiet) setFailedConversationId(conversationId);
      setSnapshotUnavailable(true);
      return null;
    }
  }, [updateConversation]);

  const waitForStreamReady = useCallback((conversationId: string) => {
    const connection = streamConnectionRef.current;
    if (connection?.conversationId === conversationId && connection.ready) return Promise.resolve();
    // Establish the subscription before sending, including a newly created
    // conversation. A broken stream must not block the polling fallback.
    return new Promise<void>((resolve) => {
      const waiter = { conversationId, finish: () => {} };
      const timer = setTimeout(() => waiter.finish(), 2500);
      waiter.finish = () => {
        clearTimeout(timer);
        streamReadyWaitersRef.current.delete(waiter);
        resolve();
      };
      streamReadyWaitersRef.current.add(waiter);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Refresh client-side route-cache data after model settings may have changed.
    void getChatModels().then((settings) => {
      if (cancelled) return;
      setAvailableModels(settings.models);
      setModel((current) =>
        settings.models.some((item) => item.model === current)
          ? current
          : settings.defaultModel,
      );
    }).catch((error) => {
      if (!cancelled) {
        toast.error(error instanceof Error ? `加载模型列表失败：${error.message}` : "加载模型列表失败");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const savedModel = localStorage.getItem(CHAT_MODEL_KEY);
      if (savedModel && availableModels.some((item) => item.model === savedModel)) setModel(savedModel);
    } catch {
      // Browser storage may be unavailable.
    }
  }, [availableModels]);

  useEffect(() => {
    conversationGenerationRef.current += 1;
    activeConversationRef.current = activeConversationId;
    const empty = createConversationStreamState(activeConversationId);
    streamStateRef.current = empty;
    setStreamState(empty);
    setSnapshot(null);
    setSnapshotUnavailable(false);
    setFailedConversationId(null);
    setStreamDisconnected(false);
    if (activeConversationId) void refreshConversation(activeConversationId);
  }, [activeConversationId, refreshConversation]);

  useEffect(() => {
    if (!newConversationRequest || !draftsReady) return;
    const action = resolveNewConversationRequest(newConversationRequest, activeConversationId);
    if (action === "ignore") return;
    acknowledgeNewConversationRequest(newConversationRequest.id);
    if (action === "discard") return;
    conversationGenerationRef.current += 1;
    activeConversationRef.current = null;
    streamConnectionRef.current?.source.close();
    streamConnectionRef.current = null;
    const empty = createConversationStreamState(null);
    streamStateRef.current = empty;
    setStreamState(empty);
    setSnapshot(null);
    setSnapshotUnavailable(false);
    setFailedConversationId(null);
    setStreamDisconnected(false);
    // Reopening the blank conversation restores its own draft; explicit prefills replace it.
    if (newConversationRequest.prefill) {
      setDraft(draftKey, { input: newConversationRequest.prefill, attachments: [] });
    }
    setNotice(null);
  }, [acknowledgeNewConversationRequest, activeConversationId, draftKey, draftsReady, newConversationRequest, setDraft]);

  useEffect(() => {
    if (executionBlockedReason) setNotice(executionBlockedReason);
  }, [executionBlockedReason]);

  const hasActiveExecution = useMemo(
    () => snapshot?.executions.some((item) => ACTIVE_STATUSES.includes(item.status)) ?? false,
    [snapshot],
  );

  useEffect(() => {
    if (!activeConversationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (cancelled) return;
      await refreshConversation(activeConversationId, true);
      if (!cancelled) timer = setTimeout(poll, hasActiveExecution ? 1000 : 5000);
    };
    timer = setTimeout(poll, hasActiveExecution ? 1000 : 5000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeConversationId, hasActiveExecution, refreshConversation]);

  useEffect(() => {
    if (!activeConversationId) return;
    const conversationId = activeConversationId;
    const generation = conversationGenerationRef.current;
    const source = new EventSource(`/v1/conversations/${encodeURIComponent(conversationId)}/events`);
    const connection = { conversationId, source, ready: false };
    streamConnectionRef.current = connection;
    let cancelled = false;
    let frame: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;
    let refreshAgain = false;
    const isCurrent = () => !cancelled && activeConversationRef.current === conversationId &&
      conversationGenerationRef.current === generation;
    const refresh = async () => {
      refreshTimer = null;
      if (!isCurrent()) return;
      refreshing = true;
      await refreshConversation(conversationId, true);
      refreshing = false;
      if (refreshAgain && isCurrent()) {
        refreshAgain = false;
        scheduleRefresh();
      }
    };
    const scheduleRefresh = () => {
      if (!isCurrent()) return;
      if (refreshing) {
        refreshAgain = true;
      } else if (refreshTimer === null) {
        refreshTimer = setTimeout(() => void refresh(), 100);
      }
    };
    source.addEventListener("text", (event) => {
      if (!isCurrent()) return;
      let payload: unknown;
      try {
        payload = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        return;
      }
      const next = receiveStreamText(streamStateRef.current, conversationId, payload);
      if (next === streamStateRef.current) return;
      streamStateRef.current = next;
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (isCurrent()) setStreamState(streamStateRef.current);
        });
      }
    });
    source.addEventListener("ready", () => {
      if (!isCurrent()) return;
      connection.ready = true;
      setStreamDisconnected(false);
      for (const waiter of streamReadyWaitersRef.current) {
        if (waiter.conversationId === conversationId) waiter.finish();
      }
      scheduleRefresh();
    });
    source.addEventListener("changed", scheduleRefresh);
    source.onerror = () => {
      if (!isCurrent()) return;
      connection.ready = false;
      setStreamDisconnected(true);
      scheduleRefresh();
    };
    return () => {
      cancelled = true;
      source.close();
      if (streamConnectionRef.current === connection) streamConnectionRef.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
  }, [activeConversationId, refreshConversation, streamGeneration]);

  useEffect(() => () => {
    for (const waiter of streamReadyWaitersRef.current) waiter.finish();
  }, []);

  const conversationSurface = resolveConversationSurface(
    activeConversationId,
    snapshot?.conversation.id ?? null,
    failedConversationId,
  );
  const visibleSnapshot = conversationSurface === "ready" ? snapshot : null;
  const currentMessages = useMemo(
    () => sortedMessages(fromInitialMessages(visibleSnapshot?.messages ?? [])),
    [visibleSnapshot?.messages],
  );
  const visibleOptimisticMessages = useMemo(
    () => pendingOptimisticMessages(
      optimisticMessages,
      activeConversationId,
      currentMessages,
    ),
    [activeConversationId, currentMessages, optimisticMessages],
  );
  const displayedMessages = useMemo(
    () => mergeStreamMessages(
      [...currentMessages, ...visibleOptimisticMessages.map((item) => item.message)],
      streamState,
      activeConversationId,
    ),
    [activeConversationId, currentMessages, streamState, visibleOptimisticMessages],
  );

  useEffect(() => {
    updateOptimisticMessages((current) => pruneConfirmedOptimisticMessages(
      current,
      activeConversationId,
      currentMessages,
    ));
  }, [activeConversationId, currentMessages, updateOptimisticMessages]);

  const readyAttachments = useMemo(
    () => attachments.filter((item) => item.status === "ready"),
    [attachments],
  );
  const activeAssistant = activeAgent ? asAssistant(activeAgent) : null;

  const restoreFailedDraft = useCallback((key: string) => {
    const draft = drafts[key];
    if (!draft || !draftsReady || navigating || activeConversationRef.current || sendingRef.current || forkingRef.current) return;
    if (attachments.some((item) => item.status === "uploading")) return;
    // Swap snapshots so recovering never discards the current blank draft.
    setDraft(key, { input, attachments });
    setDraft(draftKey, draft);
    setNotice(null);
  }, [attachments, draftKey, drafts, draftsReady, input, navigating, setDraft]);

  // 只发送当前草稿：首屏示例、未发送草稿恢复都先写回草稿，再走同一条路径。
  const send = useCallback(async () => {
    const text = input;
    if (!activeAssistant || (!text.trim() && readyAttachments.length === 0)) return;
    if (attachments.some((item) => item.status === "uploading")) return;
    if (!draftsReady || navigating || sendingRef.current || forkingRef.current) return;
    sendingRef.current = true;
    const generation = conversationGenerationRef.current;
    let submittedDraftKey = draftKey;

    const clientId = createClientId();
    const message = optimisticMessage(clientId, text, readyAttachments);
    const visibleSignature = messageSignature(message);
    const conversationIdAtSend = activeConversationRef.current;
    let submittedConversationId = conversationIdAtSend;
    updateOptimisticMessages((current) => [...current, {
      clientId,
      conversationId: conversationIdAtSend,
      expectedMatchCount: nextExpectedMatchCount(
        optimisticMessagesRef.current,
        conversationIdAtSend,
        visibleSignature,
        currentMessages,
      ),
      signature: visibleSignature,
      message,
    }]);
    // 内容已经进了乐观消息，草稿立刻清空（失败时由 setDraft 恢复）。
    setInput("");
    setAttachments([]);
    setSending(true);
    setNotice(null);
    try {
      let conversationId = activeConversationRef.current;
      if (!conversationId) {
        const created = await createConversation({
          leadAgentKey: activeAssistant.id,
          // 有文字时留给服务端：它会按问题内容生成简短标题。
          title: text.trim() ? undefined : readyAttachments[0]?.filename || "新的对话",
        });
        conversationId = created.conversationId;
        submittedConversationId = conversationId;
        submittedDraftKey = conversationDraftKey(conversationId, activeAssistant.id);
        if (activeConversationRef.current === conversationIdAtSend && generation === conversationGenerationRef.current) {
          // A reopened blank view shares this key, but owns a different generation's draft.
          moveDraft(draftKey, submittedDraftKey);
          activeConversationRef.current = conversationId;
          activateConversation(conversationId, activeAssistant.id);
          router.replace(`/chat?conversation=${encodeURIComponent(conversationId)}`);
        }
        updateOptimisticMessages((current) => current.map((item) =>
          item.clientId === clientId ? { ...item, conversationId } : item));
      }

      const signature = requestSignature(
        conversationId,
        activeAssistant.id,
        text,
        readyAttachments,
        model,
        false,
      );
      if (pendingRequestRef.current?.signature !== signature) {
        pendingRequestRef.current = { signature, requestKey: createClientId() };
      }

      await waitForStreamReady(conversationId);
      await createExecution(conversationId, {
        requestKey: pendingRequestRef.current.requestKey,
        leadAgentKey: activeAssistant.id,
        text,
        attachments: readyAttachments.map((item) => ({
          path: item.path,
          filename: item.filename,
          mime: item.mime,
        })),
        ...(model ? { model } : {}),
        autoApprovePermissions: false,
      });
      pendingRequestRef.current = null;
      await refreshHome(conversationId, { activate: false });
      await refreshConversation(conversationId);
    } catch (error) {
      updateOptimisticMessages((current) => current.filter((item) => item.clientId !== clientId));
      if (!submittedConversationId) {
        // Creation failed before a conversation existed. The blank key may already own a newer draft.
        setDraft(`${draftKey}:failed:${clientId}`, { input: text, attachments: readyAttachments });
      } else {
        updateDraft(submittedDraftKey, (draft) => ({
          input: draft.input || text,
          attachments: draft.attachments.length > 0 ? draft.attachments : readyAttachments,
        }));
      }
      const message = submittedConversationId
        ? `${error instanceof Error ? error.message : "发送失败"}。草稿已保留，网络恢复后再次发送会继续核对同一请求。`
        : `${error instanceof Error ? error.message : "创建会话失败"}。未发送草稿已单独保留，可在该智能体的新会话中恢复。`;
      if (conversationDraftKey(activeConversationRef.current, activeAssistant.id) === submittedDraftKey) setNotice(message);
      else toast.error(message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [
    activeAssistant,
    activateConversation,
    attachments,
    currentMessages,
    draftKey,
    draftsReady,
    input,
    moveDraft,
    model,
    navigating,
    readyAttachments,
    refreshConversation,
    refreshHome,
    router,
    updateDraft,
    updateOptimisticMessages,
    setDraft,
    setInput,
    setAttachments,
    waitForStreamReady,
  ]);

  const stop = useCallback(async () => {
    const active = snapshot?.executions.find((item) => ACTIVE_STATUSES.includes(item.status));
    if (!active) return;
    setStopping(true);
    setNotice(null);
    try {
      await abortExecution(active.id);
      if (activeConversationRef.current) await refreshConversation(activeConversationRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "停止失败");
    } finally {
      setStopping(false);
    }
  }, [refreshConversation, snapshot?.executions]);

  const addFiles = useCallback((files: File[]) => {
    if (!draftsReady || navigating || sendingRef.current || forkingRef.current) return;
    for (const file of files) {
      const id = createClientId();
      setAttachments((current) => [...current, {
        id,
        path: "",
        filename: file.name,
        mime: file.type || guessMime(file.name),
        status: "uploading",
        source: "upload",
      }]);
      void uploadFile(CHAT_UPLOAD_DIR, file, file.name, () => undefined)
        .then((result) => {
          setAttachments((current) => current.map((item) => item.id === id
            ? { ...item, path: result.path, status: "ready" }
            : item));
        })
        .catch((error) => {
          setAttachments((current) => current.map((item) => item.id === id
            ? { ...item, status: "error" }
            : item));
          setNotice(error instanceof Error ? error.message : "附件上传失败");
        });
    }
  }, [draftsReady, navigating, setAttachments]);

  const mention = useCallback((file: MentionFile) => {
    setAttachments((current) => current.some((item) => item.path === file.path)
      ? current
      : [...current, {
          id: createClientId(),
          path: file.path,
          filename: file.filename,
          mime: file.type === "directory" ? "inode/directory" : guessMime(file.filename),
          status: "ready",
          source: "mention",
        }]);
  }, [setAttachments]);

  const searchFiles = useCallback(async (query: string) => {
    const response = await fetch(
      `/v1/users/me/files/list?path=${encodeURIComponent(directory)}&q=${encodeURIComponent(query)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return [];
    const payload = await response.json() as { files?: FileInfo[] };
    return (payload.files ?? [])
      .filter((file) => file.type === "file" && file.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 12)
      .map((file) => ({
        rel: file.path.replace(/^\/workspace\/?/, ""),
        path: file.path,
        filename: file.name,
        type: file.type,
      }));
  }, [directory]);

  const restartFrom = useCallback(async (message: ChatMessage, retryImmediately = false) => {
    const sourceId = activeConversationRef.current;
    if (!sourceId || forkingRef.current || sendingRef.current || hasActiveExecution) return;
    forkingRef.current = true;
    setForkingMessageId(message.id);
    setNotice(null);
    const generation = conversationGenerationRef.current;
    try {
      const created = await forkConversation(sourceId, message.id, retryImmediately);
      const destinationId = retryImmediately ? sourceId : created.conversationId;
      setDraft(conversationDraftKey(destinationId, created.leadAgentKey), {
        input: created.text,
        attachments: created.attachments.map((attachment) => ({
          ...attachment,
          id: createClientId(),
          status: "ready",
          source: "mention",
        })),
      });
      // A slow fork must not replace a conversation the user opened meanwhile.
      if (activeConversationRef.current !== sourceId || generation !== conversationGenerationRef.current) {
        await refreshHome(undefined, { activate: false });
        return;
      }
      pendingRequestRef.current = null;
      if (retryImmediately) {
        streamStateRef.current = createConversationStreamState(sourceId);
        setStreamState(streamStateRef.current);
        updateOptimisticMessages(() => []);
        setSnapshot((current) => current ? { ...current, messages: [] } : current);
        streamConnectionRef.current?.source.close();
        streamConnectionRef.current = null;
        setStreamGeneration((current) => current + 1);
        const refreshed = await refreshConversation(sourceId);
        if (!refreshed || activeConversationRef.current !== sourceId ||
            generation !== conversationGenerationRef.current) return;
        setPendingRetry({
          conversationId: sourceId,
          cleanupWarning: created.cleanupWarning,
        });
        return;
      }
      // Navigate before activating so the old URL cannot reactivate the source.
      router.push(`/chat?conversation=${encodeURIComponent(created.conversationId)}`);
      await refreshHome(created.conversationId);
    } catch (error) {
      if (activeConversationRef.current === sourceId && generation === conversationGenerationRef.current) {
        setNotice(error instanceof Error ? error.message : "创建会话分支失败");
      }
    } finally {
      forkingRef.current = false;
      setForkingMessageId(null);
    }
  }, [hasActiveExecution, refreshConversation, refreshHome, router, setDraft, updateOptimisticMessages]);

  const retryResponse = useCallback((message: ChatMessage) => {
    void restartFrom(message, true);
  }, [restartFrom]);

  useEffect(() => {
    if (!pendingRetry) return;
    if (activeConversationId !== pendingRetry.conversationId) {
      if (!navigating) setPendingRetry(null);
      return;
    }
    if (navigating || !draftsReady || forkingMessageId !== null || sendingRef.current || forkingRef.current) return;
    setPendingRetry(null);
    void (async () => {
      await send();
      if (pendingRetry.cleanupWarning && activeConversationRef.current === pendingRetry.conversationId) {
        setNotice(pendingRetry.cleanupWarning);
      }
    })();
  }, [activeConversationId, draftsReady, forkingMessageId, navigating, pendingRetry, send]);

  const currentExecution = visibleSnapshot?.executions.find((item) =>
    ACTIVE_STATUSES.includes(item.status),
  );
  const blocked = navigating || !draftsReady || conversationSurface === "loading" || conversationSurface === "unavailable" ||
    Boolean(visibleSnapshot?.conversation.recoveryRequired);

  if (loading) {
    return (
      <main className="opshelper-main">
        <div className="opshelper-boot opshelper-boot-contained">
          <div className="opshelper-spinner" />
          <div className="opshelper-boot-text">正在打开运维工作台…</div>
        </div>
      </main>
    );
  }

  if (!activeAssistant) {
    return (
      <main className="opshelper-main">
        <div className="opshelper-boot opshelper-boot-contained">
          <div className="opshelper-boot-text">当前无可用智能体</div>
          <button className="opshelper-btn" onClick={() => router.push("/agents?create=1")}>新建智能体</button>
        </div>
      </main>
    );
  }

  return (
    <>
      <main className="opshelper-main">
        <header className="opshelper-topbar opshelper-chat-topbar">
          <WorkspaceMenuButton />
          <div className="opshelper-topbar-meta">
            <div className="opshelper-chat-agent-title">
              <AgentMark
                id={activeAssistant.id}
                name={activeAssistant.name}
                description={activeAssistant.description}
              />
              <span>{activeAssistant.name}</span>
            </div>
          </div>
        </header>
        <div className={`opshelper-stage${conversationSurface === "new" && displayedMessages.length === 0 && !(sending || hasActiveExecution || forkingMessageId !== null) ? " opshelper-stage-empty" : ""}`}>
          <Conversation
            messages={displayedMessages}
            surface={conversationSurface}
            assistant={activeAssistant}
            busy={sending || hasActiveExecution || forkingMessageId !== null}
            sessionId={activeConversationId}
            onRestartFrom={restartFrom}
            onRetryFrom={retryResponse}
            forkingMessageId={forkingMessageId}
            executions={visibleSnapshot?.executions ?? []}
            reconnecting={snapshotUnavailable || streamDisconnected}
            onReconcile={(executionId) => void reconcileExecution(executionId)
              .then(() => activeConversationRef.current
                ? refreshConversation(activeConversationRef.current)
                : null)
              .catch((error) => setNotice(error instanceof Error ? error.message : "核对失败"))}
          />
          {notice ? (
            <div className="opshelper-notice" role="status">
              <span>{notice}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><IconClose /></button>
            </div>
          ) : null}
          {!activeConversationId ? failedDrafts.map(([key, draft]) => (
            <div className="opshelper-notice" role="status" key={key}>
              <span>未发送草稿：{draft.input.slice(0, 60) || "仅附件"}{draft.attachments.length > 0 ? `（${draft.attachments.length} 个附件）` : ""}</span>
              <button
                type="button"
                disabled={blocked || sending || forkingMessageId !== null || attachments.some((item) => item.status === "uploading")}
                title="恢复此草稿；当前内容会另存为未发送草稿"
                onClick={() => restoreFailedDraft(key)}
              >恢复未发送草稿</button>
            </div>
          )) : null}
          {visibleSnapshot?.pendingQuestion && currentExecution ? (
            <QuestionCard
              key={visibleSnapshot.pendingQuestion.id}
              question={visibleSnapshot.pendingQuestion}
              onAnswer={(answers) => void replyExecutionQuestion(
                currentExecution.id,
                visibleSnapshot.pendingQuestion!.id,
                answers,
              ).then(() => activeConversationId
                ? refreshConversation(activeConversationId)
                : null).catch((error) => setNotice(error instanceof Error ? error.message : "提交失败"))}
            />
          ) : null}
          {!currentExecution?.autoApprovePermissions
            ? visibleSnapshot?.pendingPermissions.map((permission) => currentExecution ? (
              <PermissionCard
                key={permission.id}
                permission={{ ...permission, sessionId: "" }}
                onRespond={(response) => void replyExecutionPermission(
                  currentExecution.id,
                  permission.id,
                  response,
                ).then(() => activeConversationId
                  ? refreshConversation(activeConversationId)
                  : null).catch((error) => setNotice(error instanceof Error ? error.message : "提交失败"))}
              />
            ) : null)
            : null}
          {/* 协作过程贴在输入框上沿：留在分割线上方的固定条里，不混进可滚动的对话正文。 */}
          <CollaborationBar
            collaborations={visibleSnapshot?.collaborations ?? []}
            conversationId={activeConversationId}
          />
          <Composer
            key={draftKey}
            value={input}
            onChange={setInput}
            focusToken={composerFocus}
            onSend={() => void send()}
            onStop={() => void stop()}
            busy={hasActiveExecution || stopping}
            blocked={blocked || sending || forkingMessageId !== null}
            readOnly={navigating || !draftsReady || conversationSurface === "loading"}
            queueHint={hasActiveExecution}
            submitting={sending}
            stopping={stopping}
            models={availableModels}
            model={model}
            onModelChange={(next) => {
              setModel(next);
              try {
                localStorage.setItem(CHAT_MODEL_KEY, next);
              } catch {
                // Browser storage may be unavailable.
              }
            }}
            attachments={attachments}
            onAddFiles={addFiles}
            onRequestReference={() => setReferenceFilesOpen(true)}
            onRemoveAttachment={(id) => setAttachments((current) =>
              current.filter((item) => item.id !== id))}
            onSearchFiles={searchFiles}
            onMention={mention}
          />
        </div>
      </main>

      {referenceFilesOpen ? (
        <AttachmentPanel
          onAttach={mention}
          onClose={closeReferenceFiles}
        />
      ) : null}
    </>
  );
}
