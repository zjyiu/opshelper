import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { SsoTokenDialog } from "./sso-token-dialog";

test("令牌弹窗展示令牌、复制入口及已保存白名单和用户状态", () => {
  const html = renderToStaticMarkup(createElement(SsoTokenDialog, {
    result: { token: "example-token", isActive: false, isWhitelisted: false },
    userName: "测试用户",
    onClose: () => undefined,
  }));
  assert.match(html, /example-token/);
  assert.match(html, /复制令牌/);
  assert.match(html, /用户已停用/);
  assert.match(html, /用户未加入已保存的白名单/);
  assert.match(html, /当前无法使用该令牌免密登录/);
});
