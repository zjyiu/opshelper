import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import * as note from "./collaboration-note";

type Element = {
  type: string;
  props: {
    children?: Element | Element[];
    open?: boolean;
    onToggle?: (event: { currentTarget: { open: boolean } }) => void;
    onWheel?: () => void;
  };
};

function panel() {
  let open: boolean | undefined;
  const refs: Array<{ current: unknown }> = [];
  let refIndex = 0;
  let effects: Array<() => void> = [];
  let updates: Array<(value: boolean) => boolean> = [];
  const react = {
    useMemo: (callback: () => unknown) => callback(),
    useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useState: (initial: () => boolean) => {
      open ??= initial();
      return [open, (update: boolean | ((value: boolean) => boolean)) => {
        updates.push(typeof update === "function" ? update : () => update);
      }];
    },
    useLayoutEffect: (effect: () => void) => { effects.push(effect); },
  };
  const jsx = (type: string, props: Element["props"]) => ({ type, props });
  const code = ts.transpileModule(readFileSync(new URL("./collaboration-bar.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const context = vm.createContext({
    exports,
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./collaboration-note") return note;
      if (name === "./icons") return { IconChevron: "chevron" };
      if (name === "next/link") return { __esModule: true, default: "a" };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  vm.runInContext(code, context);

  function render(status: "running" | "completed", traceId = "child-1") {
    refIndex = 0;
    effects = [];
    const root: Element = context.exports.CollaborationBar({
      collaborations: [{ traceId, status, agentKey: "agent", title: "task" }],
    });
    for (const effect of effects) effect();
    for (const update of updates) open = update(open ?? false);
    updates = [];
    return root.props.children as Element;
  }

  return { render };
}

test("scrolling keeps the collaboration panel open through completion and refresh", () => {
  const component = panel();
  let details = component.render("running");
  assert.equal(details.props.open, true);
  const list = (details.props.children as Element[])[1];
  list.props.onWheel?.();
  component.render("completed");
  details = component.render("completed");
  assert.equal(details.props.open, true);
  details.props.onToggle?.({ currentTarget: { open: false } });
  component.render("completed");
  component.render("running", "child-2");
  details = component.render("running", "child-2");
  assert.equal(details.props.open, true);
  component.render("completed", "child-2");
  details = component.render("completed", "child-2");
  assert.equal(details.props.open, false);
});

test("reopening a completed collaboration stays open on refresh", () => {
  const component = panel();
  let details = component.render("completed");
  details.props.onToggle?.({ currentTarget: { open: true } });
  component.render("completed");
  details = component.render("completed");
  assert.equal(details.props.open, true);
});
