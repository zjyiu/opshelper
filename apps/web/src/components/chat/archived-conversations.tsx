"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ConversationSummary } from "@opshelper/shared";
import { deleteConversation, listArchivedConversations, restoreConversation } from "@/lib/browser-api";
import { useWorkspace } from "../workspace-shell";
import { confirm as confirmDialog } from "../ui/dialog-host";
import { cleanTitle, formatConversationTimestamp } from "./format";
import { filterAndSortArchivedConversations } from "./archived-conversation-list";
import { IconArchive, IconClose, IconSearch } from "./icons";

export function ArchivedConversations() {
  const { agents, refreshHome } = useWorkspace();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const loadSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const results = await listArchivedConversations();
      if (sequence === loadSequence.current) setConversations(results);
    } catch (cause) {
      if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "读取归档对话失败");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  const act = async (item: ConversationSummary, action: "restore" | "delete") => {
    if (busyRef.current) return;
    if (action === "delete" && !await confirmDialog({
      title: "永久删除对话？",
      description: `将永久删除“${cleanTitle(item.title)}”及其聊天记录，无法恢复。工作区文件不会删除。`,
      confirmLabel: "永久删除",
      variant: "danger",
    })) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(item.id);
    try {
      await (action === "delete" ? deleteConversation(item.id) : restoreConversation(item.id));
      setConversations((current) => current.filter((entry) => entry.id !== item.id));
      toast.success(action === "delete" ? "对话已永久删除" : "对话已恢复");
      void refreshHome(undefined, { activate: false })
        .catch((cause) => toast.error(cause instanceof Error ? cause.message : "刷新对话列表失败"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "操作失败，请重试");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  const agentNames = new Map(agents.map((agent) => [agent.key, agent.name]));
  const archivedAgentOptions = [...new Set(conversations.map((item) => item.leadAgentKey))]
    .map((key) => ({ key, name: agentNames.get(key) ?? key }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const filteredConversations = filterAndSortArchivedConversations(conversations, {
    query,
    agentKey,
  });
  return (
    <div className="opshelper-archived-page">
      <section className="opshelper-archived-card">
        <div className="opshelper-archived-toolbar">
          <div className="opshelper-archived-filters">
            <div className="opshelper-archived-search-wrap">
              <IconSearch />
              <input
                type="search"
                aria-label="搜索归档对话"
                placeholder="搜索归档对话标题..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="opshelper-archived-search-clear"
                  aria-label="清除搜索"
                  title="清除搜索"
                  onClick={() => setQuery("")}
                >
                  <IconClose />
                </button>
              ) : null}
            </div>
            <select
              aria-label="按智能体筛选"
              value={agentKey}
              onChange={(event) => setAgentKey(event.target.value)}
            >
              <option value="">所有智能体</option>
              {archivedAgentOptions.map((agent) => (
                <option key={agent.key} value={agent.key}>{agent.name}</option>
              ))}
            </select>
          </div>
          {!loading && !error ? (
            <div className="opshelper-archived-count">
              {query.trim() || agentKey
                ? `显示 ${filteredConversations.length} / ${conversations.length} 条`
                : `共 ${conversations.length} 条`}
            </div>
          ) : null}
        </div>
        {loading ? (
          <div className="opshelper-archived-state" role="status">正在读取归档对话…</div>
        ) : null}
        {error ? (
          <div className="opshelper-archived-error" role="alert">
            <span>{error}</span>
            <button type="button" className="button-secondary" onClick={() => void load()}>重试</button>
          </div>
        ) : null}
        {!loading && !error && conversations.length === 0 ? (
          <div className="opshelper-archived-empty">
            <span className="opshelper-archived-empty-icon" aria-hidden="true"><IconArchive /></span>
            <strong>暂无归档对话</strong>
            <span>在左侧对话菜单中选择「归档」后，对话会出现在这里并可随时恢复。</span>
          </div>
        ) : null}
        {!loading && !error && conversations.length > 0 && filteredConversations.length === 0 ? (
          <div className="opshelper-archived-empty">
            <strong>没有符合条件的归档对话</strong>
            <span>换个关键词或智能体筛选试试。</span>
            <button type="button" className="button-secondary" onClick={() => { setQuery(""); setAgentKey(""); }}>
              重置筛选
            </button>
          </div>
        ) : null}
        {filteredConversations.length > 0 ? (
          <div className="opshelper-archived-list">
            {filteredConversations.map((item) => (
              <div className="opshelper-archived-row" key={item.id}>
                <div className="opshelper-archived-row-info">
                  <Link href={`/chat?conversation=${encodeURIComponent(item.id)}&from=archive`}>
                    {cleanTitle(item.title)}
                  </Link>
                  <span>
                    {agentNames.get(item.leadAgentKey) ?? item.leadAgentKey}
                    {" · "}
                    归档于 {formatConversationTimestamp(item.archivedAt ?? item.updatedAt)}
                  </span>
                </div>
                <div className="opshelper-archived-actions">
                  <button type="button" disabled={busy !== null || loading} onClick={() => void act(item, "restore")}>
                    {busy === item.id ? "处理中…" : "恢复"}
                  </button>
                  <button type="button" className="danger" disabled={busy !== null || loading} onClick={() => void act(item, "delete")}>
                    永久删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
