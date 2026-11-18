import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("conversation.tsx", readFileSync(new URL("./conversation.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let scrollEffect: string | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useLayoutEffect" &&
      node.arguments[0]?.getText(source).includes("settledSessionId.current")) {
    scrollEffect = node.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(scrollEffect);
const effectScript = ts.transpileModule(`globalThis.runScrollEffect = ${scrollEffect};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup({ following = true, settled = "session", reply = "reply" }: {
  following?: boolean;
  settled?: string | null;
  reply?: string | null;
} = {}) {
  const calls: string[] = [];
  const context = vm.createContext({
    settledSessionId: { current: settled },
    sessionId: "session",
    messages: [{}],
    shouldFollowOutput: { current: following },
    latestReplyIdRef: { current: null },
    latestReply: reply ? { key: reply } : null,
    latestReplyRef: { current: { scrollIntoView: () => calls.push("reply") } },
    endRef: { current: { scrollIntoView: () => calls.push("end") } },
    updateFollowOutput: () => calls.push("update-follow"),
  });
  vm.runInContext(effectScript, context);
  return { context, calls };
}

test("a new reply and subsequent updates do not move someone reading history", () => {
  const { context, calls } = setup({ following: false });
  context.runScrollEffect();
  context.runScrollEffect();
  assert.deepEqual(calls, []);
  assert.equal(context.latestReplyIdRef.current, "reply");
  context.shouldFollowOutput.current = true;
  context.runScrollEffect();
  assert.deepEqual(calls, ["end"]);
});

test("a new reply is still brought into view when following output", () => {
  const { context, calls } = setup();
  context.runScrollEffect();
  context.runScrollEffect();
  assert.deepEqual(calls, ["reply", "update-follow", "end"]);
});

test("opening a different session still positions its loaded history at the end", () => {
  const { context, calls } = setup({ following: false, settled: "previous" });
  context.runScrollEffect();
  assert.deepEqual(calls, ["end"]);
  assert.equal(context.shouldFollowOutput.current, true);
  assert.equal(context.latestReplyIdRef.current, "reply");
});
