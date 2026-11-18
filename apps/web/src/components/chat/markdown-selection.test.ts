import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { guardMarkdownSelection } from "./markdown-selection";

test("selection color-mix overrides are guarded so older browsers retain a visible fallback", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  for (const selector of ["::selection", ".login-shell ::selection"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fallback = new RegExp(`${escaped}\\s*\\{[^}]*background:\\s*rgba\\(5,\\s*150,\\s*105,\\s*0\\.24\\)`);
    const guarded = new RegExp(`@supports\\s*\\(background-color:\\s*color-mix\\(in srgb, black, transparent\\)\\)\\s*\\{\\s*${escaped}\\s*\\{[^}]*background:\\s*color-mix\\(`);
    assert.match(css, fallback);
    assert.match(css, guarded);
  }
});

function setup(legacyRange = false) {
  const view = new EventTarget();
  const document = new EventTarget();
  const textNode = { contains: () => false };
  let selected = false;
  let intersects = false;
  Object.assign(document, {
    defaultView: view,
    getSelection: () => ({
      isCollapsed: !selected,
      rangeCount: selected ? 1 : 0,
      getRangeAt: () => legacyRange
        ? { commonAncestorContainer: textNode }
        : { intersectsNode: () => intersects },
    }),
  });
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (node: unknown) => node === textNode,
  });
  const rendered: string[] = [];
  const guard = guardMarkdownSelection(element as unknown as HTMLElement, "original", (text) => rendered.push(text));
  return {
    view, document, element, guard, rendered,
    select(value: boolean, inside = true) { selected = value; intersects = inside; },
    pointerDown() {
      element.dispatchEvent(Object.assign(new Event("pointerdown"), { isPrimary: true, button: 0 }));
    },
    mouseDown() {
      element.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0 }));
    },
  };
}

test("stream updates preserve a dragged selection after pointer release until it is cleared", () => {
  const fixture = setup();
  fixture.pointerDown();
  fixture.guard.update("first update");
  fixture.select(true);
  fixture.document.dispatchEvent(new Event("selectionchange"));
  fixture.guard.update("latest update");
  fixture.view.dispatchEvent(new Event("pointerup"));
  assert.deepEqual(fixture.rendered, []);
  fixture.select(false);
  fixture.document.dispatchEvent(new Event("selectionchange"));
  assert.deepEqual(fixture.rendered, ["latest update"]);
  fixture.guard.dispose();
});

test("updates resume after a click or cancelled drag, and unrelated selections do not block them", () => {
  const fixture = setup();
  fixture.pointerDown();
  fixture.guard.update("after click");
  fixture.view.dispatchEvent(new Event("pointercancel"));
  assert.deepEqual(fixture.rendered, ["after click"]);
  fixture.select(true, false);
  fixture.guard.update("unrelated selection");
  assert.deepEqual(fixture.rendered, ["after click", "unrelated selection"]);
  fixture.guard.dispose();
});

test("keyboard and cross-element selections defer updates, and disposal removes pending listeners", () => {
  const fixture = setup();
  fixture.select(true);
  fixture.guard.update("deferred");
  assert.deepEqual(fixture.rendered, []);
  fixture.guard.dispose();
  fixture.select(false);
  fixture.document.dispatchEvent(new Event("selectionchange"));
  assert.deepEqual(fixture.rendered, []);
});

test("legacy mouse selection and ranges without intersectsNode preserve selected text", () => {
  const fixture = setup(true);
  fixture.mouseDown();
  fixture.guard.update("pending");
  fixture.select(true);
  fixture.view.dispatchEvent(new Event("mouseup"));
  assert.deepEqual(fixture.rendered, []);
  fixture.select(false);
  fixture.document.dispatchEvent(new Event("selectionchange"));
  assert.deepEqual(fixture.rendered, ["pending"]);
  fixture.guard.dispose();
});
