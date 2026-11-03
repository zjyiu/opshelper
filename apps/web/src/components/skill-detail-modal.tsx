"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

interface SkillDetailModalProps {
  name: string;
  description: string;
  fileCount: number;
  updatedAt: string;
  actionLabel: string;
  actionVariant: "button" | "button-danger";
  busy?: boolean;
  onAction: () => void;
  onClose: () => void;
}

export function SkillDetailModal({
  name,
  description,
  fileCount,
  updatedAt,
  actionLabel,
  actionVariant,
  busy,
  onAction,
  onClose,
}: SkillDetailModalProps) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="file-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="file-dialog skill-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={name}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="file-dialog-title skill-detail-name">{name}</div>
        <div className="skill-detail-description">{description || "暂无描述"}</div>
        <small className="mono skill-detail-meta">
          {fileCount} 个文件 · 更新于 {new Date(updatedAt).toLocaleString("zh-CN")}
        </small>
        <div className="inline-actions file-dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>
            关闭
          </button>
          <button className={actionVariant} type="button" disabled={busy} onClick={onAction}>
            {actionLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
