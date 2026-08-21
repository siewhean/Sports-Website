import { createHash, randomUUID } from "node:crypto";
import type {
  OfflineMatchAuthorization,
  OfflineCanonicalEventCommand,
  OfflineCanonicalCommand,
  RepairMatchSnapshot,
  RepairDependency,
  RepairOutcomeSnapshot,
  AffectedMatchClosureInput,
} from "@matchday/domain";
import type { ScoringFallbackHmacKeyring } from "@matchday/config";
import type { AuthenticationAssurance } from "@matchday/identity";

export const TEST_UUIDS = {
  competitionId: "11111111-1111-4111-8111-111111111111",
  divisionId1: "22222222-2222-4222-8222-222222222221",
  divisionId2: "22222222-2222-4222-8222-222222222222",
  matchId1: "33333333-3333-4333-8333-333333333331",
  matchId2: "33333333-3333-4333-8333-333333333332",
  matchId3: "33333333-3333-4333-8333-333333333333",
  authorizationId: "44444444-4444-4444-8444-444444444444",
  clientEventId1: "55555555-5555-4555-8555-555555555551",
  clientEventId2: "55555555-5555-4555-8555-555555555552",
  clientEventId3: "55555555-5555-4555-8555-555555555553",
  repairCaseId: "66666666-6666-4666-8666-666666666666",
  repairRevisionId: "77777777-7777-4777-8777-777777777777",
  accountId: "88888888-8888-4888-8888-888888888888",
  organisationId: "99999999-9999-4999-8999-999999999999",
  entryHome: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entryAway: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  entryWinner: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  entryLoser: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

export const TEST_PRINCIPAL_ID = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const TEST_CANDIDATE_SHA = "9e6572bfab7f9c5d2c6ea04c726fc5141a578a45";

export function createValidOfflineAuthorization(
  overrides: Partial<OfflineMatchAuthorization> = {},
): OfflineMatchAuthorization {
  const baseTime = Date.now();
  const authorizedAt = new Date(baseTime).toISOString();
  const recordingExpiresAt = new Date(baseTime + 3.5 * 60 * 60 * 1_000).toISOString(); // 3.5h < 4h
  const replayExpiresAt = new Date(baseTime + 3.5 * 60 * 60 * 1_000 + 10 * 60 * 1_000).toISOString(); // +10m < 15m
  const passExpiresAt = new Date(baseTime + 8 * 60 * 60 * 1_000).toISOString(); // 8h

  return {
    schema_version: 1,
    authorization_id: TEST_UUIDS.authorizationId,
    match_id: TEST_UUIDS.matchId1,
    competition_id: TEST_UUIDS.competitionId,
    principal_id: TEST_PRINCIPAL_ID,
    writer_generation: 1,
    last_acknowledged_sequence: 0,
    last_acknowledged_aggregate_version: 0,
    authorized_at: authorizedAt,
    recording_expires_at: recordingExpiresAt,
    replay_expires_at: replayExpiresAt,
    pass_expires_at: passExpiresAt,
    status: "active",
    ...overrides,
  };
}

export function createValidOfflineEventCommand(
  sequence: number,
  clientEventId: string = randomUUID(),
  overrides: Partial<OfflineCanonicalEventCommand> = {},
): OfflineCanonicalEventCommand {
  return {
    kind: "event",
    client_event_id: clientEventId,
    expected_sequence: sequence,
    type: "canoe_polo_goal",
    occurred_at: new Date().toISOString(),
    team: "home",
    points: 1,
    period: 1,
    period_time_ms: 120_000,
    ...overrides,
  };
}

export function createValidClosureInput(): AffectedMatchClosureInput {
  const match1: RepairMatchSnapshot = {
    matchId: TEST_UUIDS.matchId1,
    divisionId: TEST_UUIDS.divisionId1,
    state: "corrected",
    homeEntryId: TEST_UUIDS.entryHome,
    awayEntryId: TEST_UUIDS.entryAway,
    homeControl: "automatic",
    awayControl: "automatic",
  };

  const match2: RepairMatchSnapshot = {
    matchId: TEST_UUIDS.matchId2,
    divisionId: TEST_UUIDS.divisionId1,
    state: "ready",
    homeEntryId: TEST_UUIDS.entryHome,
    awayEntryId: null,
    homeControl: "automatic",
    awayControl: "automatic",
  };

  const dependency: RepairDependency = {
    sourceMatchId: TEST_UUIDS.matchId1,
    downstreamMatchId: TEST_UUIDS.matchId2,
    slot: "home",
    outcome: "winner",
  };

  const proposedOutcome: RepairOutcomeSnapshot = {
    matchId: TEST_UUIDS.matchId1,
    winnerEntryId: TEST_UUIDS.entryAway, // Winner changed to away!
    loserEntryId: TEST_UUIDS.entryHome,
  };

  return {
    competitionId: TEST_UUIDS.competitionId,
    correctedMatchId: TEST_UUIDS.matchId1,
    sourceResultVersion: 1,
    sourceScheduleVersion: 1,
    matches: [match1, match2],
    dependencies: [dependency],
    proposedOutcomes: [proposedOutcome],
  };
}

export function createValidFallbackKeyring(): ScoringFallbackHmacKeyring {
  return {
    primary: {
      version: "v2-2026",
      secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    verificationOnly: [
      {
        version: "v1-legacy",
        secret: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      },
    ],
  };
}

export function createValidAssuranceEvidence(
  level: "single_factor" | "multi_factor" | "phishing_resistant",
): AuthenticationAssurance {
  const now = new Date();
  if (level === "phishing_resistant") {
    return {
      level: "phishing_resistant",
      methods: ["pwd", "mfa", "fido2"],
      acr: "https://schemas.matchday.com/assurance/mfa-phishing-resistant",
      authenticatedAt: now,
      mfaPerformed: true,
      phishingResistant: true,
    };
  }
  if (level === "multi_factor") {
    return {
      level: "multi_factor",
      methods: ["pwd", "mfa", "totp"],
      acr: "https://schemas.matchday.com/assurance/mfa",
      authenticatedAt: now,
      mfaPerformed: true,
      phishingResistant: false,
    };
  }
  return {
    level: "single_factor",
    methods: ["pwd"],
    acr: null,
    authenticatedAt: now,
    mfaPerformed: false,
    phishingResistant: false,
  };
}
