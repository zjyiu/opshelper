import { timingSafeEqual } from "node:crypto";
import http from "node:http";

import { DshRuntimeHost, RuntimeHttpError } from "./runtime-host.mjs";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

function safeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyAuthorizationHeader(headerValue, expectedPassword, allowedUsernames = ["opshelper"]) {
  if (!expectedPassword) return true;
  if (typeof headerValue !== "string" || !headerValue.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(headerValue.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  if (!allowedUsernames.includes(user)) return false;
  return safeEqualString(pass, expectedPassword);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new RuntimeHttpError(413, "请求体过大");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RuntimeHttpError(400, "请求体不是合法 JSON");
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createRuntimeServer(host, options = {}) {
  const password = options.password ?? process.env.RUNTIME_SERVER_PASSWORD ?? "";

  return http.createServer(async (req, res) => {
    try {
      if (!verifyAuthorizationHeader(req.headers.authorization, password)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="opshelper-runtime"' });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const pathname = url.pathname;

      // SSE event stream
      if (method === "GET" && pathname === "/runtime/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(`data: ${JSON.stringify({ type: "server.connected" })}\n\n`);

        const unsubscribe = host.subscribeEvents((event) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "server.heartbeat" })}\n\n`);
          }
        }, HEARTBEAT_MS);
        heartbeat.unref?.();

        const close = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        req.on("close", close);
        res.on("close", close);
        return;
      }

      if (method === "GET" && pathname === "/runtime/health") {
        return sendJson(res, 200, { data: await host.getInfo() });
      }

      if (method === "GET" && pathname === "/runtime/agents") {
        return sendJson(res, 200, { data: await host.listAgents() });
      }

      let match = /^\/runtime\/agents\/([^/]+)$/.exec(pathname);
      if (method === "GET" && match) {
        return sendJson(res, 200, { data: await host.getAgent(decodeURIComponent(match[1])) });
      }

      if (method === "GET" && pathname === "/runtime/sessions") {
        return sendJson(res, 200, { data: await host.listSessions() });
      }

      if (method === "POST" && pathname === "/runtime/sessions") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { data: await host.createSession(body) });
      }

      if (method === "GET" && pathname === "/runtime/sessions/active") {
        return sendJson(res, 200, { data: await host.listActiveSessions() });
      }

      if (method === "GET" && pathname === "/runtime/permissions") {
        return sendJson(res, 200, { data: host.listPermissions() });
      }

      if (method === "GET" && pathname === "/runtime/questions") {
        return sendJson(res, 200, { data: host.listQuestions() });
      }

      match = /^\/runtime\/sessions\/([^/]+)$/.exec(pathname);
      if (match) {
        const sessionId = decodeURIComponent(match[1]);
        if (method === "PATCH") {
          const body = await readJsonBody(req);
          return sendJson(res, 200, { data: await host.updateSession(sessionId, body) });
        }
        if (method === "DELETE") {
          return sendJson(res, 200, { data: await host.deleteSession(sessionId) });
        }
      }

      match = /^\/runtime\/sessions\/([^/]+)\/messages$/.exec(pathname);
      if (method === "GET" && match) {
        const sessionId = decodeURIComponent(match[1]);
        return sendJson(res, 200, { data: await host.getSessionMessages(sessionId) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/agent$/.exec(pathname);
      if (method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, { data: await host.setSessionAgent(sessionId, body.agent) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/model$/.exec(pathname);
      if (method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, { data: await host.setSessionModel(sessionId, body) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/prompt$/.exec(pathname);
      if (method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, { data: await host.promptSession(sessionId, body) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/cancel$/.exec(pathname);
      if (method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        return sendJson(res, 200, { data: await host.cancelSession(sessionId) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/fork$/.exec(pathname);
      if (method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, { data: await host.forkSession(sessionId, body) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/permissions\/([^/]+)\/reply$/.exec(pathname);
      if (method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const permissionId = decodeURIComponent(match[2]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, { data: host.replyPermission(sessionId, permissionId, body.decision) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/questions\/([^/]+)\/reply$/.exec(pathname);
      if (method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const requestId = decodeURIComponent(match[2]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, { data: host.replyQuestion(sessionId, requestId, body.answers) });
      }

      match = /^\/runtime\/sessions\/([^/]+)\/questions\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const requestId = decodeURIComponent(match[2]);
        return sendJson(res, 200, { data: host.cancelQuestion(sessionId, requestId) });
      }

      return sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
    } catch (error) {
      const statusCode = error instanceof RuntimeHttpError
        ? error.statusCode
        : error?.isDSHRemoteError && String(error.code).includes("not-found")
          ? 404
          : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, statusCode, { error: message });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}

async function main() {
  const host = new DshRuntimeHost();
  await host.start();
  const server = createRuntimeServer(host);
  const port = Number(process.env.RUNTIME_PORT ?? "4096");
  const hostname = process.env.RUNTIME_HOST ?? "0.0.0.0";

  await new Promise((resolve) => server.listen(port, hostname, resolve));
  console.log(`[opshelper-dsh-runtime] listening on http://${hostname}:${port}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[opshelper-dsh-runtime] received ${signal}, shutting down...`);
    await new Promise((resolve) => server.close(() => resolve()));
    await host.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isEntrypoint = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    console.error("[opshelper-dsh-runtime] fatal startup error:", error);
    process.exit(1);
  });
}
