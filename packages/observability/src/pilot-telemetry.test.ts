import { describe, expect, it } from "vitest";
import { PilotTelemetryCollector } from "./pilot-telemetry.js";

describe("PilotTelemetryCollector", () => {
  it("collects score writes, public propagation, errors, and evaluates SLA verdict PASS", () => {
    const collector = new PilotTelemetryCollector({
      candidateSha: "68f948392131922579dfd964f7b2ee93c8340dcf",
      competitionId: "comp-pilot-test-01",
      pilotId: "local-pilot-01",
    });

    collector.recordScoreWrite(2.5, true);
    collector.recordScoreWrite(3.1, true);
    collector.recordPublicPropagation(10.5, true);
    collector.recordRedisEvent({
      type: "lease_acquired",
      matchId: "m-01",
      deviceId: "dev-01",
    });
    collector.recordReconnect({
      deviceId: "dev-01",
      matchId: "m-01",
      offlineCommandsCount: 5,
      syncedSuccessCount: 5,
      conflictCount: 0,
    });
    collector.recordCorrection({
      matchId: "m-01",
      actorId: "usr-01",
      reason: "Scoring clerical typo",
      priorScore: { home: 1, away: 0 },
      correctedScore: { home: 1, away: 1 },
      standingsRecalculated: true,
    });

    const summary = collector.summarize();
    expect(summary.candidateSha).toBe("68f948392131922579dfd964f7b2ee93c8340dcf");
    expect(summary.competitionId).toBe("comp-pilot-test-01");
    expect(summary.pilotId).toBe("local-pilot-01");
    expect(summary.scoreWriteSummary.sampleCount).toBe(2);
    expect(summary.publicPropagationSummary.sampleCount).toBe(1);
    expect(summary.totalApiErrors).toBe(0);
    expect(summary.redisEvents.length).toBe(1);
    expect(summary.reconnectEvents.length).toBe(1);
    expect(summary.correctionEvents.length).toBe(1);
    expect(summary.slaVerdict).toBe("PASS");
  });

  it("evaluates SLA verdict FAIL when latency exceeds SLA thresholds", () => {
    const collector = new PilotTelemetryCollector({
      candidateSha: "68f948392131922579dfd964f7b2ee93c8340dcf",
      competitionId: "comp-pilot-test-02",
      pilotId: "local-pilot-01",
    });

    // Score write p95 budget is < 500ms; 650ms will breach SLA
    collector.recordScoreWrite(650, true);
    collector.recordApiError({
      route: "/api/v1/scoring/matches/m-01/events",
      method: "POST",
      statusCode: 500,
      message: "Database connection timeout",
    });

    const summary = collector.summarize();
    expect(summary.slaVerdict).toBe("FAIL");
    expect(summary.totalApiErrors).toBe(1);
  });
});
