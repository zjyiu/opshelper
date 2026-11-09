import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { SsoConfigurationError } from "../lib/sso-service";
import { registerSsoSettingsRoutes } from "./admin-config";

test("independent SSO routes validate their inputs and update only the requested field", async () => {
  const app = Fastify();
  const calls: Array<{ secret?: string; accountWhitelist?: string[] }> = [];
  const snapshot = { secretConfigured: true, encryptionKeyConfigured: true, accountWhitelist: ["alice"] };
  registerSsoSettingsRoutes(app, {
    requireAdmin: async () => ({ id: "admin", username: "admin", name: "Admin", role: "admin" }),
    getSettings: async () => snapshot,
    updateSettings: async (input) => { calls.push(input); return snapshot; },
  });
  try {
    const secret = await app.inject({ method: "PUT", url: "/v1/admin/sso/secret", payload: { secret: "new" } });
    assert.equal(secret.statusCode, 200);
    assert.deepEqual(secret.json(), { secretConfigured: true });
    const whitelist = await app.inject({ method: "PUT", url: "/v1/admin/sso/whitelist", payload: { accountWhitelist: [] } });
    assert.equal(whitelist.statusCode, 200);
    assert.deepEqual(whitelist.json(), { accountWhitelist: ["alice"] });
    assert.deepEqual(calls, [{ secret: "new" }, { accountWhitelist: [] }]);

    for (const [url, payload] of [
      ["/v1/admin/sso/secret", { secret: "new", accountWhitelist: [] }],
      ["/v1/admin/sso/secret", { secret: "" }],
      ["/v1/admin/sso/whitelist", { accountWhitelist: [], secret: "new" }],
      ["/v1/admin/sso/whitelist", { accountWhitelist: [" "] }],
    ] as const) {
      assert.equal((await app.inject({ method: "PUT", url, payload })).statusCode, 400);
    }
    assert.equal(calls.length, 2);

    const legacy = await app.inject({ method: "PUT", url: "/v1/admin/sso", payload: { accountWhitelist: ["alice"], secret: "new" } });
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(calls[2], { accountWhitelist: ["alice"], secret: "new" });
  } finally {
    await app.close();
  }
});

test("independent SSO saves require an administrator and surface configuration errors", async () => {
  const app = Fastify();
  let allowed = false;
  let calls = 0;
  registerSsoSettingsRoutes(app, {
    requireAdmin: async (_request, reply) => {
      if (!allowed) {
        await reply.code(403).send({ message: "Forbidden" });
        return null;
      }
      return { id: "admin", username: "admin", name: "Admin", role: "admin" };
    },
    getSettings: async () => ({ secretConfigured: false, encryptionKeyConfigured: false, accountWhitelist: [] }),
    updateSettings: async () => { calls++; throw new SsoConfigurationError("encryption key missing"); },
  });
  try {
    for (const [url, payload] of [
      ["/v1/admin/sso/secret", { secret: "new" }],
      ["/v1/admin/sso/whitelist", { accountWhitelist: [] }],
    ] as const) {
      assert.equal((await app.inject({ method: "PUT", url, payload })).statusCode, 403);
    }
    assert.equal(calls, 0);
    allowed = true;
    const response = await app.inject({ method: "PUT", url: "/v1/admin/sso/secret", payload: { secret: "new" } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().message, "encryption key missing");
  } finally {
    await app.close();
  }
});
