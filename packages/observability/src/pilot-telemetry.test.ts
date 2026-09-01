import { describe, expect, it } from "vitest";
import { PilotTelemetryCollector, CURRENT_SLO_DEFINITION_VERSION } from "./pilot-telemetry.js";

const VALID_40_CHAR_SHA = "c084b640e72545678d79652bc2a6d2cc048a7ad8";

describe("QA-022 / QA-024 — Structured Pilot Event Telemetry Collector", () => {
  it("rejects non-40-character or malformed candidate SHAs", () => {
    expect(() => {
      new PilotTelemetryCollector({
        candidateSha: "c084b64", // short SHA
        competitionId: "comp-123",
        pilotId: "local-pilot-01",
      });
    }).toThrow(/strict 40-character hex candidate SHA/);

    expect(() => {
      new PilotTelemetryCollector({
        candidateSha: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", // non-hex
        competitionId: "comp-123",
        pilotId: "local-pilot-01",
      });
    }).toThrow(/strict 40-character hex candidate SHA/);
  });

  it("fails closed when sample counts are below minimum threshold", () => {
    const collector = new PilotTelemetryCollector({
      candidateSha: VALID_40_CHAR_SHA,
      competitionId: "comp-123",
      pilotId: "local-pilot-01",
      minSamplesRequired: 10,
    });

    // Only record 2 samples each (below threshold of 10)
    collector.recordScoreWrite(1.2);
    collector.recordScoreWrite(2.1);
    collector.recordPublicPageRead(10.5);
    collector.recordResultPropagation(15.2);

    const summary = collector.summarize();
    expect(summary.slaVerdict).toBe("FAIL");
    expect(summary.failureReasons.length).toBeGreaterThan(0);
    expect(summary.failureReasons.some((r) => r.includes("Insufficient"))).toBe(true);
  });

  it("records all lifecycle dimensions and returns PASS when meeting SLA budgets", () => {
    const collector = new PilotTelemetryCollector({
      candidateSha: VALID_40_CHAR_SHA,
      competitionId: "comp-123",
      pilotId: "local-pilot-01",
      minSamplesRequired: 5,
    });

    // Score writes (SLA <= 500ms)
    for (let i = 0; i < 10; i++) {
      collector.recordScoreWrite(1.5 + i * 0.1);
    }

    // Public page reads (SLA <= 2500ms)
    for (let i = 0; i < 10; i++) {
      collector.recordPublicPageRead(15.0 + i * 2);
    }

    // Result propagation (SLA <= 2000ms)
    for (let i = 0; i < 10; i++) {
      collector.recordResultPropagation(25.0 + i * 5);
    }

    // API requests (error rate <= 0.1%)
    for (let i = 0; i < 100; i++) {
      collector.recordApiRequest({
        route: "/api/v1/scoring/events",
        method: "POST",
        durationMs: 2.1,
        statusCode: 200,
        isError: false,
      });
    }

    collector.recordRedisEvent({
      type: "lease_acquired",
      matchId: "match-1",
      deviceId: "dev-1",
    });

    collector.recordReconnect({
      deviceId: "dev-1",
      matchId: "match-1",
      offlineCommandsCount: 50,
      syncedSuccessCount: 50,
      conflictCount: 0,
    });

    collector.recordCorrection({
      matchId: "match-1",
      actorId: "actor-1",
      reason: "Official umpire correction",
      priorScore: { home: 1, away: 0 },
      correctedScore: { home: 1, away: 1 },
      standingsRecalculated: true,
    });

    const summary = collector.summarize();
    expect(summary.sloDefinitionVersion).toBe(CURRENT_SLO_DEFINITION_VERSION);
    expect(summary.candidateSha).toBe(VALID_40_CHAR_SHA);
    expect(summary.slaVerdict).toBe("PASS");
    expect(summary.failureReasons).toHaveLength(0);
    expect(summary.scoreWriteSummary?.p95Ms).toBeLessThanOrEqual(500);
    expect(summary.publicPageSummary?.p95Ms).toBeLessThanOrEqual(2500);
    expect(summary.resultPropagationSummary?.p95Ms).toBeLessThanOrEqual(2000);
    expect(summary.apiErrorRate).toBe(0);
    expect(summary.redisEvents).toHaveLength(1);
    expect(summary.reconnectEvents).toHaveLength(1);
    expect(summary.correctionEvents).toHaveLength(1);
  });
});
