import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { UserProfileName } from "./user-profile-name";

test("用户菜单显示名称和头像使用显示名称而不是登录账号", () => {
  const html = renderToStaticMarkup(createElement(UserProfileName, {
    username: "login-account",
    name: "Display Name",
  }));
  assert.match(html, /<span class="opshelper-user-name">Display Name<\/span>/);
  assert.match(html, /<span class="opshelper-user-avatar">D<\/span>/);
  assert.doesNotMatch(html, />login-account<\/span>/);
});

test("显示名称为空时头像回退到登录账号", () => {
  const html = renderToStaticMarkup(createElement(UserProfileName, {
    username: "login-account",
    name: "",
  }));
  assert.match(html, /<span class="opshelper-user-avatar">L<\/span>/);
});
