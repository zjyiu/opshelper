import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "agent-management-panel.tsx",
  readFileSync(new URL("./agent-management-panel.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function catalogRefresh(listAgents: () => Promise<{ agents: string[] }>, automaticCreate = false, pristine = true) {
  let declaration = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "refreshCatalog") {
      declaration = node.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration);
  let agents: string[] = ["old"];
  let mode = "create";
  const context = vm.createContext({
    catalogRefreshRef: { current: 0 },
    automaticCreateRef: { current: automaticCreate },
    pristineCreateRef: { current: pristine },
    setEditorMode: (value: string) => { mode = value; },
    listAgents,
    scope: "user",
    setAgents: (value: string[]) => { agents = value; },
  });
  vm.runInContext(ts.transpileModule(`${declaration}\nglobalThis.refreshCatalog = refreshCatalog;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { refresh: context.refreshCatalog as () => Promise<void>, agents: () => agents, mode: () => mode };
}

function selectedAgentMode(agents: Array<{ key: string; canManage: boolean }>, adminScope: boolean) {
  let mode = "";
  let selectedKey = "";
  let detail: unknown = {};
  const context = vm.createContext({
    agents,
    adminScope,
    rememberCatalogScroll: () => {},
    setSkillRepositoryOpen: () => {},
    setDetail: (value: unknown) => { detail = value; },
    setSelectedKey: (value: string) => { selectedKey = value; },
    setEditorMode: (value: string) => { mode = value; },
  });
  let declaration = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "selectAgent") {
      declaration = node.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration);
  vm.runInContext(ts.transpileModule(`${declaration}\nglobalThis.selectAgent = selectAgent;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  (context.selectAgent as (key: string) => void)("agent");
  return { mode, selectedKey, detail };
}

test("refreshing the agent catalog shows newly created agents", async () => {
  const catalog = catalogRefresh(async () => ({ agents: ["old", "new"] }));
  await catalog.refresh();
  assert.deepEqual(catalog.agents(), ["old", "new"]);
});

test("fresh agents replace an untouched automatic create form without discarding edited drafts", async () => {
  const load = async () => ({ agents: ["new"] });
  const pristine = catalogRefresh(load, true);
  const edited = catalogRefresh(load, true, false);
  await Promise.all([pristine.refresh(), edited.refresh()]);
  assert.equal(pristine.mode(), "catalog");
  assert.equal(edited.mode(), "create");
});

test("selecting a manageable agent opens the editor directly", () => {
  assert.equal(selectedAgentMode([{ key: "agent", canManage: true }], false).mode, "edit");
  assert.equal(selectedAgentMode([{ key: "agent", canManage: false }], true).mode, "edit");
});

test("selecting an assigned agent without edit access keeps its read-only view", () => {
  const selected = selectedAgentMode([{ key: "agent", canManage: false }], false);
  assert.equal(selected.mode, "view");
  assert.equal(selected.selectedKey, "agent");
  assert.equal(selected.detail, null);
});

test("a delayed catalog request cannot overwrite a newer result", async () => {
  let finish!: (value: { agents: string[] }) => void;
  const delayed = new Promise<{ agents: string[] }>((resolve) => { finish = resolve; });
  let calls = 0;
  const catalog = catalogRefresh(() => ++calls === 1 ? delayed : Promise.resolve({ agents: ["new"] }));
  const first = catalog.refresh();
  await catalog.refresh();
  finish({ agents: ["old"] });
  await first;
  assert.deepEqual(catalog.agents(), ["new"]);
});
