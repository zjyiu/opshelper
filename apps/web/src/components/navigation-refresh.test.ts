import assert from "node:assert/strict";
import test from "node:test";
import { refreshCurrentPage } from "./navigation-refresh";

test("reopening the current page refreshes server and client data", () => {
  const target = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: target, configurable: true });
  let requests = 0;
  let events = 0;
  target.addEventListener("opshelper:refresh-current-page", () => { events += 1; });
  try {
    refreshCurrentPage({ refresh: () => { requests += 1; } });
    assert.equal(requests, 1);
    assert.equal(events, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
