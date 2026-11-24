"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ConversationAgent,
  ConversationSearchResult,
  ConversationSummary,
} from "@opshelper/shared";

import {
  archiveConversation,
  deleteConversation,
  saveConversationAgentOrder,
  setConversationPinned,
  renameConversation,
  getConversation,
  listConversations,
  searchConversations,
} from "@/lib/browser-api";
import { AgentMark } from "./chat/assistant";
import { getActiveConversationGroupKey, groupConversationsByAgent } from "./chat/conversation-groups";
import { moveAgentOrder, reconcileAgentOrder, sameAgentOrder } from "./chat/agent-order";
import { runConversationBatch, toggleConversationSelection } from "./chat/conversation-batch";
import { cleanTitle, formatConversationTime, formatConversationTimestamp, fullConversationTitle } from "./chat/format";
import type { NewConversationRequest } from "./chat/new-conversation-request";
import {
  IconChevron,
  IconClock,
  IconClose,
  IconCompose,
  IconFolder,
  IconMenu,
  IconPlus,
  IconArchive,
  IconPin,
  IconSidePanel,
  IconSettings,
  IconSearch,
  IconTrash,
} from "./chat/icons";
import { ConversationActions } from "./chat/conversation-actions";
import { ConversationDraftProvider, useConversationDraftStore } from "./chat/conversation-draft-provider";
import { conversationDraftKey, hasDraft } from "./chat/conversation-drafts";
import { UserProfileMenu } from "./user-profile-menu";
import { refreshCurrentPage, useRouteRefresh } from "./navigation-refresh";
import { confirm as confirmDialog } from "./ui/dialog-host";

const CHAT_CONTEXT_KEY = "opshelper:conversation";
const CHAT_AGENT_KEY = "opshelper:agent";

type WorkspaceUser = {
  name: string;
  username: string;
  role: string;
};

interface WorkspaceContextValue {
  agents: ConversationAgent[];
  agentOrder: string[];
  conversations: ConversationSummary[];
  activeAgent: ConversationAgent | null;
  activeConversationId: string | null;
  loading: boolean;
  executionBlockedReason: string | null;
  renameConversationTitle: (conversationId: string, title: string) => Promise<void>;
  showSidebar: boolean;
  newConversationRequest: NewConversationRequest | null;
  acknowledgeNewConversationRequest: (requestId: number) => void;
  refreshHome: (preferredConversationId?: string | null, options?: { activate?: boolean }) => Promise<void>;
  activateConversation: (conversationId: string, agentKey?: string) => void;
  updateConversation: (conversation: ConversationSummary) => void;
  selectAgent: (agentKey: string) => void;
  startNewConversation: (prefill?: string, agentKey?: string) => void;
  removeConversation: (conversationId: string) => Promise<void>;
  deleteConversationPermanently: (conversationId: string) => Promise<void>;
  pinConversation: (conversationId: string, pinned: boolean) => Promise<void>;
  reorderAgentGroups: (activeKey: string, targetKey: string) => void;
  setShowSidebar: (value: boolean) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function storedValue(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeValue(key: string, value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Browser storage may be unavailable.
  }
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceShell");
  return value;
}

export function WorkspaceShell({
  user,
  children,
}: Readonly<{
  user: WorkspaceUser;
  children: ReactNode;
}>) {
  const pathname = usePathname();
  const router = useRouter();
  useRouteRefresh();
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<ConversationAgent[]>([]);
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeAgentKey, setActiveAgentKey] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [executionBlockedReason, setExecutionBlockedReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sideWidth, setSideWidth] = useState(SIDE_WIDTH.fallback);
  const [showSidebar, setShowSidebar] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    setSideWidth(readWidth(SIDE_WIDTH.key, SIDE_WIDTH));
    setSidebarCollapsed(readCollapsed());
  }, []);
  const changeSideWidth = useCallback((width: number) => {
    setSideWidth(width);
    saveWidth(SIDE_WIDTH.key, width);
  }, []);
  const changeSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    saveCollapsed(collapsed);
  }, []);
  const [newConversationRequest, setNewConversationRequest] = useState<NewConversationRequest | null>(null);
  const newConversationSequenceRef = useRef(0);
  const activeAgentKeyRef = useRef<string | null>(null);
  const activeConversationRef = useRef<string | null>(null);
  const navigationGenerationRef = useRef(0);
  const homeRefreshSequenceRef = useRef(0);
  const agentOrderRef = useRef<string[]>([]);
  const agentOrderInitializedRef = useRef(false);
  const agentOrderSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const handledNewRouteRef = useRef<string | null>(null);
  // 不在会话列表里的对话（定时任务）每换一次链接只尝试打开一次，避免重复请求和提示。
  const requestedConversationRef = useRef<string | null>(null);
  // Archive callbacks may outlive the route they were invoked from.
  const currentRouteRef = useRef({ pathname, conversationId: searchParams.get("conversation") });
  currentRouteRef.current = { pathname, conversationId: searchParams.get("conversation") };

  const persistAgentOrder = useCallback((order: string[]) => {
    const snapshot = [...order];
    const save = agentOrderSaveQueueRef.current.catch(() => undefined).then(async () => {
      await saveConversationAgentOrder(snapshot);
    });
    agentOrderSaveQueueRef.current = save;
    return save;
  }, []);

  const reorderAgentGroups = useCallback((activeKey: string, targetKey: string) => {
    const nextOrder = moveAgentOrder(agentOrderRef.current, activeKey, targetKey);
    if (sameAgentOrder(nextOrder, agentOrderRef.current)) return;
    agentOrderRef.current = nextOrder;
    setAgentOrder(nextOrder);
    void persistAgentOrder(nextOrder).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : "智能体顺序保存失败"));
  }, [persistAgentOrder]);

  const setActiveAgent = useCallback((agentKey: string | null) => {
    navigationGenerationRef.current += 1;
    activeAgentKeyRef.current = agentKey;
    setActiveAgentKey(agentKey);
    storeValue(CHAT_AGENT_KEY, agentKey);
  }, []);

  const activateConversation = useCallback((conversationId: string, agentKey?: string) => {
    navigationGenerationRef.current += 1;
    activeConversationRef.current = conversationId;
    setActiveConversationId(conversationId);
    storeValue(CHAT_CONTEXT_KEY, conversationId);
    if (agentKey) setActiveAgent(agentKey);
  }, [setActiveAgent]);

  const clearActiveConversation = useCallback(() => {
    navigationGenerationRef.current += 1;
    activeConversationRef.current = null;
    setActiveConversationId(null);
    storeValue(CHAT_CONTEXT_KEY, null);
  }, []);

  const refreshHome = useCallback(async (preferredConversationId?: string | null, { activate = true }: { activate?: boolean } = {}) => {
    const generation = navigationGenerationRef.current;
    const sequence = ++homeRefreshSequenceRef.current;
    const home = await listConversations();
    if (sequence !== homeRefreshSequenceRef.current) return;
    setAgents(home.agents);
    setConversations(home.conversations);
    setExecutionBlockedReason(home.executionBlockedReason);
    if (!agentOrderInitializedRef.current) {
      const initialOrder = groupConversationsByAgent(home.conversations, home.agents)
        .map((group) => group.agentKey);
      const nextOrder = reconcileAgentOrder(
        home.agentOrder,
        home.agents.map((agent) => agent.key),
        initialOrder,
      );
      agentOrderInitializedRef.current = true;
      agentOrderRef.current = nextOrder;
      setAgentOrder(nextOrder);
      if (!sameAgentOrder(nextOrder, home.agentOrder)) {
        void persistAgentOrder(nextOrder).catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : "智能体顺序保存失败"));
      }
    }

    // Refresh the list, but preserve any navigation made while it was loading.
    if (!activate || generation !== navigationGenerationRef.current) return;

    const requestedConversationId = preferredConversationId !== undefined
      ? preferredConversationId
      : activeConversationRef.current ?? storedValue(CHAT_CONTEXT_KEY);
    let requestedConversation = requestedConversationId
      ? home.conversations.find((item) => item.id === requestedConversationId) ?? null
      : null;
    // 定时任务的对话不在首页列表里，但仍然是上次打开的上下文：直接按 id 读回来。
    if (!requestedConversation && requestedConversationId) {
      requestedConversation = await getConversation(requestedConversationId)
        .then((snapshot) => snapshot.conversation)
        .catch(() => null);
    }
    if (sequence !== homeRefreshSequenceRef.current || generation !== navigationGenerationRef.current) return;
    const requestedAgentKey = requestedConversation?.leadAgentKey
      ?? activeAgentKeyRef.current
      ?? storedValue(CHAT_AGENT_KEY);
    const nextAgent = home.agents.find((item) => item.key === requestedAgentKey)
      ?? home.agents[0]
      ?? null;

    setActiveAgent(nextAgent?.key ?? null);
    if (requestedConversation && requestedConversation.leadAgentKey === nextAgent?.key) {
      activateConversation(requestedConversation.id, requestedConversation.leadAgentKey);
    } else if (preferredConversationId === null) {
      clearActiveConversation();
    } else {
      const latest = nextAgent
        ? home.conversations.find((item) => item.leadAgentKey === nextAgent.key) ?? null
        : null;
      if (latest) activateConversation(latest.id, latest.leadAgentKey);
      else clearActiveConversation();
    }
  }, [activateConversation, clearActiveConversation, persistAgentOrder, setActiveAgent]);

  useEffect(() => {
    if (loading || !agentOrderInitializedRef.current) return;
    const initialOrder = groupConversationsByAgent(conversations, agents).map((group) => group.agentKey);
    const nextOrder = reconcileAgentOrder(
      agentOrder,
      agents.map((agent) => agent.key),
      initialOrder,
    );
    if (sameAgentOrder(nextOrder, agentOrder)) return;
    agentOrderRef.current = nextOrder;
    setAgentOrder(nextOrder);
    void persistAgentOrder(nextOrder).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : "智能体顺序保存失败"));
  }, [agentOrder, agents, conversations, loading, persistAgentOrder]);

  useEffect(() => {
    const requested = searchParams.get("conversation");
    const newRoute = searchParams.get("new");
    const startingNew = newRoute !== null;
    handledNewRouteRef.current = newRoute;
    void refreshHome(startingNew ? null : requested ?? undefined)
      .catch((error) => setExecutionBlockedReason(error instanceof Error ? error.message : "对话加载失败"))
      .finally(() => setLoading(false));
    // The provider persists across workspace routes; initial loading should happen once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loading || !pathname.endsWith("/chat")) return;
    const requested = searchParams.get("conversation");
    if (requested) {
      handledNewRouteRef.current = null;
      if (requested === activeConversationRef.current) {
        requestedConversationRef.current = requested;
        return;
      }
      const conversation = conversations.find((item) => item.id === requested);
      if (conversation) {
        requestedConversationRef.current = requested;
        activateConversation(conversation.id, conversation.leadAgentKey);
        return;
      }
      if (requestedConversationRef.current === requested) return;
      requestedConversationRef.current = requested;
      // 定时任务的对话不在会话列表里：带上链接也要按 id 打开，
      // 否则页面会停在原来的对话上。打开结果不能被这个 effect 的重跑丢掉，
      // 因此按“请求是否仍是当前目标”判断，而不是用 cleanup 取消。
      void getConversation(requested)
        .then((snapshot) => {
          if (requestedConversationRef.current !== requested) return;
          activateConversation(snapshot.conversation.id, snapshot.conversation.leadAgentKey);
        })
        .catch(() => {
          if (requestedConversationRef.current !== requested) return;
          toast.error("这条对话无法打开，可能已归档或不属于当前账号");
        });
      return;
    }
    const newRoute = searchParams.get("new");
    if (newRoute) {
      if (newRoute !== handledNewRouteRef.current) {
        handledNewRouteRef.current = newRoute;
        if (activeConversationRef.current !== null) clearActiveConversation();
      }
      return;
    }
    handledNewRouteRef.current = null;
  }, [activateConversation, clearActiveConversation, conversations, loading, pathname, searchParams]);

  useEffect(() => {
    setShowSidebar(false);
    if (!loading) {
      void refreshHome(undefined, { activate: false })
        .catch((error) => toast.error(error instanceof Error ? error.message : "刷新对话列表失败"));
    }
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeAgent = useMemo(
    () => agents.find((item) => item.key === activeAgentKey) ?? agents[0] ?? null,
    [activeAgentKey, agents],
  );

  const selectAgent = useCallback((agentKey: string) => {
    const agent = agents.find((item) => item.key === agentKey);
    if (!agent) return;
    setActiveAgent(agent.key);
    const latest = conversations.find((item) => item.leadAgentKey === agent.key) ?? null;
    if (latest) activateConversation(latest.id, agent.key);
    else clearActiveConversation();
    setShowSidebar(false);
    if (pathname.endsWith("/chat")) {
      router.replace(latest
        ? `/chat?conversation=${encodeURIComponent(latest.id)}`
        : `/chat?new=${Date.now()}`);
      if (!latest) {
        newConversationSequenceRef.current += 1;
        setNewConversationRequest({ id: newConversationSequenceRef.current, prefill: "" });
      }
    }
  }, [activateConversation, agents, clearActiveConversation, conversations, pathname, router, setActiveAgent]);

  const startNewConversation = useCallback((prefill = "", agentKey?: string) => {
    if (agentKey) {
      const agent = agents.find((item) => item.key === agentKey);
      if (!agent) return;
      setActiveAgent(agent.key);
    }
    clearActiveConversation();
    setShowSidebar(false);
    newConversationSequenceRef.current += 1;
    setNewConversationRequest({ id: newConversationSequenceRef.current, prefill });
    router.push(`/chat?new=${Date.now()}`);
  }, [agents, clearActiveConversation, router, setActiveAgent]);

  const acknowledgeNewConversationRequest = useCallback((requestId: number) => {
    setNewConversationRequest((current) => current?.id === requestId ? null : current);
  }, []);

  const renameConversationTitle = useCallback(async (conversationId: string, title: string) => {
    const result = await renameConversation(conversationId, title);
    setConversations((current) => current.map((item) =>
      item.id === conversationId ? { ...item, title: result.title } : item));
  }, []);

  const removeConversation = useCallback(async (conversationId: string) => {
    await archiveConversation(conversationId);
    setConversations((current) => current.filter((item) => item.id !== conversationId));
    if (activeConversationRef.current === conversationId) {
      clearActiveConversation();
      const route = currentRouteRef.current;
      // Clear the archived URL only if the user is still viewing that conversation.
      if (route.pathname.endsWith("/chat") && route.conversationId === conversationId) {
        router.replace(`/chat?new=${Date.now()}`);
      }
    }
    // Archiving succeeded; a best-effort list refresh must not turn it into an error.
    void refreshHome(undefined, { activate: false }).catch(() => undefined);
  }, [clearActiveConversation, refreshHome, router]);

  const deleteConversationPermanently = useCallback(async (conversationId: string) => {
    await deleteConversation(conversationId);
    setConversations((current) => current.filter((item) => item.id !== conversationId));
    if (activeConversationRef.current === conversationId) {
      clearActiveConversation();
      const route = currentRouteRef.current;
      if (route.pathname.endsWith("/chat") && route.conversationId === conversationId) {
        router.replace(`/chat?new=${Date.now()}`);
      }
    }
    void refreshHome(undefined, { activate: false })
      .catch((error) => toast.error(error instanceof Error ? error.message : "刷新对话列表失败"));
  }, [clearActiveConversation, refreshHome, router]);

  const pinConversation = useCallback(async (conversationId: string, pinned: boolean) => {
    await setConversationPinned(conversationId, pinned);
    setConversations((current) => current.map((item) =>
      item.id === conversationId ? { ...item, pinnedAt: pinned ? new Date().toISOString() : null } : item));
    void refreshHome(undefined, { activate: false })
      .catch((error) => toast.error(error instanceof Error ? error.message : "刷新对话列表失败"));
  }, [refreshHome]);

  const updateConversation = useCallback((conversation: ConversationSummary) => {
    setConversations((current) => current.map((item) =>
      item.id === conversation.id ? conversation : item));
  }, []);

  const contextValue = useMemo<WorkspaceContextValue>(() => ({
    agents,
    agentOrder,
    conversations,
    activeAgent,
    activeConversationId,
    loading,
    executionBlockedReason,
    showSidebar,
    newConversationRequest,
    acknowledgeNewConversationRequest,
    refreshHome,
    activateConversation,
    updateConversation,
    selectAgent,
    startNewConversation,
    removeConversation,
    deleteConversationPermanently,
    pinConversation,
    reorderAgentGroups,
    renameConversationTitle,
    setShowSidebar,
  }), [
    activeAgent,
    activeConversationId,
    acknowledgeNewConversationRequest,
    activateConversation,
    agentOrder,
    agents,
    conversations,
    executionBlockedReason,
    loading,
    newConversationRequest,
    refreshHome,
    removeConversation,
    deleteConversationPermanently,
    pinConversation,
    reorderAgentGroups,
    renameConversationTitle,
    selectAgent,
    showSidebar,
    startNewConversation,
    updateConversation,
  ]);

  return (
    <ConversationDraftProvider key={user.username} userKey={user.username}>
      <WorkspaceContext.Provider value={contextValue}>
        <div
          className={`opshelper-shell${showSidebar ? " opshelper-sidebar-open" : ""}${sidebarCollapsed ? " opshelper-sidebar-collapsed" : ""}`}
          style={{ "--g-side-user": `${sideWidth}px` } as React.CSSProperties}
        >
          <WorkspaceSidebar user={user} onCollapse={() => { setShowSidebar(false); changeSidebarCollapsed(true); }} />
          {sidebarCollapsed ? (
            <button
              className="opshelper-sidebar-expand"
              type="button"
              aria-label="展开侧边栏"
              title="展开侧边栏"
              onClick={() => changeSidebarCollapsed(false)}
            >
              <IconSidePanel />
            </button>
          ) : (
            <ColumnResizer edge="side" range={SIDE_WIDTH} width={sideWidth} label="调整对话列表宽度" onChange={changeSideWidth} />
          )}
          <button
            className="opshelper-sidebar-scrim"
            type="button"
            aria-label="关闭导航"
            onClick={() => setShowSidebar(false)}
          />
          {children}
        </div>
      </WorkspaceContext.Provider>
    </ConversationDraftProvider>
  );
}

const SIDE_WIDTH = { min: 220, max: 420, fallback: 280, key: "opshelper.sideWidth" };
const SIDE_COLLAPSED_KEY = "opshelper.sidebarCollapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(SIDE_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(SIDE_COLLAPSED_KEY, "1");
    else localStorage.removeItem(SIDE_COLLAPSED_KEY);
  } catch {
    // Browser storage may be unavailable.
  }
}

function readWidth(key: string, range: { min: number; max: number; fallback: number }) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? clampWidth(Number(raw), range) : range.fallback;
  } catch {
    return range.fallback;
  }
}

function saveWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    // Browser storage may be unavailable.
  }
}

function clampWidth(value: number, range: { min: number; max: number; fallback: number }) {
  if (!Number.isFinite(value)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function ColumnResizer({
  edge,
  range,
  width,
  label,
  onChange,
}: {
  edge: "side";
  range: { min: number; max: number; fallback: number; key: string };
  width: number;
  label: string;
  onChange: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, width: 0 });
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = { x: event.clientX, width };
    setDragging(true);
    document.body.classList.add("opshelper-resizing");
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const delta = event.clientX - startRef.current.x;
    onChange(clampWidth(startRef.current.width + delta, range));
  };
  const stop = () => {
    setDragging(false);
    document.body.classList.remove("opshelper-resizing");
  };
  return (
    <div
      className={`opshelper-resizer opshelper-resizer-${edge}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onChange(range.fallback)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const direction = edge === "side" ? 1 : -1;
        if (event.key === "ArrowLeft") onChange(clampWidth(width - step * direction, range));
        else if (event.key === "ArrowRight") onChange(clampWidth(width + step * direction, range));
        else return;
        event.preventDefault();
      }}
    />
  );
}

function SelectionCheckbox({ label, checked, partial = false, disabled, onChange }: {
  label: string;
  checked: boolean;
  partial?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />;
}

export function WorkspaceMenuButton() {
  const { showSidebar, setShowSidebar } = useWorkspace();
  return (
    <button
      className="opshelper-mobile-nav"
      type="button"
      aria-label="打开导航"
      aria-controls="opshelper-sidebar"
      aria-expanded={showSidebar}
      onClick={() => setShowSidebar(true)}
    >
      <IconMenu />
    </button>
  );
}

function WorkspaceSidebar({ user, onCollapse }: { user: WorkspaceUser; onCollapse: () => void }) {
  const { drafts } = useConversationDraftStore();
  const pathname = usePathname();
  const {
    agents,
    agentOrder,
    conversations,
    activeAgent,
    activeConversationId,
    loading,
    executionBlockedReason,
    startNewConversation,
    removeConversation,
    deleteConversationPermanently,
    pinConversation,
    reorderAgentGroups,
    renameConversationTitle,
    refreshHome,
    showSidebar,
    setShowSidebar,
  } = useWorkspace();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchAgentFilterRef = useRef<HTMLDivElement>(null);
  const searchResultRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const [selectedSearchAgentKeys, setSelectedSearchAgentKeys] = useState<string[] | null>(null);
  const [searchAgentMenuOpen, setSearchAgentMenuOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [newConversationMenuOpen, setNewConversationMenuOpen] = useState(false);
  const [expandedAgentKey, setExpandedAgentKey] = useState<string | null>(null);
  const [draggedAgentKey, setDraggedAgentKey] = useState<string | null>(null);
  const [dragOverAgentKey, setDragOverAgentKey] = useState<string | null>(null);
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const closeConversationMenu = useCallback(() => setMenuConversationId(null), []);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const batchBusyRef = useRef(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameBusyRef = useRef(false);
  const commitRename = async (item: { id: string; title: string }) => {
    if (renameBusyRef.current) return;
    const next = renameValue.replace(/\s+/g, " ").trim().slice(0, 120);
    setRenamingId(null);
    if (!next || next === item.title) return;
    renameBusyRef.current = true;
    try {
      await renameConversationTitle(item.id, next);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "重命名失败，请重试");
    } finally {
      renameBusyRef.current = false;
    }
  };

  useEffect(() => {
    closeConversationMenu();
  }, [activeAgent?.key, activeConversationId, pathname, search, showSidebar, closeConversationMenu]);
  const conversationListId = useId();
  const newConversationMenuId = useId();
  const newConversationButtonRef = useRef<HTMLButtonElement>(null);
  const newConversationMenuRef = useRef<HTMLDivElement>(null);
  const newConversationOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!newConversationMenuOpen) return;
    requestAnimationFrame(() => newConversationOptionRefs.current[0]?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!newConversationMenuRef.current?.contains(event.target as Node)) {
        setNewConversationMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [newConversationMenuOpen]);

  const closeSearch = useCallback(() => {
    setSearch("");
    setSearchOpen(false);
    setSearchActiveIndex(0);
    setSelectedSearchAgentKeys(null);
    setSearchAgentMenuOpen(false);
    setSearchResults([]);
    setSearchError(null);
    requestAnimationFrame(() => searchButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (document.querySelector(".file-dialog-backdrop, .schedule-dialog-backdrop")) return;
        event.preventDefault();
        if (searchOpen) closeSearch();
        else setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onGlobalKeyDown);
    return () => document.removeEventListener("keydown", onGlobalKeyDown);
  }, [closeSearch, searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (searchAgentMenuOpen) {
          setSearchAgentMenuOpen(false);
          searchInputRef.current?.focus();
        } else {
          closeSearch();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSearch, searchAgentMenuOpen, searchOpen]);

  useEffect(() => {
    if (!searchAgentMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!searchAgentFilterRef.current?.contains(event.target as Node)) {
        setSearchAgentMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [searchAgentMenuOpen]);

  const searchTerm = search.trim();
  useEffect(() => {
    if (!searchOpen || !searchTerm) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void searchConversations(searchTerm, selectedSearchAgentKeys ?? [])
        .then((results) => {
          if (!cancelled) setSearchResults(results);
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setSearchResults([]);
            setSearchError(error instanceof Error ? error.message : "搜索失败，请重试");
          }
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchOpen, searchTerm, selectedSearchAgentKeys]);

  const selectedSearchAgentCount = selectedSearchAgentKeys?.length ?? agents.length;
  const searchAgentLabel = selectedSearchAgentCount === agents.length
    ? "全部智能体"
    : `已选 ${selectedSearchAgentCount} 个智能体`;

  const highlightSearchMatch = (text: string) => {
    const term = searchTerm.toLocaleLowerCase();
    const normalized = text.toLocaleLowerCase();
    const nodes: ReactNode[] = [];
    let cursor = 0;
    let matchIndex = normalized.indexOf(term);
    while (term && matchIndex >= 0) {
      if (matchIndex > cursor) nodes.push(text.slice(cursor, matchIndex));
      nodes.push(
        <mark className="opshelper-search-match" key={`${matchIndex}-${cursor}`}>
          {text.slice(matchIndex, matchIndex + term.length)}
        </mark>,
      );
      cursor = matchIndex + term.length;
      matchIndex = normalized.indexOf(term, cursor);
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
  };

  const toggleSearchAgent = (agentKey: string) => {
    const currentlySelected = selectedSearchAgentKeys ?? agents.map((agent) => agent.key);
    if (currentlySelected.length === 1 && currentlySelected[0] === agentKey) return;
    const next = currentlySelected.includes(agentKey)
      ? currentlySelected.filter((key) => key !== agentKey)
      : [...currentlySelected, agentKey];
    if (next.length === agents.length) {
      setSelectedSearchAgentKeys(null);
    } else {
      setSelectedSearchAgentKeys(next);
    }
  };

  const orderedAgents = useMemo(() => {
    const positions = new Map(agentOrder.map((key, index) => [key, index]));
    return [...agents].sort((left, right) =>
      (positions.get(left.key) ?? Number.MAX_SAFE_INTEGER)
      - (positions.get(right.key) ?? Number.MAX_SAFE_INTEGER));
  }, [agentOrder, agents]);

  const recentSearchItems = useMemo(() => {
    const agentNames = new Map(agents.map((agent) => [agent.key, agent.name]));
    const allowed = selectedSearchAgentKeys ? new Set(selectedSearchAgentKeys) : null;
    return [...conversations]
      .filter((item) => !allowed || allowed.has(item.leadAgentKey))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 6)
      .map((conversation) => ({
        conversation,
        agentName: agentNames.get(conversation.leadAgentKey) ?? conversation.leadAgentKey,
        matchedContent: null,
      }));
  }, [agents, conversations, selectedSearchAgentKeys]);

  const visibleSearchItems = searchTerm ? searchResults : recentSearchItems;

  useEffect(() => {
    setSearchActiveIndex(0);
  }, [searchOpen, searchTerm, selectedSearchAgentKeys, searchResults]);

  const conversationGroups = useMemo(
    () => groupConversationsByAgent(conversations, agents, "", agentOrder),
    [agentOrder, agents, conversations],
  );
  const draggedAgentKeyRef = useRef<string | null>(null);
  const onAgentGroupDragStart = (event: React.DragEvent<HTMLDivElement>, agentKey: string) => {
    draggedAgentKeyRef.current = agentKey;
    setDraggedAgentKey(agentKey);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", agentKey);
  };
  const onAgentGroupDragOver = (event: React.DragEvent<HTMLDivElement>, targetKey: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (draggedAgentKeyRef.current && draggedAgentKeyRef.current !== targetKey) {
      setDragOverAgentKey(targetKey);
    }
  };
  const onAgentGroupDrop = (event: React.DragEvent<HTMLDivElement>, targetKey: string) => {
    event.preventDefault();
    const activeKey = draggedAgentKeyRef.current ?? event.dataTransfer.getData("text/plain");
    if (activeKey) reorderAgentGroups(activeKey, targetKey);
    draggedAgentKeyRef.current = null;
    setDraggedAgentKey(null);
    setDragOverAgentKey(null);
  };
  const selectedConversations = conversations.filter((item) => selectedIds.has(item.id));
  const toggleSelection = (ids: string[]) => {
    setSelectedIds((current) => toggleConversationSelection(current, ids));
  };
  const performConversationAction = async (action: "archive" | "delete", items: ConversationSummary[]) => {
    if (!items.length || batchBusyRef.current) return;
    const confirmed = await confirmDialog({
      title: action === "delete" ? "永久删除对话？" : "归档对话？",
      description: action === "delete"
        ? `将永久删除 ${items.length} 个对话及其聊天记录，无法恢复。工作区文件不会删除；排队或执行中的对话会跳过。`
        : `将归档 ${items.length} 个对话，可在“已归档的对话”中恢复；排队或执行中的对话会跳过。`,
      confirmLabel: action === "delete" ? "永久删除" : "归档",
      variant: action === "delete" ? "danger" : "default",
    });
    if (!confirmed || batchBusyRef.current) return;
    batchBusyRef.current = true;
    setBatchBusy(true);
    try {
      const failures = await runConversationBatch(items, action === "delete" ? deleteConversationPermanently : removeConversation);
      setSelectedIds(new Set(failures.map((item) => item.id)));
      const succeeded = items.length - failures.length;
      if (succeeded) toast.success(`已${action === "delete" ? "删除" : "归档"} ${succeeded} 个对话`);
      if (failures.length) {
        toast.error(`${failures.length} 个对话未处理：${failures.map((item) => `${cleanTitle(item.title)}（${item.message}）`).join("；")}`);
      } else {
        setBatchMode(false);
      }
    } finally {
      batchBusyRef.current = false;
      setBatchBusy(false);
    }
  };
  const currentAgentGroupKey = getActiveConversationGroupKey(
    conversationGroups,
    activeConversationId,
    activeAgent?.key ?? null,
  );

  useEffect(() => {
    setExpandedAgentKey(currentAgentGroupKey);
  }, [activeAgent?.key, activeConversationId, currentAgentGroupKey]);

  const toggleConversationGroup = (agentKey: string) => {
    const currentlyExpanded = expandedAgentKey ?? currentAgentGroupKey;
    if (currentlyExpanded !== agentKey) {
      void refreshHome(undefined, { activate: false })
        .catch((error) => toast.error(error instanceof Error ? error.message : "刷新对话列表失败"));
    }
    setExpandedAgentKey(currentlyExpanded === agentKey ? "" : agentKey);
  };

  const expandConversationGroup = (agentKey: string) => {
    setExpandedAgentKey(agentKey);
  };

  const chooseAgentForNewConversation = (agentKey: string) => {
    setNewConversationMenuOpen(false);
    startNewConversation("", agentKey);
  };

  return (
    <>
    <aside className="opshelper-sidebar" id="opshelper-sidebar" aria-label="小信运维助手导航">
      <div className="opshelper-brand">
        <span className="opshelper-brand-name">小信运维助手</span>
        <button
          ref={searchButtonRef}
          type="button"
          className={`opshelper-search-toggle${searchOpen ? " active" : ""}`}
          aria-label={searchOpen ? "收起搜索" : "搜索对话"}
          aria-expanded={searchOpen}
          aria-haspopup="dialog"
          title="搜索对话 (Ctrl+K)"
          onClick={() => {
            if (searchOpen) closeSearch();
            else setSearchOpen(true);
          }}
        >
          <IconSearch />
        </button>
        <button
          className="opshelper-sidebar-collapse"
          type="button"
          aria-label="收起侧边栏"
          title="收起侧边栏"
          onClick={onCollapse}
        >
          <IconSidePanel />
        </button>
      </div>

      <div className="opshelper-side-group">
        <div className="opshelper-new-conversation-picker" ref={newConversationMenuRef}>
          <button
            ref={newConversationButtonRef}
            type="button"
            className="opshelper-new-conversation"
            disabled={loading}
            aria-haspopup="menu"
            aria-expanded={newConversationMenuOpen}
            aria-controls={newConversationMenuOpen ? newConversationMenuId : undefined}
            onClick={() => {
              if (!newConversationMenuOpen) {
                void refreshHome(undefined, { activate: false })
                  .catch((error) => toast.error(error instanceof Error ? error.message : "刷新智能体列表失败"));
              }
              setNewConversationMenuOpen((open) => !open);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && newConversationMenuOpen) {
                event.preventDefault();
                setNewConversationMenuOpen(false);
              }
            }}
          >
            <IconCompose />
            <span>新建对话</span>
          </button>
          {newConversationMenuOpen ? (
            <div
              className="opshelper-new-conversation-menu"
              id={newConversationMenuId}
              role="menu"
              aria-label="选择智能体以新建对话"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setNewConversationMenuOpen(false);
                  newConversationButtonRef.current?.focus();
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const options = newConversationOptionRefs.current.filter(
                    (el): el is HTMLButtonElement => Boolean(el),
                  );
                  if (!options.length) return;
                  const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
                  const nextIndex = event.key === "ArrowDown"
                    ? (currentIndex + 1 + options.length) % options.length
                    : (currentIndex - 1 + options.length) % options.length;
                  options[nextIndex]?.focus();
                }
              }}
            >
              <div className="opshelper-new-conversation-hint">选择智能体</div>
              {orderedAgents.length === 0 ? <div className="opshelper-new-conversation-hint">暂无可用智能体</div> : null}
              {orderedAgents.map((agent, index) => (
                <button
                  key={agent.key}
                  ref={(element) => { newConversationOptionRefs.current[index] = element; }}
                  type="button"
                  className={`opshelper-new-conversation-option${activeAgent?.key === agent.key ? " current" : ""}`}
                  role="menuitem"
                  onClick={() => chooseAgentForNewConversation(agent.key)}
                >
                  <AgentMark id={agent.key} name={agent.name} description={agent.description} />
                  <span className="opshelper-assistant-text">
                    <span className="opshelper-assistant-name">
                      {agent.name}
                      {activeAgent?.key === agent.key ? <span className="opshelper-agent-current-tag">当前</span> : null}
                    </span>
                    <span className="opshelper-assistant-desc">{agent.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="opshelper-shortcuts">
          <Link
            className={`opshelper-shortcut${pathname.endsWith("/schedules") ? " active" : ""}`}
            href="/schedules"
            prefetch={false}
            title="定时任务：个人计划和执行记录"
            aria-current={pathname.endsWith("/schedules") ? "page" : undefined}
            onNavigate={() => {
              setShowSidebar(false);
              if (pathname.endsWith("/schedules")) refreshCurrentPage(router);
            }}
          >
            <IconClock />
            <span className="opshelper-shortcut-label">定时任务</span>
          </Link>
          <Link
            className={`opshelper-shortcut${pathname.endsWith("/files") ? " active" : ""}`}
            href="/files"
            prefetch={false}
            title="我的文件：完整文件管理"
            aria-current={pathname.endsWith("/files") ? "page" : undefined}
            onNavigate={() => {
              setShowSidebar(false);
              if (pathname.endsWith("/files")) refreshCurrentPage(router);
            }}
          >
            <IconFolder />
            <span className="opshelper-shortcut-label">我的文件</span>
          </Link>
        </div>
      </div>

      <div className="opshelper-side-label">
        <span>对话</span>
      </div>

      <nav className="opshelper-nav" aria-label="所有智能体的对话和用户功能">
        <div className="opshelper-current-conversations">
          {loading ? <div className="opshelper-conv-empty">正在读取对话…</div> : null}
          {!loading && conversationGroups.length === 0 ? (
            <div className="opshelper-conv-empty">暂无对话</div>
          ) : null}
          {conversationGroups.map((group, index) => {
            const expanded = batchMode || (expandedAgentKey === null
              ? group.agentKey === currentAgentGroupKey
              : expandedAgentKey === group.agentKey);
            const groupId = `${conversationListId}-${index}`;
            const groupIds = group.conversations.map((item) => item.id);
            const groupSelected = groupIds.filter((id) => selectedIds.has(id)).length;
            return (
              <section className="opshelper-conversation-group" key={group.agentKey}>
                <div
                  className={`opshelper-conversation-agent-row${expanded ? " expanded" : ""}${draggedAgentKey === group.agentKey ? " dragging" : ""}${dragOverAgentKey === group.agentKey ? " drag-over" : ""}`}
                  draggable={!batchMode}
                  title={batchMode ? undefined : "点击展开/收起，拖动可调整顺序"}
                  onDragStart={(event) => onAgentGroupDragStart(event, group.agentKey)}
                  onDragOver={(event) => onAgentGroupDragOver(event, group.agentKey)}
                  onDragLeave={() => {
                    setDragOverAgentKey((current) => (current === group.agentKey ? null : current));
                  }}
                  onDrop={(event) => onAgentGroupDrop(event, group.agentKey)}
                  onDragEnd={() => {
                    draggedAgentKeyRef.current = null;
                    setDraggedAgentKey(null);
                    setDragOverAgentKey(null);
                  }}
                >
                  {batchMode ? <SelectionCheckbox
                    label={`选择${group.agentName}的所有对话`}
                    checked={groupSelected === groupIds.length}
                    partial={groupSelected > 0 && groupSelected < groupIds.length}
                    disabled={batchBusy}
                    onChange={() => toggleSelection(groupIds)}
                  /> : null}
                  <button
                    className="opshelper-conversation-agent"
                    type="button"
                    aria-expanded={batchMode ? undefined : expanded}
                    aria-controls={!batchMode && expanded ? groupId : undefined}
                    disabled={batchBusy}
                    onClick={() => batchMode ? toggleSelection(groupIds) : toggleConversationGroup(group.agentKey)}
                  >
                    {!batchMode ? (
                      <span className="opshelper-conversation-agent-chevron" aria-hidden="true">
                        <IconChevron open={expanded} />
                      </span>
                    ) : null}
                    <AgentMark
                      id={group.agentKey}
                      name={group.agentName}
                      description={group.agentDescription}
                    />
                    <span className="opshelper-conversation-agent-name">{group.agentName}</span>
                    <span className="opshelper-conversation-agent-count" aria-label={`${group.conversations.length} 个对话`}>
                      {group.conversations.length}
                    </span>
                  </button>
                  {!batchMode ? <button
                    className="opshelper-conversation-agent-add"
                    type="button"
                    aria-label={`为${group.agentName}新建对话`}
                    title={`为${group.agentName}新建对话`}
                    onClick={() => startNewConversation("", group.agentKey)}
                  >
                    <IconPlus />
                  </button> : null}
                </div>
                {expanded ? (
                  <div className="opshelper-conversation-group-list" id={groupId}>
                    {group.conversations.map((item) => (
                      <div
                        className={`opshelper-conv${batchMode ? " batch" : ""}${pathname.endsWith("/chat") && item.id === activeConversationId ? " active" : ""}`}
                        key={item.id}
                      >
                        {batchMode ? <SelectionCheckbox
                          label={`选择对话 ${cleanTitle(item.title)}`}
                          checked={selectedIds.has(item.id)}
                          disabled={batchBusy}
                          onChange={() => toggleSelection([item.id])}
                        /> : null}
                        {/* 让最终生效的 URL 驱动会话切换。若先改 activeConversationId，快速跨页点击时
                            前一次路由可能在会话请求期间提交，聊天页便会遗留在加载态。 */}
                        {batchMode ? (
                          <button className="opshelper-conv-main" type="button" disabled={batchBusy} onClick={() => toggleSelection([item.id])}>
                            <span className="opshelper-conv-label">{cleanTitle(item.title)}</span>
                          </button>
                        ) : renamingId === item.id ? (
                          <div className="opshelper-conv-main opshelper-conv-renaming">
                            <input
                              className="opshelper-conv-rename-input"
                              value={renameValue}
                              maxLength={120}
                              autoFocus
                              aria-label="对话名称"
                              onFocus={(event) => event.currentTarget.select()}
                              onChange={(event) => setRenameValue(event.target.value)}
                              onBlur={() => void commitRename(item)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void commitRename(item);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setRenamingId(null);
                                }
                              }}
                            />
                          </div>
                        ) : (
                          <Link
                            className="opshelper-conv-main"
                            href={`/chat?conversation=${encodeURIComponent(item.id)}`}
                            onNavigate={() => {
                              setShowSidebar(false);
                              expandConversationGroup(item.leadAgentKey);
                              if (pathname.endsWith("/chat") && item.id === activeConversationId) {
                                refreshCurrentPage(router);
                                void refreshHome(undefined, { activate: false })
                                  .catch((error) => toast.error(error instanceof Error ? error.message : "刷新对话列表失败"));
                              }
                            }}
                            // 侧栏标题单行截断（字号抬高后更早截断），完整标题用原生提示补上。
                            title={fullConversationTitle(item.title)}
                            aria-current={pathname.endsWith("/chat") && item.id === activeConversationId ? "page" : undefined}
                          >
                            <span className="opshelper-conv-copy">
                              <span className="opshelper-conv-label">
                                {cleanTitle(item.title)}
                                {item.source && item.source !== "chat" ? <small>定时</small> : null}
                                {item.pinnedAt ? <span className="opshelper-conversation-pinned" title="已置顶"><IconPin /></span> : null}
                              </span>
                              {hasDraft(drafts[conversationDraftKey(item.id, item.leadAgentKey)]) ? <small className="opshelper-conv-draft">草稿</small> : null}
                              <span className="opshelper-conv-time" title={formatConversationTimestamp(item.updatedAt)}>
                                {formatConversationTime(item.updatedAt)}
                              </span>
                            </span>
                          </Link>
                        )}
                        {!batchMode && renamingId !== item.id ? (
                          <ConversationActions
                            title={item.title}
                            pinned={Boolean(item.pinnedAt)}
                            open={menuConversationId === item.id}
                            onOpen={() => setMenuConversationId(item.id)}
                            onClose={closeConversationMenu}
                            onPin={() => {
                              void pinConversation(item.id, !item.pinnedAt)
                                .catch((error) => toast.error(error instanceof Error ? error.message : "置顶操作失败"));
                            }}
                            onRename={() => {
                              setRenameValue(cleanTitle(item.title));
                              setRenamingId(item.id);
                            }}
                            onBatch={() => { setSelectedIds(new Set([item.id])); setBatchMode(true); }}
                            onArchive={() => void performConversationAction("archive", [item])}
                            onDelete={() => void performConversationAction("delete", [item])}
                          />
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>

        {executionBlockedReason ? <div className="opshelper-sidebar-notice">{executionBlockedReason}</div> : null}
        {batchMode ? (
          <div className="opshelper-batch-bar">
            <div className="opshelper-batch-header">
              <label>
                <SelectionCheckbox
                  label="选择所有对话"
                  checked={conversations.length > 0 && selectedConversations.length === conversations.length}
                  partial={selectedConversations.length > 0 && selectedConversations.length < conversations.length}
                  disabled={batchBusy || conversations.length === 0}
                  onChange={() => toggleSelection(conversations.map((item) => item.id))}
                />
                全选 ({selectedConversations.length})
              </label>
              <button type="button" aria-label="退出批量操作" disabled={batchBusy} onClick={() => { setBatchMode(false); setSelectedIds(new Set()); }}><IconClose /></button>
            </div>
            <div className="opshelper-batch-actions">
              <button type="button" className="danger" disabled={batchBusy || !selectedConversations.length} onClick={() => void performConversationAction("delete", selectedConversations)}><IconTrash />删除</button>
              <button type="button" disabled={batchBusy || !selectedConversations.length} onClick={() => void performConversationAction("archive", selectedConversations)}><IconArchive />归档</button>
            </div>
          </div>
        ) : null}
      </nav>

      <div className="opshelper-userbar">
          <UserProfileMenu user={user} />
          {user.role === "admin" ? (
          <Link className="opshelper-admin-link" href="/admin" title="管理" aria-label="管理">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
        ) : (
          <Link
            className="opshelper-admin-link"
            href="/agents"
            prefetch={false}
            title="智能体目录：创建并查看智能体"
            aria-label="智能体目录"
            aria-current={pathname.endsWith("/agents") ? "page" : undefined}
            onNavigate={() => {
              setShowSidebar(false);
              if (pathname.endsWith("/agents")) refreshCurrentPage(router);
            }}
          >
            <IconSettings />
          </Link>
        )}
      </div>
    </aside>
    {searchOpen && typeof document !== "undefined" ? createPortal(
      <div className="opshelper-search-overlay" onMouseDown={closeSearch}>
        <section
          className="opshelper-search-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="搜索对话"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="opshelper-search-dialog-bar">
            <IconSearch />
            <input
              ref={searchInputRef}
              value={search}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              onFocus={() => setSearchAgentMenuOpen(false)}
              onClick={() => setSearchAgentMenuOpen(false)}
              onKeyDown={(event) => {
                if (!visibleSearchItems.length) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  const next = (searchActiveIndex + 1) % visibleSearchItems.length;
                  setSearchActiveIndex(next);
                  searchResultRefs.current[next]?.scrollIntoView({ block: "nearest" });
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = (searchActiveIndex - 1 + visibleSearchItems.length) % visibleSearchItems.length;
                  setSearchActiveIndex(next);
                  searchResultRefs.current[next]?.scrollIntoView({ block: "nearest" });
                } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  const chosen = visibleSearchItems[searchActiveIndex];
                  if (chosen) {
                    event.preventDefault();
                    closeSearch();
                    setShowSidebar(false);
                    router.push(`/chat?conversation=${encodeURIComponent(chosen.conversation.id)}`);
                  }
                }
              }}
              placeholder="搜索对话标题或内容..."
              aria-label="搜索所有对话"
            />
            <div className="opshelper-search-agent-filter" ref={searchAgentFilterRef}>
              <button
                type="button"
                className="opshelper-search-agent-filter-toggle"
                aria-haspopup="dialog"
                aria-expanded={searchAgentMenuOpen}
                onClick={() => setSearchAgentMenuOpen((open) => !open)}
              >
                {searchAgentLabel}
                <IconChevron open={searchAgentMenuOpen} />
              </button>
              {searchAgentMenuOpen ? (
                <div className="opshelper-search-agent-menu" role="dialog" aria-label="筛选智能体">
                  <div className="opshelper-search-agent-menu-header">
                    <span>选择智能体</span>
                    <button
                      type="button"
                      className="opshelper-search-agent-select-all"
                      disabled={selectedSearchAgentCount === agents.length}
                      onClick={() => setSelectedSearchAgentKeys(null)}
                    >
                      全选
                    </button>
                  </div>
                  {agents.map((agent) => {
                    const checked = selectedSearchAgentKeys === null ||
                      selectedSearchAgentKeys.includes(agent.key);
                    return (
                      <label className="opshelper-search-agent-option" key={agent.key}>
                        <span>{agent.name}</span>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSearchAgent(agent.key)}
                        />
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <span className="opshelper-search-dialog-divider" aria-hidden="true" />
            <button type="button" aria-label="关闭搜索" onClick={closeSearch}>
              <IconClose />
            </button>
          </div>
          <div className="opshelper-search-dialog-results" aria-live="polite">
            {searchTerm ? (
              searchLoading ? (
                <div className="opshelper-search-dialog-empty">正在搜索…</div>
              ) : searchError ? (
                <div className="opshelper-search-dialog-empty" role="alert">{searchError}</div>
              ) : searchResults.length === 0 ? (
                <div className="opshelper-search-dialog-empty">没有匹配的对话</div>
              ) : searchResults.map(({ conversation, agentName, matchedContent }, index) => (
                <Link
                  ref={(element) => { searchResultRefs.current[index] = element; }}
                  className={`opshelper-search-result${index === searchActiveIndex ? " active" : ""}`}
                  href={`/chat?conversation=${encodeURIComponent(conversation.id)}`}
                  key={conversation.id}
                  onMouseEnter={() => setSearchActiveIndex(index)}
                  onClick={() => {
                    closeSearch();
                    setShowSidebar(false);
                  }}
                >
                  <span className="opshelper-search-result-copy">
                    <span className="opshelper-search-result-title">
                      {highlightSearchMatch(cleanTitle(conversation.title))}
                    </span>
                    {matchedContent ? (
                      <span className="opshelper-search-result-content">
                        {matchedContent.before.length > 22
                          ? `…${matchedContent.before.slice(-20)}`
                          : matchedContent.before}
                        <mark className="opshelper-search-match">{matchedContent.match}</mark>
                        {matchedContent.after}
                      </span>
                    ) : null}
                  </span>
                  <span className="opshelper-search-result-agent">{agentName}</span>
                </Link>
              ))
            ) : recentSearchItems.length > 0 ? (
              <>
                <div className="opshelper-search-section-label">最近对话</div>
                {recentSearchItems.map(({ conversation, agentName }, index) => (
                  <Link
                    ref={(element) => { searchResultRefs.current[index] = element; }}
                    className={`opshelper-search-result${index === searchActiveIndex ? " active" : ""}`}
                    href={`/chat?conversation=${encodeURIComponent(conversation.id)}`}
                    key={conversation.id}
                    onMouseEnter={() => setSearchActiveIndex(index)}
                    onClick={() => {
                      closeSearch();
                      setShowSidebar(false);
                    }}
                  >
                    <span className="opshelper-search-result-copy">
                      <span className="opshelper-search-result-title">
                        {cleanTitle(conversation.title)}
                      </span>
                    </span>
                    <span className="opshelper-search-result-meta">
                      <span className="opshelper-search-result-agent">{agentName}</span>
                      <span className="opshelper-search-result-time">{formatConversationTime(conversation.updatedAt)}</span>
                    </span>
                  </Link>
                ))}
              </>
            ) : (
              <div className="opshelper-search-dialog-empty">输入关键词搜索对话标题与消息内容</div>
            )}
            <div className="opshelper-search-dialog-foot">
              <span>↑↓ 选择</span>
              <span>Enter 打开</span>
              <span>Esc 关闭</span>
            </div>
          </div>
        </section>
      </div>,
      document.body,
    ) : null}
    </>
  );
}
