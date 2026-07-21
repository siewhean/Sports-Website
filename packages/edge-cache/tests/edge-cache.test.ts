import { describe, expect, it, vi } from "vitest";
import {
  assertEdgePurgeRequest,
  edgePurgeIdempotencyKey,
  EdgePurgePermanentError,
  EdgePurgeRetryableError,
  EdgePurgeValidationError,
  HttpEdgeCachePurgeAdapter,
  type EdgePurgeRequest,
} from "../src/index.js";

const request: EdgePurgeRequest = {
  competitionId: "10000000-0000-4000-a000-000000000001",
  projection: "results",
  publicationState: "published",
  previousPublishedVersion: 4,
  publishedVersion: 5,
  correlationId: "publish-request-5",
};

describe("edge purge contract", () => {
  it("derives a stable idempotency key without credentials or URLs", () => {
    expect(edgePurgeIdempotencyKey(request)).toBe("purge:10000000-0000-4000-a000-000000000001:results:4");
  });

  it("rejects drafts, invalid identifiers and non-advancing versions", () => {
    expect(() =>
      assertEdgePurgeRequest({ ...request, publicationState: "draft" } as unknown as EdgePurgeRequest),
    ).toThrow(EdgePurgeValidationError);
    expect(() => assertEdgePurgeRequest({ ...request, competitionId: "../other-tenant" })).toThrow(
      EdgePurgeValidationError,
    );
    expect(() => assertEdgePurgeRequest({ ...request, publishedVersion: 4 })).toThrow(EdgePurgeValidationError);
  });

  it("posts a fixed payload and returns a sanitized provider receipt", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${"t".repeat(32)}`,
        "idempotency-key": edgePurgeIdempotencyKey(request),
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        competition_id: request.competitionId,
        projection: "results",
        previous_published_version: 4,
        published_version: 5,
      });
      return Response.json({ request_id: "provider-5" });
    });
    const adapter = new HttpEdgeCachePurgeAdapter({
      endpoint: "https://edge-bridge.example.test/purge",
      bearerToken: "t".repeat(32),
      fetch,
      now: () => new Date("2026-07-17T01:00:00.000Z"),
    });
    await expect(adapter.purge(request)).resolves.toEqual({
      purgedAt: "2026-07-17T01:00:00.000Z",
      providerRequestId: "provider-5",
    });
  });

  it("ignores an oversized optional provider receipt", async () => {
    const adapter = new HttpEdgeCachePurgeAdapter({
      endpoint: "https://edge-bridge.example.test/purge",
      bearerToken: "t".repeat(32),
      fetch: async () => Response.json({ request_id: "x".repeat(5_000) }),
      now: () => new Date("2026-07-17T01:00:00.000Z"),
    });
    await expect(adapter.purge(request)).resolves.toEqual({ purgedAt: "2026-07-17T01:00:00.000Z" });
  });

  it("classifies provider failures without leaking the credential or response body", async () => {
    const token = "private-token-value-that-is-long-enough";
    const retryable = new HttpEdgeCachePurgeAdapter({
      endpoint: "https://edge-bridge.example.test/purge",
      bearerToken: token,
      fetch: async () => new Response(`provider failed with ${token}`, { status: 503 }),
    });
    const permanent = new HttpEdgeCachePurgeAdapter({
      endpoint: "https://edge-bridge.example.test/purge",
      bearerToken: token,
      fetch: async () => new Response("wrong tenant", { status: 403 }),
    });
    await expect(retryable.purge(request)).rejects.toBeInstanceOf(EdgePurgeRetryableError);
    await expect(permanent.purge(request)).rejects.toBeInstanceOf(EdgePurgePermanentError);
    await expect(retryable.purge(request)).rejects.not.toThrow(token);
  });

  it("rejects unsafe endpoints and short credentials before any request", () => {
    expect(
      () =>
        new HttpEdgeCachePurgeAdapter({
          endpoint: "http://edge.example.test/purge",
          bearerToken: "t".repeat(32),
        }),
    ).toThrow("HTTPS");
    expect(
      () =>
        new HttpEdgeCachePurgeAdapter({
          endpoint: "https://user:secret@edge.example.test/purge",
          bearerToken: "t".repeat(32),
        }),
    ).toThrow("credentials");
    expect(
      () =>
        new HttpEdgeCachePurgeAdapter({
          endpoint: "https://edge.example.test/purge",
          bearerToken: "short",
        }),
    ).toThrow("32 bytes");
  });
});
