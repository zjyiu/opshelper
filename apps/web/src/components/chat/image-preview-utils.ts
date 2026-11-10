export function imageFitScale(
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  if (!size.width || !size.height || !viewport.width || !viewport.height) return 1;
  return Math.min(Math.max(1, viewport.width - 32) / size.width, Math.max(1, viewport.height - 32) / size.height);
}

export function nextImageZoom(zoom: number, direction: -1 | 1) {
  return Math.min(4, Math.max(0.25, Math.round((zoom + direction * 0.25) * 100) / 100));
}

export function imageDownloadName(src: string, origin: string) {
  const url = new URL(src, origin);
  const workspacePath = url.searchParams.get("path");
  return (workspacePath
    ? workspacePath.split("/").pop()
    : decodeURIComponent(url.pathname.split("/").pop() || "")) || "图片";
}
