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
