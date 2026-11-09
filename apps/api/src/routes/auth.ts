import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  authenticateWithPassword,
  clearSession,
  createSession,
  getSessionCookieName,
  getSessionUserByToken,
  getSessionUserFromRequest,
  requireSession,
} from "../lib/session";
import { hashPassword, verifyPassword } from "../lib/password";
import { prisma } from "../lib/prisma";
import { getSessionResponse } from "../lib/container-views";
import {
  authenticateSsoAccount,
  SsoConfigurationError,
  SsoTokenError,
} from "../lib/sso-service";

const loginSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(6),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

const desktopOpenSchema = z.object({
  _token: z.string().trim().min(1),
  redirect: z.string().trim().optional(),
});

const ssoQuerySchema = z.object({
  account: z.string().min(1).max(2048),
});

export function resolveDesktopOpenRedirect(redirect?: string) {
  if (!redirect) {
    return "/gateway/";
  }

  if (!redirect.startsWith("/") || redirect.startsWith("//") || /[\\\u0000-\u0020]/.test(redirect)) {
    return "/gateway/";
  }

  return redirect;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid login payload" });
    }

    const user = await authenticateWithPassword(
      parsed.data.username,
      parsed.data.password,
    );

    if (!user) {
      return reply.code(401).send({ message: "Invalid credentials" });
    }

    const session = await createSession(reply, user.id);
    return {
      user,
      session: {
        token: session.token,
        tokenType: "Bearer" as const,
        expiresAt: session.expiresAt.toISOString(),
        cookieName: getSessionCookieName(),
      },
    };
  });

  app.get("/v1/auth/desktop-open", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer").header("Cache-Control", "no-store");
    const parsed = desktopOpenSchema.safeParse(request.query);
    const redirectPath = resolveDesktopOpenRedirect(parsed.success ? parsed.data.redirect : undefined);

    if (!parsed.success) {
      return reply.redirect("/gateway/login");
    }

    const auth = await getSessionUserByToken(parsed.data._token);

    if (!auth) {
      return reply.redirect("/gateway/login");
    }

    await createSession(reply, auth.user.id);
    return reply.redirect(redirectPath);
  });

  app.get("/v1/auth/sso", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer").header("Cache-Control", "no-store");
    const parsed = ssoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.redirect("/gateway/login?ssoError=failed");
    }

    try {
      const username = await authenticateSsoAccount(parsed.data.account);
      if (!username) {
        return reply.redirect("/gateway/login?ssoError=failed");
      }

      const user = await prisma.user.findUnique({
        where: { username },
        select: { id: true, isActive: true },
      });
      if (!user?.isActive) {
        return reply.redirect("/gateway/login?ssoError=failed");
      }

      await createSession(reply, user.id);
      return reply.redirect("/gateway/chat");
    } catch (error) {
      if (error instanceof SsoTokenError) {
        return reply.redirect("/gateway/login?ssoError=failed");
      }
      if (error instanceof SsoConfigurationError) {
        return reply.redirect("/gateway/login?ssoError=unavailable");
      }
      throw error;
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    await clearSession(request, reply);
    return reply.code(204).send();
  });

  app.get("/v1/auth/session", async (request) => {
    const auth = await getSessionUserFromRequest(request);
    return getSessionResponse(auth?.user ?? null);
  });

  app.put("/v1/auth/change-password", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) {
      return;
    }

    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload" });
    }

    const { currentPassword, newPassword } = parsed.data;

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    if (!dbUser) {
      return reply.code(404).send({ message: "User not found" });
    }

    const isValid = await verifyPassword(currentPassword, dbUser.passwordHash);
    if (!isValid) {
      return reply.code(401).send({ message: "Current password is incorrect" });
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    return reply.code(204).send();
  });

  app.get("/v1/auth/me", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    return { user };
  });
}
