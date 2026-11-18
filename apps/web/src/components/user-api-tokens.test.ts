import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "user-api-tokens.tsx",
  readFileSync(new URL("./user-api-tokens.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const callbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && ["createToken", "revokeToken"].includes(node.name.text)) {
    callbacks.set(node.name.text, node.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(callbacks.size, 2);
const code = ts.transpileModule(
  `${callbacks.get("createToken")}\n${callbacks.get("revokeToken")}\nglobalThis.actions = { createToken, revokeToken };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function actions(options: {
  create?: (name: string) => Promise<{ id: string; name: string; createdAt: string; token: string }>;
  revoke?: (id: string) => Promise<void>;
  confirmed?: boolean;
} = {}) {
  const state = {
    tokens: [] as Array<{ id: string; name: string; createdAt: string }>,
    newToken: null as string | null,
    error: null as string | null,
    creating: false,
    closeBlocked: false,
    revoking: null as string | null,
  };
  const context = vm.createContext({
    Error,
    name: "  告警平台  ",
    creatingRef: { current: false },
    revokingRef: { current: false },
    setError: (value: string | null) => { state.error = value; },
    setCreating: (value: boolean) => { state.creating = value; },
    onCreatingChange: (value: boolean) => { state.closeBlocked = value; },
    setTokens: (fn: (tokens: typeof state.tokens) => typeof state.tokens) => { state.tokens = fn(state.tokens); },
    setNewToken: (value: string | null) => { state.newToken = value; },
    setCopyStatus: () => {},
    setName: () => {},
    setRevoking: (value: string | null) => { state.revoking = value; },
    createUserApiToken: options.create ?? (async () => ({ id: "id", name: "告警平台", createdAt: "2026-01-01", token: "secret" })),
    deleteUserApiToken: options.revoke ?? (async () => {}),
    confirm: async () => options.confirmed ?? true,
  });
  vm.runInContext(code, context);
  return { state, ...context.actions as { createToken: () => Promise<void>; revokeToken: (token: { id: string; name: string; createdAt: string }) => Promise<void> } };
}

test("创建时阻止重复提交和关闭，明文只保存在一次性展示状态", async () => {
  let resolve!: (value: { id: string; name: string; createdAt: string; token: string }) => void;
  let requests = 0;
  const panel = actions({
    create: async (name) => {
      requests += 1;
      assert.equal(name, "告警平台");
      return new Promise((done) => { resolve = done; });
    },
  });
  const pending = panel.createToken();
  await panel.createToken();
  assert.equal(requests, 1);
  assert.equal(panel.state.closeBlocked, true);
  resolve({ id: "id", name: "告警平台", createdAt: "2026-01-01", token: "secret" });
  await pending;
  assert.equal(panel.state.newToken, "secret");
  assert.equal(panel.state.tokens[0].name, "告警平台");
  assert.equal("token" in panel.state.tokens[0], false);
  assert.equal(panel.state.closeBlocked, false);
});

test("创建失败可见并解除关闭限制，撤销需确认且失败保留列表", async () => {
  const panel = actions({ create: async () => { throw new Error("连接失败"); }, revoke: async () => { throw new Error("撤销失败"); } });
  await panel.createToken();
  assert.match(panel.state.error ?? "", /连接失败/);
  assert.equal(panel.state.closeBlocked, false);
  panel.state.tokens = [{ id: "id", name: "告警平台", createdAt: "2026-01-01" }];
  await panel.revokeToken(panel.state.tokens[0]);
  assert.match(panel.state.error ?? "", /撤销失败/);
  assert.equal(panel.state.tokens.length, 1);
  let revoked = false;
  const cancelled = actions({ confirmed: false, revoke: async () => { revoked = true; } });
  await cancelled.revokeToken({ id: "id", name: "告警平台", createdAt: "2026-01-01" });
  assert.equal(revoked, false);
});

test("确认撤销成功后从列表移除 Token", async () => {
  const panel = actions();
  panel.state.tokens = [{ id: "id", name: "告警平台", createdAt: "2026-01-01" }];
  await panel.revokeToken(panel.state.tokens[0]);
  assert.equal(panel.state.tokens.length, 0);
});
