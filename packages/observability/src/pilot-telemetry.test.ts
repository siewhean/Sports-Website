import { describe, expect, it } from "vitest";
import { PilotTelemetryCollector, CURRENT_SLO_DEFINITION_VERSION } from "./pilot-telemetry.js";

const VALID_40_CHAR_SHA = "c084b640e72545678d79652bc2a6d2cc048a7ad8";
const observationWindow = {
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("QA-022 / QA-024 — Structured Pilot Event Telemetry Collector", () => {
  it("rejects non-40-character or malformed candidate SHAs", () => {
    expect(() => {
      new PilotTelemetryCollector({
        candidateSha: "c084b64", // short SHA
        competitionId: "comp-123",
        pilotId: "local-pilot-01",
        ...observationWindow,
      });
    }).toThrow(/strict 40-character hex candidate SHA/);

    expect(() => {
      new PilotTelemetryCollector({
        candidateSha: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", // non-hex
        competitionId: "comp-123",
        pilotId: "local-pilot-01",
        ...observationWindow,
      });
    }).toThrow(/strict 40-character hex candidate SHA/);
  });

  it("fails closed when sample counts are below minimum threshold", () => {
    const collector = new PilotTelemetryCollector({
      candidateSha: VALID_40_CHAR_SHA,
      competitionId: "comp-123",
      pilotId: "local-pilot-01",
      minSamplesRequired: 10,
      ...observationWindow,
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
      ...observationWindow,
    });

    // Score writes (SLA <= 500ms)
    collector.recordSession("test-session-1");
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
    expect(summary.redisEvents[0]?.deviceId).not.toBe("dev-1");
    expect(summary.reconnectEvents[0]?.deviceId).not.toBe("dev-1");
    expect(summary.correctionEvents[0]?.actorId).not.toBe("actor-1");
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.redisEvents)).toBe(true);
  });

  it("fails the strict public and propagation p95 boundaries", () => {
    const collector = new PilotTelemetryCollector({
      candidateSha: VALID_40_CHAR_SHA,
      competitionId: "comp-123",
      pilotId: "boundary-pilot",
      minSamplesRequired: 1,
      ...observationWindow,
    });
    collector.recordSession("boundary-session");
    collector.recordScoreWrite(1);
    collector.recordPublicPageRead(2500);
    collector.recordResultPropagation(2000);
    collector.recordApiRequest({
      route: "/health/live",
      method: "GET",
      durationMs: 1,
      statusCode: 200,
      isError: false,
    });

    expect(collector.summarize()).toMatchObject({
      slaVerdict: "FAIL",
      failureReasons: expect.arrayContaining([
        expect.stringContaining(">= 2500ms"),
        expect.stringContaining(">= 2000ms"),
      ]),
    });
  });
});
