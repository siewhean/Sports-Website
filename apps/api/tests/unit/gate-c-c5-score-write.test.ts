import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGateCC5ScoreWriteExecutor,
  createGateCC5ScoreWriteResource,
  GATE_C_C5_MAX_SCORE_WRITE_DURATION_SECONDS,
  GATE_C_C5_SCORE_WRITE_PASS_VALIDITY_SECONDS,
  issueGateCC5ScoreWriteSessions,
} from "../../src/gate-c-c5-score-write.js";

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
      expect.objectContaining({ role: "scorekeeper", expiresAt: "2026-08-04T02:00:00.000Z" }),
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
    expect(GATE_C_C5_SCORE_WRITE_PASS_VALIDITY_SECONDS).toBe(7_200);
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
      ([, init]) => JSON.parse(String(init?.body)) as { expected_sequence: number; participant_id: string },
    );
    expect(bodies.map((body) => body.expected_sequence)).toEqual([0, 4]);
    expect(bodies.map((body) => body.participant_id)).toEqual(["C5 workload scorer", "C5 workload scorer"]);
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

  it("warms each writer through the API, maintains an initial lease heartbeat, and measures only subsequent goals", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path.endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ mode: "writer", generation: 1, read_only: false }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          client_event_id: body.client_event_id,
          outcome: "accepted",
          aggregate_version: Number(body.expected_sequence) + 1,
          sequence: Number(body.expected_sequence) + 1,
        }),
        { status: 200 },
      );
    });

    const resource = await createGateCC5ScoreWriteResource([sessions[0]], {
      durationSeconds: 60,
      heartbeatIntervalMs: 15_000,
    });
    await expect(resource.executor(invocation(0))).resolves.toMatchObject({ outcome: "success" });
    await resource.close();

    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/scoring/events",
      "/api/v1/scoring/sessions/heartbeat",
      "/api/v1/scoring/events",
    ]);
    expect(requests[0]?.body).toMatchObject({ type: "match_started", expected_sequence: 0 });
    expect(requests[1]?.body).toMatchObject({ last_acknowledged_sequence: 1, pending_event_count: 0 });
    expect(requests[2]?.body).toMatchObject({
      type: "goal",
      expected_sequence: 1,
      participant_id: "C5 workload scorer",
    });
  });

  it("rejects profiles that would outlive the short-lived writer session", async () => {
    expect(GATE_C_C5_MAX_SCORE_WRITE_DURATION_SECONDS).toBe(3_600);
    await expect(
      createGateCC5ScoreWriteResource([sessions[0]], {
        durationSeconds: GATE_C_C5_MAX_SCORE_WRITE_DURATION_SECONDS + 1,
      }),
    ).rejects.toThrow("C5 score-write duration");
  });

  it("fails resource creation when the authoritative writer heartbeat is denied", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path.endsWith("/heartbeat")) return new Response(JSON.stringify({ mode: "candidate" }), { status: 409 });
      return new Response(
        JSON.stringify({
          client_event_id: body.client_event_id,
          outcome: "accepted",
          aggregate_version: 1,
          sequence: 1,
        }),
        { status: 200 },
      );
    });
    await expect(createGateCC5ScoreWriteResource([sessions[0]], { durationSeconds: 60 })).rejects.toThrow(
      "heartbeat was rejected",
    );
  });

  it("reports the latest acknowledged score sequence on each later heartbeat", async () => {
    vi.useFakeTimers();
    const heartbeatSequences: number[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path.endsWith("/heartbeat")) {
        heartbeatSequences.push(Number(body.last_acknowledged_sequence));
        return new Response(JSON.stringify({ mode: "writer", generation: 1, read_only: false }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          client_event_id: body.client_event_id,
          outcome: "accepted",
          aggregate_version: Number(body.expected_sequence) + 1,
          sequence: Number(body.expected_sequence) + 1,
        }),
        { status: 200 },
      );
    });
    try {
      const resource = await createGateCC5ScoreWriteResource([sessions[0]], {
        durationSeconds: 60,
        heartbeatIntervalMs: 1,
      });
      await resource.executor(invocation(0));
      await vi.advanceTimersByTimeAsync(1);
      await resource.close();
      expect(heartbeatSequences).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops renewing and rejects score writes at the configured resource deadline", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path.endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ mode: "writer", generation: 1, read_only: false }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          client_event_id: body.client_event_id,
          outcome: "accepted",
          aggregate_version: Number(body.expected_sequence) + 1,
          sequence: Number(body.expected_sequence) + 1,
        }),
        { status: 200 },
      );
    });
    try {
      const resource = await createGateCC5ScoreWriteResource([sessions[0]], {
        durationSeconds: 1,
        heartbeatIntervalMs: 15_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(resource.executor(invocation(0))).resolves.toMatchObject({
        outcome: "unexpected_failure",
        correctness: { failureCode: "score_session_duration_expired" },
      });
      await resource.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences new writes and waits for an in-flight write when the resource closes", async () => {
    const goalGate = (() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    let goalPending = false;
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path.endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ mode: "writer", generation: 1, read_only: false }), { status: 200 });
      }
      if (body.type === "goal") {
        goalPending = true;
        await goalGate.promise;
      }
      return new Response(
        JSON.stringify({
          client_event_id: body.client_event_id,
          outcome: "accepted",
          aggregate_version: Number(body.expected_sequence) + 1,
          sequence: Number(body.expected_sequence) + 1,
        }),
        { status: 200 },
      );
    });
    const resource = await createGateCC5ScoreWriteResource([sessions[0]], { durationSeconds: 60 });
    const inFlight = resource.executor(invocation(0));
    await vi.waitFor(() => expect(goalPending).toBe(true));
    const closing = resource.close();
    await expect(resource.executor(invocation(0))).resolves.toMatchObject({
      outcome: "unexpected_failure",
      correctness: { failureCode: "score_session_resource_closed" },
    });
    goalGate.release();
    await expect(inFlight).resolves.toMatchObject({ outcome: "success" });
    await expect(closing).resolves.toBeUndefined();
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
