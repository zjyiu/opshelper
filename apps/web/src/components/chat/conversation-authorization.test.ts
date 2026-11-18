import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationAuthorizationStorageKey,
  moveConversationAuthorization,
  parseConversationAuthorizations,
} from "./conversation-authorization";

test("authorization choices survive reload and remain isolated by conversation and account", () => {
  const saved = parseConversationAuthorizations(JSON.stringify({
    "conversation:a": false,
    "conversation:b": true,
    "new:ops": false,
  }));
  assert.equal(saved["conversation:a"], false);
  assert.equal(saved["conversation:b"], true);
  assert.equal(saved["conversation:c"] ?? true, true);
  assert.equal(saved["new:ops"], false);
  assert.notEqual(conversationAuthorizationStorageKey("alice"), conversationAuthorizationStorageKey("bob"));
  assert.deepEqual(parseConversationAuthorizations(null), {});
});

test("creating a conversation transfers its blank choice and resets the blank to the default", () => {
  const settings = { "new:ops": false, "conversation:b": true };
  const next = moveConversationAuthorization(settings, "new:ops", "conversation:a");
  assert.equal(next["conversation:a"], false);
  assert.equal(next["conversation:b"], true);
  assert.equal(next["new:ops"] ?? true, true);
  assert.equal(settings["new:ops"], false);
  assert.equal(moveConversationAuthorization({}, "new:ops", "conversation:c")["conversation:c"], true);
});

test("invalid saved authorization settings are reported rather than silently accepted", () => {
  for (const raw of ["{", "null", "[]", '{"conversation:a":"false"}', '{"other":false}']) {
    assert.throws(() => parseConversationAuthorizations(raw));
  }
});
