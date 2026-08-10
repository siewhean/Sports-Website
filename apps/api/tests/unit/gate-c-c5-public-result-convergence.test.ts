import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateCC5PublicResultConvergenceExecutor } from "../../src/gate-c-c5-public-result-convergence.js";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock;
});
afterEach(() => fetchMock.mockReset());
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const target = {
  apiOrigin: "http://127.0.0.1:4101",
  slug: "c5-public-fixture",
  matchId: "match-1",
  sessionId: "session-1",
  sessionToken: "s".repeat(32),
  writerGeneration: 1,
  expectedSequence: 3,
};

const invocation = {
  operation: "public_result_convergence" as const,
  workerIndex: 0,
  sampleIndex: 0,
  signal: new AbortController().signal,
};

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function receipt(clientEventId: string) {
  return {
    client_event_id: clientEventId,
    outcome: "accepted",
    duplicate: false,
    match_id: "match-1",
    sequence: 4,
    aggregate_version: 4,
    result_version: 1,
    publication_version: 1,
  };
}

function current(resultVersion = 1) {
  return {
    publication: { result_version: resultVersion },
    freshness: { result_version: resultVersion },
    divisions: [{ results: [{ id: "match-1", state: "final" }] }],
  };
}

describe("C5 public-result convergence executor", () => {
  it("requires a finalisation receipt and an exact canonical public result version", async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { client_event_id: string };
      return json(receipt(body.client_event_id));
    });
    fetchMock.mockResolvedValueOnce(
      json(current(), 200, {
        etag: '"c4-1-1"',
        "last-modified": "Mon, 03 Aug 2026 00:00:00 GMT",
        "cache-control": "public, max-age=30",
      }),
    );
    const executor = createGateCC5PublicResultConvergenceExecutor([target]);

    await expect(executor(invocation)).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("acquires a fresh writer session just in time for a delayed convergence wave", async () => {
    const acquireSession = vi.fn(async () => ({
      sessionId: "wave-session",
      sessionToken: "wave-token",
      writerGeneration: 9,
    }));
    fetchMock.mockImplementationOnce(async (_url, init) => {
      expect(new Headers(init?.headers).get("x-scoring-session-id")).toBe("wave-session");
      expect(new Headers(init?.headers).get("x-writer-generation")).toBe("9");
      const body = JSON.parse(String(init?.body)) as { client_event_id: string };
      return json(receipt(body.client_event_id));
    });
    fetchMock.mockResolvedValueOnce(
      json(current(), 200, {
        etag: '"c4-1-1"',
        "last-modified": "Mon, 03 Aug 2026 00:00:00 GMT",
        "cache-control": "public, max-age=30",
      }),
    );
    const executor = createGateCC5PublicResultConvergenceExecutor([
      {
        apiOrigin: target.apiOrigin,
        slug: target.slug,
        matchId: target.matchId,
        expectedSequence: target.expectedSequence,
        acquireSession,
      },
    ]);
    await expect(executor(invocation)).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
    expect(acquireSession).toHaveBeenCalledOnce();
  });

  it("fails closed when a different aggregate advances the public result version", async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return json(receipt(body.client_event_id));
    });
    fetchMock.mockResolvedValueOnce(
      json(current(2), 200, {
        etag: '"c4-1-2"',
        "last-modified": "Mon, 03 Aug 2026 00:00:00 GMT",
        "cache-control": "public, max-age=30",
      }),
    );
    const executor = createGateCC5PublicResultConvergenceExecutor([target]);

    await expect(executor(invocation)).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { failureCode: "public_result_version_advanced" },
    });
  });

  it("retries a lower public result version and accepts only exact convergence", async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { client_event_id: string };
      return json({ ...receipt(body.client_event_id), result_version: 2, publication_version: 2 });
    });
    fetchMock.mockResolvedValueOnce(
      json(current(1), 200, {
        etag: '"c4-1-1"',
        "last-modified": "Mon, 03 Aug 2026 00:00:00 GMT",
        "cache-control": "public, max-age=30",
      }),
    );
    fetchMock.mockResolvedValueOnce(
      json(current(2), 200, {
        etag: '"c4-1-2"',
        "last-modified": "Mon, 03 Aug 2026 00:00:01 GMT",
        "cache-control": "public, max-age=30",
      }),
    );
    const executor = createGateCC5PublicResultConvergenceExecutor([target]);

    await expect(executor(invocation)).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
  });

  it("rejects malformed freshness and missing final results", async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { client_event_id: string };
      return json(receipt(body.client_event_id));
    });
    fetchMock.mockResolvedValueOnce(
      json(
        { publication: { result_version: 1 }, freshness: { result_version: 1 }, divisions: [{ results: [] }] },
        200,
        {
          etag: '"c4-1-1"',
          "last-modified": "Mon, 03 Aug 2026 00:00:00 GMT",
          "cache-control": "public, max-age=30",
        },
      ),
    );
    const executor = createGateCC5PublicResultConvergenceExecutor([target]);

    await expect(executor(invocation)).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { failureCode: "public_result_projection_mismatch" },
    });
  });

  it("fails once targets are exhausted rather than reusing a finalised aggregate", async () => {
    const executor = createGateCC5PublicResultConvergenceExecutor([target]);
    await expect(executor({ ...invocation, sampleIndex: 1 })).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { failureCode: "public_result_target_exhausted" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
