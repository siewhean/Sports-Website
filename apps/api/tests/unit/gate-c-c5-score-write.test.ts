import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateCC5ScoreWriteExecutor, issueGateCC5ScoreWriteSessions } from "../../src/gate-c-c5-score-write.js";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  fetchMock.mockReset();
});

const sessions = [
  {
    apiOrigin: "http://127.0.0.1:4101",
    sessionId: "a",
    sessionToken: "a".repeat(32),
    writerGeneration: 1,
    expectedSequence: 0,
  },
  {
    apiOrigin: "http://127.0.0.1:4101",
    sessionId: "b",
    sessionToken: "b".repeat(32),
    writerGeneration: 1,
    expectedSequence: 4,
  },
] as const;

function invocation(workerIndex: number) {
  return {
    operation: "score_event_acknowledgement" as const,
    workerIndex,
    sampleIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("C5 score-write traffic adapter", () => {
  it("issues dedicated one-time passes and retains only exchanged writer-session material", async () => {
    const createAccessPass = vi.fn().mockResolvedValue({ token: "one-time-token" });
    const exchangeAccess = vi.fn().mockResolvedValue({
      session_id: "session-1",
      session_token: "s".repeat(32),
      mode: "writer",
      generation: 3,
    });
    const sessions = await issueGateCC5ScoreWriteSessions(
      { createAccessPass, exchangeAccess } as never,
      { accountId: "organiser" },
      "http://127.0.0.1:4101",
      [{ competitionId: "competition", matchId: "match", expectedSequence: 2 }],
      () => new Date("2026-08-04T00:00:00.000Z"),
    );
    expect(createAccessPass).toHaveBeenCalledWith(
      { accountId: "organiser" },
      "competition",
      "match",
      expect.objectContaining({ role: "scorekeeper", expiresAt: "2026-08-04T00:30:00.000Z" }),
      expect.any(String),
    );
    expect(exchangeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ token: "one-time-token", expectedMatchId: "match" }),
      expect.any(String),
    );
    expect(sessions).toEqual([
      expect.objectContaining({ sessionId: "session-1", writerGeneration: 3, expectedSequence: 2 }),
    ]);
    expect(JSON.stringify(sessions)).not.toContain("one-time-token");
  });

  it("rejects a candidate exchange instead of generating unfenced traffic", async () => {
    await expect(
      issueGateCC5ScoreWriteSessions(
        {
          createAccessPass: vi.fn().mockResolvedValue({ token: "one-time-token" }),
          exchangeAccess: vi.fn().mockResolvedValue({ mode: "candidate", generation: null }),
        } as never,
        { accountId: "organiser" },
        "http://127.0.0.1:4101",
        [{ competitionId: "competition", matchId: "match", expectedSequence: 0 }],
      ),
    ).rejects.toThrow("did not acquire a writer lease");
  });

  it("binds each worker to its own writer session and advances only accepted receipts", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { client_event_id: string; expected_sequence: number };
      return new Response(
        JSON.stringify({
          client_event_id: body.client_event_id,
          outcome: "accepted",
          aggregate_version: body.expected_sequence + 1,
          sequence: body.expected_sequence + 1,
        }),
        { status: 200 },
      );
    });
    const execute = createGateCC5ScoreWriteExecutor(sessions);
    await expect(execute(invocation(0))).resolves.toMatchObject({ outcome: "success" });
    await expect(execute(invocation(1))).resolves.toMatchObject({ outcome: "success" });
    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as { expected_sequence: number },
    );
    expect(bodies.map((body) => body.expected_sequence)).toEqual([0, 4]);
  });

  it("fails closed for non-accepted and malformed upstream receipts", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "duplicate" }), { status: 200 }));
    const execute = createGateCC5ScoreWriteExecutor([sessions[0]]);
    await expect(execute(invocation(0))).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { passed: false },
    });
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 409 }));
    await expect(execute(invocation(0))).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { failureCode: "score_write_http_409" },
    });
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
