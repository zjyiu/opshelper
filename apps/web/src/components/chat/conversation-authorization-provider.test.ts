import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import * as authorization from "./conversation-authorization";
import * as drafts from "./conversation-drafts";

const code = ts.transpileModule(readFileSync(new URL("./conversation-draft-provider.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function provider(storage: Map<string, string>, userKey: string, unavailable = false) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const errors: string[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let mounted = false;
  let effects: Array<() => void> = [];
  const react = {
    createContext: () => ({ Provider: "provider" }),
    useCallback: (callback: unknown) => callback,
    useMemo: (callback: () => unknown) => callback(),
    useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value: unknown) => {
        states[index] = typeof value === "function" ? value(states[index]) : value;
      }];
    },
    useEffect: (effect: () => void) => { if (!mounted) effects.push(effect); },
  };
  const exports = {};
  const context = vm.createContext({
    exports,
    sessionStorage: {
      getItem: (key: string) => {
        if (unavailable) throw new Error("storage unavailable");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (unavailable) throw new Error("storage unavailable");
        storage.set(key, value);
      },
    },
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (_type: unknown, props: unknown) => ({ props }) };
      if (name === "sonner") return { toast: { error: (message: string) => errors.push(message) } };
      if (name === "./conversation-drafts") return drafts;
      if (name === "./conversation-authorization") return authorization;
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  vm.runInContext(code, context);

  function render() {
    stateIndex = 0;
    refIndex = 0;
    effects = [];
    const element = context.exports.ConversationDraftProvider({ userKey, children: null });
    for (const effect of effects) effect();
    mounted = true;
    return element.props.value as {
      authorizations: authorization.ConversationAuthorizations;
      setAuthorization: (key: string, enabled: boolean) => void;
      moveAuthorization: (from: string, to: string) => void;
    };
  }
  render();
  return { render, errors };
}

test("saved per-conversation choices restore after the provider remounts", () => {
  const storage = new Map<string, string>();
  const first = provider(storage, "alice");
  let store = first.render();
  store.setAuthorization("conversation:a", false);
  store.setAuthorization("conversation:b", true);
  store.setAuthorization("new:ops", false);
  store.moveAuthorization("new:ops", "conversation:c");

  const restored = provider(storage, "alice").render();
  assert.equal(restored.authorizations["conversation:a"], false);
  assert.equal(restored.authorizations["conversation:b"], true);
  assert.equal(restored.authorizations["conversation:c"], false);
  assert.equal(restored.authorizations["new:ops"] ?? true, true);
  assert.equal(provider(storage, "bob").render().authorizations["conversation:a"], undefined);
});

test("storage failures warn the user while retaining the choice in memory", () => {
  const instance = provider(new Map(), "alice", true);
  instance.render().setAuthorization("conversation:a", false);
  assert.equal(instance.render().authorizations["conversation:a"], false);
  assert.ok(instance.errors.some((message) => message.includes("无法读取")));
  assert.ok(instance.errors.some((message) => message.includes("无法保存")));
});
