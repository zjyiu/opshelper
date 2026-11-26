import assert from "node:assert/strict";
import test from "node:test";

import { render } from "pele";

import { applyDiagramTheme, DIAGRAM_THEME_CSS } from "./diagram-theme.mjs";

test("standalone SVG embeds colorful diagram theme without depending on web CSS", () => {
  const svg = render("flowchart TD\n  A[输入] --> B{判断}\n  B --> C[完成]").svg;
  const themed = applyDiagramTheme(svg);

  assert.match(themed, /^<svg\b/);
  assert.match(themed, /<style>\.pele \{/);
  assert.match(themed, /--pele-surface: #e5f2ff/);
  assert.match(themed, /--pele-series-8: #7e9d45/);
  assert.match(themed, /\.pele \.pele-node\.pele-shape-diam/);
  assert.match(themed, /\.pele \.pele-edge-label rect \{ fill: #f4f9ff/);
  assert.match(themed, /\.pele \.pele-edge-label text \{ fill: #1760a8/);
  assert.match(themed, /class="pele-node pele-shape-rect"/);
  assert.match(themed, /class="pele-node pele-shape-diam"/);
});

test("invalid SVG is rejected rather than written without its theme", () => {
  assert.throws(() => applyDiagramTheme("not an svg"), /有效的 SVG 根节点/);
  assert.ok(DIAGRAM_THEME_CSS.length > 0);
});
