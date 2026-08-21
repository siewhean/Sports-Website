import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateCC5LeaseTakeoverExecutor } from "../../src/gate-c-c5-lease-takeover.js";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock;
});
afterEach(() => fetchMock.mockReset());
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const invocation = {
  operation: "lease_takeover" as const,
  workerIndex: 0,
  sampleIndex: 0,
  signal: new AbortController().signal,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("C5 lease-takeover workload executor", () => {
  it("proves organiser approval fences the stale writer before the candidate writes", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ mode: "writer", read_only: false, generation: 1 }))
      .mockResolvedValueOnce(json({ id: "takeover-1" }, 201))
      .mockResolvedValueOnce(json({ csrf_token: "csrf" }))
      .mockResolvedValueOnce(json({ generation: 2 }))
      .mockResolvedValueOnce(json({ error: { code: "STALE_WRITER_GENERATION" } }, 409))
      .mockResolvedValueOnce(json({ outcome: "accepted", sequence: 1 }));
    const candidate = vi
      .fn()
      .mockResolvedValue({ sessionId: "candidate", sessionToken: "c".repeat(32), generation: null });
    const executor = createGateCC5LeaseTakeoverExecutor({
      apiOrigin: "http://127.0.0.1:4101",
      webOrigin: "http://localhost:3103",
      competitionId: "competition",
      organiserCookie: "session=opaque",
      incumbent: { sessionId: "writer", sessionToken: "w".repeat(32), generation: 1 },
      createCandidate: candidate,
    });

    await expect(executor(invocation)).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
    expect(candidate).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/v1/scoring/sessions/heartbeat",
      "/api/v1/scoring/takeover-requests",
      "/api/v1/identity/session",
      "/api/v1/competitions/competition/takeover-requests/takeover-1/approve",
      "/api/v1/scoring/events",
      "/api/v1/scoring/events",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-writer-generation": "1" });
    expect(fetchMock.mock.calls[4]?.[1]?.headers).toMatchObject({ "x-writer-generation": "1" });
    expect(fetchMock.mock.calls[5]?.[1]?.headers).toMatchObject({ "x-writer-generation": "2" });
  });

  it("fails closed when the stale generation is accepted", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ mode: "writer", read_only: false, generation: 1 }))
      .mockResolvedValueOnce(json({ id: "takeover-1" }, 201))
      .mockResolvedValueOnce(json({ csrf_token: "csrf" }))
      .mockResolvedValueOnce(json({ generation: 2 }))
      .mockResolvedValueOnce(json({ outcome: "accepted", sequence: 1 }));
    const executor = createGateCC5LeaseTakeoverExecutor({
      apiOrigin: "http://127.0.0.1:4101",
      webOrigin: "http://localhost:3103",
      competitionId: "competition",
      organiserCookie: "session=opaque",
      incumbent: { sessionId: "writer", sessionToken: "w".repeat(32), generation: 1 },
      createCandidate: vi
        .fn()
        .mockResolvedValue({ sessionId: "candidate", sessionToken: "c".repeat(32), generation: null }),
    });

    await expect(executor(invocation)).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { failureCode: "takeover_stale_fence_http_200" },
    });
  });

  it("heartbeats each incumbent and monotonically fences generations across repeated takeovers", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ mode: "writer", read_only: false, generation: 1 }))
      .mockResolvedValueOnce(json({ id: "takeover-1" }, 201))
      .mockResolvedValueOnce(json({ csrf_token: "csrf" }))
      .mockResolvedValueOnce(json({ generation: 2 }))
      .mockResolvedValueOnce(json({ error: { code: "STALE_WRITER_GENERATION" } }, 409))
      .mockResolvedValueOnce(json({ outcome: "accepted", sequence: 1 }))
      .mockResolvedValueOnce(json({ mode: "writer", read_only: false, generation: 2 }))
      .mockResolvedValueOnce(json({ id: "takeover-2" }, 201))
      .mockResolvedValueOnce(json({ csrf_token: "csrf" }))
      .mockResolvedValueOnce(json({ generation: 3 }))
      .mockResolvedValueOnce(json({ error: { code: "STALE_WRITER_GENERATION" } }, 409))
      .mockResolvedValueOnce(json({ outcome: "accepted", sequence: 2 }));
    const candidate = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "candidate-1", sessionToken: "a".repeat(32), generation: null })
      .mockResolvedValueOnce({ sessionId: "candidate-2", sessionToken: "b".repeat(32), generation: null });
    const executor = createGateCC5LeaseTakeoverExecutor({
      apiOrigin: "http://127.0.0.1:4101",
      webOrigin: "http://localhost:3103",
      competitionId: "competition",
      organiserCookie: "session=opaque",
      incumbent: { sessionId: "writer", sessionToken: "w".repeat(32), generation: 1 },
      createCandidate: candidate,
    });

    await expect(executor(invocation)).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
    await expect(executor({ ...invocation, sampleIndex: 1 })).resolves.toEqual({
      outcome: "success",
      correctness: { passed: true },
    });

    const calls = fetchMock.mock.calls.map(([url, options]) => ({
      pathname: new URL(String(url)).pathname,
      generation: new Headers(options?.headers).get("x-writer-generation"),
    }));
    expect(calls.filter((call) => call.pathname === "/api/v1/scoring/sessions/heartbeat")).toEqual([
      { pathname: "/api/v1/scoring/sessions/heartbeat", generation: "1" },
      { pathname: "/api/v1/scoring/sessions/heartbeat", generation: "2" },
    ]);
    expect(calls.filter((call) => call.pathname === "/api/v1/scoring/events").map((call) => call.generation)).toEqual([
      "1",
      "2",
      "2",
      "3",
    ]);
  });
});
