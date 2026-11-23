import assert from "node:assert/strict";
import test from "node:test";

import { copyText } from "./clipboard";

function installBrowser(options: {
  secure: boolean;
  writeText?: (text: string) => Promise<void>;
  copyResult?: boolean;
}) {
  const saved = new Map(
    ["window", "navigator", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const calls: string[] = [];
  const textArea = {
    value: "",
    style: {},
    setAttribute: () => {},
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
  };
  const browser = {
    window: { isSecureContext: options.secure },
    navigator: { clipboard: options.writeText ? { writeText: options.writeText } : undefined },
    document: {
      createElement: () => textArea,
      body: {
        appendChild: () => calls.push("append"),
        removeChild: () => calls.push("remove"),
      },
      execCommand: (command: string) => {
        calls.push(command);
        return options.copyResult ?? true;
      },
    },
  };
  for (const [key, value] of Object.entries(browser)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return {
    calls,
    textArea,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("uses the Clipboard API in a secure context", async () => {
  const written: string[] = [];
  const browser = installBrowser({ secure: true, writeText: async (text) => { written.push(text); } });
  try {
    await copyText("消息\n内容");
    assert.deepEqual(written, ["消息\n内容"]);
    assert.deepEqual(browser.calls, []);
  } finally {
    browser.restore();
  }
});

test("copies using the fallback on an insecure origin", async () => {
  const browser = installBrowser({ secure: false });
  try {
    await copyText("消息\n内容");
    assert.equal(browser.textArea.value, "消息\n内容");
    assert.deepEqual(browser.calls, ["append", "focus", "select", "copy", "remove"]);
  } finally {
    browser.restore();
  }
});

test("falls back when the Clipboard API rejects a write", async () => {
  const browser = installBrowser({ secure: true, writeText: async () => { throw new Error("denied"); } });
  try {
    await copyText("回答");
    assert.equal(browser.textArea.value, "回答");
    assert.deepEqual(browser.calls, ["append", "focus", "select", "copy", "remove"]);
  } finally {
    browser.restore();
  }
});

test("reports failure and removes the temporary textarea when fallback fails", async () => {
  const browser = installBrowser({ secure: false, copyResult: false });
  try {
    await assert.rejects(copyText("代码"), /浏览器拒绝复制/);
    assert.equal(browser.calls.at(-1), "remove");
  } finally {
    browser.restore();
  }
});
