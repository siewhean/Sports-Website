import { randomUUID } from "node:crypto";
import type { C5WorkloadExecutor } from "@matchday/observability";

export type GateCC5PublicResultConvergenceSession = Readonly<{
  sessionId: string;
  sessionToken: string;
  writerGeneration: number;
}>;

export type GateCC5PublicResultConvergenceTarget = Readonly<{
  apiOrigin: string;
  slug: string;
  matchId: string;
  sessionId?: string;
  sessionToken?: string;
  writerGeneration?: number;
  acquireSession?: () => Promise<GateCC5PublicResultConvergenceSession>;
  /** The precondition stream must already be reduced through this sequence. */
  expectedSequence: number;
}>;

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cacheHeadersAreCanonical(response: Response): boolean {
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  const cacheControl = response.headers.get("cache-control");
  return (
    etag !== null &&
    etag.length > 2 &&
    etag.length <= 512 &&
    lastModified !== null &&
    Number.isFinite(Date.parse(lastModified)) &&
    cacheControl !== null &&
    cacheControl.includes("public")
  );
}

function hasFinalResult(payload: RecordValue, matchId: string): boolean {
  const divisions = payload.divisions;
  if (!Array.isArray(divisions) || divisions.length === 0) return false;
  return divisions.some((division) => {
    const results = record(division)?.results;
    return (
      Array.isArray(results) &&
      results.some((result) => {
        const candidate = record(result);
        return candidate?.id === matchId && (candidate.state === "final" || candidate.state === "corrected");
      })
    );
  });
}

function exactFreshness(payload: RecordValue, resultVersion: number): "match" | "behind" | "advanced" | "malformed" {
  const freshness = record(payload.freshness);
  const publication = record(payload.publication);
  if (
    !freshness ||
    !publication ||
    !positiveInteger(freshness.result_version) ||
    !positiveInteger(publication.result_version)
  ) {
    return "malformed";
  }
  if (freshness.result_version !== publication.result_version) return "malformed";
  if (freshness.result_version < resultVersion) return "behind";
  if (freshness.result_version > resultVersion) return "advanced";
  return "match";
}

function scoringHeaders(target: GateCC5PublicResultConvergenceSession): HeadersInit {
  return {
    "content-type": "application/json",
    "x-scoring-session-id": target.sessionId,
    "x-scoring-session-token": target.sessionToken,
    "x-writer-generation": String(target.writerGeneration),
  };
}

async function waitForRetry(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 50);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Finalises a pre-warmed isolated match and proves that its canonical public
 * projection carries the exact receipt result version. The fixture factory
 * must allocate one competition per target: a later competition-global result
 * version is a correctness failure, never convergence evidence.
 */
export function createGateCC5PublicResultConvergenceExecutor(
  targets: readonly GateCC5PublicResultConvergenceTarget[],
): C5WorkloadExecutor {
  if (targets.length === 0) throw new Error("C5 public-result convergence requires at least one isolated target");
  if (
    targets.some(
      (target) =>
        target.acquireSession === undefined &&
        (typeof target.sessionId !== "string" ||
          typeof target.sessionToken !== "string" ||
          typeof target.writerGeneration !== "number"),
    )
  )
    throw new Error("C5 public-result convergence target requires a session factory or complete session");
  const consumed = new Set<number>();
  return async (invocation) => {
    const targetIndex = invocation.sampleIndex;
    const target = targets[targetIndex];
    if (!target || consumed.has(targetIndex)) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: "public_result_target_exhausted" },
      };
    }
    consumed.add(targetIndex);
    const session = target.acquireSession
      ? await target.acquireSession()
      : {
          sessionId: target.sessionId!,
          sessionToken: target.sessionToken!,
          writerGeneration: target.writerGeneration!,
        };
    const finalisationId = randomUUID();
    const finalisation = await fetch(`${target.apiOrigin}/api/v1/scoring/finalise`, {
      method: "POST",
      headers: scoringHeaders(session),
      body: JSON.stringify({ client_event_id: finalisationId, expected_sequence: target.expectedSequence }),
      signal: invocation.signal,
    });
    const receipt = record(await finalisation.json().catch(() => null));
    if (
      finalisation.status !== 200 ||
      receipt?.client_event_id !== finalisationId ||
      receipt.outcome !== "accepted" ||
      receipt.duplicate !== false ||
      receipt.match_id !== target.matchId ||
      receipt.sequence !== target.expectedSequence + 1 ||
      receipt.aggregate_version !== target.expectedSequence + 1 ||
      !positiveInteger(receipt.result_version) ||
      receipt.publication_version !== receipt.result_version
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `public_result_finalise_http_${String(finalisation.status)}` },
      };
    }
    const endpoint = new URL(
      `/api/v1/public/competitions/${encodeURIComponent(target.slug)}/current`,
      target.apiOrigin,
    );
    while (!invocation.signal.aborted) {
      const publicResponse = await fetch(endpoint, {
        headers: { accept: "application/json" },
        signal: invocation.signal,
      });
      if (publicResponse.status !== 200 || !cacheHeadersAreCanonical(publicResponse)) {
        return {
          outcome: "unexpected_failure",
          correctness: { passed: false, failureCode: `public_result_public_http_${String(publicResponse.status)}` },
        };
      }
      const projection = record(await publicResponse.json().catch(() => null));
      if (!projection) {
        return {
          outcome: "unexpected_failure",
          correctness: { passed: false, failureCode: "public_result_payload_malformed" },
        };
      }
      const freshness = exactFreshness(projection, receipt.result_version);
      if (freshness === "behind") {
        await waitForRetry(invocation.signal);
        continue;
      }
      if (freshness === "advanced") {
        return {
          outcome: "unexpected_failure",
          correctness: { passed: false, failureCode: "public_result_version_advanced" },
        };
      }
      if (freshness === "malformed" || !hasFinalResult(projection, target.matchId)) {
        return {
          outcome: "unexpected_failure",
          correctness: { passed: false, failureCode: "public_result_projection_mismatch" },
        };
      }
      return { outcome: "success", correctness: { passed: true } };
    }
    return {
      outcome: "unexpected_failure",
      correctness: { passed: false, failureCode: "public_result_convergence_timeout" },
    };
  };
}
