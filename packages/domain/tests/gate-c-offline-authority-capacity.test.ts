import { describe, expect, it } from "vitest";
import {
  assertOfflineMatchAuthorization,
  assertOfflineQueueIntegrity,
  canReplayOfflineCommand,
  canTransitionOfflineAuthorizationStatus,
  gateCOfflineQueueLimit,
  gateCOfflineQueueWarningCount,
  gateCOfflineRecordingDurationMs,
  gateCOfflineReplayGraceMs,
  gateCOfflineTerminalRetentionMs,
  offlineRecordingAvailability,
  type OfflineCanonicalEventCommand,
  type OfflineMatchAuthorization,
  type OfflineQueuedCommand,
} from "../src/offline-scoring.js";

const BASE_AUTHORIZED_AT = "2026-08-01T00:00:00.000Z";
const BASE_RECORDING_EXPIRES_AT = "2026-08-01T04:00:00.000Z"; // 4 hours
const BASE_REPLAY_EXPIRES_AT = "2026-08-01T04:15:00.000Z"; // 15 mins grace
const BASE_PASS_EXPIRES_AT = "2026-08-01T06:00:00.000Z";

function makeMatchAuthorization(overrides: Partial<OfflineMatchAuthorization> = {}): OfflineMatchAuthorization {
  return {
    principal_id: "1".repeat(64),
    authorization_id: "11111111-1111-4111-8111-111111111111",
    competition_id: "22222222-2222-4222-8222-222222222222",
    competition_slug: "offline-authority-cup",
    match_id: "33333333-3333-4333-8333-333333333333",
    match_code: "M-AUTH-1",
    match_stage: "Finals",
    writer_generation: 1,
    sport_code: "table_tennis",
    sport_pack_version: "1.0.0",
    settings: {},
    participants: [],
    last_acknowledged_sequence: 0,
    last_acknowledged_aggregate_version: 0,
    authorized_at: BASE_AUTHORIZED_AT,
    recording_expires_at: BASE_RECORDING_EXPIRES_AT,
    replay_expires_at: BASE_REPLAY_EXPIRES_AT,
    pass_expires_at: BASE_PASS_EXPIRES_AT,
    status: "active",
    ...overrides,
  };
}

function makeEventCommand(seq: number): OfflineCanonicalEventCommand {
  const hex = seq.toString(16).padStart(12, "0");
  return {
    kind: "event",
    client_event_id: `44444444-4444-4444-8444-${hex}`,
    expected_sequence: seq - 1,
    type: "point",
    occurred_at: "2026-08-01T01:00:00.000Z",
    team_slot: seq % 2 === 0 ? "home" : "away",
  };
}

function makeQueuedCommand(matchAuth: OfflineMatchAuthorization, localSeq: number): OfflineQueuedCommand {
  return {
    authorization_id: matchAuth.authorization_id,
    match_id: matchAuth.match_id,
    local_sequence: localSeq,
    writer_generation: matchAuth.writer_generation,
    command: makeEventCommand(localSeq),
  };
}

describe("Server-Authoritative Expiration Enforcement (Domain)", () => {
  it("enforces 4h recording window and 15m replay grace window constants", () => {
    expect(gateCOfflineRecordingDurationMs).toBe(4 * 60 * 60 * 1_000);
    expect(gateCOfflineReplayGraceMs).toBe(15 * 60 * 1_000);
    expect(gateCOfflineTerminalRetentionMs).toBe(72 * 60 * 60 * 1_000);
  });

  it("validates compliant server-issued expiration windows", () => {
    const auth = makeMatchAuthorization();
    expect(() => assertOfflineMatchAuthorization(auth)).not.toThrow();
  });

  it("rejects recording window exceeding 4 hours from authorized_at", () => {
    const auth = makeMatchAuthorization({
      recording_expires_at: "2026-08-01T04:00:00.001Z", // 4h + 1ms
    });
    expect(() => assertOfflineMatchAuthorization(auth)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("rejects recording window where recording_expires_at <= authorized_at", () => {
    const auth = makeMatchAuthorization({
      recording_expires_at: BASE_AUTHORIZED_AT,
    });
    expect(() => assertOfflineMatchAuthorization(auth)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("rejects replay grace window exceeding 15 minutes beyond recording_expires_at", () => {
    const auth = makeMatchAuthorization({
      replay_expires_at: "2026-08-01T04:15:00.001Z", // 15m + 1ms
    });
    expect(() => assertOfflineMatchAuthorization(auth)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("rejects replay_expires_at earlier than recording_expires_at", () => {
    const auth = makeMatchAuthorization({
      replay_expires_at: "2026-08-01T03:59:59.999Z",
    });
    expect(() => assertOfflineMatchAuthorization(auth)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("rejects replay_expires_at exceeding pass_expires_at", () => {
    const auth = makeMatchAuthorization({
      pass_expires_at: "2026-08-01T04:10:00.000Z", // less than replay_expires_at 04:15
    });
    expect(() => assertOfflineMatchAuthorization(auth)).toThrow(
      "Offline authorization recording and replay windows are invalid",
    );
  });

  it("strictly prohibits recording when recording_expires_at timestamp is reached or exceeded", () => {
    const auth = makeMatchAuthorization();
    const t0 = Date.parse(BASE_AUTHORIZED_AT);
    const tRecMinus1 = Date.parse(BASE_RECORDING_EXPIRES_AT) - 1;
    const tRec = Date.parse(BASE_RECORDING_EXPIRES_AT);
    const tGrace = Date.parse(BASE_RECORDING_EXPIRES_AT) + 5 * 60 * 1_000;

    // Available during recording window
    expect(offlineRecordingAvailability(auth, 0, t0)).toBe("available");
    expect(offlineRecordingAvailability(auth, 0, tRecMinus1)).toBe("available");

    // Prohibited at exact boundary and during grace period
    expect(offlineRecordingAvailability(auth, 0, tRec)).toBe("recording_expired");
    expect(offlineRecordingAvailability(auth, 0, tGrace)).toBe("recording_expired");
  });

  it("permits command replay during the 15m grace window and prohibits replay after replay_expires_at", () => {
    const auth = makeMatchAuthorization();
    const tRec = Date.parse(BASE_RECORDING_EXPIRES_AT);
    const tGrace = Date.parse(BASE_RECORDING_EXPIRES_AT) + 10 * 60 * 1_000;
    const tReplayMinus1 = Date.parse(BASE_REPLAY_EXPIRES_AT) - 1;
    const tReplay = Date.parse(BASE_REPLAY_EXPIRES_AT);
    const tPass = Date.parse(BASE_PASS_EXPIRES_AT);

    // Can replay during recording window and 15m grace window
    expect(canReplayOfflineCommand(auth, tRec)).toBe(true);
    expect(canReplayOfflineCommand(auth, tGrace)).toBe(true);
    expect(canReplayOfflineCommand(auth, tReplayMinus1)).toBe(true);

    // Cannot replay at or after replay_expires_at
    expect(canReplayOfflineCommand(auth, tReplay)).toBe(false);
    expect(offlineRecordingAvailability(auth, 0, tReplay)).toBe("replay_expired");

    // Cannot replay at or after pass_expires_at
    expect(canReplayOfflineCommand(auth, tPass)).toBe(false);
    expect(offlineRecordingAvailability(auth, 0, tPass)).toBe("pass_expired");
  });

  it("enforces status transition unidirectional flow and terminal states", () => {
    expect(canTransitionOfflineAuthorizationStatus("active", "expired")).toBe(true);
    expect(canTransitionOfflineAuthorizationStatus("active", "revoked")).toBe(true);
    expect(canTransitionOfflineAuthorizationStatus("active", "transferred")).toBe(true);
    expect(canTransitionOfflineAuthorizationStatus("active", "completed")).toBe(true);

    expect(canTransitionOfflineAuthorizationStatus("expired", "active")).toBe(false);
    expect(canTransitionOfflineAuthorizationStatus("revoked", "active")).toBe(false);
    expect(canTransitionOfflineAuthorizationStatus("transferred", "active")).toBe(false);
    expect(canTransitionOfflineAuthorizationStatus("completed", "active")).toBe(false);
  });
});

describe("Offline Queue Capacity Model (2,000 Commands)", () => {
  it("enforces capacity constants: 1,800 warning threshold and 2,000 hard ceiling", () => {
    expect(gateCOfflineQueueWarningCount).toBe(1_800);
    expect(gateCOfflineQueueLimit).toBe(2_000);
  });

  it("evaluates queue availability at all exact boundary thresholds", () => {
    const auth = makeMatchAuthorization();
    const now = Date.parse("2026-08-01T01:00:00.000Z");

    // Under warning threshold: 0 to 1,799 commands
    expect(offlineRecordingAvailability(auth, 0, now)).toBe("available");
    expect(offlineRecordingAvailability(auth, 1, now)).toBe("available");
    expect(offlineRecordingAvailability(auth, 1_799, now)).toBe("available");

    // At and above warning threshold: 1,800 to 1,999 commands
    expect(offlineRecordingAvailability(auth, 1_800, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(auth, 1_801, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(auth, 1_999, now)).toBe("queue_warning");

    // At hard ceiling: 2,000 commands
    expect(offlineRecordingAvailability(auth, 2_000, now)).toBe("queue_full");
    expect(offlineRecordingAvailability(auth, 2_001, now)).toBe("queue_full");
  });

  it("assertOfflineQueueIntegrity accepts up to 2,000 commands and rejects 2,001 commands", () => {
    const auth = makeMatchAuthorization();
    const commands2000: OfflineQueuedCommand[] = [];
    for (let i = 1; i <= 2_000; i++) {
      commands2000.push(makeQueuedCommand(auth, i));
    }

    // 2000 commands should pass queue integrity
    expect(() => assertOfflineQueueIntegrity(auth, commands2000, [])).not.toThrow();

    // 2001 commands must be rejected by hard limit check
    const commands2001 = [...commands2000, makeQueuedCommand(auth, 2_001)];
    expect(() => assertOfflineQueueIntegrity(auth, commands2001, [])).toThrow(
      "Offline queue exceeds its hard command limit",
    );
  });

  it("validates capacity headroom for highest-frequency sports models", () => {
    const sportsCapacityProfiles = [
      {
        sport: "table_tennis",
        description: "7 games to 11 pts with multiple deuces, timeouts, reversals",
        projectedEvents: 500,
        expectedHeadroom: 2000 - 500, // 1500 commands remaining
      },
      {
        sport: "badminton",
        description: "3 sets to 21/30 pts with service events and intervals",
        projectedEvents: 350,
        expectedHeadroom: 2000 - 350, // 1650 commands remaining
      },
      {
        sport: "basketball",
        description: "4 quarters with high scoring, fouls, substitutions",
        projectedEvents: 450,
        expectedHeadroom: 2000 - 450, // 1550 commands remaining
      },
      {
        sport: "volleyball",
        description: "5 sets to 25/15 pts with timeouts and substitutions",
        projectedEvents: 320,
        expectedHeadroom: 2000 - 320, // 1680 commands remaining
      },
      {
        sport: "canoe_polo",
        description: "2 halves with goals, cards, and timeouts",
        projectedEvents: 50,
        expectedHeadroom: 2000 - 50, // 1950 commands remaining
      },
    ];

    for (const profile of sportsCapacityProfiles) {
      const auth = makeMatchAuthorization({ sport_code: profile.sport as never });
      const now = Date.parse("2026-08-01T01:00:00.000Z");

      // Availability must be clean "available" (< 1800)
      expect(offlineRecordingAvailability(auth, profile.projectedEvents, now)).toBe("available");
      expect(gateCOfflineQueueLimit - profile.projectedEvents).toBe(profile.expectedHeadroom);
      expect(profile.projectedEvents).toBeLessThan(gateCOfflineQueueWarningCount);
    }
  });
});
