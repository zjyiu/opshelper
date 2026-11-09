import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { UserSummary } from "@opshelper/shared";

import { filterSsoUsers, SsoUserPicker } from "./sso-user-picker";

const users: UserSummary[] = [
  { id: "1", username: "active", name: "启用用户", role: "user", isActive: true, createdAt: "" },
  { id: "2", username: "inactive", name: "停用用户", role: "user", isActive: false, createdAt: "" },
  { id: "3", username: "added", name: "已添加用户", role: "user", isActive: true, createdAt: "" },
];

test("用户选择支持按用户名和显示名称搜索", () => {
  assert.deepEqual(filterSsoUsers(users, " ACTIVE ").map((user) => user.id), ["1", "2"]);
  assert.deepEqual(filterSsoUsers(users, "启用").map((user) => user.id), ["1"]);
  assert.deepEqual(filterSsoUsers(users, "不存在"), []);
});

test("用户选择允许选择启用用户并禁用已添加和停用用户", () => {
  const html = renderToStaticMarkup(createElement(SsoUserPicker, {
    users,
    existingAccounts: ["added"],
    onAdd: () => undefined,
    onClose: () => undefined,
  }));
  const labels = html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
  const labelFor = (name: string) => {
    const label = labels.find((item) => item.includes(`<strong>${name}</strong>`));
    assert.ok(label);
    return label;
  };
  assert.doesNotMatch(labelFor("启用用户"), /disabled=""/);
  assert.match(labelFor("停用用户"), /disabled=""/);
  assert.match(labelFor("已添加用户"), /disabled=""/);
  assert.match(labelFor("停用用户"), /已停用/);
  assert.match(labelFor("已添加用户"), /已添加/);
  assert.match(html, /添加（0）/);
  assert.match(html, /取消/);
});
