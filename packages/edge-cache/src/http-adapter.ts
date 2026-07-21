import {
  assertEdgePurgeRequest,
  edgePurgeIdempotencyKey,
  EdgePurgePermanentError,
  EdgePurgeRetryableError,
  type EdgeCachePurgePort,
  type EdgePurgeRequest,
  type EdgePurgeResult,
} from "./types.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HttpEdgeCachePurgeOptions = {
  endpoint: string;
  bearerToken: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => Date;
};

function validateEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("Edge purge endpoint must use HTTPS, except for loopback tests");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Edge purge endpoint must not include credentials, query, or fragment");
  }
  return endpoint;
}

export class HttpEdgeCachePurgeAdapter implements EdgeCachePurgePort {
  readonly #bearerToken: string;
  private readonly endpoint: URL;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: HttpEdgeCachePurgeOptions) {
    this.endpoint = validateEndpoint(options.endpoint);
    if (Buffer.byteLength(options.bearerToken, "utf8") < 32) {
      throw new Error("Edge purge bearer token must be at least 32 bytes");
    }
    this.#bearerToken = options.bearerToken;
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000) {
      throw new Error("Edge purge timeout must be between 250 and 30000 milliseconds");
    }
  }

  async purge(request: EdgePurgeRequest): Promise<EdgePurgeResult> {
    assertEdgePurgeRequest(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      let response: Response;
      try {
        response = await this.fetch(this.endpoint, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#bearerToken}`,
            "content-type": "application/json",
            "idempotency-key": edgePurgeIdempotencyKey(request),
            "x-correlation-id": request.correlationId,
          },
          body: JSON.stringify({
            competition_id: request.competitionId,
            projection: request.projection,
            previous_published_version: request.previousPublishedVersion,
            published_version: request.publishedVersion,
          }),
        });
      } catch {
        throw new EdgePurgeRetryableError();
      }

      if (response.status === 429 || response.status >= 500) throw new EdgePurgeRetryableError();
      if (!response.ok) throw new EdgePurgePermanentError();

      let providerRequestId: string | undefined;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          const body = await readBoundedBody(response, 4_096);
          const payload = body === undefined ? undefined : (JSON.parse(body) as { request_id?: unknown });
          if (typeof payload?.request_id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(payload.request_id)) {
            providerRequestId = payload.request_id;
          }
        } catch {
          // A successful purge does not depend on an optional provider receipt body.
        }
      }
      return {
        purgedAt: this.now().toISOString(),
        ...(providerRequestId ? { providerRequestId } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return body + decoder.decode();
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
}
