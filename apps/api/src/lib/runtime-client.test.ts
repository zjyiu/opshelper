import assert from "node:assert/strict";
import test from "node:test";

import { runtimeHttpRequest, RuntimeRequestError } from "./runtime-client";

test("runtimeHttpRequest unwraps data envelopes and throws RuntimeRequestError with statusCode", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "http://runtime:4096/runtime/health");
      assert.equal((init?.headers as Record<string, string>)?.authorization, "Basic dGVzdA==");
      return new Response(JSON.stringify({ data: { engine: "dsh", ready: true } }), { status: 200 });
    }) as typeof fetch;

    const result = await runtimeHttpRequest<{ engine: string; ready: boolean }>(
      { target: "http://runtime:4096", authorization: "Basic dGVzdA==" },
      "GET",
      "/runtime/health",
    );
    assert.deepEqual(result, { engine: "dsh", ready: true });

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "会话不存在" }), { status: 404 })) as typeof fetch;
    await assert.rejects(
      runtimeHttpRequest({ target: "http://runtime:4096", authorization: "Basic dGVzdA==" }, "DELETE", "/runtime/sessions/missing"),
      (error: unknown) =>
        error instanceof RuntimeRequestError &&
        error.statusCode === 404 &&
        /会话不存在/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
