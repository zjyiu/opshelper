import assert from "node:assert/strict";
import test from "node:test";

import { imageDownloadName, imageFitScale, nextImageZoom } from "./image-preview-utils";

test("图片按预览区域比例适配并为边距留空间", () => {
  assert.equal(imageFitScale({ width: 1200, height: 600 }, { width: 632, height: 632 }), 0.5);
  assert.equal(imageFitScale({ width: 600, height: 1200 }, { width: 632, height: 632 }), 0.5);
  assert.equal(imageFitScale({ width: 0, height: 0 }, { width: 632, height: 632 }), 1);
  assert.ok(imageFitScale({ width: 1200, height: 600 }, { width: 20, height: 20 }) > 0);
});

test("缩放按 25% 递增并限制在 25% 到 400%", () => {
  assert.equal(nextImageZoom(1, 1), 1.25);
  assert.equal(nextImageZoom(1, -1), 0.75);
  assert.equal(nextImageZoom(0.25, -1), 0.25);
  assert.equal(nextImageZoom(4, 1), 4);
});

test("下载保留工作区文件名并正确处理百分号和中文", () => {
  const path = "/workspace/outputs/图 100%.svg";
  assert.equal(
    imageDownloadName(`/v1/users/me/files/download?path=${encodeURIComponent(path)}&inline=1`, "https://example.com"),
    "图 100%.svg",
  );
  assert.equal(imageDownloadName("https://example.com/%E5%9B%BE.png", "https://example.com"), "图.png");
});
