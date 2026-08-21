import { randomUUID } from "node:crypto";
import type { C5WorkloadExecutor } from "@matchday/observability";

export type GateCC5RepairPublicationTarget = Readonly<{
  apiOrigin: string;
  webOrigin: string;
  competitionId: string;
  correctionTransactionId: string;
  organiserCookie: string;
}>;

type Value = Readonly<Record<string, unknown>>;

function record(value: unknown): Value | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Value) : null;
}

async function json(response: Response): Promise<Value | null> {
  return record(await response.json().catch(() => null));
}

async function csrf(apiOrigin: string, cookie: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${apiOrigin}/api/v1/identity/session`, { headers: { cookie }, signal });
  const body = await json(response);
  return response.ok && typeof body?.csrf_token === "string" ? body.csrf_token : null;
}

function decision(action: Value): Value | null {
  const matchId = action.match_id;
  const slot = action.slot;
  if (typeof matchId !== "string" || (slot !== "home" && slot !== "away")) return null;
  switch (action.source_action) {
    case "no_change":
      return null;
    case "automatic_update":
    case "protected_manual_slot":
      return {
        client_event_id: randomUUID(),
        match_id: matchId,
        slot,
        decision: "accept_proposed",
        reason: "C5 approved repair",
      };
    case "protected_started_match":
    case "protected_finalised_match":
      return {
        client_event_id: randomUUID(),
        match_id: matchId,
        slot,
        decision: "keep_current",
        reason: "C5 protected match retained",
      };
    case "requires_organiser_decision":
      return {
        client_event_id: randomUUID(),
        match_id: matchId,
        slot,
        decision: "keep_current",
        reason: "C5 organiser decision",
      };
    default:
      return null;
  }
}

/** Publishes one fresh repair through the organiser API with strict version and fingerprint fencing. */
export function createGateCC5RepairPublicationExecutor(
  targets: readonly GateCC5RepairPublicationTarget[],
): C5WorkloadExecutor {
  if (targets.length === 0) throw new Error("C5 repair-publication requires at least one target");
  const consumed = new Set<number>();
  return async (invocation) => {
    const target = targets[invocation.sampleIndex];
    if (!target || consumed.has(invocation.sampleIndex)) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: "repair_publication_target_exhausted" },
      };
    }
    consumed.add(invocation.sampleIndex);
    const token = await csrf(target.apiOrigin, target.organiserCookie, invocation.signal);
    if (!token)
      return { outcome: "unexpected_failure", correctness: { passed: false, failureCode: "repair_publication_csrf" } };
    const headers = {
      "content-type": "application/json",
      cookie: target.organiserCookie,
      origin: target.webOrigin,
      "x-csrf-token": token,
    };
    const base = `/api/v1/competitions/${encodeURIComponent(target.competitionId)}/repairs`;
    const analysisResponse = await fetch(`${target.apiOrigin}${base}/analyse`, {
      method: "POST",
      headers,
      body: JSON.stringify({ correction_transaction_id: target.correctionTransactionId }),
      signal: invocation.signal,
    });
    const analysis = await json(analysisResponse);
    const repair = record(analysis?.repair);
    const parentRevision = record(analysis?.latest_revision);
    const actions = Array.isArray(analysis?.actions) ? analysis.actions.map(record) : [];
    if (
      analysisResponse.status !== 200 ||
      !repair ||
      !parentRevision ||
      typeof repair.repair_id !== "string" ||
      typeof parentRevision.repair_revision_id !== "string" ||
      typeof parentRevision.analysis_fingerprint !== "string" ||
      typeof analysis?.current_result_version !== "number" ||
      typeof analysis?.published_schedule_version !== "number" ||
      actions.some((action) => action === null)
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `repair_publication_analyse_http_${analysisResponse.status}` },
      };
    }
    const decisions = actions.map((action) => decision(action!)).filter((value): value is Value => value !== null);
    const revisionResponse = await fetch(
      `${target.apiOrigin}${base}/${encodeURIComponent(repair.repair_id)}/revisions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent_revision_id: parentRevision.repair_revision_id,
          expected_result_version: analysis.current_result_version,
          expected_schedule_version: analysis.published_schedule_version,
          expected_analysis_fingerprint: parentRevision.analysis_fingerprint,
          status: "ready",
          decisions,
          schedule_adjustments: [],
        }),
        signal: invocation.signal,
      },
    );
    const revision = await json(revisionResponse);
    const revisionView = record(revision?.revision);
    if (
      revisionResponse.status !== 201 ||
      !revisionView ||
      typeof revisionView.repair_revision_id !== "string" ||
      typeof revisionView.analysis_fingerprint !== "string"
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `repair_publication_revision_http_${revisionResponse.status}` },
      };
    }
    const publication = await fetch(
      `${target.apiOrigin}${base}/${encodeURIComponent(repair.repair_id)}/revisions/${encodeURIComponent(revisionView.repair_revision_id)}/publish`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          competition_id: target.competitionId,
          repair_id: repair.repair_id,
          repair_revision_id: revisionView.repair_revision_id,
          expected_schedule_version: analysis.published_schedule_version,
          expected_result_version: analysis.current_result_version,
          expected_analysis_fingerprint: revisionView.analysis_fingerprint,
          publication_idempotency_key: `c5-${randomUUID()}`,
        }),
        signal: invocation.signal,
      },
    );
    const receipt = await json(publication);
    if (
      publication.status !== 200 ||
      receipt?.duplicate !== false ||
      receipt?.repair_id !== repair.repair_id ||
      receipt?.repair_revision_id !== revisionView.repair_revision_id
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `repair_publication_publish_http_${publication.status}` },
      };
    }
    return { outcome: "success", correctness: { passed: true } };
  };
}
