import assert from "node:assert/strict";
import test from "node:test";

import { categorizeUploadPath } from "./utils";

test("默认工作区与上传分类的文件按当前智能体归档", () => {
  assert.equal(categorizeUploadPath("/workspace", "network"), "/workspace/chat-uploads/network");
  assert.equal(categorizeUploadPath("/workspace/chat-uploads", "network"), "/workspace/chat-uploads/network");
  assert.equal(categorizeUploadPath("/workspace/outputs", "network"), "/workspace/outputs/network");
});

test("显式选择的智能体子目录保持不变", () => {
  assert.equal(
    categorizeUploadPath("/workspace/chat-uploads/storage/reference", "network"),
    "/workspace/chat-uploads/storage/reference",
  );
});
