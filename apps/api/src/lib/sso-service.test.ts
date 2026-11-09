import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import test from "node:test";

import {
  decryptSsoAccount,
  decryptStoredSsoSecret,
  encryptSsoAccount,
  encryptSsoSecret,
  SsoConfigurationError,
  SsoTokenError,
} from "./sso-service";

function encryptAccount(account: string, secret: string) {
  const secretBytes = Buffer.from(secret, "utf8");
  const key = Buffer.alloc(16);
  secretBytes.copy(key, 0, 0, Math.min(secretBytes.length, 16));
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(account, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext]).toString("base64url");
}

test("SSO account tokens decrypt UTF-8 accounts using the supplied shared secret", () => {
  const secret = randomBytes(32).toString("hex");
  const token = encryptAccount("运维用户@example.com", secret);
  assert.equal(decryptSsoAccount(token, secret), "运维用户@example.com");
});

test("generated account tokens use random IVs and support short and UTF-8 secrets", () => {
  for (const secret of ["short", "密钥example-123456789"]) {
    const first = encryptSsoAccount("用户@example.com", secret);
    const second = encryptSsoAccount("用户@example.com", secret);
    assert.match(first, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(first, second);
    assert.equal(decryptSsoAccount(first, secret), "用户@example.com");
    assert.equal(decryptSsoAccount(second, secret), "用户@example.com");
    const data = Buffer.from(first, "base64url");
    const key = Buffer.alloc(16);
    Buffer.from(secret, "utf8").copy(key, 0, 0, 16);
    const decipher = createDecipheriv("aes-128-cbc", key, data.subarray(0, 16));
    assert.equal(Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString("utf8"), "用户@example.com");
  }
});

test("invalid or tampered SSO tokens are rejected", () => {
  const secret = randomBytes(32).toString("hex");
  const token = encryptAccount("user@example.com", secret);
  assert.throws(() => decryptSsoAccount(`${token}*`, secret), SsoTokenError);
  assert.throws(() => decryptSsoAccount("AA", secret), SsoTokenError);
  const tampered = Buffer.from(token, "base64url");
  tampered[0] ^= 0x80;
  assert.throws(
    () => decryptSsoAccount(tampered.toString("base64url"), secret),
    SsoTokenError,
  );
});

test("SSO secrets are stored with authenticated encryption", () => {
  const encryptionSecret = randomBytes(48).toString("hex");
  const sharedSecret = randomBytes(32).toString("base64url");
  const encrypted = encryptSsoSecret(sharedSecret, encryptionSecret);
  assert.equal(decryptStoredSsoSecret(encrypted, encryptionSecret), sharedSecret);
  assert.throws(
    () => decryptStoredSsoSecret(encrypted, randomBytes(48).toString("hex")),
    SsoConfigurationError,
  );
});
