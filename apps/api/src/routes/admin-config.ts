import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  AdminConfigError,
  getPlatformInstructions,
  getModelSettings,
  MAX_PLATFORM_INSTRUCTIONS_BYTES,
  normalizePlatformInstructionsContent,
  updateGlobalInstructions,
  updatePlatformInstructions,
  updateModelSettings,
} from "../lib/admin-config-service";
import {
  encryptSsoAccount,
  getSsoSecret,
  getSsoSettings,
  SsoConfigurationError,
  updateSsoSettings,
} from "../lib/sso-service";
import { prisma } from "../lib/prisma";
import { queueUserRuntimeConfiguration } from "../lib/runtime-configuration-service";
import { requireAdmin } from "../lib/session";
import { withUserConfigLocks } from "../lib/user-config-lock";

const modelSettingsBodySchema = z.object({
  baseURL: z.string().max(2048).optional().default(""),
  apiKey: z.string().max(4096).optional().default(""),
  models: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().max(128).optional().default(""),
  })).max(100).optional().default([]),
  defaultModel: z.string().max(160).optional().default(""),
}).strict();

const modelDiscoverBodySchema = z.object({
  baseURL: z.string().trim().min(1).max(2048),
  apiKey: z.string().max(4096).optional().default(""),
}).strict();

const DISCOVER_MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

export async function discoverRemoteModels(
  input: { baseURL: string; apiKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: Array<{ id: string; name: string }> }> {
  const trimmedBase = input.baseURL.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(trimmedBase)) {
    throw new AdminConfigError("接口地址 (baseURL) 需以 http:// 或 https:// 开头", 400);
  }
  const url = trimmedBase.endsWith("/models") ? trimmedBase : `${trimmedBase}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const trimmedKey = input.apiKey?.trim() ?? "";
  if (trimmedKey) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AdminConfigError("连接模型服务超时，请检查接口地址与网络连通性", 504);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new AdminConfigError(`无法连接模型服务：${detail}`, 502);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as { error?: { message?: string }; message?: string };
      detail = payload.error?.message || payload.message || "";
    } catch {
      // ignore non-json error body
    }
    const suffix = detail ? `：${detail}` : "";
    if (response.status === 401 || response.status === 403) {
      throw new AdminConfigError(`接口鉴权失败（${response.status}），请检查 API Key${suffix}`, 502);
    }
    throw new AdminConfigError(`模型列表接口返回错误（HTTP ${response.status}）${suffix}`, 502);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AdminConfigError("模型列表接口未返回合法 JSON", 502);
  }

  const rawList = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data))
      ? (payload as { data: unknown[] }).data
      : null;
  if (!rawList) {
    throw new AdminConfigError("接口返回格式不符合 OpenAI /models 规范（缺少 data 数组）", 502);
  }

  const byId = new Map<string, { id: string; name: string }>();
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; name?: unknown; display_name?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || !DISCOVER_MODEL_ID_RE.test(id)) continue;
    if (byId.has(id)) continue;
    const rawName = typeof record.name === "string"
      ? record.name.trim()
      : typeof record.display_name === "string"
        ? record.display_name.trim()
        : "";
    byId.set(id, { id, name: (rawName || id).slice(0, 128) });
  }

  const models = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

const platformInstructionsBodySchema = z.object({
  content: z.string(),
}).strict();

const ssoSettingsBodySchema = z.object({
  accountWhitelist: z.array(z.string().trim().min(1).max(128)).max(500),
  secret: z.string().min(1).max(4096).optional(),
}).strict();

const ssoSecretBodySchema = z.object({
  secret: z.string().min(1).max(4096),
}).strict();

const ssoWhitelistBodySchema = z.object({
  accountWhitelist: z.array(z.string().trim().min(1).max(128)).max(500),
}).strict();

const ssoTokenParamsSchema = z.object({
  userId: z.string().min(1).max(128),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminConfigError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  if (error instanceof SsoConfigurationError) {
    return reply.code(503).send({ message: error.message });
  }
  throw error;
}

/**
 * Platform model and global instruction settings are shared. Agent-specific
 * content comes from data/agents and is projected into each user's environment.
 */
export interface SsoTokenRouteServices {
  requireAdmin: typeof requireAdmin;
  getSecret: typeof getSsoSecret;
  getUser: (id: string) => Promise<{ username: string; isActive: boolean } | null>;
  getWhitelist: () => Promise<string[]>;
}

const ssoTokenRouteServices: SsoTokenRouteServices = {
  requireAdmin,
  getSecret: getSsoSecret,
  getUser: (id) => prisma.user.findUnique({
    where: { id },
    select: { username: true, isActive: true },
  }),
  getWhitelist: async () => (await getSsoSettings()).accountWhitelist,
};

export function registerSsoTokenRoute(
  app: FastifyInstance,
  services: SsoTokenRouteServices = ssoTokenRouteServices,
) {
  app.post("/v1/admin/sso/users/:userId/token", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (!await services.requireAdmin(request, reply)) return;
    const parsed = ssoTokenParamsSchema.safeParse(request.params);
    if (!parsed.success || !z.object({}).strict().safeParse(request.body).success) {
      return reply.code(400).send({ message: "请求参数不合法" });
    }

    try {
      const [secret, user, whitelist] = await Promise.all([
        services.getSecret(),
        services.getUser(parsed.data.userId),
        services.getWhitelist(),
      ]);
      if (!secret) return reply.code(503).send({ message: "尚未配置共享密钥，请先配置并保存" });
      if (!user) return reply.code(404).send({ message: "用户不存在，请刷新页面" });
      return {
        token: encryptSsoAccount(user.username, secret),
        isActive: user.isActive,
        isWhitelisted: whitelist.includes(user.username),
      };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}

export function registerSsoSettingsRoutes(
  app: FastifyInstance,
  services: {
    requireAdmin: typeof requireAdmin;
    getSettings: typeof getSsoSettings;
    updateSettings: typeof updateSsoSettings;
  } = {
    requireAdmin,
    getSettings: getSsoSettings,
    updateSettings: updateSsoSettings,
  },
) {
  app.get("/v1/admin/sso", async (request, reply) => {
    if (!await services.requireAdmin(request, reply)) return;
    return services.getSettings();
  });

  app.put("/v1/admin/sso", async (request, reply) => {
    if (!await services.requireAdmin(request, reply)) return;
    const parsed = ssoSettingsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    try {
      return await services.updateSettings(parsed.data);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put("/v1/admin/sso/secret", async (request, reply) => {
    if (!await services.requireAdmin(request, reply)) return;
    const parsed = ssoSecretBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    try {
      const settings = await services.updateSettings({ secret: parsed.data.secret });
      return { secretConfigured: settings.secretConfigured };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put("/v1/admin/sso/whitelist", async (request, reply) => {
    if (!await services.requireAdmin(request, reply)) return;
    const parsed = ssoWhitelistBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    try {
      const settings = await services.updateSettings({ accountWhitelist: parsed.data.accountWhitelist });
      return { accountWhitelist: settings.accountWhitelist };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}

export async function registerAdminConfigRoutes(app: FastifyInstance) {
  registerSsoTokenRoute(app);
  registerSsoSettingsRoutes(app);

  app.get("/v1/admin/opencode/models", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return await getModelSettings();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/v1/admin/opencode/models/discover", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = modelDiscoverBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请先填写合法的接口地址 (baseURL)" });
    try {
      return await discoverRemoteModels(parsed.data);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put("/v1/admin/opencode/models", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = modelSettingsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    const users = await prisma.containerInstance.findMany({ select: { userId: true } });
    const userIds = users.map((entry) => entry.userId);
    try {
      const settings = await withUserConfigLocks(userIds, async () => {
        const updated = await updateModelSettings(parsed.data);
        await prisma.containerInstance.updateMany({
          where: { userId: { in: userIds } },
          data: {
            desiredGeneration: { increment: 1 },
            desiredRuntimeHash: null,
            configApplyStatus: "DRAINING",
            configApplyError: null,
          },
        });
        return updated;
      });
      for (const userId of userIds) queueUserRuntimeConfiguration(userId);
      return { success: true, ...settings };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/v1/admin/opencode/instructions", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return {
      content: await getPlatformInstructions(),
      maxBytes: MAX_PLATFORM_INSTRUCTIONS_BYTES,
    };
  });

  app.put("/v1/admin/opencode/instructions", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = platformInstructionsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    try {
      normalizePlatformInstructionsContent(parsed.data.content);
    } catch (error) {
      return handleError(error, reply);
    }
    const users = await prisma.containerInstance.findMany({ select: { userId: true } });
    const userIds = users.map((entry) => entry.userId);
    try {
      const content = await withUserConfigLocks(userIds, async () => {
        const updated = await updatePlatformInstructions(parsed.data.content);
        await updateGlobalInstructions("");
        await prisma.containerInstance.updateMany({
          where: { userId: { in: userIds } },
          data: {
            desiredGeneration: { increment: 1 },
            desiredRuntimeHash: null,
            configApplyStatus: "DRAINING",
            configApplyError: null,
          },
        });
        return updated;
      });
      for (const userId of userIds) queueUserRuntimeConfiguration(userId);
      return {
        success: true,
        content,
        maxBytes: MAX_PLATFORM_INSTRUCTIONS_BYTES,
      };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
