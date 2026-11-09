import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  AdminConfigError,
  getGlobalInstructions,
  getModelSettings,
  MAX_GLOBAL_INSTRUCTIONS_BYTES,
  updateGlobalInstructions,
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

const globalInstructionsBodySchema = z.object({
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
      content: await getGlobalInstructions(),
      maxBytes: MAX_GLOBAL_INSTRUCTIONS_BYTES,
    };
  });

  app.put("/v1/admin/opencode/instructions", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = globalInstructionsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    const users = await prisma.containerInstance.findMany({ select: { userId: true } });
    const userIds = users.map((entry) => entry.userId);
    try {
      const content = await withUserConfigLocks(userIds, async () => {
        const updated = await updateGlobalInstructions(parsed.data.content);
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
      return { success: true, content, maxBytes: MAX_GLOBAL_INSTRUCTIONS_BYTES };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
