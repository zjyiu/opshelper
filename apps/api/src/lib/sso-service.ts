import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { TextDecoder } from "node:util";

import { loadConfig } from "./config";
import { normalizeUsername } from "./session";
import { prisma } from "./prisma";

const config = loadConfig();
const ACCOUNT_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export class SsoTokenError extends Error {
  constructor() {
    super("Invalid SSO account token");
  }
}

export class SsoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function encryptionKey(configuredKey = config.ssoEncryptionKey) {
  if (!configuredKey || Buffer.byteLength(configuredKey, "utf8") < 32) {
    throw new SsoConfigurationError(
      "OPSHELPER_SSO_ENCRYPTION_KEY must contain at least 32 UTF-8 bytes",
    );
  }
  return createHash("sha256").update(configuredKey, "utf8").digest();
}

export function encryptSsoSecret(secret: string, configuredKey: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(configuredKey), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptStoredSsoSecret(encrypted: string, configuredKey: string) {
  const [version, encodedIv, encodedTag, encodedCiphertext, ...extra] = encrypted.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext || extra.length) {
    throw new SsoConfigurationError("Stored SSO secret is invalid");
  }

  try {
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("Invalid encrypted secret fields");
    }
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(configuredKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SsoConfigurationError("Unable to decrypt stored SSO secret");
  }
}

function accountKey(secret: string) {
  const secretBytes = Buffer.from(secret, "utf8");
  const key = Buffer.alloc(16);
  secretBytes.copy(key, 0, 0, Math.min(secretBytes.length, key.length));
  return key;
}

export function encryptSsoAccount(account: string, secret: string) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", accountKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(account, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext]).toString("base64url");
}

export function decryptSsoAccount(token: string, secret: string) {
  if (!ACCOUNT_TOKEN_RE.test(token) || token.length % 4 === 1) {
    throw new SsoTokenError();
  }

  const data = Buffer.from(token, "base64url");
  if (
    data.toString("base64url") !== token ||
    data.length < 32 ||
    (data.length - 16) % 16 !== 0
  ) {
    throw new SsoTokenError();
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", accountKey(secret), data.subarray(0, 16));
    plaintext = Buffer.concat([
      decipher.update(data.subarray(16)),
      decipher.final(),
    ]);
  } catch {
    throw new SsoTokenError();
  }

  try {
    const account = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!account.trim()) throw new Error("Empty SSO account");
    return account;
  } catch {
    throw new SsoTokenError();
  }
}

export async function getSsoSettings() {
  const settings = await prisma.ssoSettings.findUnique({
    where: { id: "default" },
  });
  return {
    accountWhitelist: settings?.accountWhitelist ?? [],
    secretConfigured: Boolean(settings?.encryptedSecret || config.ssoSecret),
    encryptionKeyConfigured: Boolean(
      config.ssoEncryptionKey &&
      Buffer.byteLength(config.ssoEncryptionKey, "utf8") >= 32,
    ),
  };
}

interface SsoSettingsStore {
  upsert(args: {
    where: { id: string };
    create: { id: string; accountWhitelist?: string[]; encryptedSecret?: string };
    update: { accountWhitelist?: string[]; encryptedSecret?: string };
  }): Promise<{ accountWhitelist: string[]; encryptedSecret: string | null }>;
}

export async function updateSsoSettings(input: {
  accountWhitelist?: string[];
  secret?: string;
}, settingsStore: SsoSettingsStore = prisma.ssoSettings) {
  const accountWhitelist = input.accountWhitelist === undefined
    ? undefined
    : [...new Set(input.accountWhitelist.map(normalizeUsername).filter(Boolean))];
  const encryptedSecret = input.secret === undefined
    ? undefined
    : encryptSsoSecret(input.secret, config.ssoEncryptionKey ?? "");

  const settings = await settingsStore.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ...(accountWhitelist === undefined ? {} : { accountWhitelist }),
      ...(encryptedSecret === undefined ? {} : { encryptedSecret }),
    },
    update: {
      ...(accountWhitelist === undefined ? {} : { accountWhitelist }),
      ...(encryptedSecret === undefined ? {} : { encryptedSecret }),
    },
  });

  return {
    accountWhitelist: settings.accountWhitelist,
    secretConfigured: Boolean(settings.encryptedSecret || config.ssoSecret),
    encryptionKeyConfigured: Boolean(
      config.ssoEncryptionKey &&
      Buffer.byteLength(config.ssoEncryptionKey, "utf8") >= 32,
    ),
  };
}

export async function getSsoSecret() {
  const settings = await prisma.ssoSettings.findUnique({
    where: { id: "default" },
    select: { encryptedSecret: true },
  });
  if (settings?.encryptedSecret) {
    return decryptStoredSsoSecret(
      settings.encryptedSecret,
      config.ssoEncryptionKey ?? "",
    );
  }
  return config.ssoSecret ?? null;
}

export async function authenticateSsoAccount(token: string) {
  const [secret, settings] = await Promise.all([
    getSsoSecret(),
    prisma.ssoSettings.findUnique({
      where: { id: "default" },
      select: { accountWhitelist: true },
    }),
  ]);
  if (!secret) {
    throw new SsoConfigurationError("SSO shared secret is not configured");
  }

  const username = normalizeUsername(decryptSsoAccount(token, secret));
  if (!settings?.accountWhitelist.includes(username)) {
    return null;
  }
  return username;
}
