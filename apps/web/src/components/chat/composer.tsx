"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatModelOption } from "@opshelper/shared";

import { IconClose, IconExpand, IconFolder, IconPaperclip, IconSend, IconStop } from "./icons";
import type { Attachment, MentionFile } from "./types";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  models = [],
  model = "",
  onModelChange,
  attachments,
  onAddFiles,
  onRequestReference,
  onRemoveAttachment,
  onSearchFiles,
  onMention,
  blocked = false,
  readOnly = false,
  queueHint = false,
  submitting = false,
  stopping = false,
  focusToken = 0,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  // 可切换模型列表（为空时不渲染选择器）与当前选中的完整引用。
  models?: ChatModelOption[];
  model?: string;
  onModelChange?: (model: string) => void;
  attachments: Attachment[];
  onAddFiles: (files: File[]) => void;
  onRequestReference: () => void;
  onRemoveAttachment: (id: string) => void;
  onSearchFiles: (query: string) => Promise<MentionFile[]>;
  onMention: (file: MentionFile) => void;
  blocked?: boolean;
  readOnly?: boolean;
  queueHint?: boolean;
  submitting?: boolean;
  stopping?: boolean;
  // 每次递增都把焦点移到输入框末尾（首屏示例填入草稿后接着编辑）。
  focusToken?: number;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const composingRef = useRef(false);
  const keyboardHintId = useId();
  // The `@` autocomplete: `range` is the [start,end) span of the `@query` token
  // in the textarea that a pick should replace.
  const [mention, setMention] = useState<
    { query: string; range: [number, number] } | null
  >(null);
  const [mentionResults, setMentionResults] = useState<MentionFile[]>([]);
  const [mentionActive, setMentionActive] = useState(0);
  const [multiline, setMultiline] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dragDepth = useRef(0);

  const uploading = attachments.some((a) => a.status === "uploading");
  const hasReady = attachments.some((a) => a.status === "ready");
  const canSend = (value.trim().length > 0 || hasReady) && !uploading && !blocked;

  useEffect(() => {
    if (!attachMenuOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (!attachMenuRef.current?.contains(event.target as Node)) {
        setAttachMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAttachMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [attachMenuOpen]);

  // 单行起步、随内容自动增高（封顶交给 CSS max-height，超出后内部滚动）。
  useEffect(() => {
    const el = textareaRef.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const controlSelectors = [
      ".opshelper-attach-menu-wrap",
      ".opshelper-queue-hint",
      ".opshelper-sending-hint",
      ".opshelper-stop",
      ".opshelper-model-pick",
      ".opshelper-send:not(.opshelper-stop)",
    ];
    const updateSize = () => {
      el.style.height = "auto";
      const height = el.scrollHeight;
      const textareaStyle = window.getComputedStyle(el);
      const rowStyle = window.getComputedStyle(row);
      const controls = controlSelectors
        .map((selector) => row.querySelector<HTMLElement>(selector))
        .filter((control): control is HTMLElement => {
          if (!control) return false;
          const style = window.getComputedStyle(control);
          return style.display !== "none" && style.position !== "absolute";
        });
      const controlsWidth = controls.reduce(
        (total, control) => total + control.getBoundingClientRect().width,
        0,
      );
      const horizontalPadding =
        Number.parseFloat(rowStyle.paddingLeft) +
        Number.parseFloat(rowStyle.paddingRight);
      const gap = Number.parseFloat(rowStyle.columnGap) || 0;
      const inlineWidth =
        row.clientWidth - horizontalPadding - controlsWidth - gap * controls.length;
      if (context) {
        context.font = `${textareaStyle.fontStyle} ${textareaStyle.fontWeight} ${textareaStyle.fontSize} ${textareaStyle.fontFamily}`;
      }
      const wraps = value.includes("\n") || Boolean(
        value && context && context.measureText(value).width > inlineWidth,
      );
      setMultiline(wraps);
      const overflows = height > 168;
      setHasOverflow(overflows);
      if (!overflows && expanded) setExpanded(false);
      el.style.height = `${height}px`;
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(row);
    return () => observer.disconnect();
  }, [busy, expanded, model, models, queueHint, stopping, submitting, value]);

  useEffect(() => {
    if (focusToken <= 0) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusToken]);

  // Detect a `@token` immediately before the caret and drive the autocomplete.
  const syncMention = useCallback((text: string, caret: number) => {
    if (composingRef.current) return;
    const upToCaret = text.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(upToCaret);
    if (!match) {
      setMention(null);
      return;
    }
    const start = caret - match[2].length - 1; // include the '@'
    setMention({ query: match[2], range: [start, caret] });
    setMentionActive(0);
  }, []);

  useEffect(() => {
    if (!mention) {
      setMentionResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void onSearchFiles(mention.query).then((results) => {
        if (!cancelled) setMentionResults(results);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention, onSearchFiles]);

  const pickMention = useCallback(
    (file: MentionFile) => {
      onMention(file);
      const range = mention?.range;
      if (range) {
        // Replace the typed `@query` with a tidy `@filename ` reference.
        const next = `${value.slice(0, range[0])}@${file.filename} ${value.slice(range[1])}`;
        onChange(next);
      }
      setMention(null);
      setMentionResults([]);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [mention, onChange, onMention, value],
  );

  const showMentions = mention !== null && mentionResults.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229 covers Safari's Enter after compositionend.
    if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (showMentions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActive((i) => (i + 1) % mentionResults.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActive((i) => (i - 1 + mentionResults.length) % mentionResults.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionResults[mentionActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (blocked) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) onAddFiles(files);
  };

  return (
    <div
      className={`opshelper-composer${dragOver ? " opshelper-composer-dragover" : ""}`}
      onDragEnter={(e) => {
        if (!blocked && Array.from(e.dataTransfer.types).includes("Files")) {
          dragDepth.current += 1;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {dragOver ? <div className="opshelper-composer-drop-hint">松开以上传文件</div> : null}

      {attachments.length > 0 ? (
        <div className="opshelper-attach-list">
          {attachments.map((a) => (
            <div
              key={a.id}
              className={`opshelper-attach-chip${a.status === "error" ? " error" : ""}`}
              title={a.path || a.filename}
            >
              {a.status === "uploading" ? (
                <span className="opshelper-attach-spinner" aria-hidden="true" />
              ) : (
                <span className="opshelper-attach-icon" aria-hidden="true">
                  {a.source === "mention" ? "@" : <IconPaperclip />}
                </span>
              )}
              <span className="opshelper-attach-name">
                {a.mime === "inode/directory" ? `${a.filename}/` : a.filename}
              </span>
              <button
                className="opshelper-attach-remove"
                onClick={() => onRemoveAttachment(a.id)}
                aria-label="移除附件"
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className={`opshelper-composer-row${multiline ? " opshelper-composer-multiline" : ""}${expanded ? " opshelper-composer-expanded" : ""}${hasOverflow ? " opshelper-composer-has-expand" : ""}`}>
        {showMentions ? (
          <div className="opshelper-mention-menu" role="listbox">
            {mentionResults.map((file, idx) => (
              <button
                key={file.path}
                role="option"
                aria-selected={idx === mentionActive}
                className={`opshelper-mention-item${idx === mentionActive ? " active" : ""}`}
                onMouseEnter={() => setMentionActive(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(file);
                }}
              >
                <span className="opshelper-mention-name">{file.filename}</span>
                <span className="opshelper-mention-path">{file.rel}</span>
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="输入你的需求，或添加文件"
          aria-label="消息内容"
          aria-describedby={keyboardHintId}
          value={value}
          readOnly={readOnly}
          onCompositionStart={() => {
            composingRef.current = true;
            setMention(null);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            syncMention(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) =>
            syncMention(value, (e.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 120)}
        />
        {hasOverflow ? (
          <button
            className="opshelper-composer-expand"
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? "收起输入框" : "展开输入框"}
            aria-expanded={expanded}
            title={expanded ? "收起输入框" : "展开输入框"}
          >
            <IconExpand expanded={expanded} />
          </button>
        ) : null}

        <div className="opshelper-composer-tools">
          <div className="opshelper-attach-menu-wrap" ref={attachMenuRef}>
            <button
              className="opshelper-attach-btn"
              type="button"
              onClick={() => setAttachMenuOpen((open) => !open)}
              aria-label="添加附件"
              title="上传文件或引用/下载文件"
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
              disabled={blocked}
            >
              <IconPaperclip />
            </button>
            {attachMenuOpen ? (
              <div className="opshelper-attach-menu" role="menu" aria-label="添加附件">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <IconPaperclip />
                  <span>上传文件</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    onRequestReference();
                  }}
                >
                  <IconFolder />
                  <span>引用/下载文件</span>
                </button>
              </div>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (!blocked && files.length > 0) onAddFiles(files);
            }}
          />

          {queueHint ? <span className="opshelper-queue-hint">任务处理中，可继续输入下一条</span> : null}
          {submitting ? <span className="opshelper-sending-hint" role="status">发送中…</span> : null}

          {busy ? (
            <button
              className="opshelper-send opshelper-stop"
              onClick={onStop}
              disabled={stopping}
              aria-label={stopping ? "正在停止当前任务" : "停止当前任务"}
            >
              <IconStop />
              <span>{stopping ? "停止中…" : "停止"}</span>
            </button>
          ) : null}
          {models.length > 0 ? (
            <label className="opshelper-model-pick" title="切换模型（对下一条消息生效）">
              <select
                value={models.some((m) => m.model === model) ? model : ""}
                onChange={(e) => onModelChange?.(e.target.value)}
                aria-label="切换模型"
              >
                {!models.some((m) => m.model === model) ? (
                  <option value="">默认模型</option>
                ) : null}
                {models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            className="opshelper-send"
            type="button"
            onClick={onSend}
            disabled={!canSend || submitting}
            aria-label={busy ? "将消息加入队列" : "发送"}
            title={busy ? "将消息加入队列" : "发送"}
          >
            <IconSend />
          </button>
        </div>
      </div>
      <div className="opshelper-composer-keyboard-hint" id={keyboardHintId}>Enter 发送/排队 · Shift+Enter 换行</div>
    </div>
  );
}
