"use client";

import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { anchoredConfirmPosition } from "../ui/anchored-confirm-position";
import { IconArchive, IconEdit, IconMore, IconPin, IconTrash } from "./icons";
import { cleanTitle } from "./format";

export function ConversationActions({
  title, pinned, open, onOpen, onClose, onPin, onRename, onBatch, onArchive, onDelete,
}: {
  title: string;
  pinned: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPin: () => void;
  onRename: () => void;
  onBatch: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const place = () => {
      const position = anchoredConfirmPosition(trigger.getBoundingClientRect(), menu.getBoundingClientRect(), {
        width: window.innerWidth, height: window.innerHeight,
      });
      menu.style.left = `${position.left}px`;
      menu.style.top = `${position.top}px`;
    };
    place();
    menu.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: Event) => {
      if (!menu.contains(event.target as Node) && !trigger.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        trigger.focus();
      }
    };
    const scroll = (event: Event) => { if (!menu.contains(event.target as Node)) onClose(); };
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    document.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open, onClose]);

  const choose = (action: () => void) => { onClose(); action(); };
  const root = open ? triggerRef.current?.closest(".opshelper-shell") : null;
  return (
    <>
      <button
        ref={triggerRef} type="button" className="opshelper-conv-del opshelper-conv-more"
        aria-label={`对话操作 ${cleanTitle(title)}`} title="对话操作"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => open ? onClose() : onOpen()}
      ><IconMore /></button>
      {open && root ? createPortal(
        <div ref={menuRef} id={id} role="menu" aria-label="对话操作" className="opshelper-conversation-menu">
          <button type="button" role="menuitem" onClick={() => choose(onPin)}><IconPin />{pinned ? "取消置顶" : "置顶"}</button>
          <button type="button" role="menuitem" onClick={() => choose(onRename)}><IconEdit />重命名</button>
          <button type="button" role="menuitem" className="menu-section" onClick={() => choose(onBatch)}><IconMenuList />批量操作</button>
          <button type="button" role="menuitem" className="menu-section" onClick={() => choose(onArchive)}><IconArchive />归档</button>
          <button type="button" role="menuitem" className="danger" onClick={() => choose(onDelete)}><IconTrash />删除对话</button>
        </div>,
        root,
      ) : null}
    </>
  );
}

function IconMenuList() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m4 6 1.5 1.5L8 5m2 2h10M4 12l1.5 1.5L8 11m2 2h10M4 18l1.5 1.5L8 17m2 2h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
