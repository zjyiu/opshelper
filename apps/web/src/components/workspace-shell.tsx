"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ConversationAgent, ConversationSummary } from "@opshelper/shared";

import {
  archiveConversation,
  renameConversation,
  getConversation,
  listConversations,
} from "@/lib/browser-api";
import { AgentMark } from "./chat/assistant";
import { resolveConversationHistory, RECENT_CONVERSATION_LIMIT } from "./chat/conversation-history";
import { cleanTitle, formatConversationTime, formatConversationTimestamp, fullConversationTitle } from "./chat/format";
import type { NewConversationRequest } from "./chat/new-conversation-request";
import {
  IconChat,
  IconAgent,
  IconChevron,
  IconClock,
  IconCompose,
  IconDisclosure,
  IconEdit,
  IconFolder,
  IconMenu,
  IconSidePanel,
  IconSearch,
} from "./chat/icons";
import { ConversationArchiveAction } from "./chat/conversation-archive-action";
import { ConversationDraftProvider, useConversationDraftStore } from "./chat/conversation-draft-provider";
import { conversationDraftKey, hasDraft } from "./chat/conversation-drafts";

const CHAT_CONTEXT_KEY = "opshelper:conversation";
const CHAT_AGENT_KEY = "opshelper:agent";
// “显示更早”按钮要从可用高度里扣掉：展开过一次后量它的真实高度，
// 首次渲染时按钮还没挂载，用与 CSS 对齐的兜底值（行高 40 + 外边距 6）。
const FOLD_RESERVE_FALLBACK = 46;
const FOLD_BUTTON_GAP = 6;

type WorkspaceUser = {
  name: string;
  username: string;
  role: string;
};

interface WorkspaceContextValue {
  agents: ConversationAgent[];
  conversations: ConversationSummary[];
  activeAgent: ConversationAgent | null;
  activeConversationId: string | null;
  loading: boolean;
  executionBlockedReason: string | null;
  showAttachments: boolean;
  renameConversationTitle: (conversationId: string, title: string) => Promise<void>;
  showSidebar: boolean;
  newConversationRequest: NewConversationRequest | null;
  acknowledgeNewConversationRequest: (requestId: number) => void;
  refreshHome: (preferredConversationId?: string | null, options?: { activate?: boolean }) => Promise<void>;
  activateConversation: (conversationId: string, agentKey?: string) => void;
  updateConversation: (conversation: ConversationSummary) => void;
  selectAgent: (agentKey: string) => void;
  startNewConversation: (prefill?: string) => void;
  removeConversation: (conversationId: string) => Promise<void>;
  setShowAttachments: (value: boolean | ((current: boolean) => boolean)) => void;
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
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<ConversationAgent[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeAgentKey, setActiveAgentKey] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [executionBlockedReason, setExecutionBlockedReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAttachments, setShowAttachments] = useState(false);
  const [sideWidth, setSideWidth] = useState(SIDE_WIDTH.fallback);
  const [artWidth, setArtWidth] = useState(ART_WIDTH.fallback);
  useEffect(() => {
    setSideWidth(readWidth(SIDE_WIDTH.key, SIDE_WIDTH));
    setArtWidth(readWidth(ART_WIDTH.key, ART_WIDTH));
  }, []);
  const changeSideWidth = useCallback((width: number) => {
    setSideWidth(width);
    saveWidth(SIDE_WIDTH.key, width);
  }, []);
  const changeArtWidth = useCallback((width: number) => {
    setArtWidth(width);
    saveWidth(ART_WIDTH.key, width);
  }, []);
  const [showSidebar, setShowSidebar] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [newConversationRequest, setNewConversationRequest] = useState<NewConversationRequest | null>(null);
  const newConversationSequenceRef = useRef(0);
  const activeAgentKeyRef = useRef<string | null>(null);
  const activeConversationRef = useRef<string | null>(null);
  const navigationGenerationRef = useRef(0);
  const handledNewRouteRef = useRef<string | null>(null);
  // 不在会话列表里的对话（定时任务）每换一次链接只尝试打开一次，避免重复请求和提示。
  const requestedConversationRef = useRef<string | null>(null);
  // Archive callbacks may outlive the route they were invoked from.
  const currentRouteRef = useRef({ pathname, conversationId: searchParams.get("conversation") });
  currentRouteRef.current = { pathname, conversationId: searchParams.get("conversation") };

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
    const home = await listConversations();
    setAgents(home.agents);
    setConversations(home.conversations);
    setExecutionBlockedReason(home.executionBlockedReason);

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
    if (generation !== navigationGenerationRef.current) return;
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
  }, [activateConversation, clearActiveConversation, setActiveAgent]);

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
    if (!pathname.endsWith("/chat")) setShowAttachments(false);
  }, [pathname]);

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

  const startNewConversation = useCallback((prefill = "") => {
    clearActiveConversation();
    setShowSidebar(false);
    newConversationSequenceRef.current += 1;
    setNewConversationRequest({ id: newConversationSequenceRef.current, prefill });
    router.push(`/chat?new=${Date.now()}`);
  }, [clearActiveConversation, router]);

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

  const updateConversation = useCallback((conversation: ConversationSummary) => {
    setConversations((current) => current.map((item) =>
      item.id === conversation.id ? conversation : item));
  }, []);

  const contextValue = useMemo<WorkspaceContextValue>(() => ({
    agents,
    conversations,
    activeAgent,
    activeConversationId,
    loading,
    executionBlockedReason,
    showAttachments,
    showSidebar,
    newConversationRequest,
    acknowledgeNewConversationRequest,
    refreshHome,
    activateConversation,
    updateConversation,
    selectAgent,
    startNewConversation,
    removeConversation,
    renameConversationTitle,
    setShowAttachments,
    setShowSidebar,
  }), [
    activeAgent,
    activeConversationId,
    acknowledgeNewConversationRequest,
    activateConversation,
    agents,
    conversations,
    executionBlockedReason,
    loading,
    newConversationRequest,
    refreshHome,
    removeConversation,
    renameConversationTitle,
    selectAgent,
    showAttachments,
    showSidebar,
    startNewConversation,
    updateConversation,
  ]);

  return (
    <ConversationDraftProvider key={user.username} userKey={user.username}>
      <WorkspaceContext.Provider value={contextValue}>
        <div
          className={`opshelper-shell${showAttachments ? " opshelper-shell-files" : ""}${showSidebar ? " opshelper-sidebar-open" : ""}${sidebarCollapsed ? " opshelper-sidebar-collapsed" : ""}`}
          style={{ "--g-side-user": `${sideWidth}px`, "--g-art-user": `${artWidth}px` } as React.CSSProperties}
        >
          <WorkspaceSidebar user={user} onCollapse={() => { setShowSidebar(false); setSidebarCollapsed(true); }} />
          {sidebarCollapsed ? (
            <button
              className="opshelper-sidebar-expand"
              type="button"
              aria-label="展开侧边栏"
              title="展开侧边栏"
              onClick={() => setSidebarCollapsed(false)}
            >
              <IconSidePanel />
            </button>
          ) : (
            <ColumnResizer edge="side" range={SIDE_WIDTH} width={sideWidth} label="调整会话列表宽度" onChange={changeSideWidth} />
          )}
          {showAttachments ? (
            <ColumnResizer edge="art" range={ART_WIDTH} width={artWidth} label="调整文件列表宽度" onChange={changeArtWidth} />
          ) : null}
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
const ART_WIDTH = { min: 280, max: 560, fallback: 360, key: "opshelper.artWidth" };

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
  edge: "side" | "art";
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
    // 右栏的左边界向左拖动意味着变宽。
    onChange(clampWidth(startRef.current.width + (edge === "side" ? delta : -delta), range));
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
    conversations,
    activeAgent,
    activeConversationId,
    loading,
    executionBlockedReason,
    selectAgent,
    startNewConversation,
    removeConversation,
    renameConversationTitle,
    showSidebar,
    setShowSidebar,
  } = useWorkspace();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [showAllConversations, setShowAllConversations] = useState(false);
  const [archiveConversationId, setArchiveConversationId] = useState<string | null>(null);
  const closeArchive = useCallback(() => setArchiveConversationId(null), []);
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
    closeArchive();
  }, [activeAgent?.key, activeConversationId, pathname, search, showAllConversations, showSidebar, closeArchive]);
  // 折叠后能列几条由可用高度决定，先按 RECENT_CONVERSATION_LIMIT 兜底，量到高度后再铺满。
  const [collapsedCapacity, setCollapsedCapacity] = useState(RECENT_CONVERSATION_LIMIT);
  const menuId = useId();
  const conversationListId = useId();
  const conversationListRef = useRef<HTMLDivElement>(null);
  const selectorRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectorWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const selectedIndex = Math.max(0, agents.findIndex((item) => item.key === activeAgent?.key));
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!selectorWrapRef.current?.contains(event.target as Node)) setAgentMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [activeAgent?.key, agentMenuOpen, agents]);

  const activeConversations = useMemo(() => {
    const term = search.trim().toLowerCase();
    return conversations.filter((item) =>
      item.leadAgentKey === activeAgent?.key &&
      (!term || item.title.toLowerCase().includes(term)));
  }, [activeAgent?.key, conversations, search]);

  const searchTerm = search.trim();
  // 分区标题上的条数：搜索时就是命中数，与列表里真正渲染的条数一致。
  const visibleCount = activeConversations.length;
  const {
    listed: listedConversations,
    earlierCount,
    expandable,
    expanded: conversationsExpanded,
  } = resolveConversationHistory(activeConversations, {
    activeConversationId,
    searchTerm,
    showAll: showAllConversations,
    limit: collapsedCapacity,
  });

  // 侧栏是固定高度的可伸缩区域，能列几条会话只有量过才知道：按行高和容器高度算出折叠窗口，
  // 并预留“显示更早”按钮的位置，折叠状态就既不浪费空位也不会冒出滚动条。
  useEffect(() => {
    const list = conversationListRef.current;
    if (!list) return;
    const measure = () => {
      const rowHeight = list.querySelector<HTMLElement>(".opshelper-conv")?.offsetHeight ?? 0;
      if (!rowHeight) return;
      const fold = list.querySelector<HTMLElement>(".opshelper-conv-more");
      const reserve = fold ? fold.offsetHeight + FOLD_BUTTON_GAP : FOLD_RESERVE_FALLBACK;
      const capacity = Math.floor((list.clientHeight - reserve) / rowHeight);
      setCollapsedCapacity(Math.max(1, capacity));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeConversations.length]);

  const chooseAgent = (agentKey: string) => {
    selectAgent(agentKey);
    setAgentMenuOpen(false);
    requestAnimationFrame(() => selectorRef.current?.focus());
  };

  const handleOptionKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setAgentMenuOpen(false);
      selectorRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? agents.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + agents.length) % agents.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <aside className="opshelper-sidebar" id="opshelper-sidebar" aria-label="小信运维助手导航">
      <div className="opshelper-brand">
        <span className="opshelper-brand-name">小信运维助手</span>
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
        <div className="opshelper-agent-selector" ref={selectorWrapRef}>
          <button
            ref={selectorRef}
            type="button"
            className="opshelper-agent-selector-button"
            aria-haspopup="listbox"
            aria-expanded={agentMenuOpen}
            aria-controls={menuId}
            disabled={loading || agents.length === 0}
            // 窄栏里描述总被截断，所以触发按钮只留名字，完整描述放下拉项和 title。
            title={activeAgent ? `${activeAgent.name}：${activeAgent.description}` : "请联系管理员分配智能体"}
            onClick={() => setAgentMenuOpen((value) => !value)}
            onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                setAgentMenuOpen(true);
              }
            }}
          >
            {activeAgent ? (
              <AgentMark
                id={activeAgent.key}
                name={activeAgent.name}
                description={activeAgent.description}
              />
            ) : <span className="opshelper-agent-mark" />}
            <span className="opshelper-agent-name">{activeAgent?.name ?? "暂无可用智能体"}</span>
            <IconChevron open={agentMenuOpen} />
          </button>
          {agentMenuOpen ? (
            <div className="opshelper-agent-menu" id={menuId} role="listbox" aria-label="切换智能体">
              {agents.map((agent, index) => (
                <button
                  key={agent.key}
                  ref={(element) => { optionRefs.current[index] = element; }}
                  type="button"
                  className={`opshelper-agent-option${agent.key === activeAgent?.key ? " active" : ""}`}
                  role="option"
                  aria-selected={agent.key === activeAgent?.key}
                  onClick={() => chooseAgent(agent.key)}
                  onKeyDown={(event) => handleOptionKey(event, index)}
                >
                  <AgentMark id={agent.key} name={agent.name} description={agent.description} />
                  <span className="opshelper-assistant-text">
                    <span className="opshelper-assistant-name">{agent.name}</span>
                    <span className="opshelper-assistant-desc">{agent.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="opshelper-new-conversation"
          disabled={!activeAgent}
          onClick={() => startNewConversation()}
        >
          <IconCompose />
          <span>新建会话</span>
        </button>

        <div className="opshelper-shortcuts">
          <Link
            className={`opshelper-shortcut${pathname.endsWith("/agents") ? " active" : ""}`}
            href="/agents"
            title="智能体目录：创建并查看智能体"
            aria-current={pathname.endsWith("/agents") ? "page" : undefined}
            onClick={() => setShowSidebar(false)}
          >
            <IconAgent />
            <span className="opshelper-shortcut-label">智能体目录</span>
          </Link>
          <Link
            className={`opshelper-shortcut${pathname.endsWith("/schedules") ? " active" : ""}`}
            href="/schedules"
            title="定时任务：个人计划和执行记录"
            aria-current={pathname.endsWith("/schedules") ? "page" : undefined}
            onClick={() => setShowSidebar(false)}
          >
            <IconClock />
            <span className="opshelper-shortcut-label">定时任务</span>
          </Link>
          <Link
            className={`opshelper-shortcut${pathname.endsWith("/files") ? " active" : ""}`}
            href="/files"
            title="我的文件：完整文件管理"
            aria-current={pathname.endsWith("/files") ? "page" : undefined}
            onClick={() => setShowSidebar(false)}
          >
            <IconFolder />
            <span className="opshelper-shortcut-label">我的文件</span>
          </Link>
        </div>
      </div>

      <div className="opshelper-side-label">
        <span>会话</span>
        {!loading && visibleCount > 0 ? <span className="opshelper-side-count">{visibleCount}</span> : null}
        <button
          type="button"
          className={`opshelper-search-toggle${searchOpen ? " active" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          aria-label={searchOpen ? "收起搜索" : "搜索会话"}
          aria-expanded={searchOpen}
          title="搜索会话"
          onClick={() => {
            if (searchOpen) setSearch("");
            setSearchOpen(!searchOpen);
          }}
        >
          <IconSearch />
        </button>
      </div>

      {searchOpen ? (
        <div className="opshelper-search">
          <IconSearch />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearch("");
                setSearchOpen(false);
              }
            }}
            placeholder="搜索会话"
            aria-label="搜索当前智能体的会话"
            onBlur={() => {
              if (!search.trim()) setSearchOpen(false);
            }}
            autoFocus
          />
        </div>
      ) : null}

      <nav className="opshelper-nav" aria-label="当前智能体的会话和用户功能">
        <div className="opshelper-current-conversations" id={conversationListId} ref={conversationListRef}>
          {loading ? <div className="opshelper-conv-empty">正在读取会话…</div> : null}
          {!loading && activeConversations.length === 0 ? (
            <div className="opshelper-conv-empty">{searchTerm ? "没有匹配的会话" : "暂无会话"}</div>
          ) : null}
          {listedConversations.map((item) => (
            <div className={`opshelper-conv${pathname.endsWith("/chat") && item.id === activeConversationId ? " active" : ""}`} key={item.id}>
              {/* 让最终生效的 URL 驱动会话切换。若先改 activeConversationId，快速跨页点击时
                  前一次路由可能在会话请求期间提交，聊天页便会遗留在加载态。 */}
              {renamingId === item.id ? (
                <div className="opshelper-conv-main opshelper-conv-renaming">
                  <IconChat />
                  <input
                    className="opshelper-conv-rename-input"
                    value={renameValue}
                    maxLength={120}
                    autoFocus
                    aria-label="会话名称"
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
                onClick={() => setShowSidebar(false)}
                // 侧栏标题单行截断（字号抬高后更早截断），完整标题用原生提示补上。
                title={fullConversationTitle(item.title)}
                aria-current={pathname.endsWith("/chat") && item.id === activeConversationId ? "page" : undefined}
              >
                <IconChat />
                <span className="opshelper-conv-copy">
                  <span className="opshelper-conv-label">
                    {cleanTitle(item.title)}
                    {item.source && item.source !== "chat" ? <small>定时</small> : null}
                  </span>
                  {hasDraft(drafts[conversationDraftKey(item.id, item.leadAgentKey)]) ? <small className="opshelper-conv-draft">草稿</small> : null}
                  <span className="opshelper-conv-time" title={formatConversationTimestamp(item.updatedAt)}>
                    {formatConversationTime(item.updatedAt)}
                  </span>
                </span>
              </Link>
              )}
              {renamingId === item.id ? null : (
                <button
                  type="button"
                  className="opshelper-conv-del opshelper-conv-edit"
                  aria-label={`重命名会话 ${cleanTitle(item.title)}`}
                  title="重命名"
                  onClick={() => {
                    setRenameValue(cleanTitle(item.title));
                    setRenamingId(item.id);
                  }}
                >
                  <IconEdit />
                </button>
              )}
              <ConversationArchiveAction
                title={item.title}
                open={archiveConversationId === item.id}
                onOpen={() => setArchiveConversationId(item.id)}
                onClose={closeArchive}
                onArchive={() => removeConversation(item.id)}
              />
            </div>
          ))}

          {expandable && !conversationsExpanded ? (
            <button
              type="button"
              className="opshelper-conv-more"
              aria-expanded={false}
              aria-controls={conversationListId}
              onClick={() => setShowAllConversations(true)}
            >
              <span>显示更早的 {earlierCount} 条会话</span>
              <IconDisclosure expanded={false} />
            </button>
          ) : null}
          {conversationsExpanded ? (
            <button
              type="button"
              className="opshelper-conv-more"
              aria-expanded
              aria-controls={conversationListId}
              onClick={() => setShowAllConversations(false)}
            >
              <span>收起更早的会话</span>
              <IconDisclosure expanded />
            </button>
          ) : null}
        </div>

        {executionBlockedReason ? <div className="opshelper-sidebar-notice">{executionBlockedReason}</div> : null}
      </nav>

      <div className="opshelper-userbar">
        <span className="opshelper-user-avatar">{Array.from(user.name.trim() || user.username)[0]?.toUpperCase()}</span>
        <Link
          className={`opshelper-user-name${pathname.endsWith("/user") ? " active" : ""}`}
          href="/user"
          aria-current={pathname.endsWith("/user") ? "page" : undefined}
          title="个人设置"
        >
          {user.name}
        </Link>
        {user.role === "admin" ? (
          <Link className="opshelper-admin-link" href="/admin" title="管理" aria-label="管理">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
