import { randomUUID } from "node:crypto";
import type { C5WorkloadExecutor } from "@matchday/observability";

export type GateCC5ScoreWriteSession = Readonly<{
  apiOrigin: string;
  sessionId: string;
  sessionToken: string;
  writerGeneration: number;
  expectedSequence: number;
}>;

type ScoreReceipt = Readonly<{
  client_event_id?: unknown;
  outcome?: unknown;
  aggregate_version?: unknown;
  sequence?: unknown;
}>;

function validAcceptedReceipt(value: unknown, clientEventId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as ScoreReceipt;
  return (
    receipt.client_event_id === clientEventId &&
    receipt.outcome === "accepted" &&
    Number.isInteger(receipt.aggregate_version) &&
    Number.isInteger(receipt.sequence)
  );
}

/** Creates real, session-fenced score-write traffic for the C5 local harness. */
export function createGateCC5ScoreWriteExecutor(sessions: readonly GateCC5ScoreWriteSession[]): C5WorkloadExecutor {
  if (sessions.length === 0) throw new Error("C5 score-write adapter requires an active writer session");
  const expectedSequences = sessions.map((session) => session.expectedSequence);
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
