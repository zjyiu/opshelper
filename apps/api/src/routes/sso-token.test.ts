import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { decryptSsoAccount, SsoConfigurationError } from "../lib/sso-service";
import { registerSsoTokenRoute, type SsoTokenRouteServices } from "./admin-config";

const secret = "test-only-generated-secret";
const services: SsoTokenRouteServices = {
  requireAdmin: async () => ({ id: "admin", username: "admin", name: "Admin", role: "admin" }),
  getSecret: async () => secret,
  getUser: async (id) => id === "user-1" ? { username: "用户", isActive: true } : null,
  getWhitelist: async () => ["用户"],
};

async function requestToken(overrides: Partial<SsoTokenRouteServices> = {}, userId = "user-1") {
  const app = Fastify();
  registerSsoTokenRoute(app, { ...services, ...overrides });
  try {
    return await app.inject({
      method: "POST",
      url: `/v1/admin/sso/users/${userId}/token`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
  } finally {
    await app.close();
  }
}

test("管理员可生成对应用户的无缓存免密令牌", async () => {
  const response = await requestToken();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  const result = response.json();
  assert.equal(decryptSsoAccount(result.token, secret), "用户");
  assert.equal(result.isActive, true);
  assert.equal(result.isWhitelisted, true);
});

test("令牌返回用户当前状态和已保存白名单状态", async () => {
  const response = await requestToken({
    getUser: async () => ({ username: "user", isActive: false }),
    getWhitelist: async () => [],
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().isActive, false);
  assert.equal(response.json().isWhitelisted, false);
});

test("非管理员不能生成令牌", async () => {
  let called = false;
  const response = await requestToken({
    requireAdmin: async (_request, reply) => {
      await reply.code(403).send({ message: "Forbidden" });
      return null;
    },
    getSecret: async () => { called = true; return secret; },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
});

test("密钥缺失、密钥解密失败和用户不存在时返回错误", async () => {
  const missingSecret = await requestToken({ getSecret: async () => null });
  assert.equal(missingSecret.statusCode, 503);
  assert.match(missingSecret.json().message, /尚未配置共享密钥/);
  assert.equal((await requestToken({
    getSecret: async () => { throw new SsoConfigurationError("密钥配置错误"); },
  })).statusCode, 503);
  assert.equal((await requestToken({}, "missing")).statusCode, 404);
});
