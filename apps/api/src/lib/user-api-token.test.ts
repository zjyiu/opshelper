import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { authenticateUserApiToken, createUserApiToken } from "./user-api-token";

test("用户 API token 随机生成，只保存摘要，并按所属用户和启用状态认证", async () => {
  const saved: Array<{ userId: string; name: string; tokenHash: string }> = [];
  const save = async (input: { userId: string; name: string; tokenHash: string }) => {
    saved.push(input);
    return { id: "id", name: input.name, createdAt: new Date(0) };
  };
  const first = await createUserApiToken("alice", "integration", save);
  const second = await createUserApiToken("alice", "integration", save);
  assert.match(first.token, /^ops_[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.deepEqual(saved[0], {
    userId: "alice",
    name: "integration",
    tokenHash: createHash("sha256").update(first.token).digest("hex"),
  });
  const find = async (hash: string) => hash === saved[0].tokenHash ? { id: "alice", isActive: true } : null;
  assert.equal(await authenticateUserApiToken(first.token, find), "alice");
  assert.equal(await authenticateUserApiToken(second.token, find), null);
  assert.equal(await authenticateUserApiToken(first.token, async () => ({ id: "alice", isActive: false })), null);
  assert.equal(await authenticateUserApiToken(first.token, async () => null), null);
  assert.equal(await authenticateUserApiToken("invalid", async () => { throw new Error("must not query"); }), null);
});
