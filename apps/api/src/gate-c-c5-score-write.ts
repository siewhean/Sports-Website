import { randomUUID } from "node:crypto";
import type { C5WorkloadExecutor } from "@matchday/observability";
import type { Phase2Actor, Phase2Runtime } from "./phase-2-runtime.js";

export type GateCC5ScoreWriteSession = Readonly<{
  apiOrigin: string;
  sessionId: string;
  sessionToken: string;
  writerGeneration: number;
  expectedSequence: number;
}>;

export type GateCC5ScoreWriteTarget = Readonly<{ competitionId: string; matchId: string; expectedSequence: number }>;

export type GateCC5ScoreWriteResource = Readonly<{
  executor: C5WorkloadExecutor;
  close(): Promise<void>;
}>;

export const GATE_C_C5_MAX_SCORE_WRITE_DURATION_SECONDS = 25 * 60;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const RESOURCE_SETTLEMENT_TIMEOUT_MS = 1_000;

export async function issueGateCC5ScoreWriteSessions(
  runtime: Phase2Runtime,
  actor: Phase2Actor,
  apiOrigin: string,
  targets: readonly GateCC5ScoreWriteTarget[],
  now: () => Date = () => new Date(),
): Promise<GateCC5ScoreWriteSession[]> {
  return await Promise.all(
    targets.map(async (target, index) => {
      const pass = await runtime.createAccessPass(
        actor,
        target.competitionId,
        target.matchId,
        {
          role: "scorekeeper",
          expiresAt: new Date(now().getTime() + 30 * 60_000).toISOString(),
          idempotencyKey: randomUUID(),
        },
        randomUUID(),
      );
      if (!pass.token) throw new Error("C5 score-write pass issuance returned no one-time token");
      const session = await runtime.exchangeAccess(
        {
          token: pass.token,
          expectedMatchId: target.matchId,
          deviceId: randomUUID(),
          deviceLabel: `C5 worker ${String(index + 1)}`,
        },
        randomUUID(),
      );
      if (session.mode !== "writer" || !session.generation)
        throw new Error("C5 score-write pass did not acquire a writer lease");
      return {
        apiOrigin,
        sessionId: session.session_id,
        sessionToken: session.session_token,
        writerGeneration: session.generation,
        expectedSequence: target.expectedSequence,
      };
    }),
  );
}

type AcceptedReceipt = Readonly<{
  client_event_id: string;
  outcome: "accepted";
  aggregate_version: number;
  sequence: number;
}>;

function validAcceptedReceipt(value: unknown, clientEventId: string): value is AcceptedReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Readonly<Record<string, unknown>>;
  return (
    receipt.client_event_id === clientEventId &&
    receipt.outcome === "accepted" &&
    Number.isInteger(receipt.aggregate_version) &&
    Number.isInteger(receipt.sequence)
  );
}

/** Creates real, session-fenced score-write traffic for the C5 local harness. */
export function createGateCC5ScoreWriteExecutor(
  sessions: readonly GateCC5ScoreWriteSession[],
  expectedSequences = sessions.map((session) => session.expectedSequence),
): C5WorkloadExecutor {
  if (sessions.length === 0) throw new Error("C5 score-write adapter requires an active writer session");
  if (expectedSequences.length !== sessions.length) {
    throw new Error("C5 score-write adapter requires one expected sequence for every writer session");
  }
  return async (invocation) => {
    const sessionIndex = invocation.workerIndex % sessions.length;
    const session = sessions[sessionIndex]!;
    const expectedSequence = expectedSequences[sessionIndex]!;
    const clientEventId = randomUUID();
    const response = await fetch(`${session.apiOrigin}/api/v1/scoring/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scoring-session-id": session.sessionId,
        "x-scoring-session-token": session.sessionToken,
        "x-writer-generation": String(session.writerGeneration),
      },
      body: JSON.stringify({
        client_event_id: clientEventId,
        expected_sequence: expectedSequence,
        type: "goal",
        team_slot: invocation.sampleIndex % 2 === 0 ? "home" : "away",
        // Canoe Polo requires scorer attribution. This is a non-personal
        // deterministic fixture label and is never retained in C5 evidence.
        participant_id: "C5 workload scorer",
        segment_number: 1,
        manual_time_seconds: invocation.sampleIndex % 1_800,
        occurred_at: new Date().toISOString(),
      }),
      signal: invocation.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 200 && validAcceptedReceipt(payload, clientEventId)) {
      expectedSequences[sessionIndex] = expectedSequence + 1;
      return { outcome: "success", correctness: { passed: true } };
    }
    return {
      outcome: "unexpected_failure",
      correctness: { passed: false, failureCode: `score_write_http_${String(response.status)}` },
    };
  };
}

function scoringHeaders(session: GateCC5ScoreWriteSession): HeadersInit {
  return {
    "content-type": "application/json",
    "x-scoring-session-id": session.sessionId,
    "x-scoring-session-token": session.sessionToken,
    "x-writer-generation": String(session.writerGeneration),
  };
}

async function appendAcceptedEvent(
  session: GateCC5ScoreWriteSession,
  expectedSequence: number,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AcceptedReceipt> {
  const clientEventId = randomUUID();
  const init: RequestInit = {
    method: "POST",
    headers: scoringHeaders(session),
    body: JSON.stringify({ ...body, client_event_id: clientEventId, expected_sequence: expectedSequence }),
  };
  if (signal) init.signal = signal;
  const response = await fetch(`${session.apiOrigin}/api/v1/scoring/events`, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !validAcceptedReceipt(payload, clientEventId)) {
    throw new Error(`C5 score-write warm-up was rejected with HTTP ${String(response.status)}`);
  }
  return {
    client_event_id: clientEventId,
    outcome: "accepted",
    aggregate_version: payload.aggregate_version as number,
    sequence: payload.sequence as number,
  };
}

function validWriterHeartbeat(value: unknown, generation: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.mode === "writer" && record.generation === generation && record.read_only === false;
}

async function heartbeat(
  session: GateCC5ScoreWriteSession,
  lastAcknowledgedSequence: number,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${session.apiOrigin}/api/v1/scoring/sessions/heartbeat`, {
    method: "POST",
    headers: scoringHeaders(session),
    body: JSON.stringify({
      last_acknowledged_sequence: lastAcknowledgedSequence,
      pending_event_count: 0,
      pending_through_sequence: lastAcknowledgedSequence,
    }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !validWriterHeartbeat(payload, session.writerGeneration)) {
    throw new Error(`C5 scoring-session heartbeat was rejected with HTTP ${String(response.status)}`);
  }
}

async function settleResourceOperations(operations: readonly Promise<unknown>[]): Promise<void> {
  if (operations.length === 0) return;
  const settled = Promise.allSettled(operations).then(() => true);
  const settledBeforeTimeout = await Promise.race([
    settled,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), RESOURCE_SETTLEMENT_TIMEOUT_MS)),
  ]);
  if (!settledBeforeTimeout) throw new Error("C5 score-write resource did not settle after shutdown");
}

/**
 * Creates a bounded score-event workload resource. It makes an actual API
 * `match_started` request before measured writes, renews every writer lease
 * at most every 15 seconds, and leaves session material inside this closure.
 */
export async function createGateCC5ScoreWriteResource(
  sessions: readonly GateCC5ScoreWriteSession[],
  input: Readonly<{ durationSeconds: number; heartbeatIntervalMs?: number }>,
): Promise<GateCC5ScoreWriteResource> {
  if (sessions.length === 0) throw new Error("C5 score-write resource requires an active writer session");
  if (
    !Number.isInteger(input.durationSeconds) ||
    input.durationSeconds < 1 ||
    input.durationSeconds > GATE_C_C5_MAX_SCORE_WRITE_DURATION_SECONDS
  ) {
    throw new Error(
      `C5 score-write duration must be an integer from 1 to ${String(GATE_C_C5_MAX_SCORE_WRITE_DURATION_SECONDS)} seconds`,
    );
  }
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (
    !Number.isInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 1 ||
    heartbeatIntervalMs > DEFAULT_HEARTBEAT_INTERVAL_MS
  ) {
    throw new Error(
      `C5 score-write heartbeat interval must be an integer from 1 to ${String(DEFAULT_HEARTBEAT_INTERVAL_MS)}ms`,
    );
  }

  const expectedSequences = sessions.map((session) => session.expectedSequence);
  await Promise.all(
    sessions.map(async (session, index) => {
      const receipt = await appendAcceptedEvent(session, expectedSequences[index]!, {
        type: "match_started",
        occurred_at: new Date().toISOString(),
        segment_number: 1,
        manual_time_seconds: 0,
      });
      expectedSequences[index] = receipt.aggregate_version;
    }),
  );

  let heartbeatFailure: unknown = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let closed = false;
  let expired = false;
  const lifecycleAbortController = new AbortController();
  const inFlightWrites = new Set<Promise<unknown>>();
  const heartbeatAll = async () => {
    await Promise.all(
      sessions.map((session, index) => heartbeat(session, expectedSequences[index]!, lifecycleAbortController.signal)),
    );
  };
  const runHeartbeat = () => {
    if (closed || expired || heartbeatFailure || heartbeatInFlight) return;
    heartbeatInFlight = heartbeatAll()
      .catch((error: unknown) => {
        if (!closed && !expired) heartbeatFailure = error;
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  };
  await heartbeatAll();
  const timer = setInterval(runHeartbeat, heartbeatIntervalMs);
  const expiryTimer = setTimeout(() => {
    expired = true;
    clearInterval(timer);
    lifecycleAbortController.abort();
  }, input.durationSeconds * 1_000);
  expiryTimer.unref?.();
  const executor = createGateCC5ScoreWriteExecutor(sessions, expectedSequences);
  return {
    executor: async (invocation) => {
      if (closed) {
        return {
          outcome: "unexpected_failure",
          correctness: { passed: false, failureCode: "score_session_resource_closed" },
        };
      }
      if (expired) {
        return {
          outcome: "unexpected_failure",
          correctness: { passed: false, failureCode: "score_session_duration_expired" },
        };
      }
      if (heartbeatFailure) {
        return {
          outcome: "unexpected_failure",
          correctness: { passed: false, failureCode: "score_session_heartbeat_failed" },
        };
      }
      const signal = AbortSignal.any([invocation.signal, lifecycleAbortController.signal]);
      const write = executor({ ...invocation, signal });
      inFlightWrites.add(write);
      try {
        return await write;
      } finally {
        inFlightWrites.delete(write);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(expiryTimer);
      lifecycleAbortController.abort();
      await settleResourceOperations([...inFlightWrites, ...(heartbeatInFlight ? [heartbeatInFlight] : [])]);
      if (heartbeatFailure) throw new Error("C5 scoring-session heartbeat failed before resource shutdown");
    },
  };
}
