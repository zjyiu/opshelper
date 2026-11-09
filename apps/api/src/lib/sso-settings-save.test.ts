import assert from "node:assert/strict";
import test from "node:test";

test("separate SSO saves only write their own field for new and existing settings", async () => {
  const previousKey = process.env.OPSHELPER_SSO_ENCRYPTION_KEY;
  process.env.OPSHELPER_SSO_ENCRYPTION_KEY = "test-only-encryption-key-at-least-32-bytes";
  const { updateSsoSettings, decryptStoredSsoSecret } = await import("./sso-service");
  if (previousKey === undefined) delete process.env.OPSHELPER_SSO_ENCRYPTION_KEY;
  else process.env.OPSHELPER_SSO_ENCRYPTION_KEY = previousKey;

  type Args = {
    where: { id: string };
    create: { id: string; accountWhitelist?: string[]; encryptedSecret?: string };
    update: { accountWhitelist?: string[]; encryptedSecret?: string };
  };
  function makeStore() {
    let record: { accountWhitelist: string[]; encryptedSecret: string | null } | undefined;
    const calls: Args[] = [];
    return {
      calls,
      get record() { return record; },
      async upsert(args: Args) {
        calls.push(args);
        record = record
          ? { ...record, ...args.update }
          : { accountWhitelist: [], encryptedSecret: null, ...args.create };
        return record;
      },
    };
  }

  const secretFirst = makeStore();
  await updateSsoSettings({ secret: "first-secret" }, secretFirst);
  assert.deepEqual(secretFirst.record?.accountWhitelist, []);
  assert.equal(decryptStoredSsoSecret(secretFirst.record!.encryptedSecret!, "test-only-encryption-key-at-least-32-bytes"), "first-secret");
  assert.deepEqual(Object.keys(secretFirst.calls[0].update), ["encryptedSecret"]);
  const storedSecret = secretFirst.record!.encryptedSecret;
  await updateSsoSettings({ accountWhitelist: [" Alice ", "alice", "Bob"] }, secretFirst);
  assert.deepEqual(secretFirst.record?.accountWhitelist, ["alice", "bob"]);
  assert.equal(secretFirst.record?.encryptedSecret, storedSecret);
  assert.deepEqual(Object.keys(secretFirst.calls[1].update), ["accountWhitelist"]);
  assert.equal("encryptedSecret" in secretFirst.calls[1].create, false);

  const whitelistFirst = makeStore();
  await updateSsoSettings({ accountWhitelist: ["alice"] }, whitelistFirst);
  assert.equal(whitelistFirst.record?.encryptedSecret, null);
  await updateSsoSettings({ secret: "second-secret" }, whitelistFirst);
  assert.deepEqual(whitelistFirst.record?.accountWhitelist, ["alice"]);
  assert.equal("accountWhitelist" in whitelistFirst.calls[1].create, false);
  await updateSsoSettings({ accountWhitelist: [] }, whitelistFirst);
  assert.deepEqual(whitelistFirst.record?.accountWhitelist, []);
  assert.equal(decryptStoredSsoSecret(whitelistFirst.record!.encryptedSecret!, "test-only-encryption-key-at-least-32-bytes"), "second-secret");
});
