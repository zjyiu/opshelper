import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("refreshing an unchanged answer does not replace its selectable HTML", () => {
  const source = ts.createSourceFile("conversation.tsx", readFileSync(new URL("./conversation.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "PartView") initializer = node.initializer?.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer);

  const hooks: Array<{ value: unknown; deps?: unknown[] }> = [];
  let index = 0;
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const context = vm.createContext({
    exports: {},
    require: () => ({ jsx, jsxs: jsx, Fragment: Symbol("Fragment") }),
    memo: (component: unknown) => component,
    useState: (initial: unknown) => {
      const slot = index++;
      hooks[slot] ??= { value: initial };
      return [hooks[slot].value, (value: unknown) => { hooks[slot].value = value; }];
    },
    useRef: (initial: unknown) => {
      const slot = index++;
      hooks[slot] ??= { value: { current: initial } };
      return hooks[slot].value;
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const slot = index++;
      if (!hooks[slot] || deps.some((value, i) => value !== hooks[slot].deps?.[i])) {
        hooks[slot] = { value: factory(), deps };
      }
      return hooks[slot].value;
    },
    useCallback: (callback: unknown) => callback,
    useLayoutEffect: () => {},
    renderAssistantMarkdown: (text: string) => `<p>${text}</p>`,
  });
  vm.runInContext(ts.transpileModule(`globalThis.PartView = ${initializer};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context);

  function render() {
    index = 0;
    return context.PartView({ part: { id: "p1", type: "text", text: "answer", raw: {} } }).props.children[0].props.dangerouslySetInnerHTML;
  }
  const original = render();
  assert.strictEqual(render(), original);
});
