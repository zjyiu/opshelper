export const DIAGRAM_THEME_CSS = `
.pele {
  --pele-bg: transparent;
  --pele-fg: #24324a;
  --pele-muted: #64748b;
  --pele-line: #8593a8;
  --pele-surface: #e5f2ff;
  --pele-surface-alt: #d8f3ed;
  --pele-border: #8db4d8;
  --pele-accent: #3978c5;
  --pele-series-1: #3978c5;
  --pele-series-2: #11a683;
  --pele-series-3: #e6a23c;
  --pele-series-4: #e56b6f;
  --pele-series-5: #8b70c9;
  --pele-series-6: #31a6b8;
  --pele-series-7: #d77ca8;
  --pele-series-8: #7e9d45;
}
.pele .pele-node:nth-child(8n + 1) { --_s: #e5f2ff; --_b: #8db4d8; }
.pele .pele-node:nth-child(8n + 2) { --_s: #dff4ef; --_b: #82c6b3; }
.pele .pele-node:nth-child(8n + 3) { --_s: #fff1d6; --_b: #e8bd68; }
.pele .pele-node:nth-child(8n + 4) { --_s: #fde7e5; --_b: #e7a09a; }
.pele .pele-node:nth-child(8n + 5) { --_s: #eee8fb; --_b: #b2a1dc; }
.pele .pele-node:nth-child(8n + 6) { --_s: #def2f5; --_b: #81bbc4; }
.pele .pele-node:nth-child(8n + 7) { --_s: #f9e8f0; --_b: #d8a0b9; }
.pele .pele-node:nth-child(8n) { --_s: #edf2dc; --_b: #afbd7c; }
.pele .pele-node.pele-shape-diam { --_s: #fff1d6; --_b: #e8bd68; }
.pele .pele-edge-label rect { fill: #f4f9ff; stroke: #d6e5f5; stroke-width: 1; rx: 12px; }
.pele .pele-edge-label text { fill: #1760a8; font-weight: 600; }
`.trim();

export function applyDiagramTheme(svg) {
  const svgRootEnd = svg.indexOf(">");
  if (!svg.startsWith("<svg") || svgRootEnd === -1) {
    throw new Error("pele 没有生成有效的 SVG 根节点");
  }
  return `${svg.slice(0, svgRootEnd + 1)}<style>${DIAGRAM_THEME_CSS}</style>${svg.slice(svgRootEnd + 1)}`;
}
