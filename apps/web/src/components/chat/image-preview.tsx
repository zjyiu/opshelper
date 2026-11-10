"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { IconClose, IconDownload } from "./icons";
import { imageDownloadName, imageFitScale, nextImageZoom } from "./image-preview-utils";

export type PreviewImage =
  | { kind: "image"; src: string; alt: string }
  | { kind: "svg"; svg: string };

export function ImagePreview({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [svgUrl, setSvgUrl] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const src = image.kind === "svg" ? svgUrl : image.src;

  useEffect(() => {
    if (image.kind !== "svg") return;
    const url = URL.createObjectURL(new Blob([image.svg], { type: "image/svg+xml" }));
    setSvgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = imageFitScale(size, viewport);

  const download = async () => {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = image.kind === "svg" ? "图表.svg" : imageDownloadName(image.src, window.location.href);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? `下载失败：${error.message}` : "下载失败");
    }
  };

  return createPortal(
    <div
      className="opshelper-image-preview-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} className="opshelper-image-preview" role="dialog" aria-modal="true" aria-label="图片预览" tabIndex={-1}>
        <div className="opshelper-image-preview-toolbar">
          <button type="button" onClick={() => void download()} disabled={!src} aria-label="下载图片" title="下载图片"><IconDownload /></button>
          <button type="button" onClick={onClose} aria-label="关闭预览" title="关闭预览"><IconClose /></button>
        </div>
        <div className="opshelper-image-preview-viewport" ref={viewportRef}>
          {src ? <img
            src={src}
            alt={image.kind === "image" ? image.alt : "图表预览"}
            style={size.width && size.height ? { width: size.width * fit * zoom, height: size.height * fit * zoom } : undefined}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => toast.error("图片加载失败")}
          /> : null}
        </div>
        <div className="opshelper-image-preview-zoom" aria-label="图片缩放">
          <button type="button" aria-label="缩小图片" disabled={zoom <= 0.25} onClick={() => setZoom((value) => nextImageZoom(value, -1))}>−</button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="放大图片" disabled={zoom >= 4} onClick={() => setZoom((value) => nextImageZoom(value, 1))}>+</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
