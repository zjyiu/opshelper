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
      <div className="opshelper-archived-filters">
        <input
          type="search"
          aria-label="搜索归档对话"
          placeholder="搜索对话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
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
      {loading ? <p role="status">正在读取归档对话…</p> : null}
      {error ? <div role="alert">{error} <button type="button" onClick={() => void load()}>重试</button></div> : null}
      {!loading && !error && conversations.length === 0 ? <p>暂无归档对话</p> : null}
      {!loading && !error && conversations.length > 0 && filteredConversations.length === 0 ? (
        <p>没有符合条件的归档对话</p>
      ) : null}
      {filteredConversations.map((item) => (
        <div className="opshelper-archived-row" key={item.id}>
          <div>
            <Link href={`/chat?conversation=${encodeURIComponent(item.id)}&from=archive`}>
              {cleanTitle(item.title)}
            </Link>
            <span>
              {agentNames.get(item.leadAgentKey) ?? item.leadAgentKey}
              {" · "}
              {formatConversationTimestamp(item.archivedAt ?? item.updatedAt)}
            </span>
          </div>
          <div className="opshelper-archived-actions">
            <button type="button" disabled={busy !== null || loading} onClick={() => void act(item, "restore")}>恢复</button>
            <button type="button" className="danger" disabled={busy !== null || loading} onClick={() => void act(item, "delete")}>永久删除</button>
          </div>
        </div>
      ))}
    </div>
  );
}
