import { describe, expect, it } from "vitest";
import {
  c2MigrationLockFixtureExpectedRows,
  defaultC2MigrationLockFixtureProfile,
  resolveC2MigrationLockFixtureProfile,
} from "../../scripts/migration-lock-profile.js";

describe("Gate C C2 controlled-staging fixture profile", () => {
  it("uses a representative default volume rather than the historical 1/1/1/20 fixture", () => {
    expect(defaultC2MigrationLockFixtureProfile).toMatchObject({
      name: "representative-c2-v1",
      competitions: 3,
      divisionsPerCompetition: 2,
      matchesPerDivision: 12,
      scoreEventsPerMatch: 16,
    });
    expect(c2MigrationLockFixtureExpectedRows(defaultC2MigrationLockFixtureProfile)).toEqual({
      competitions: 3,
      divisions: 6,
      matches: 72,
      scheduledMatches: 72,
      scoreEvents: 1152,
      scoringSessions: 72,
      resultConflicts: 6,
    });
  });

  it("accepts only bounded explicit controlled-staging overrides", () => {
    const profile = resolveC2MigrationLockFixtureProfile({
      GATE_C_C2_FIXTURE_COMPETITIONS: "4",
      GATE_C_C2_FIXTURE_DIVISIONS_PER_COMPETITION: "3",
      GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION: "10",
      GATE_C_C2_FIXTURE_SCORE_EVENTS_PER_MATCH: "8",
      GATE_C_C2_FIXTURE_SCORING_SESSIONS_PER_MATCH: "2",
      GATE_C_C2_FIXTURE_RESULT_CONFLICTS_PER_COMPETITION: "5",
    });
    expect(c2MigrationLockFixtureExpectedRows(profile)).toEqual({
      competitions: 4,
      divisions: 12,
      matches: 120,
      scheduledMatches: 120,
      scoreEvents: 960,
      scoringSessions: 240,
      resultConflicts: 20,
    });
    expect(() => resolveC2MigrationLockFixtureProfile({ GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION: "0" })).toThrow(
      "GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION must be between 1 and 200",
    );
    expect(() => resolveC2MigrationLockFixtureProfile({ GATE_C_C2_FIXTURE_COMPETITIONS: "many" })).toThrow(
      "GATE_C_C2_FIXTURE_COMPETITIONS must be a positive integer",
    );
    expect(() =>
      resolveC2MigrationLockFixtureProfile({
        GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION: "2",
        GATE_C_C2_FIXTURE_RESULT_CONFLICTS_PER_COMPETITION: "2",
      }),
    ).toThrow(
      "GATE_C_C2_FIXTURE_RESULT_CONFLICTS_PER_COMPETITION must be less than GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION",
    );
  });
});
