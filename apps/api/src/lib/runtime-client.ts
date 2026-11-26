/** DeepSeek Harness (DSH) container runtime HTTP + SSE boundary. */

export class RuntimeRequestError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

export interface RuntimeEndpoint {
  target: string;
  authorization: string;
}

export async function runtimeHttpRequest<T>(
  connection: RuntimeEndpoint,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const response = await fetch(`${connection.target}${route}`, {
    method,
    headers: {
      authorization: connection.authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = text ? JSON.parse(text) as { error?: unknown } : null;
      if (typeof parsed?.error === "string" && parsed.error) detail = `：${parsed.error}`;
    } catch {
      // ignore non-json error body
    }
    throw new RuntimeRequestError(`DSH runtime ${method} ${route} 返回 ${response.status}${detail}`, response.status);
  }
  if (!text) return undefined as T;
  const parsed = JSON.parse(text) as { data?: T } | T;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}
