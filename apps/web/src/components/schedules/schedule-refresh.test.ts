import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("a delayed schedule refresh cannot restore an older selection", async () => {
  const source = ts.createSourceFile("schedule-manager.tsx", readFileSync(new URL("./schedule-manager.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "refresh") initializer = node.initializer?.getText(source) ?? "";
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer);
  let finish!: (value: { agents: never[]; schedules: Array<{ id: string }> }) => void;
  const delayed = new Promise<{ agents: never[]; schedules: Array<{ id: string }> }>((resolve) => { finish = resolve; });
  let calls = 0;
  const state = { selected: "", detail: "" };
  const context = vm.createContext({
    useCallback: (fn: unknown) => fn,
    refreshSequence: { current: 0 },
    refreshInFlight: { current: 0 },
    selectedIdRef: { current: null },
    listSchedules: () => ++calls === 1 ? delayed : Promise.resolve({ agents: [], schedules: [{ id: "new" }] }),
    getSchedule: async (id: string) => ({ schedule: { id } }),
    setAgents: () => {},
    setSchedules: () => {},
    setSelectedId: (id: string) => { state.selected = id; },
    setDetail: (detail: { schedule: { id: string } }) => { state.detail = detail.schedule.id; },
    setNotice: () => {},
    setLoading: () => {},
  });
  vm.runInContext(ts.transpileModule(`globalThis.refresh = ${initializer};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const older = context.refresh("old") as Promise<unknown>;
  await context.refresh("new");
  finish({ agents: [], schedules: [{ id: "old" }] });
  await older;
  assert.equal(state.selected, "new");
  assert.equal(state.detail, "new");
});
