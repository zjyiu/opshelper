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
  renameConversation,
  getConversation,
  listConversations,
  searchConversations,
} from "@/lib/browser-api";
import { AgentMark } from "./chat/assistant";
import { groupConversationsByAgent } from "./chat/conversation-groups";
import { cleanTitle, formatConversationTime, formatConversationTimestamp, fullConversationTitle } from "./chat/format";
import type { NewConversationRequest } from "./chat/new-conversation-request";
import {
  IconAgent,
  IconChevron,
  IconClock,
  IconClose,
  IconCompose,
  IconEdit,
  IconFolder,
  IconMenu,
  IconPlus,
  IconSidePanel,
  IconSearch,
} from "./chat/icons";
import { ConversationArchiveAction } from "./chat/conversation-archive-action";
import { ConversationDraftProvider, useConversationDraftStore } from "./chat/conversation-draft-provider";
import { conversationDraftKey, hasDraft } from "./chat/conversation-drafts";
import { UserProfileMenu } from "./user-profile-menu";

const CHAT_CONTEXT_KEY = "opshelper:conversation";
const CHAT_AGENT_KEY = "opshelper:agent";

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
  startNewConversation: (prefill?: string, agentKey?: string) => void;
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
            <ColumnResizer edge="side" range={SIDE_WIDTH} width={sideWidth} label="调整对话列表宽度" onChange={changeSideWidth} />
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
    startNewConversation,
    removeConversation,
    renameConversationTitle,
    showSidebar,
    setShowSidebar,
  } = useWorkspace();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedSearchAgentKeys, setSelectedSearchAgentKeys] = useState<string[] | null>(null);
  const [searchAgentMenuOpen, setSearchAgentMenuOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [newConversationMenuOpen, setNewConversationMenuOpen] = useState(false);
  const [expandedAgentKey, setExpandedAgentKey] = useState<string | null>(null);
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
  }, [activeAgent?.key, activeConversationId, pathname, search, showSidebar, closeArchive]);
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
    setSelectedSearchAgentKeys(null);
    setSearchAgentMenuOpen(false);
    setSearchResults([]);
    setSearchError(null);
    requestAnimationFrame(() => searchButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSearch();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSearch, searchOpen]);

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

  const conversationGroups = useMemo(
    () => groupConversationsByAgent(conversations, agents),
    [agents, conversations],
  );
  const currentAgentGroupKey = conversationGroups.find((group) =>
    group.conversations.some((item) => item.id === activeConversationId))?.agentKey
    ?? conversationGroups.find((group) => group.agentKey === activeAgent?.key)?.agentKey
    ?? conversationGroups[0]?.agentKey
    ?? null;

  useEffect(() => {
    setExpandedAgentKey(currentAgentGroupKey);
  }, [activeAgent?.key, activeConversationId, currentAgentGroupKey]);

  const toggleConversationGroup = (agentKey: string) => {
    const currentlyExpanded = expandedAgentKey ?? currentAgentGroupKey;
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
          title="搜索对话"
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
            disabled={loading || agents.length === 0}
            aria-haspopup="menu"
            aria-expanded={newConversationMenuOpen}
            aria-controls={newConversationMenuOpen ? newConversationMenuId : undefined}
            onClick={() => setNewConversationMenuOpen((open) => !open)}
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
                }
              }}
            >
              <div className="opshelper-new-conversation-hint">选择智能体</div>
              {agents.map((agent, index) => (
                <button
                  key={agent.key}
                  ref={(element) => { newConversationOptionRefs.current[index] = element; }}
                  type="button"
                  className="opshelper-new-conversation-option"
                  role="menuitem"
                  onClick={() => chooseAgentForNewConversation(agent.key)}
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
        <span>对话</span>
      </div>

      <nav className="opshelper-nav" aria-label="所有智能体的对话和用户功能">
        <div className="opshelper-current-conversations">
          {loading ? <div className="opshelper-conv-empty">正在读取对话…</div> : null}
          {!loading && conversationGroups.length === 0 ? (
            <div className="opshelper-conv-empty">暂无对话</div>
          ) : null}
          {conversationGroups.map((group, index) => {
            const expanded = expandedAgentKey === null
              ? group.agentKey === currentAgentGroupKey
              : expandedAgentKey === group.agentKey;
            const groupId = `${conversationListId}-${index}`;
            return (
              <section className="opshelper-conversation-group" key={group.agentKey}>
                <div className="opshelper-conversation-agent-row">
                  <button
                    className="opshelper-conversation-agent"
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={expanded ? groupId : undefined}
                    onClick={() => toggleConversationGroup(group.agentKey)}
                  >
                    <AgentMark
                      id={group.agentKey}
                      name={group.agentName}
                      description={group.agentDescription}
                    />
                    <span className="opshelper-conversation-agent-name">{group.agentName}</span>
                  </button>
                  <button
                    className="opshelper-conversation-agent-add"
                    type="button"
                    aria-label={`为${group.agentName}新建对话`}
                    title={`为${group.agentName}新建对话`}
                    onClick={() => startNewConversation("", group.agentKey)}
                  >
                    <IconPlus />
                  </button>
                </div>
                {expanded ? (
                  <div className="opshelper-conversation-group-list" id={groupId}>
                    {group.conversations.map((item) => (
                      <div
                        className={`opshelper-conv${pathname.endsWith("/chat") && item.id === activeConversationId ? " active" : ""}`}
                        key={item.id}
                      >
                        {/* 让最终生效的 URL 驱动会话切换。若先改 activeConversationId，快速跨页点击时
                            前一次路由可能在会话请求期间提交，聊天页便会遗留在加载态。 */}
                        {renamingId === item.id ? (
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
                            onClick={() => {
                              setShowSidebar(false);
                              expandConversationGroup(item.leadAgentKey);
                            }}
                            // 侧栏标题单行截断（字号抬高后更早截断），完整标题用原生提示补上。
                            title={fullConversationTitle(item.title)}
                            aria-current={pathname.endsWith("/chat") && item.id === activeConversationId ? "page" : undefined}
                          >
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
                            aria-label={`重命名对话 ${cleanTitle(item.title)}`}
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
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>

        {executionBlockedReason ? <div className="opshelper-sidebar-notice">{executionBlockedReason}</div> : null}
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
        ) : null}
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
              placeholder="搜索对话内容..."
              aria-label="搜索所有对话"
            />
            <div className="opshelper-search-agent-filter">
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
          {searchTerm ? (
            <div className="opshelper-search-dialog-results" aria-live="polite">
              {searchLoading ? (
                <div className="opshelper-search-dialog-empty">正在搜索…</div>
              ) : searchError ? (
                <div className="opshelper-search-dialog-empty" role="alert">{searchError}</div>
              ) : searchResults.length === 0 ? (
                <div className="opshelper-search-dialog-empty">没有匹配的对话</div>
              ) : searchResults.map(({ conversation, agentName, matchedContent }) => (
                <Link
                  className="opshelper-search-result"
                  href={`/chat?conversation=${encodeURIComponent(conversation.id)}`}
                  key={conversation.id}
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
                        {matchedContent.before}
                        <mark className="opshelper-search-match">{matchedContent.match}</mark>
                        {matchedContent.after}
                      </span>
                    ) : null}
                  </span>
                  <span className="opshelper-search-result-agent">{agentName}</span>
                </Link>
              ))}
            </div>
          ) : null}
        </section>
      </div>,
      document.body,
    ) : null}
    </>
  );
}
