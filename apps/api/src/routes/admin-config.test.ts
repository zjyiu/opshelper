import assert from "node:assert/strict";
import test from "node:test";

import { AdminConfigError } from "../lib/admin-config-service";
import { discoverRemoteModels } from "./admin-config";

test("discoverRemoteModels fetches /models, attaches bearer key, deduplicates and sorts", async () => {
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({
      data: [
        { id: "deepseek-reasoner" },
        { id: "deepseek-chat", name: "DeepSeek Chat" },
        { id: "deepseek-chat" },
        { id: "invalid id with spaces" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const result = await discoverRemoteModels(
    { baseURL: "https://api.deepseek.com/v1/", apiKey: "sk-test" },
    fakeFetch,
  );

  assert.equal(requestedUrl, "https://api.deepseek.com/v1/models");
  assert.equal(requestedHeaders.Authorization, "Bearer sk-test");
  assert.deepEqual(result.models, [
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek-reasoner", name: "deepseek-reasoner" },
  ]);
});

test("discoverRemoteModels omits Authorization header when apiKey is empty and preserves /models suffix", async () => {
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({
      data: [{ id: "qwen2.5:7b" }],
    }), { status: 200 });
  };

  const result = await discoverRemoteModels(
    { baseURL: "http://127.0.0.1:11434/v1/models", apiKey: "   " },
    fakeFetch,
  );

  assert.equal(requestedUrl, "http://127.0.0.1:11434/v1/models");
  assert.equal(requestedHeaders.Authorization, undefined);
  assert.deepEqual(result.models, [{ id: "qwen2.5:7b", name: "qwen2.5:7b" }]);
});

test("discoverRemoteModels reports auth errors and rejects invalid baseURL", async () => {
  await assert.rejects(
    () => discoverRemoteModels({ baseURL: "ftp://example.com" }),
    (error: unknown) => error instanceof AdminConfigError && error.statusCode === 400,
  );

  const unauthorizedFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });

  await assert.rejects(
    () => discoverRemoteModels({ baseURL: "https://api.example.com/v1", apiKey: "bad" }, unauthorizedFetch),
    (error: unknown) =>
      error instanceof AdminConfigError &&
      error.statusCode === 502 &&
      error.message.includes("鉴权失败") &&
      error.message.includes("bad key"),
  );
});
