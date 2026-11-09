import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { UserSummary } from "@opshelper/shared";

import { SsoSettingsManager } from "./sso-settings-manager";

const users: UserSummary[] = [
  { id: "1", username: "active", name: "启用用户", role: "user", isActive: true, createdAt: "" },
  { id: "2", username: "inactive", name: "已停用用户", role: "user", isActive: false, createdAt: "" },
  { id: "3", username: "inactive-selected", name: "已选停用用户", role: "user", isActive: false, createdAt: "" },
];

test("白名单只显示已添加的用户并保留可移除的历史条目", () => {
  const html = renderToStaticMarkup(createElement(SsoSettingsManager, {
    initialSettings: {
      accountWhitelist: ["active", "inactive-selected", "deleted"],
      secretConfigured: true,
      encryptionKeyConfigured: true,
    },
    users,
  }));
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /允许登录的账号（3）/);
  assert.match(html, /添加用户/);
  assert.match(html, /启用用户/);
  assert.match(html, /已选停用用户/);
  assert.match(html, /用户不存在/);
  assert.doesNotMatch(html, /<strong>已停用用户<\/strong>/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(html, /account 明文用户名/);
  assert.match(html, /aria-label="获取 启用用户 的令牌"/);
  assert.match(html, /aria-label="获取 已选停用用户 的令牌"/);
  assert.match(html, /aria-label="移除 已选停用用户"/);
  assert.match(html, /aria-label="移除 deleted"/);
  assert.doesNotMatch(html, /aria-label="获取 deleted 的令牌"/);
  assert.match(html, /<button[^>]*disabled[^>]*>保存密钥<\/button>/);
  assert.doesNotMatch(html, />保存白名单<\/button>/);
  assert.match(html, /添加或移除后自动保存/);
  assert.doesNotMatch(html, /保存配置/);
});

test("没有用户时展示空状态，未配置加密密钥时仍显示提示", () => {
  const html = renderToStaticMarkup(createElement(SsoSettingsManager, {
    initialSettings: {
      accountWhitelist: [],
      secretConfigured: false,
      encryptionKeyConfigured: false,
    },
    users: [],
  }));
  assert.match(html, /白名单为空，请点击“添加用户”/);
  assert.match(html, /OPSHELPER_SSO_ENCRYPTION_KEY/);
  assert.match(html, /<button[^>]*disabled[^>]*>保存密钥<\/button>/);
  assert.doesNotMatch(html, />保存白名单<\/button>/);
});
