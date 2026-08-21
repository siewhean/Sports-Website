import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateCC5PublicCurrentExecutor } from "../../src/gate-c-c5-public-current.js";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const invocation = {
  operation: "public_current_conditional_read" as const,
  workerIndex: 0,
  sampleIndex: 0,
  signal: new AbortController().signal,
};

describe("C5 canonical public-current executor", () => {
  it("requires the canonical 200 freshness response followed by an ETag-matched 304", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 200,
          headers: {
            etag: '"current-v7"',
            "last-modified": "Mon, 03 Aug 2026 00:00:00 GMT",
            "cache-control": "public, max-age=30",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: { etag: '"current-v7"', "last-modified": "Mon, 03 Aug 2026 00:00:00 GMT" },
        }),
      );
    const executor = createGateCC5PublicCurrentExecutor({ apiOrigin: "http://127.0.0.1:4101", slug: "c5-fixture" });

    await expect(executor(invocation)).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "if-none-match": '"current-v7"' });
  });

  it("fails closed when a public response lacks canonical freshness metadata", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { etag: '"current-v7"' } }));
    const executor = createGateCC5PublicCurrentExecutor({ apiOrigin: "http://127.0.0.1:4101", slug: "c5-fixture" });

    await expect(executor(invocation)).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { failureCode: "public_current_initial_http_200" },
    });
  });
});
