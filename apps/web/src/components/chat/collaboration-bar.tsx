"use client";

import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationCollaboration } from "@opshelper/shared";

import { collaborationNote, nextCollaborationPanelOpen } from "./collaboration-note";
import { IconChevron } from "./icons";

const statusLabels: Record<ConversationCollaboration["status"], string> = {
  running: "执行中",
  waiting_input: "等待回答",
  waiting_permission: "等待授权",
  failed: "失败",
  completed: "已完成",
};

/** Keep collaboration details collapsible and separate from assistant prose. */
export function CollaborationBar({
  collaborations,
  conversationId,
  inline = false,
}: {
  collaborations: ConversationCollaboration[];
  conversationId?: string | null;
  inline?: boolean;
}) {
  const note = collaborationNote(collaborations);
  const activeIds = useMemo(
    () => collaborations
      .filter((item) => item.status === "running" || item.status === "waiting_input" || item.status === "waiting_permission")
      .map((item) => item.traceId),
    [collaborations],
  );
  const [open, setOpen] = useState(() => activeIds.length > 0);
  const previousActiveIds = useRef<string[] | null>(null);
  const readingRef = useRef(false);

  useLayoutEffect(() => {
    const previous = previousActiveIds.current;
    if (previous?.length === 0 && activeIds.length > 0) readingRef.current = false;
    const reading = readingRef.current;
    setOpen((currentlyOpen) => nextCollaborationPanelOpen(
      previous,
      activeIds,
      currentlyOpen,
      reading,
    ));
    previousActiveIds.current = activeIds;
  }, [activeIds]);

  if (!note) return null;

  return (
    <div className={`opshelper-collaboration-strip${inline ? " inline" : ""}`}>
      <details
        className={`opshelper-collaboration-bar${inline ? " inline" : ""}`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="opshelper-caret" aria-hidden="true"><IconChevron open={false} /></span>
          <span className="opshelper-collaboration-bar-title">
            协作过程 · {collaborations.length} 个智能体
          </span>
          <span className={`opshelper-collaboration-note ${note.tone}`}>{note.label}</span>
        </summary>
        <div className="opshelper-collaboration-list" onWheel={() => { readingRef.current = true; }}>
          {collaborations.map((item) => (
            <div className="opshelper-collaboration-item" key={item.traceId}>
              <div>
                <strong>{item.agentKey}</strong>
                <span className={`opshelper-collaboration-status ${item.status}`}>
                  {statusLabels[item.status]}
                </span>
              </div>
              <div className="opshelper-collaboration-title">{item.title}</div>
              {item.summary ? (
                <div className="opshelper-collaboration-summary">{item.summary}</div>
              ) : null}
              {conversationId ? (
                <Link
                  className="opshelper-collaboration-link"
                  href={`/chat/${encodeURIComponent(conversationId)}/collaborations/${item.traceId}`}
                >
                  查看进度
                </Link>
              ) : null}
              <div className="opshelper-collaboration-trace">排障编号 {item.traceId}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
