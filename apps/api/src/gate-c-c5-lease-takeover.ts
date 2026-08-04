import { randomUUID } from "node:crypto";
import type { C5WorkloadExecutor } from "@matchday/observability";

export type GateCC5LeaseSession = Readonly<{
  sessionId: string;
  sessionToken: string;
  generation: number | null;
}>;

type CandidateFactory = () => Promise<GateCC5LeaseSession>;

function scoringHeaders(session: GateCC5LeaseSession): HeadersInit {
  return {
    "content-type": "application/json",
    "x-scoring-session-id": session.sessionId,
    "x-scoring-session-token": session.sessionToken,
    ...(session.generation === null ? {} : { "x-writer-generation": String(session.generation) }),
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

async function csrfToken(apiOrigin: string, cookie: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${apiOrigin}/api/v1/identity/session`, { headers: { cookie }, signal });
  const payload = record(await response.json().catch(() => null));
  return response.ok && typeof payload?.csrf_token === "string" ? payload.csrf_token : null;
}

/** Executes an organiser-approved takeover and proves the old generation is fenced. */
export function createGateCC5LeaseTakeoverExecutor(
  input: Readonly<{
    apiOrigin: string;
    webOrigin: string;
    competitionId: string;
    organiserCookie: string;
    incumbent: GateCC5LeaseSession;
    createCandidate: CandidateFactory;
  }>,
): C5WorkloadExecutor {
  let current = input.incumbent;
  let expectedSequence = 0;
  return async (invocation) => {
    if (current.generation === null) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: "lease_incumbent_not_writer" },
      };
    }
    const heartbeat = await fetch(`${input.apiOrigin}/api/v1/scoring/sessions/heartbeat`, {
      method: "POST",
      headers: scoringHeaders(current),
      body: JSON.stringify({
        last_acknowledged_sequence: expectedSequence,
        pending_event_count: 0,
        pending_through_sequence: expectedSequence,
      }),
      signal: invocation.signal,
    });
    const heartbeated = record(await heartbeat.json().catch(() => null));
    if (
      heartbeat.status !== 200 ||
      heartbeated?.mode !== "writer" ||
      heartbeated?.read_only !== false ||
      heartbeated?.generation !== current.generation
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `takeover_heartbeat_http_${heartbeat.status}` },
      };
    }
    const candidate = await input.createCandidate();
    const request = await fetch(`${input.apiOrigin}/api/v1/scoring/takeover-requests`, {
      method: "POST",
      headers: scoringHeaders(candidate),
      body: JSON.stringify({ pending_event_count: 0, pending_through_sequence: expectedSequence }),
      signal: invocation.signal,
    });
    const requested = record(await request.json().catch(() => null));
    if (request.status !== 201 || typeof requested?.id !== "string") {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `takeover_request_http_${request.status}` },
      };
    }
    const csrf = await csrfToken(input.apiOrigin, input.organiserCookie, invocation.signal);
    if (!csrf)
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: "takeover_csrf_unavailable" },
      };
    const approval = await fetch(
      `${input.apiOrigin}/api/v1/competitions/${encodeURIComponent(input.competitionId)}/takeover-requests/${encodeURIComponent(requested.id)}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: input.organiserCookie,
          origin: input.webOrigin,
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ reason: "C5 workload lease transfer" }),
        signal: invocation.signal,
      },
    );
    const approved = record(await approval.json().catch(() => null));
    if (
      approval.status !== 200 ||
      typeof approved?.generation !== "number" ||
      approved.generation !== current.generation + 1
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `takeover_approve_http_${approval.status}` },
      };
    }
    const event =
      expectedSequence === 0
        ? { type: "match_started", occurred_at: new Date().toISOString(), segment_number: 1, manual_time_seconds: 0 }
        : {
            type: "goal",
            team_slot: "home",
            participant_id: "C5 workload scorer",
            occurred_at: new Date().toISOString(),
            segment_number: 1,
            manual_time_seconds: expectedSequence,
          };
    const stale = await fetch(`${input.apiOrigin}/api/v1/scoring/events`, {
      method: "POST",
      headers: scoringHeaders(current),
      body: JSON.stringify({ client_event_id: randomUUID(), expected_sequence: expectedSequence, ...event }),
      signal: invocation.signal,
    });
    const stalePayload = record(await stale.json().catch(() => null));
    if (stale.status !== 409 || record(stalePayload?.error)?.code !== "STALE_WRITER_GENERATION") {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `takeover_stale_fence_http_${stale.status}` },
      };
    }
    const replacement: GateCC5LeaseSession = { ...candidate, generation: approved.generation };
    const accepted = await fetch(`${input.apiOrigin}/api/v1/scoring/events`, {
      method: "POST",
      headers: scoringHeaders(replacement),
      body: JSON.stringify({ client_event_id: randomUUID(), expected_sequence: expectedSequence, ...event }),
      signal: invocation.signal,
    });
    const receipt = record(await accepted.json().catch(() => null));
    if (accepted.status !== 200 || receipt?.outcome !== "accepted" || receipt.sequence !== expectedSequence + 1) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `takeover_replacement_http_${accepted.status}` },
      };
    }
    current = replacement;
    expectedSequence += 1;
    return { outcome: "success", correctness: { passed: true } };
  };
}
