import assert from "node:assert/strict";
import test from "node:test";

import { cleanSummaryTitle, needsTitleSummary } from "./conversation-title";

test("summary titles are stripped of quotes, labels and reasoning blocks", () => {
  assert.equal(cleanSummaryTitle("<think>想一想</think>\n标题：「进程调度流程图」。"), "进程调度流程图");
  assert.equal(cleanSummaryTitle("   "), "");
});

test("only long first questions are summarized", () => {
  assert.equal(needsTitleSummary("你是谁"), false);
  assert.equal(needsTitleSummary("根据以下内容生成流程图：1. 开始与选择操作 系统启动后进入操作选择阶段"), true);
});
