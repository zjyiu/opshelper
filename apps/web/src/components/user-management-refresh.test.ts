import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "user-management-panel.tsx",
  readFileSync(new URL("./user-management-panel.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let declaration = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "openUser") declaration = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);

test("opening a user retrieves current details before entering edit mode", async () => {
  assert.ok(declaration);
  let resolve!: (value: { users: Array<{ id: string; name: string }> }) => void;
  const pending = new Promise<{ users: Array<{ id: string; name: string }> }>((done) => { resolve = done; });
  const state = { users: [] as Array<{ id: string; name: string }>, selected: "", mode: "view" };
  const context = vm.createContext({
    refreshSequence: { current: 0 },
    query: "",
    listUsers: () => pending,
    setSearching: () => {},
    setUsers: (users: typeof state.users) => { state.users = users; },
    setSelectedUserId: (id: string) => { state.selected = id; },
    setMode: (mode: string) => { state.mode = mode; },
    toast: { error: () => {} },
  });
  vm.runInContext(ts.transpileModule(`${declaration}\nglobalThis.openUser = openUser;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const opening = context.openUser("user-1") as Promise<void>;
  assert.equal(state.mode, "view");
  resolve({ users: [{ id: "user-1", name: "updated" }] });
  await opening;
  assert.equal(state.mode, "edit");
  assert.equal(state.selected, "user-1");
  assert.equal(state.users[0].name, "updated");
});
