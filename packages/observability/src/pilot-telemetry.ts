/**
 * pilot-telemetry.ts
 *
 * Structured pilot event telemetry collector and verification ledger (QA-022 / QA-024).
 * Captures live physical and staging pilot observations bound to candidate SHA and competition ID:
 * - score-write latency distributions (SLA: p95 <= 500ms)
 * - public page read latency distributions (SLA: p95 <= 2500ms)
 * - result convergence & public projection propagation latency (SLA: p95 <= 2000ms)
 * - API requests and error rates (SLA: errorRate <= 0.1%)
 * - Redis queue and lease events
 * - Reconnect and conflict resolution events
 * - Match result corrections and standings recalculations
 */

import { createHash } from "node:crypto";
import { summarizeWorkload, type WorkloadSample, type WorkloadSummary } from "./workload.js";

const SHA_REGEX = /^[a-f0-9]{40}$/i;
export const CURRENT_SLO_DEFINITION_VERSION = "2026.09.gate-d";

export interface PilotTelemetryConfig {
  readonly candidateSha: string;
  readonly competitionId: string;
  readonly pilotId: string; // e.g. "local-pilot-01" | "national-pilot-01"
  readonly minSamplesRequired?: number; // default: 10
  readonly minSessionsRequired?: number; // default: 1
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface ApiRequestObservation {
  readonly route: string;
  readonly method: string;
  readonly durationMs: number;
  readonly statusCode: number;
  readonly isError: boolean;
  readonly errorCode?: string;
  readonly timestamp: string;
}

export interface RedisLeaseObservation {
  readonly type: "lease_acquired" | "lease_takeover" | "lease_expired" | "queue_drained";
  readonly matchId: string;
  readonly deviceId: string;
  readonly timestamp: string;
}

export interface ReconnectObservation {
  readonly deviceId: string;
  readonly matchId: string;
  readonly offlineCommandsCount: number;
  readonly syncedSuccessCount: number;
  readonly conflictCount: number;
  readonly timestamp: string;
}

export interface CorrectionObservation {
  readonly matchId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly priorScore: { home: number; away: number };
  readonly correctedScore: { home: number; away: number };
  readonly standingsRecalculated: boolean;
  readonly timestamp: string;
}

export interface PilotTelemetrySummary {
  readonly sloDefinitionVersion: string;
  readonly candidateSha: string;
  readonly competitionId: string;
  readonly pilotId: string;
  readonly minSamplesThreshold: number;
  readonly minSessionsThreshold: number;
  readonly observedSessionCount: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly scoreWriteSummary: WorkloadSummary | null;
  readonly publicPageSummary: WorkloadSummary | null;
  readonly resultPropagationSummary: WorkloadSummary | null;
  readonly totalApiRequests: number;
  readonly totalApiErrors: number;
  readonly apiErrorRate: number;
  readonly apiRequests: readonly ApiRequestObservation[];
  readonly redisEvents: readonly RedisLeaseObservation[];
  readonly reconnectEvents: readonly ReconnectObservation[];
  readonly correctionEvents: readonly CorrectionObservation[];
  readonly slaVerdict: "PASS" | "FAIL";
  readonly failureReasons: readonly string[];
  readonly generatedAt: string;
  readonly receiptSha256: string;
}

export class PilotTelemetryCollector {
  private readonly scoreWriteSamples: WorkloadSample[] = [];
  private readonly publicPageSamples: WorkloadSample[] = [];
  private readonly resultPropagationSamples: WorkloadSample[] = [];
  private readonly apiRequests: ApiRequestObservation[] = [];
  private readonly redisEvents: RedisLeaseObservation[] = [];
  private readonly reconnectEvents: ReconnectObservation[] = [];
  private readonly correctionEvents: CorrectionObservation[] = [];
  private readonly sessionIds = new Set<string>();
  private readonly minSamples: number;
  private readonly minSessions: number;

  constructor(private readonly config: PilotTelemetryConfig) {
    if (!config.candidateSha || !SHA_REGEX.test(config.candidateSha)) {
      throw new Error(
        `Pilot telemetry requires a strict 40-character hex candidate SHA. Received: '${config.candidateSha}'`,
      );
    }
    if (!config.competitionId || config.competitionId.trim().length === 0) {
      throw new Error("Pilot telemetry requires a non-empty competition ID.");
    }
    const startsAt = new Date(config.startsAt);
    const endsAt = new Date(config.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
      throw new Error("Pilot telemetry requires valid, increasing observation time bounds.");
    }
    this.minSamples = config.minSamplesRequired ?? 10;
    this.minSessions = config.minSessionsRequired ?? 1;
    if (this.minSamples < 1 || this.minSessions < 1) throw new Error("Pilot telemetry thresholds must be positive.");
  }

  private assertObservationWindow(now = new Date()): void {
    const startsAt = new Date(this.config.startsAt).getTime();
    const endsAt = new Date(this.config.endsAt).getTime();
    if (now.getTime() < startsAt || now.getTime() > endsAt) {
      throw new Error("Pilot telemetry observation falls outside its declared time bounds.");
    }
  }

  recordSession(sessionId: string): void {
    if (!sessionId.trim()) throw new Error("Pilot telemetry session IDs must be non-empty.");
    this.sessionIds.add(sessionId);
  }

  recordScoreWrite(durationMs: number, success = true): void {
    this.assertObservationWindow();
    this.scoreWriteSamples.push({
      durationMs,
      outcome: success ? "success" : "unexpected_failure",
    });
  }

  recordPublicPageRead(durationMs: number, success = true): void {
    this.assertObservationWindow();
    this.publicPageSamples.push({
      durationMs,
      outcome: success ? "success" : "unexpected_failure",
    });
  }

  recordResultPropagation(durationMs: number, success = true): void {
    this.assertObservationWindow();
    this.resultPropagationSamples.push({
      durationMs,
      outcome: success ? "success" : "unexpected_failure",
    });
  }

  recordApiRequest(request: Omit<ApiRequestObservation, "timestamp">): void {
    this.assertObservationWindow();
    this.apiRequests.push({
      ...request,
      timestamp: new Date().toISOString(),
    });
  }

  recordRedisEvent(event: Omit<RedisLeaseObservation, "timestamp">): void {
    this.assertObservationWindow();
    this.redisEvents.push({
      ...event,
      timestamp: new Date().toISOString(),
    });
  }

  recordReconnect(reconnect: Omit<ReconnectObservation, "timestamp">): void {
    this.assertObservationWindow();
    this.reconnectEvents.push({
      ...reconnect,
      timestamp: new Date().toISOString(),
    });
  }

  recordCorrection(correction: Omit<CorrectionObservation, "timestamp">): void {
    this.assertObservationWindow();
    this.correctionEvents.push({
      ...correction,
      timestamp: new Date().toISOString(),
    });
  }

  summarize(): PilotTelemetrySummary {
    const failureReasons: string[] = [];

    // 1. Check minimum sample thresholds (fail closed if samples are insufficient)
    if (this.scoreWriteSamples.length < this.minSamples) {
      failureReasons.push(`Insufficient score write samples: ${this.scoreWriteSamples.length} < ${this.minSamples}`);
    }
    if (this.publicPageSamples.length < this.minSamples) {
      failureReasons.push(`Insufficient public page samples: ${this.publicPageSamples.length} < ${this.minSamples}`);
    }
    if (this.resultPropagationSamples.length < this.minSamples) {
      failureReasons.push(
        `Insufficient result propagation samples: ${this.resultPropagationSamples.length} < ${this.minSamples}`,
      );
    }
    if (this.sessionIds.size < this.minSessions) {
      failureReasons.push(`Insufficient observed sessions: ${this.sessionIds.size} < ${this.minSessions}`);
    }

    const scoreWriteSummary = this.scoreWriteSamples.length > 0 ? summarizeWorkload(this.scoreWriteSamples) : null;
    const publicPageSummary = this.publicPageSamples.length > 0 ? summarizeWorkload(this.publicPageSamples) : null;
    const resultPropagationSummary =
      this.resultPropagationSamples.length > 0 ? summarizeWorkload(this.resultPropagationSamples) : null;

    // 2. Evaluate Score Write SLA: p95 <= 500ms, errorRate <= 0.1%
    if (scoreWriteSummary) {
      if (scoreWriteSummary.p95Ms > 500) {
        failureReasons.push(`Score write latency p95 breached: ${scoreWriteSummary.p95Ms.toFixed(2)}ms > 500ms`);
      }
      if (scoreWriteSummary.errorRate > 0.001) {
        failureReasons.push(
          `Score write error rate breached: ${(scoreWriteSummary.errorRate * 100).toFixed(2)}% > 0.1%`,
        );
      }
    }

    // 3. Evaluate Public Page Read SLA: p95 <= 2500ms, errorRate <= 0.1%
    if (publicPageSummary) {
      if (publicPageSummary.p95Ms >= 2500) {
        failureReasons.push(`Public page latency p95 breached: ${publicPageSummary.p95Ms.toFixed(2)}ms >= 2500ms`);
      }
      if (publicPageSummary.errorRate > 0.001) {
        failureReasons.push(
          `Public page error rate breached: ${(publicPageSummary.errorRate * 100).toFixed(2)}% > 0.1%`,
        );
      }
    }

    // 4. Evaluate Result Propagation SLA: p95 <= 2000ms, errorRate <= 0.1%
    if (resultPropagationSummary) {
      if (resultPropagationSummary.p95Ms >= 2000) {
        failureReasons.push(
          `Result propagation latency p95 breached: ${resultPropagationSummary.p95Ms.toFixed(2)}ms >= 2000ms`,
        );
      }
      if (resultPropagationSummary.errorRate > 0.001) {
        failureReasons.push(
          `Result propagation error rate breached: ${(resultPropagationSummary.errorRate * 100).toFixed(2)}% > 0.1%`,
        );
      }
    }

    // 5. Evaluate API request error rate
    const totalApiRequests = this.apiRequests.length;
    const totalApiErrors = this.apiRequests.filter((r) => r.isError || r.statusCode >= 500).length;
    const apiErrorRate = totalApiRequests > 0 ? totalApiErrors / totalApiRequests : 0;

    if (totalApiRequests === 0) {
      failureReasons.push("No API request observations were retained.");
    } else if (apiErrorRate > 0.001) {
      failureReasons.push(`Overall API error rate breached: ${(apiErrorRate * 100).toFixed(2)}% > 0.1%`);
    }

    const slaVerdict = failureReasons.length === 0 ? "PASS" : "FAIL";

    const generatedAt = new Date().toISOString();
    const receipt: Omit<PilotTelemetrySummary, "receiptSha256"> = {
      sloDefinitionVersion: CURRENT_SLO_DEFINITION_VERSION,
      candidateSha: this.config.candidateSha,
      competitionId: this.config.competitionId,
      pilotId: this.config.pilotId,
      minSamplesThreshold: this.minSamples,
      minSessionsThreshold: this.minSessions,
      observedSessionCount: this.sessionIds.size,
      startsAt: this.config.startsAt,
      endsAt: this.config.endsAt,
      scoreWriteSummary,
      publicPageSummary,
      resultPropagationSummary,
      totalApiRequests,
      totalApiErrors,
      apiErrorRate,
      apiRequests: [...this.apiRequests],
      redisEvents: this.redisEvents.map((event) => ({ ...event, deviceId: hashIdentifier(event.deviceId) })),
      reconnectEvents: this.reconnectEvents.map((event) => ({ ...event, deviceId: hashIdentifier(event.deviceId) })),
      correctionEvents: this.correctionEvents.map((event) => ({ ...event, actorId: hashIdentifier(event.actorId) })),
      slaVerdict,
      failureReasons,
      generatedAt,
    };
    const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
    return deepFreeze({ ...receipt, receiptSha256 });
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
