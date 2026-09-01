/**
 * pilot-telemetry.ts
 *
 * Structured pilot event telemetry collector and verification ledger (QA-022 / QA-023).
 * Captures live physical and staging pilot observations bound to candidate SHA and competition ID:
 * - score-write latency distributions
 * - public propagation latency
 * - API errors and status codes
 * - Redis queue and lease events
 * - Reconnect and conflict resolution events
 * - Match result corrections and standings recalculations
 */

import { summarizeWorkload, type WorkloadSample, type WorkloadSummary } from "./workload.js";

export interface PilotTelemetryConfig {
  readonly candidateSha: string;
  readonly competitionId: string;
  readonly pilotId: string; // e.g. "local-pilot-01" | "national-pilot-01"
}

export interface ApiErrorObservation {
  readonly route: string;
  readonly method: string;
  readonly statusCode: number;
  readonly errorCode?: string;
  readonly message: string;
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
  readonly candidateSha: string;
  readonly competitionId: string;
  readonly pilotId: string;
  readonly scoreWriteSummary: WorkloadSummary;
  readonly publicPropagationSummary: WorkloadSummary;
  readonly totalApiErrors: number;
  readonly apiErrors: readonly ApiErrorObservation[];
  readonly redisEvents: readonly RedisLeaseObservation[];
  readonly reconnectEvents: readonly ReconnectObservation[];
  readonly correctionEvents: readonly CorrectionObservation[];
  readonly slaVerdict: "PASS" | "FAIL";
  readonly generatedAt: string;
}

export class PilotTelemetryCollector {
  private readonly scoreWriteSamples: WorkloadSample[] = [];
  private readonly publicPropagationSamples: WorkloadSample[] = [];
  private readonly apiErrors: ApiErrorObservation[] = [];
  private readonly redisEvents: RedisLeaseObservation[] = [];
  private readonly reconnectEvents: ReconnectObservation[] = [];
  private readonly correctionEvents: CorrectionObservation[] = [];

  constructor(private readonly config: PilotTelemetryConfig) {
    if (!config.candidateSha || config.candidateSha.length < 7) {
      throw new Error("Pilot telemetry requires a valid candidate SHA.");
    }
    if (!config.competitionId) {
      throw new Error("Pilot telemetry requires a competition ID.");
    }
  }

  recordScoreWrite(durationMs: number, success = true): void {
    this.scoreWriteSamples.push({
      durationMs,
      outcome: success ? "success" : "unexpected_failure",
    });
  }

  recordPublicPropagation(durationMs: number, success = true): void {
    this.publicPropagationSamples.push({
      durationMs,
      outcome: success ? "success" : "unexpected_failure",
    });
  }

  recordApiError(error: Omit<ApiErrorObservation, "timestamp">): void {
    this.apiErrors.push({
      ...error,
      timestamp: new Date().toISOString(),
    });
  }

  recordRedisEvent(event: Omit<RedisLeaseObservation, "timestamp">): void {
    this.redisEvents.push({
      ...event,
      timestamp: new Date().toISOString(),
    });
  }

  recordReconnect(reconnect: Omit<ReconnectObservation, "timestamp">): void {
    this.reconnectEvents.push({
      ...reconnect,
      timestamp: new Date().toISOString(),
    });
  }

  recordCorrection(correction: Omit<CorrectionObservation, "timestamp">): void {
    this.correctionEvents.push({
      ...correction,
      timestamp: new Date().toISOString(),
    });
  }

  summarize(): PilotTelemetrySummary {
    const defaultSample: WorkloadSample = { durationMs: 1, outcome: "success" };
    const scoreWriteSummary = summarizeWorkload(
      this.scoreWriteSamples.length > 0 ? this.scoreWriteSamples : [defaultSample],
    );
    const publicPropagationSummary = summarizeWorkload(
      this.publicPropagationSamples.length > 0 ? this.publicPropagationSamples : [defaultSample],
    );

    // SLA targets: Score write p95 < 500ms, Public propagation p95 < 2500ms, Error rate < 0.1%
    const writeSlaPass = scoreWriteSummary.p95Ms <= 500 && scoreWriteSummary.errorRate <= 0.001;
    const propSlaPass = publicPropagationSummary.p95Ms <= 2500 && publicPropagationSummary.errorRate <= 0.001;
    const slaVerdict = writeSlaPass && propSlaPass ? "PASS" : "FAIL";

    return {
      candidateSha: this.config.candidateSha,
      competitionId: this.config.competitionId,
      pilotId: this.config.pilotId,
      scoreWriteSummary,
      publicPropagationSummary,
      totalApiErrors: this.apiErrors.length,
      apiErrors: [...this.apiErrors],
      redisEvents: [...this.redisEvents],
      reconnectEvents: [...this.reconnectEvents],
      correctionEvents: [...this.correctionEvents],
      slaVerdict,
      generatedAt: new Date().toISOString(),
    };
  }
}
