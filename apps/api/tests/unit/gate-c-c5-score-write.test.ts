import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateCC5ScoreWriteExecutor } from "../../src/gate-c-c5-score-write.js";

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
