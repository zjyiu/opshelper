import assert from "node:assert/strict";
import test from "node:test";
import { insertEditorIndent } from "./agent-editor-keys";

test("Tab inserts indentation at the cursor and keeps the cursor after it", () => {
  assert.deepEqual(insertEditorIndent("name: agent", 6, 6), {
    value: "name:   agent",
    selectionStart: 8,
    selectionEnd: 8,
  });
});

test("Tab replaces selected text with indentation", () => {
  assert.deepEqual(insertEditorIndent("firstsecond", 5, 6), {
    value: "first  econd",
    selectionStart: 7,
    selectionEnd: 7,
  });
});
