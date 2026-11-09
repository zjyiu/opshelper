"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { parentPath, rootPath, parseJson, type FileInfo } from "../file-manager/utils";
import { confirm as confirmDialog } from "@/components/ui/dialog-host";
import { toast } from "@/lib/toast";
import { IconChevron, IconClose, IconDownload, IconFolder, IconPaperclip, IconTrash } from "./icons";
import type { MentionFile } from "./types";

const FILE_VIEWS = [
  { id: "all", label: "全部文件", path: rootPath },
  { id: "uploads", label: "对话上传文件", path: `${rootPath}/chat-uploads` },
  { id: "outputs", label: "生成文件", path: `${rootPath}/outputs` },
] as const;

type FileView = (typeof FILE_VIEWS)[number]["id"];

export function AttachmentPanel({
  onAttach,
  onClose,
}: {
  onAttach: (file: MentionFile) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<FileView>("all");
  const [path, setPath] = useState(rootPath);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const load = useCallback(async (nextPath: string) => {
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    setPath(nextPath);
    try {
      const response = await fetch(
        `/v1/users/me/files/list?path=${encodeURIComponent(nextPath)}`,
        { cache: "no-store" },
      );
      const payload = await parseJson<{ files: FileInfo[] }>(response);
      if (request !== requestId.current) return;
      setFiles(payload.files);
      setPath(nextPath);
    } catch (caught) {
      if (request !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : "文件列表加载失败");
      setFiles([]);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(rootPath);
  }, [load]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose]);

  function changeView(nextView: FileView) {
    setView(nextView);
    const nextRoot = FILE_VIEWS.find((item) => item.id === nextView)?.path ?? rootPath;
    void load(nextRoot);
  }

  const scopeRoot = FILE_VIEWS.find((item) => item.id === view)?.path ?? rootPath;
  const canGoUp = path !== scopeRoot;

  async function deleteFile(file: FileInfo) {
    const confirmed = await confirmDialog({
      title: `删除文件 ${file.name}`,
      description: "该文件会被删除，且无法恢复。",
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!confirmed) return;

    setDeletingPath(file.path);
    try {
      await parseJson<{ success: boolean }>(
        await fetch("/v1/users/me/files/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: file.path }),
        }),
      );
      toast.success("文件已删除");
      await load(path);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setDeletingPath(null);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="file-dialog-backdrop opshelper-reference-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="opshelper-reference-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="opshelper-reference-title"
        aria-busy={loading}
      >
        <div className="opshelper-files-head">
          <div className="opshelper-files-title" id="opshelper-reference-title">引用/下载文件</div>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭文件弹窗">
            <IconClose />
          </button>
        </div>
        <div className="opshelper-reference-tabs" role="group" aria-label="文件分类">
          {FILE_VIEWS.map((item) => (
            <button
              type="button"
              aria-pressed={view === item.id}
              className={view === item.id ? "active" : ""}
              key={item.id}
              onClick={() => changeView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="opshelper-attachment-path">
          {canGoUp ? (
            <button type="button" onClick={() => void load(parentPath(path))} title="上一级">
              <span className="opshelper-attachment-back"><IconChevron open={false} /></span>
            </button>
          ) : null}
          <span>{path.replace(/^\/workspace\/?/, "工作目录/").replace(/\/$/, "")}</span>
        </div>
        <div className="opshelper-attachment-list">
          {loading ? <div className="opshelper-attachment-empty">正在加载…</div> : null}
          {error ? <div className="opshelper-attachment-error" role="alert">{error}</div> : null}
          {!loading && !error && files.length === 0 ? (
            <div className="opshelper-attachment-empty">当前目录没有文件</div>
          ) : null}
          {files.map((file) => (
            <div className="opshelper-attachment-row" key={file.path}>
              {file.type === "directory" ? (
                <button
                  type="button"
                  className="opshelper-attachment-open"
                  onClick={() => void load(file.path)}
                  title={`打开文件夹 ${file.name}`}
                >
                  <IconFolder />
                  <span>{file.name}</span>
                  <IconChevron open={false} />
                </button>
              ) : (
                <>
                  <IconPaperclip />
                  <span className="opshelper-attachment-name">{file.name}</span>
                  <button
                    type="button"
                    className="opshelper-attachment-add"
                    onClick={() => onAttach({
                      rel: file.path.replace(/^\/workspace\/?/, ""),
                      path: file.path,
                      filename: file.name,
                      type: "file",
                    })}
                  >
                    引用
                  </button>
                  <a
                    className="opshelper-attachment-download"
                    href={`/v1/users/me/files/download?path=${encodeURIComponent(file.path)}`}
                    aria-label={`下载文件 ${file.name}`}
                    title={`下载文件 ${file.name}`}
                  >
                    <IconDownload />
                  </a>
                  <button
                    type="button"
                    className="opshelper-attachment-delete"
                    aria-label={`删除文件 ${file.name}`}
                    title={`删除文件 ${file.name}`}
                    disabled={deletingPath === file.path}
                    onClick={() => void deleteFile(file)}
                  >
                    <IconTrash />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
