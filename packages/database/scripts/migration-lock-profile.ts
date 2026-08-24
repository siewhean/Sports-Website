export interface C2MigrationLockFixtureProfile {
  name: "representative-c2-v1";
  competitions: number;
  divisionsPerCompetition: number;
  matchesPerDivision: number;
  scoreEventsPerMatch: number;
  scoringSessionsPerMatch: number;
  resultConflictsPerCompetition: number;
}

export const defaultC2MigrationLockFixtureProfile: C2MigrationLockFixtureProfile = {
  name: "representative-c2-v1",
  competitions: 3,
  divisionsPerCompetition: 2,
  matchesPerDivision: 12,
  scoreEventsPerMatch: 16,
  scoringSessionsPerMatch: 1,
  resultConflictsPerCompetition: 2,
};

type FixtureEnvironment = Record<string, string | undefined>;

function positiveInteger(value: string | undefined, name: string, fallback: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

/**
 * Parses only bounded fixture sizing knobs.  The collector remains a controlled
 * staging observation and never accepts arbitrary production-sized load.
 */
export function resolveC2MigrationLockFixtureProfile(
  environment: FixtureEnvironment = process.env,
): C2MigrationLockFixtureProfile {
  const profile: C2MigrationLockFixtureProfile = {
    name: "representative-c2-v1",
    competitions: positiveInteger(
      environment.GATE_C_C2_FIXTURE_COMPETITIONS,
      "GATE_C_C2_FIXTURE_COMPETITIONS",
      defaultC2MigrationLockFixtureProfile.competitions,
      20,
    ),
    divisionsPerCompetition: positiveInteger(
      environment.GATE_C_C2_FIXTURE_DIVISIONS_PER_COMPETITION,
      "GATE_C_C2_FIXTURE_DIVISIONS_PER_COMPETITION",
      defaultC2MigrationLockFixtureProfile.divisionsPerCompetition,
      20,
    ),
    matchesPerDivision: positiveInteger(
      environment.GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION,
      "GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION",
      defaultC2MigrationLockFixtureProfile.matchesPerDivision,
      200,
    ),
    scoreEventsPerMatch: positiveInteger(
      environment.GATE_C_C2_FIXTURE_SCORE_EVENTS_PER_MATCH,
      "GATE_C_C2_FIXTURE_SCORE_EVENTS_PER_MATCH",
      defaultC2MigrationLockFixtureProfile.scoreEventsPerMatch,
      500,
    ),
    scoringSessionsPerMatch: positiveInteger(
      environment.GATE_C_C2_FIXTURE_SCORING_SESSIONS_PER_MATCH,
      "GATE_C_C2_FIXTURE_SCORING_SESSIONS_PER_MATCH",
      defaultC2MigrationLockFixtureProfile.scoringSessionsPerMatch,
      5,
    ),
    resultConflictsPerCompetition: positiveInteger(
      environment.GATE_C_C2_FIXTURE_RESULT_CONFLICTS_PER_COMPETITION,
      "GATE_C_C2_FIXTURE_RESULT_CONFLICTS_PER_COMPETITION",
      defaultC2MigrationLockFixtureProfile.resultConflictsPerCompetition,
      20,
    ),
  };
  if (profile.resultConflictsPerCompetition >= profile.matchesPerDivision) {
    throw new Error(
      "GATE_C_C2_FIXTURE_RESULT_CONFLICTS_PER_COMPETITION must be less than GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION",
    );
  }
  return profile;
}

export function c2MigrationLockFixtureExpectedRows(profile: C2MigrationLockFixtureProfile) {
  const divisions = profile.competitions * profile.divisionsPerCompetition;
  const matches = divisions * profile.matchesPerDivision;
  return {
    competitions: profile.competitions,
    divisions,
    matches,
    scheduledMatches: matches,
    scoreEvents: matches * profile.scoreEventsPerMatch,
    scoringSessions: matches * profile.scoringSessionsPerMatch,
    resultConflicts: profile.competitions * profile.resultConflictsPerCompetition,
  };
}
