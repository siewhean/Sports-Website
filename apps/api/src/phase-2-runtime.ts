import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  PublicCompetitionProjection,
  PublicDivisionProjection,
  PublicMatchResult,
  PublicScheduledMatch,
  ScoringSessionState,
} from "@matchday/contracts";
import {
  SPORT_PACKS,
  STANDINGS_SPORT_PACKS,
  assertFiveSportScoreCommandAllowed,
  calculateStandings,
  materialiseFiveSportScoreEvent,
  parseFiveSportScoreCommand,
  reduceFiveSportScoreEvents,
  type FiveSportScoreCommand,
  type FiveSportScoreEvent,
  type FiveSportScoreState,
  type SportId,
  type SportPackSettings,
  type StandingsEngineConfig,
  type StandingsMatchResult,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import {
  NoopScoringAccessRateLimiter,
  scoringAccessRateLimited,
  type ScoringAccessRateLimitHeaders,
  type ScoringAccessRateLimiter,
} from "./scoring-access-rate-limit.js";

export type Phase2Actor = { accountId: string };
export type ScoringPermission = "score:read" | "score:write" | "score:reverse" | "score:finalise";
export type ScoringSessionMode = "writer" | "candidate" | "viewer" | "transferred";
export type ScoringSessionAuth = {
  sessionId: string;
  sessionToken: string;
  generation?: number | null;
};
type IssuedAccessPass = {
  id: string;
  match_id: string;
  role: "scorekeeper" | "viewer";
  permissions: ScoringPermission[];
  token: string;
  short_code: string;
  qr_path: string;
  expires_at: string;
  duplicate: false;
  revoked: false;
};
type ExchangedScoringSession = {
  session_id: string;
  session_token: string;
  match_id: string;
  mode: ScoringSessionMode;
  permissions: ScoringPermission[];
  generation: number | null;
  expires_at: string;
  lease_expires_at: string | null;
  rate_limit: ScoringAccessRateLimitHeaders;
};
type AccessPassExchangeRow = {
  id: string;
  competition_id: string;
  match_id: string;
  secret_hash: Buffer;
  short_code_hash: Buffer | null;
  role: "scorekeeper" | "viewer";
  scope: ScoringPermission[] | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  organisation_id: string;
  competition_status: string;
};

const STANDINGS_CRITERION_ALIASES: Readonly<Record<string, StandingsEngineConfig["criteria"][number]>> = {
  points: "table_points",
  wins: "match_wins",
  match_wins: "match_wins",
  game_difference: "segment_difference",
  set_difference: "segment_difference",
  point_difference: "score_difference",
  goal_difference: "score_difference",
  goals_for: "score_for",
  points_for: "score_for",
  set_ratio: "segment_ratio",
  point_ratio: "score_ratio",
  head_to_head: "head_to_head",
  discipline: "discipline",
  seed: "seed",
};

function effectiveStandingsConfig(sportId: SportId, settings: SportPackSettings) {
  const base = STANDINGS_SPORT_PACKS[sportId];
  const configuredOrder = Array.isArray(settings.standingsOrder)
    ? settings.standingsOrder
        .map((criterion) => STANDINGS_CRITERION_ALIASES[String(criterion)])
        .filter((criterion): criterion is StandingsEngineConfig["criteria"][number] => Boolean(criterion))
    : [];
  const criteria = [...new Set(configuredOrder.length > 0 ? configuredOrder : base.criteria)];
  const winnerScore = Number(settings.forfeitWinnerScore ?? base.forfeitScore.homeScore);
  const loserScore = Number(settings.forfeitLoserScore ?? base.forfeitScore.awayScore);
  const bestOf = Number(settings.bestOf ?? 0);
  const segmentWins = Number.isSafeInteger(bestOf) && bestOf > 0 ? Math.floor(bestOf / 2) + 1 : 0;
  const winPoints = Number(settings.pointsWin ?? base.winPoints);
  const drawPoints = Number(settings.pointsDraw ?? base.drawPoints);
  const lossPoints = Number(settings.pointsLoss ?? base.lossPoints);
  const forfeitScore =
    segmentWins > 0
      ? {
          homeScore: winnerScore * segmentWins,
          awayScore: loserScore * segmentWins,
          homeSegments: Array.from({ length: segmentWins }, () => winnerScore),
          awaySegments: Array.from({ length: segmentWins }, () => loserScore),
        }
      : { homeScore: winnerScore, awayScore: loserScore };
  return {
    ...base,
    version: `${base.version}:${stableHash({ criteria, forfeitScore, winPoints, drawPoints, lossPoints }).slice(0, 16)}`,
    winPoints,
    drawPoints,
    lossPoints,
    criteria,
    forfeitScore,
  } satisfies StandingsEngineConfig;
}

export class ScoringAccessRateLimitError extends ApiError {
  constructor(public readonly rateLimit: ScoringAccessRateLimitHeaders) {
    super(429, "ACCESS_RATE_LIMITED", "Too many invalid access attempts. Try again later.");
  }
}

export class ScoringAccessRejectedError extends ApiError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    public readonly rateLimit: ScoringAccessRateLimitHeaders,
  ) {
    super(statusCode, code, message);
  }
}

class ScoringAccessDeniedError extends ApiError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    readonly accessContext: {
      competitionId: string;
      matchId: string;
      accessPassId: string;
      organisationId: string;
    },
  ) {
    super(statusCode, code, message);
  }
}

export type NormalizedMatch = {
  id: string;
  code: string;
  stage: "group" | "quarterfinal" | "semifinal" | "bronze" | "final";
  roundNumber: number;
  ordinal: number;
  homeEntryId: string | null;
  awayEntryId: string | null;
  dependencies: readonly {
    slot: "home" | "away" | null;
    sourceMatchId: string;
    outcome: "winner" | "loser" | null;
  }[];
};

export type Phase2DomainAdapter = {
  defaultSettings: Record<string, unknown>;
  generateFormat(entries: readonly { id: string; name: string; seed: number }[]): {
    definition: Record<string, unknown>;
    matches: readonly NormalizedMatch[];
  };
  generateSchedule(
    matches: readonly NormalizedMatch[],
    intervals: readonly { playingAreaId: string; startsAt: Date; endsAt: Date }[],
  ): readonly { matchId: string; playingAreaId: string; startsAt: Date; endsAt: Date }[];
  reduceScore(
    events: readonly PersistedScoreEvent[],
    match: { matchId: string; homeEntryId: string; awayEntryId: string },
  ): {
    homeScore: number;
    awayScore: number;
    state: "final" | "corrected";
    snapshot: Record<string, unknown>;
  };
  calculateStandings(input: {
    entries: readonly { id: string; name: string; seed: number }[];
    results: readonly PersistedResult[];
    settings: Record<string, unknown>;
  }): { standings: unknown; explanation: unknown };
  resolveBracket(input: {
    format: Record<string, unknown>;
    results: readonly PersistedResult[];
    entries: readonly { id: string; name: string; seed: number }[];
  }): { bracket: unknown; conflicts?: unknown };
  correctionConflicts(input: {
    format: Record<string, unknown>;
    results: readonly PersistedResult[];
    correctedMatchId: string;
    downstreamStates: Readonly<Record<string, "unstarted" | "started" | "finalised">>;
  }): readonly { correctedMatchId: string; downstreamMatchId: string; reason: string }[];
};

export type PersistedScoreEvent = {
  clientEventId: string;
  sequence: number;
  type:
    | "match_started"
    | "period_changed"
    | "goal_added"
    | "goal_reversed"
    | "card_added"
    | "card_reversed"
    | "timeout_added"
    | "incident_added"
    | "match_finalised"
    | "match_reopened"
    | "correction";
  teamSlot: "home" | "away" | null;
  scorer: string | null;
  manualPeriod: number | null;
  manualEventSeconds: number | null;
  payload: Record<string, unknown>;
  correctionReason: string | null;
  occurredAt: Date;
};

export type PersistedResult = {
  matchId: string;
  homeEntryId: string | null;
  awayEntryId: string | null;
  homeScore: number;
  awayScore: number;
  state: "final" | "corrected";
};

type CompetitionRow = {
  id: string;
  organisation_id: string;
  status: string;
  division_id?: string;
  membership_role?: "owner" | "organiser" | "viewer";
};
type EntryRow = { id: string; name: string; seed: number | null };
type FormatRow = { id: string; definition: Record<string, unknown>; revision: number };
type CanonicalScoreEventRow = {
  id: string;
  client_event_id: string;
  aggregate_version: number;
  sequence: number;
  command: Record<string, unknown> | string;
  actor_access_session_id: string | null;
  actor_account_id: string | null;
};

type CanonicalScoringContext = {
  competition_id: string;
  division_id: string;
  sport_code: SportId;
  pack_version: string;
  settings: SportPackSettings;
  settings_fingerprint: string;
};

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function jsonValue<T>(value: T | string): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function serializedDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

const fallbackCodeAttempts = 5;
const activeFallbackCodeConstraint = "scoring_access_pass_active_code_unique";
const issuanceIdempotencyConstraint = "scoring_access_passes_issue_idempotency_unique";

type FallbackCodeGenerator = () => string;
type PostgresConstraintError = {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  detail?: unknown;
  message?: unknown;
  cause?: unknown;
};

function nextFallbackCode(generator: FallbackCodeGenerator): string {
  const value = generator();
  if (!/^\d{12}$/.test(value)) {
    throw new Error("Fallback code generator must return exactly 12 digits");
  }
  return value;
}

function postgresConstraintName(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const source = error as PostgresConstraintError;
  const value = source.constraint_name ?? source.constraint;
  return typeof value === "string" ? value : null;
}

function isUniqueConstraintViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const source = error as PostgresConstraintError;
  if (source.code !== "23505") return false;
  const candidate = postgresConstraintName(source);
  if (!candidate) return false;
  return candidate === constraint || candidate.endsWith(`.${constraint}`) || candidate.includes(constraint);
}

type PostgresConstraintSignal = {
  code: string | null;
  message: string | null;
  detail: string | null;
  constraintName: string | null;
  serialized: string | null;
};

function toErrorSignals(error: unknown): PostgresConstraintSignal {
  const signals: PostgresConstraintSignal = {
    code: null,
    message: null,
    detail: null,
    constraintName: null,
    serialized: null,
  };

  const seen = new Set<unknown>();
  let current: unknown = error;
  let depth = 0;
  while (current && typeof current === "object" && depth < 4 && !seen.has(current)) {
    seen.add(current);

    const currentError = current as PostgresConstraintError & { message?: unknown; detail?: unknown; code?: unknown };
    if (currentError.code !== undefined) {
      signals.code = String(currentError.code);
    }
    if (typeof currentError.message === "string") signals.message = currentError.message;
    if (typeof currentError.detail === "string") signals.detail = currentError.detail;

    const nextConstraint = postgresConstraintName(currentError);
    if (nextConstraint) signals.constraintName = nextConstraint;

    if (!signals.message) {
      try {
        const fallbackMessage = JSON.stringify(current);
        if (!signals.serialized) signals.serialized = fallbackMessage;
      } catch {
        // ignore serialization issues in transient driver objects
      }
    }

    const next = (current as PostgresConstraintError & { cause?: unknown }).cause;
    current = next;
    depth += 1;
  }

  return signals;
}

function isIssuanceIdempotencyViolation(signals: PostgresConstraintSignal): boolean {
  const message = signals.message ?? "";
  const detail = signals.detail ?? "";
  const serialized = signals.serialized ?? "";
  const constraint = signals.constraintName ?? "";
  return (
    signals.code === "23505" &&
    (constraint.includes(issuanceIdempotencyConstraint) ||
      message.includes(issuanceIdempotencyConstraint) ||
      detail.includes("issuance_idempotency_key") ||
      serialized.includes(issuanceIdempotencyConstraint) ||
      serialized.includes("issuance_idempotency_key"))
  );
}

function isScoreWriterSessionGuardViolation(error: unknown): boolean {
  const signals = toErrorSignals(error);
  return (
    signals.code === "23514" &&
    (signals.constraintName === "canonical_score_events_writer_session_guard" ||
      signals.message?.includes("active writer") === true)
  );
}

function withSavepoint<T>(
  tx: PostgresJsSql,
  _name: "gate_c_access_code_attempt",
  operation: () => PromiseLike<T>,
): Promise<T> {
  if (!tx.savepoint) {
    throw new Error("PostgreSQL savepoints are required for collision retries.");
  }
  return Promise.resolve(tx.savepoint(async () => operation()));
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function hashFallbackCode(shortCode: string, hmacSecret: string): Buffer {
  return createHmac("sha256", hmacSecret).update(`scoring-fallback-code:${shortCode}`, "utf8").digest();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function derivedUuid(namespace: string, purpose: string): string {
  const bytes = createHash("sha256").update(`${namespace}:${purpose}`, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function wireScoreCommand(command: FiveSportScoreCommand): Record<string, unknown> {
  return {
    client_event_id: command.clientEventId,
    type: command.type,
    occurred_at: command.occurredAt,
    ...(command.side ? { team_slot: command.side } : {}),
    ...(command.participantId !== undefined ? { participant_id: command.participantId } : {}),
    ...(command.unknownParticipant !== undefined ? { unknown_participant: command.unknownParticipant } : {}),
    ...(command.segmentNumber !== undefined ? { segment_number: command.segmentNumber } : {}),
    ...(command.manualTimeSeconds !== undefined ? { manual_time_seconds: command.manualTimeSeconds } : {}),
    ...(command.reversalTargetEventId ? { reversal_target_event_id: command.reversalTargetEventId } : {}),
    ...(command.reason ? { reason: command.reason } : {}),
  };
}

function opaqueSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function randomFallbackCode(): string {
  return randomInt(0, 1_000_000_000_000).toString().padStart(12, "0");
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function required<T>(rows: readonly T[], message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", message);
  return row;
}

export class Phase2Runtime {
  private readonly fallbackCodeHmacSecret: string;

  constructor(
    private readonly sql: PostgresJsSql,
    private readonly domain: Phase2DomainAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly scoringAccessRateLimiter: ScoringAccessRateLimiter = new NoopScoringAccessRateLimiter(),
    fallbackCodeHmacSecret?: string,
    private readonly fallbackCodeGenerator: () => string = randomFallbackCode,
    private readonly takeoverRequestTtlMs = 5 * 60_000,
  ) {
    if (!fallbackCodeHmacSecret || Buffer.byteLength(fallbackCodeHmacSecret, "utf8") < 32) {
      throw new Error("Scoring fallback-code HMAC secret must contain at least 32 bytes.");
    }
    this.fallbackCodeHmacSecret = fallbackCodeHmacSecret;
    if (!Number.isInteger(takeoverRequestTtlMs) || takeoverRequestTtlMs <= 0) {
      throw new Error("Takeover request TTL must be a positive integer.");
    }
  }

  private async transaction<T>(operation: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    if (!this.sql.begin) throw new Error("Phase 2 mutations require a transaction-capable PostgreSQL client.");
    return this.sql.begin(operation);
  }

  private async requireCompetitionAccess(
    tx: PostgresJsSql,
    competitionId: string,
    actor: Phase2Actor,
    mutable = true,
  ): Promise<CompetitionRow> {
    const roles = mutable ? ["owner", "organiser"] : ["owner", "organiser", "viewer"];
    const rows = await tx.unsafe<CompetitionRow>(
      `SELECT c.id, c.organisation_id, c.status, om.role AS membership_role
       FROM competitions c
       JOIN organisation_memberships om ON om.organisation_id = c.organisation_id
       WHERE c.id = $1 AND om.account_id = $2 AND om.status = 'active' AND om.role = ANY($3::text[])
       LIMIT 1`,
      [competitionId, actor.accountId, roles],
    );
    if (!rows[0]) throw new ApiError(403, "COMPETITION_ACCESS_DENIED", "Competition access denied");
    if (mutable && rows[0].status === "archived") {
      throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
    }
    return rows[0];
  }

  private async requireOrganisationAccess(
    tx: PostgresJsSql,
    organisationId: string,
    actor: Phase2Actor,
  ): Promise<void> {
    const rows = await tx.unsafe<{ role: string }>(
      `SELECT role FROM organisation_memberships
       WHERE organisation_id = $1 AND account_id = $2 AND status = 'active' AND role IN ('owner', 'organiser')`,
      [organisationId, actor.accountId],
    );
    if (!rows[0]) throw new ApiError(403, "ORGANISATION_ACCESS_DENIED", "Organisation access denied");
  }

  private async evidence(
    tx: PostgresJsSql,
    input: {
      requestId: string;
      actorAccountId: string | null;
      actorType?: "account" | "access_pass";
      organisationId: string | null;
      action: string;
      targetType: string;
      targetId: string;
      reason?: string | null;
      before?: unknown;
      after?: unknown;
      metadata?: Record<string, unknown>;
      eventType?: string;
      eventPayload?: Record<string, unknown>;
    },
  ): Promise<void> {
    const occurredAt = this.now();
    const metadata = { ...(input.metadata ?? {}) };
    const competitionId = input.eventPayload?.competition_id;
    if (typeof competitionId === "string" && metadata.competition_id === undefined) {
      metadata.competition_id = competitionId;
    }
    await tx.unsafe(
      `INSERT INTO audit_events (
         occurred_at, request_id, actor_account_id, actor_type, organisation_id,
         action, target_type, target_id, reason, before_state, after_state, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,
         ($12::jsonb #>> '{}')::jsonb
       )`,
      [
        occurredAt,
        input.requestId,
        input.actorAccountId,
        input.actorType ?? "account",
        input.organisationId,
        input.action,
        input.targetType,
        input.targetId,
        input.reason ?? null,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        JSON.stringify(metadata),
      ],
    );
    await tx.unsafe(
      `INSERT INTO outbox_events (
         aggregate_type, aggregate_id, event_type, payload, idempotency_key, created_at, available_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$6)`,
      [
        input.targetType,
        input.targetId,
        input.eventType ?? input.action,
        JSON.stringify(input.eventPayload ?? { target_id: input.targetId }),
        `${input.requestId}:${input.action}:${input.targetId}`,
        occurredAt,
      ],
    );
  }

  private async insertAccessAttempt(
    tx: PostgresJsSql,
    input: {
      requestId: string;
      credential: string;
      ipAddress: string;
      credentialKind: "token" | "fallback_code";
      outcome: string;
      competitionId?: string | null;
      matchId?: string | null;
      accessPassId?: string | null;
      organisationId?: string | null;
      cooldownUntil?: Date | null;
    },
  ): Promise<void> {
    const fingerprints = this.scoringAccessRateLimiter.fingerprints(input.credential, input.ipAddress);
    await tx.unsafe(
      `INSERT INTO scoring_access_attempts (
         competition_id,match_id,access_pass_id,credential_kind,outcome,
         credential_hmac,ip_hmac,request_id,attempted_at,cooldown_until
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.competitionId ?? null,
        input.matchId ?? null,
        input.accessPassId ?? null,
        input.credentialKind,
        input.outcome,
        fingerprints.credential,
        fingerprints.ip,
        input.requestId,
        this.now(),
        input.cooldownUntil ?? null,
      ],
    );
    await tx.unsafe(
      `INSERT INTO audit_events (
         occurred_at,request_id,actor_account_id,actor_type,organisation_id,
         action,target_type,target_id,reason,before_state,after_state,metadata
       ) VALUES (
         $1,$2,NULL,'access_pass',$3,$4,$5,$6,NULL,NULL,NULL,
         ($7::jsonb #>> '{}')::jsonb
       )`,
      [
        this.now(),
        input.requestId,
        input.organisationId ?? null,
        `scoring_access.${input.outcome}`,
        input.accessPassId ? "scoring_access_pass" : "scoring_access_attempt",
        input.accessPassId ?? input.requestId,
        JSON.stringify({
          credential_kind: input.credentialKind,
          match_id: input.matchId ?? null,
          competition_id: input.competitionId ?? null,
        }),
      ],
    );
  }

  private async recordAccessAttempt(input: {
    requestId: string;
    credential: string;
    ipAddress: string;
    credentialKind: "token" | "fallback_code";
    outcome: string;
    competitionId?: string | null;
    matchId?: string | null;
    accessPassId?: string | null;
    organisationId?: string | null;
    cooldownUntil?: Date | null;
  }): Promise<void> {
    await this.transaction(async (tx) => {
      await this.insertAccessAttempt(tx, input);
    });
  }

  private async recordScoringSessionDenial(
    auth: ScoringSessionAuth,
    requestId: string,
    action: string,
    errorCode: string,
  ): Promise<void> {
    const rows = await this.sql.unsafe<{
      id: string;
      session_token_hash: Buffer;
      organisation_id: string;
      competition_id: string;
      match_id: string;
    }>(
      `SELECT s.id,s.session_token_hash,c.organisation_id,s.competition_id,s.match_id
       FROM scoring_access_sessions s
       JOIN matches m ON m.id=s.match_id
       JOIN competitions c ON c.id=m.competition_id
       WHERE s.id=$1`,
      [auth.sessionId],
    );
    const session = rows[0];
    if (!session || !safeEqual(Buffer.from(session.session_token_hash), hashSecret(auth.sessionToken))) return;
    await this.transaction(async (tx) => {
      await tx.unsafe(
        `INSERT INTO audit_events (
           occurred_at,request_id,actor_account_id,actor_type,organisation_id,
           action,target_type,target_id,reason,before_state,after_state,metadata
         ) VALUES (
           $1,$2,NULL,'access_pass',$3,$4,'scoring_session',$5,NULL,NULL,NULL,
           ($6::jsonb #>> '{}')::jsonb
         )`,
        [
          this.now(),
          requestId,
          session.organisation_id,
          action,
          session.id,
          JSON.stringify({
            error_code: errorCode,
            competition_id: session.competition_id,
            match_id: session.match_id,
          }),
        ],
      );
    });
  }

  private async recordStaleScoreSubmission(
    auth: ScoringSessionAuth,
    command: FiveSportScoreCommand,
    requestId: string,
  ): Promise<void> {
    const rows = await this.sql.unsafe<{
      id: string;
      session_token_hash: Buffer;
      organisation_id: string;
      competition_id: string;
      match_id: string;
    }>(
      `SELECT s.id,s.session_token_hash,c.organisation_id,s.competition_id,s.match_id
       FROM scoring_access_sessions s
       JOIN matches m ON m.id=s.match_id
       JOIN competitions c ON c.id=m.competition_id
       WHERE s.id=$1`,
      [auth.sessionId],
    );
    const session = rows[0];
    if (!session || !safeEqual(Buffer.from(session.session_token_hash), hashSecret(auth.sessionToken))) return;
    await this.transaction(async (tx) => {
      await tx.unsafe(
        `INSERT INTO audit_events (
           occurred_at,request_id,actor_account_id,actor_type,organisation_id,
           action,target_type,target_id,reason,before_state,after_state,metadata
         ) VALUES ($1,$2,NULL,'access_pass',$3,'scoring_event.stale_submission_rejected',
                   'match',$4,$5,NULL,$6::jsonb,($7::jsonb #>> '{}')::jsonb)`,
        [
          this.now(),
          requestId,
          session.organisation_id,
          session.match_id,
          command.reason ?? null,
          JSON.stringify(wireScoreCommand(command)),
          JSON.stringify({
            scoring_session_id: session.id,
            competition_id: session.competition_id,
            submitted_generation: auth.generation ?? null,
            retained_for_review: true,
          }),
        ],
      );
    });
  }

  async createCompetition(
    actor: Phase2Actor,
    input: {
      organisationId: string;
      name: string;
      slug: string;
      timezone: string;
      startsOn: string;
      endsOn: string;
    },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      await this.requireOrganisationAccess(tx, input.organisationId, actor);
      const rows = await tx.unsafe<{ id: string }>(
        `INSERT INTO competitions (
           organisation_id, created_by, name, slug, timezone, starts_on, ends_on
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          input.organisationId,
          actor.accountId,
          input.name.trim(),
          input.slug,
          input.timezone,
          input.startsOn,
          input.endsOn,
        ],
      );
      const competition = required(rows, "Competition was not created");
      const defaults = this.domain.defaultSettings;
      await tx.unsafe(
        `INSERT INTO competition_sport_settings (
           competition_id, period_count, period_minutes, slot_minutes,
           points_win, points_draw, points_loss, tiebreak_order, discipline_weights,
           updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
        [
          competition.id,
          defaults.periodCount ?? 2,
          defaults.periodMinutes ?? 10,
          defaults.slotMinutes ?? 30,
          defaults.pointsWin ?? 3,
          defaults.pointsDraw ?? 1,
          defaults.pointsLoss ?? 0,
          JSON.stringify(
            defaults.tiebreakOrder ?? ["points", "goal_difference", "goals_for", "head_to_head", "discipline", "name"],
          ),
          JSON.stringify(defaults.disciplineWeights ?? { green: 0, yellow: 1, red: 3 }),
          actor.accountId,
        ],
      );
      await tx.unsafe(`INSERT INTO competition_publications (competition_id) VALUES ($1)`, [competition.id]);
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: input.organisationId,
        action: "competition.created",
        targetType: "competition",
        targetId: competition.id,
        after: { name: input.name, slug: input.slug, sport: "canoe_polo" },
      });
      return { id: competition.id, status: "draft" as const, sport_code: "canoe_polo" as const };
    });
  }

  async updateSettings(
    actor: Phase2Actor,
    competitionId: string,
    settings: Record<string, unknown>,
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const locked = await tx.unsafe<{ locked_at: Date | null }>(
        `SELECT locked_at FROM competition_sport_settings WHERE competition_id = $1 FOR UPDATE`,
        [competitionId],
      );
      if (locked[0]?.locked_at) throw new ApiError(409, "SETTINGS_LOCKED", "Settings are locked after scoring starts");
      const values = { ...this.domain.defaultSettings, ...settings };
      await tx.unsafe(
        `UPDATE competition_sport_settings SET
           period_minutes=$2, points_win=$3, points_draw=$4, points_loss=$5,
           tiebreak_order=$6::jsonb, discipline_weights=$7::jsonb,
           customised=$8, updated_by=$9, updated_at=$10
         WHERE competition_id=$1`,
        [
          competitionId,
          values.periodMinutes ?? 10,
          values.pointsWin ?? 3,
          values.pointsDraw ?? 1,
          values.pointsLoss ?? 0,
          JSON.stringify(values.tiebreakOrder ?? []),
          JSON.stringify(values.disciplineWeights ?? {}),
          true,
          actor.accountId,
          this.now(),
        ],
      );
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "competition.settings.updated",
        targetType: "competition",
        targetId: competitionId,
        after: values,
      });
      return { competition_id: competitionId, settings: values, customised: true };
    });
  }

  async createDivision(
    actor: Phase2Actor,
    competitionId: string,
    input: { name: string; teamLimit: 8 | 16 },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const existing = await tx.unsafe<{ count: number }>(
        `SELECT count(*)::integer AS count FROM divisions WHERE competition_id=$1`,
        [competitionId],
      );
      if ((existing[0]?.count ?? 0) >= 1)
        throw new ApiError(409, "SLICE_DIVISION_LIMIT", "This slice supports one division");
      const rows = await tx.unsafe<{ id: string }>(
        `INSERT INTO divisions (competition_id, name, team_limit) VALUES ($1,$2,$3) RETURNING id`,
        [competitionId, input.name.trim(), input.teamLimit],
      );
      const division = required(rows, "Division was not created");
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "division.created",
        targetType: "division",
        targetId: division.id,
        after: input,
      });
      return { id: division.id, name: input.name.trim(), team_limit: input.teamLimit };
    });
  }

  async replaceEntries(
    actor: Phase2Actor,
    competitionId: string,
    divisionId: string,
    entries: readonly { name: string; seed: number }[],
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const division = required(
        await tx.unsafe<{ team_limit: number }>(
          `SELECT team_limit FROM divisions WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
          [divisionId, competitionId],
        ),
        "Division not found",
      );
      const existingFormat = await tx.unsafe<{ id: string }>(
        `SELECT id FROM format_revisions WHERE division_id=$1 LIMIT 1`,
        [divisionId],
      );
      if (existingFormat[0]) throw new ApiError(409, "ENTRIES_LOCKED", "Entries are locked after format generation");
      if (entries.length !== division.team_limit || ![8, 16].includes(entries.length)) {
        throw new ApiError(422, "ENTRY_COUNT_INVALID", "Entry count must exactly match the 8 or 16 team division");
      }
      if (new Set(entries.map((entry) => entry.seed)).size !== entries.length) {
        throw new ApiError(422, "ENTRY_SEEDS_INVALID", "Entry seeds must be unique");
      }
      await tx.unsafe(`DELETE FROM division_entries WHERE division_id=$1`, [divisionId]);
      const created: { id: string; name: string; seed: number }[] = [];
      for (const entry of entries) {
        const rows = await tx.unsafe<{ id: string; name: string; seed: number }>(
          `INSERT INTO division_entries (division_id,name,seed) VALUES ($1,$2,$3) RETURNING id,name,seed`,
          [divisionId, entry.name.trim(), entry.seed],
        );
        created.push(required(rows, "Entry was not created"));
      }
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "division.entries.replaced",
        targetType: "division",
        targetId: divisionId,
        after: { entry_count: created.length },
      });
      return { division_id: divisionId, entries: created };
    });
  }

  async replaceCapacity(
    actor: Phase2Actor,
    competitionId: string,
    areas: readonly { name: string; windows: readonly { startsAt: string; endsAt: string }[] }[],
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      if (areas.length < 1) throw new ApiError(422, "CAPACITY_EMPTY", "At least one playing area is required");
      for (const area of areas) {
        for (const window of area.windows) {
          if (new Date(window.endsAt).getTime() <= new Date(window.startsAt).getTime()) {
            throw new ApiError(422, "CAPACITY_WINDOW_INVALID", "Availability windows must end after they start");
          }
        }
      }
      const existingSchedule = await tx.unsafe<{ id: string }>(
        `SELECT id FROM schedule_revisions WHERE competition_id=$1 LIMIT 1`,
        [competitionId],
      );
      if (existingSchedule[0])
        throw new ApiError(409, "CAPACITY_LOCKED", "Capacity is locked after schedule generation");
      await tx.unsafe(`DELETE FROM playing_areas WHERE competition_id=$1`, [competitionId]);
      const response: unknown[] = [];
      for (const [index, area] of areas.entries()) {
        const areaRow = required(
          await tx.unsafe<{ id: string; name: string }>(
            `INSERT INTO playing_areas (competition_id,name,sort_order,slot_minutes) VALUES ($1,$2,$3,30) RETURNING id,name`,
            [competitionId, area.name.trim(), index],
          ),
          "Playing area was not created",
        );
        for (const window of area.windows) {
          await tx.unsafe(
            `INSERT INTO competition_availability_windows (competition_id,playing_area_id,starts_at,ends_at)
             VALUES ($1,$2,$3,$4)`,
            [competitionId, areaRow.id, window.startsAt, window.endsAt],
          );
        }
        response.push({ ...areaRow, windows: area.windows });
      }
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "competition.capacity.updated",
        targetType: "competition",
        targetId: competitionId,
        after: { area_count: areas.length },
      });
      return { competition_id: competitionId, slot_minutes: 30, areas: response };
    });
  }

  async generateFormat(actor: Phase2Actor, competitionId: string, divisionId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const entries = await tx.unsafe<EntryRow>(
        `SELECT e.id,e.name,e.seed FROM division_entries e JOIN divisions d ON d.id=e.division_id
         WHERE e.division_id=$1 AND d.competition_id=$2 AND e.status='confirmed' ORDER BY e.seed,e.id`,
        [divisionId, competitionId],
      );
      if (![8, 16].includes(entries.length))
        throw new ApiError(422, "ENTRY_COUNT_INVALID", "Exactly 8 or 16 entries are required");
      const generated = this.domain.generateFormat(
        entries.map((entry, index) => ({ ...entry, seed: entry.seed ?? index + 1 })),
      );
      const definitionHash = stableHash(generated.definition);
      const existing = await tx.unsafe<{ id: string; revision: number }>(
        `SELECT id,revision FROM format_revisions WHERE division_id=$1 AND definition_hash=$2`,
        [divisionId, definitionHash],
      );
      if (existing[0]) {
        return {
          id: existing[0].id,
          revision: existing[0].revision,
          definition_hash: definitionHash,
          matches: generated.matches,
          duplicate: true,
        };
      }
      const next = await tx.unsafe<{ revision: number }>(
        `SELECT COALESCE(max(revision),0)::integer + 1 AS revision FROM format_revisions WHERE division_id=$1`,
        [divisionId],
      );
      const revision = next[0]?.revision ?? 1;
      const format = required(
        await tx.unsafe<{ id: string }>(
          `INSERT INTO format_revisions (
             competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract
           ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,'phase2') RETURNING id`,
          [competitionId, divisionId, revision, JSON.stringify(generated.definition), definitionHash, actor.accountId],
        ),
        "Format was not generated",
      );
      for (const match of generated.matches) {
        await tx.unsafe(
          `INSERT INTO matches (
             id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            match.id,
            competitionId,
            divisionId,
            format.id,
            match.code,
            match.stage,
            match.roundNumber,
            match.ordinal,
            match.homeEntryId,
            match.awayEntryId,
          ],
        );
        for (const dependency of match.dependencies) {
          await tx.unsafe(
            `INSERT INTO match_dependencies (match_id,format_revision_id,slot,source_match_id,outcome) VALUES ($1,$2,$3,$4,$5)`,
            [match.id, format.id, dependency.slot, dependency.sourceMatchId, dependency.outcome],
          );
        }
      }
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "format.generated",
        targetType: "format_revision",
        targetId: format.id,
        after: { revision, definition_hash: definitionHash, match_count: generated.matches.length },
      });
      return { id: format.id, revision, definition_hash: definitionHash, matches: generated.matches, duplicate: false };
    });
  }

  async generateSchedule(actor: Phase2Actor, competitionId: string, formatRevisionId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const format = required(
        await tx.unsafe<FormatRow>(
          `SELECT id,definition,revision FROM format_revisions WHERE id=$1 AND competition_id=$2`,
          [formatRevisionId, competitionId],
        ),
        "Format revision not found",
      );
      const matchRows = await tx.unsafe<{
        id: string;
        code: string;
        stage: NormalizedMatch["stage"];
        round_number: number;
        ordinal: number;
        home_entry_id: string | null;
        away_entry_id: string | null;
      }>(
        `SELECT id,code,stage,round_number,ordinal,home_entry_id,away_entry_id
         FROM matches WHERE format_revision_id=$1 ORDER BY ordinal`,
        [formatRevisionId],
      );
      const dependencyRows = await tx.unsafe<{
        match_id: string;
        slot: "home" | "away" | null;
        source_match_id: string;
        outcome: "winner" | "loser" | null;
      }>(
        `SELECT md.match_id,md.slot,md.source_match_id,md.outcome
         FROM match_dependencies md JOIN matches m ON m.id=md.match_id
         WHERE m.format_revision_id=$1`,
        [formatRevisionId],
      );
      const matches = matchRows.map((row) => ({
        id: row.id,
        code: row.code,
        stage: row.stage,
        roundNumber: row.round_number,
        ordinal: row.ordinal,
        homeEntryId: row.home_entry_id,
        awayEntryId: row.away_entry_id,
        dependencies: dependencyRows
          .filter((item) => item.match_id === row.id)
          .map((item) => ({
            slot: item.slot,
            sourceMatchId: item.source_match_id,
            outcome: item.outcome,
          })),
      }));
      const windows = await tx.unsafe<{
        playing_area_id: string;
        starts_at: Date | string;
        ends_at: Date | string;
      }>(
        `SELECT playing_area_id,starts_at,ends_at FROM competition_availability_windows
         WHERE competition_id=$1 ORDER BY starts_at,playing_area_id`,
        [competitionId],
      );
      const intervals = windows.map((row) => ({
        playingAreaId: row.playing_area_id,
        startsAt: date(row.starts_at),
        endsAt: date(row.ends_at),
      }));
      const scheduled = this.domain.generateSchedule(matches, intervals);
      if (scheduled.length !== matches.length)
        throw new ApiError(422, "CAPACITY_INSUFFICIENT", "Schedule cannot fit available capacity");
      const inputHash = stableHash({ format: format.id, intervals });
      const existing = await tx.unsafe<{ id: string; revision: number }>(
        `SELECT id,revision FROM schedule_revisions WHERE competition_id=$1 AND input_hash=$2`,
        [competitionId, inputHash],
      );
      if (existing[0]) return { ...existing[0], duplicate: true, matches: scheduled };
      const next = await tx.unsafe<{ revision: number }>(
        `SELECT COALESCE(max(revision),0)::integer + 1 AS revision FROM schedule_revisions WHERE competition_id=$1`,
        [competitionId],
      );
      const revision = next[0]?.revision ?? 1;
      const schedule = required(
        await tx.unsafe<{ id: string }>(
          `INSERT INTO schedule_revisions (
             competition_id,format_revision_id,revision,input_hash,created_by
           ) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [competitionId, formatRevisionId, revision, inputHash, actor.accountId],
        ),
        "Schedule was not generated",
      );
      for (const item of scheduled) {
        await tx.unsafe(
          `INSERT INTO scheduled_matches (schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [schedule.id, item.matchId, competitionId, item.playingAreaId, item.startsAt, item.endsAt],
        );
      }
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "schedule.generated",
        targetType: "schedule_revision",
        targetId: schedule.id,
        after: { revision, input_hash: inputHash, match_count: scheduled.length, public: false },
      });
      return { id: schedule.id, revision, duplicate: false, matches: scheduled };
    });
  }

  async publishSchedule(actor: Phase2Actor, competitionId: string, scheduleRevisionId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const schedule = required(
        await tx.unsafe<{ id: string; status: string; revision: number; format_revision_id: string }>(
          `SELECT id,status,revision,format_revision_id FROM schedule_revisions WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
          [scheduleRevisionId, competitionId],
        ),
        "Schedule revision not found",
      );
      if (schedule.status !== "draft")
        throw new ApiError(409, "REVISION_IMMUTABLE", "Schedule revision is not a draft");
      const publication = required(
        await tx.unsafe<{ schedule_version: number; result_version: number }>(
          `SELECT schedule_version,result_version FROM competition_publications WHERE competition_id=$1 FOR UPDATE`,
          [competitionId],
        ),
        "Publication record not found",
      );
      const version = publication.schedule_version + 1;
      const occurredAt = this.now();
      await tx.unsafe(
        `UPDATE format_revisions SET status='superseded'
         WHERE competition_id=$1 AND status='published' AND id<>$2`,
        [competitionId, schedule.format_revision_id],
      );
      await tx.unsafe(
        `UPDATE format_revisions SET status='published',published_at=$2
         WHERE id=$1 AND status='draft'`,
        [schedule.format_revision_id, occurredAt],
      );
      await tx.unsafe(
        `UPDATE schedule_revisions SET status='superseded'
         WHERE competition_id=$1 AND status='published'`,
        [competitionId],
      );
      await tx.unsafe(`UPDATE schedule_revisions SET status='published',published_at=$2 WHERE id=$1`, [
        scheduleRevisionId,
        occurredAt,
      ]);
      await tx.unsafe(
        `UPDATE competition_publications SET
           published_schedule_revision_id=$2,schedule_version=$3,schedule_published_at=$4,updated_at=$4
         WHERE competition_id=$1`,
        [competitionId, scheduleRevisionId, version, occurredAt],
      );
      await tx.unsafe(
        `UPDATE competitions SET status=CASE WHEN status='draft' THEN 'active' ELSE status END,updated_at=$2 WHERE id=$1`,
        [competitionId, occurredAt],
      );
      await this.writePublicProjection(tx, competitionId, version, publication.result_version);
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "schedule.published",
        targetType: "schedule_revision",
        targetId: scheduleRevisionId,
        after: { schedule_version: version },
        eventPayload: { competition_id: competitionId, schedule_version: version },
      });
      return { competition_id: competitionId, schedule_revision_id: scheduleRevisionId, schedule_version: version };
    });
  }

  async createAccessPass(
    actor: Phase2Actor,
    competitionId: string,
    matchId: string,
    input: string,
    requestId: string,
  ): Promise<IssuedAccessPass>;
  async createAccessPass(
    actor: Phase2Actor,
    competitionId: string,
    matchId: string,
    input: {
      expiresAt: string;
      role: "scorekeeper" | "viewer";
      idempotencyKey: string;
    },
    requestId: string,
  ): Promise<
    | IssuedAccessPass
    | (Omit<IssuedAccessPass, "token" | "short_code" | "qr_path" | "duplicate" | "revoked"> & {
        token: null;
        short_code: null;
        qr_path: null;
        duplicate: true;
        revoked: boolean;
      })
  >;
  async createAccessPass(
    actor: Phase2Actor,
    competitionId: string,
    matchId: string,
    input:
      | string
      | {
          expiresAt: string;
          role: "scorekeeper" | "viewer";
          idempotencyKey: string;
        },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const normalized =
        typeof input === "string"
          ? { expiresAt: input, role: "scorekeeper" as const, idempotencyKey: requestId }
          : input;
      const permissions: ScoringPermission[] =
        normalized.role === "viewer"
          ? ["score:read"]
          : ["score:read", "score:write", "score:reverse", "score:finalise"];
      const readReplay = async () =>
        tx.unsafe<{
          id: string;
          match_id: string;
          role: "scorekeeper" | "viewer";
          scope: ScoringPermission[] | string;
          expires_at: Date | string;
          revoked_at: Date | string | null;
        }>(
          `SELECT id,match_id,role,scope,expires_at,revoked_at
         FROM scoring_access_passes
         WHERE competition_id=$1 AND issuance_idempotency_key=$2`,
          [competitionId, normalized.idempotencyKey],
        );
      const replayResponse = (row: Awaited<ReturnType<typeof readReplay>>[number]) => {
        if (
          row.match_id !== matchId ||
          row.role !== normalized.role ||
          serializedDate(row.expires_at) !== normalized.expiresAt
        ) {
          throw new ApiError(409, "ACCESS_IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input");
        }
        return {
          id: row.id,
          match_id: row.match_id,
          role: row.role,
          permissions: jsonValue<ScoringPermission[]>(row.scope),
          expires_at: serializedDate(row.expires_at),
          token: null,
          short_code: null,
          qr_path: null,
          duplicate: true as const,
          revoked: Boolean(row.revoked_at),
        };
      };
      const replay = await readReplay();
      if (replay[0]) return replayResponse(replay[0]);
      if (new Date(normalized.expiresAt).getTime() <= this.now().getTime()) {
        throw new ApiError(422, "ACCESS_EXPIRY_INVALID", "Access expiry must be in the future");
      }
      const match = required(
        await tx.unsafe<{ id: string; home_entry_id: string | null; away_entry_id: string | null }>(
          `SELECT id,home_entry_id,away_entry_id FROM matches WHERE id=$1 AND competition_id=$2`,
          [matchId, competitionId],
        ),
        "Match not found",
      );
      if (!match.home_entry_id || !match.away_entry_id) {
        throw new ApiError(409, "MATCH_PARTICIPANTS_UNRESOLVED", "Scoring access requires resolved participants");
      }
      const secret = opaqueSecret();
      let shortCode = "";
      let pass: { id: string } | undefined;
      let collisionCount = 0;
      for (let attempt = 0; attempt < fallbackCodeAttempts && !pass; attempt += 1) {
        shortCode = nextFallbackCode(this.fallbackCodeGenerator);
        try {
          const rows = await withSavepoint(tx, "gate_c_access_code_attempt", () =>
            tx.unsafe<{ id: string }>(
              `INSERT INTO scoring_access_passes (
                 competition_id,match_id,secret_hash,short_code_hash,expires_at,created_by,
                 role,scope,issuance_idempotency_key,fallback_code_hash_version
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,
                 CASE WHEN $7='viewer'
                   THEN '["score:read"]'::jsonb
                   ELSE '["score:read","score:write","score:reverse","score:finalise"]'::jsonb
                 END,
                 $8,
                 'hmac_sha256_v1'
               ) ON CONFLICT (short_code_hash)
                 WHERE short_code_hash IS NOT NULL
                   AND revoked_at IS NULL
               DO NOTHING
               RETURNING id`,
              [
                competitionId,
                match.id,
                hashSecret(secret),
                hashFallbackCode(shortCode, this.fallbackCodeHmacSecret),
                normalized.expiresAt,
                actor.accountId,
                normalized.role,
                normalized.idempotencyKey,
              ],
            ),
          );
          if (!rows[0]) {
            collisionCount += 1;
            continue;
          }
          pass = rows[0];
        } catch (error) {
          const signals = toErrorSignals(error);
          if (isUniqueConstraintViolation(error, activeFallbackCodeConstraint)) {
            collisionCount += 1;
            continue;
          }
          const idempotencyViolation =
            isIssuanceIdempotencyViolation(signals) ||
            isUniqueConstraintViolation(error, issuanceIdempotencyConstraint);
          if (idempotencyViolation) {
            const concurrentReplay = await readReplay();
            if (concurrentReplay[0]) return replayResponse(concurrentReplay[0]);
          }
          throw error;
        }
      }
      if (!pass) {
        throw new ApiError(503, "ACCESS_CODE_UNAVAILABLE", "A unique access code could not be issued");
      }
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "scoring_access.created",
        targetType: "scoring_access_pass",
        targetId: pass.id,
        after: { match_id: matchId, expires_at: normalized.expiresAt, role: normalized.role, permissions },
        metadata: { fallback_code_collision_count: collisionCount },
        eventPayload: { competition_id: competitionId, match_id: matchId, role: normalized.role },
      });
      // Secrets are returned once and are deliberately absent from audit/outbox/log metadata.
      return {
        id: pass.id,
        match_id: matchId,
        role: normalized.role,
        permissions,
        token: secret,
        short_code: shortCode,
        qr_path: `/score#access=${secret}`,
        expires_at: normalized.expiresAt,
        duplicate: false as const,
        revoked: false,
      };
    });
  }

  async rotateFallbackCode(
    actor: Phase2Actor,
    competitionId: string,
    passId: string,
    idempotencyKey: string,
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const pass = required(
        await tx.unsafe<{ id: string; match_id: string; revoked_at: Date | string | null; expires_at: Date | string }>(
          `SELECT id,match_id,revoked_at,expires_at FROM scoring_access_passes
           WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
          [passId, competitionId],
        ),
        "Access pass not found",
      );
      if (pass.revoked_at || date(pass.expires_at).getTime() <= this.now().getTime()) {
        throw new ApiError(409, "ACCESS_INACTIVE", "Only an active access pass can be rotated");
      }
      const alreadyRotated = await tx.unsafe<{ request_id: string }>(
        `SELECT request_id FROM audit_events
         WHERE target_type='scoring_access_pass' AND target_id=$1
           AND action='scoring_access.fallback_rotated'
           AND metadata->>'idempotency_key'=$2 LIMIT 1`,
        [passId, idempotencyKey],
      );
      if (alreadyRotated[0]) return { id: passId, short_code: null, duplicate: true as const };
      let shortCode = "";
      let rotated = false;
      let collisionCount = 0;
      for (let attempt = 0; attempt < fallbackCodeAttempts && !rotated; attempt += 1) {
        shortCode = nextFallbackCode(this.fallbackCodeGenerator);
        const candidateHash = hashFallbackCode(shortCode, this.fallbackCodeHmacSecret);
        try {
          const rows = await withSavepoint(tx, "gate_c_access_code_attempt", () =>
            tx.unsafe<{ id: string }>(
              `UPDATE scoring_access_passes
               SET short_code_hash=$3,
                   fallback_code_rotated_at=$4,
                   fallback_code_hash_version='hmac_sha256_v1'
               WHERE id=$1
                 AND competition_id=$2
                 AND NOT EXISTS (
                   SELECT 1 FROM scoring_access_passes
                    WHERE id<>$1
                      AND competition_id=$2
                      AND short_code_hash=$3
                      AND revoked_at IS NULL
                 )
               RETURNING id`,
              [passId, competitionId, candidateHash, this.now()],
            ),
          );
          if (!rows[0]) {
            collisionCount += 1;
            continue;
          }
          rotated = true;
        } catch (error) {
          if (isUniqueConstraintViolation(error, activeFallbackCodeConstraint)) {
            collisionCount += 1;
            continue;
          }
          throw error;
        }
      }
      if (!rotated) throw new ApiError(503, "ACCESS_CODE_UNAVAILABLE", "A unique access code could not be issued");
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "scoring_access.fallback_rotated",
        targetType: "scoring_access_pass",
        targetId: passId,
        metadata: { idempotency_key: idempotencyKey, fallback_code_collision_count: collisionCount },
        eventPayload: { competition_id: competitionId, match_id: pass.match_id },
      });
      return { id: passId, short_code: shortCode, duplicate: false as const };
    });
  }

  async listAccessPasses(actor: Phase2Actor, competitionId: string) {
    await this.requireCompetitionAccess(this.sql, competitionId, actor);
    return this.sql.unsafe<Record<string, unknown>>(
      `SELECT p.id,p.match_id,p.role,p.scope,p.expires_at,p.created_at,p.revoked_at,
              p.fallback_code_rotated_at,p.revocation_reason,
              CASE
                WHEN p.fallback_code_hash_version='rotation_required' THEN 'rotation_required'
                WHEN p.fallback_code_hash_version='unavailable' THEN 'unavailable'
                ELSE 'available'
              END AS fallback_code_status,
              CASE
                WHEN p.revoked_at IS NOT NULL THEN 'revoked'
                WHEN p.expires_at<=now() THEN 'expired'
                ELSE 'active'
              END AS status
       FROM scoring_access_passes p
       WHERE p.competition_id=$1 ORDER BY p.created_at DESC`,
      [competitionId],
    );
  }

  async revokeAccessPass(
    actor: Phase2Actor,
    competitionId: string,
    passId: string,
    requestId: string,
    reason: string | null = null,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const accessPass = required(
        await tx.unsafe<{ match_id: string }>(
          `SELECT match_id FROM scoring_access_passes
           WHERE id=$1 AND competition_id=$2 AND revoked_at IS NULL`,
          [passId, competitionId],
        ),
        "Active access pass not found",
      );
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [accessPass.match_id]);
      const rows = await tx.unsafe<{ id: string }>(
        `UPDATE scoring_access_passes p SET revoked_at=$4,revoked_by=$3,revocation_reason=$5
         FROM matches m WHERE p.id=$1 AND p.match_id=m.id AND m.competition_id=$2 AND p.revoked_at IS NULL
         RETURNING p.id`,
        [passId, competitionId, actor.accountId, this.now(), reason],
      );
      required(rows, "Active access pass not found");
      await tx.unsafe(
        `UPDATE scoring_access_sessions SET revoked_at=$2
         WHERE access_pass_id=$1 AND revoked_at IS NULL`,
        [passId, this.now()],
      );
      await tx.unsafe(
        `DELETE FROM match_writer_leases l
         USING scoring_access_sessions s
         WHERE l.access_session_id=s.id AND s.access_pass_id=$1`,
        [passId],
      );
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "scoring_access.revoked",
        targetType: "scoring_access_pass",
        targetId: passId,
        reason,
        eventPayload: { competition_id: competitionId },
      });
      return { id: passId, revoked: true as const };
    });
  }

  async exchangeAccess(
    input: { token?: string; shortCode?: string; expectedMatchId?: string },
    requestId: string,
  ): Promise<ExchangedScoringSession & { generation: number; mode: "writer" }>;
  async exchangeAccess(
    input: {
      token?: string;
      shortCode?: string;
      expectedMatchId?: string;
      deviceId: string;
      deviceLabel?: string;
      ipAddress?: string;
    },
    requestId: string,
  ): Promise<ExchangedScoringSession>;
  async exchangeAccess(
    input: {
      token?: string;
      shortCode?: string;
      expectedMatchId?: string;
      deviceId?: string;
      deviceLabel?: string;
      ipAddress?: string;
    },
    requestId: string,
  ) {
    if (Boolean(input.token) === Boolean(input.shortCode)) {
      throw new ApiError(400, "ACCESS_SECRET_AMBIGUOUS", "Provide exactly one access token or short code");
    }
    const presented = input.token ?? input.shortCode;
    if (!presented) throw new ApiError(400, "ACCESS_SECRET_REQUIRED", "Access token or code is required");
    const ipAddress = input.ipAddress ?? "runtime-test";
    const credentialKind = input.token ? ("token" as const) : ("fallback_code" as const);
    const initialLimit = await this.scoringAccessRateLimiter.assertAllowed(presented, ipAddress);
    if (scoringAccessRateLimited(initialLimit)) {
      await this.recordAccessAttempt({
        requestId,
        credential: presented,
        ipAddress,
        credentialKind,
        outcome: "rate_limited",
        cooldownUntil: new Date(this.now().getTime() + (initialLimit.retryAfterSeconds ?? 0) * 1_000),
      });
      throw new ScoringAccessRateLimitError(initialLimit);
    }
    try {
      const result = await this.transaction(async (tx) => {
        if (Boolean(input.token) === Boolean(input.shortCode)) {
          throw new ApiError(400, "ACCESS_SECRET_AMBIGUOUS", "Provide exactly one access token or short code");
        }
        const digest = input.token ? hashSecret(presented) : hashFallbackCode(presented, this.fallbackCodeHmacSecret);
        const column = input.token ? "secret_hash" : "short_code_hash";
        const loadPass = (lock: boolean) =>
          tx.unsafe<AccessPassExchangeRow>(
            `SELECT p.id,p.competition_id,p.match_id,p.secret_hash,p.short_code_hash,p.role,p.scope,
                p.expires_at,p.revoked_at,c.organisation_id,
                c.status AS competition_status
             FROM scoring_access_passes p
             JOIN matches m ON m.id=p.match_id JOIN competitions c ON c.id=m.competition_id
             WHERE p.${column}=$1 LIMIT 1 ${lock ? "FOR UPDATE OF p" : ""}`,
            [digest],
          );
        let pass = (await loadPass(false))[0];
        const stored = input.token ? pass?.secret_hash : pass?.short_code_hash;
        if (!pass || !stored || !safeEqual(Buffer.from(stored), digest)) {
          if (!input.token && input.expectedMatchId) {
            const rotationRequired = await tx.unsafe<{ required: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM scoring_access_passes p
                 JOIN competitions c ON c.id=p.competition_id
                 WHERE p.fallback_code_hash_version='rotation_required'
                   AND p.revoked_at IS NULL AND p.expires_at>$1 AND c.status<>'archived'
                   AND p.match_id=$2
               ) AS required`,
              [this.now(), input.expectedMatchId],
            );
            if (rotationRequired[0]?.required) {
              throw new ApiError(
                409,
                "ACCESS_FALLBACK_ROTATION_REQUIRED",
                "Legacy fallback numbers require organiser rotation before use",
              );
            }
          }
          throw new ApiError(403, "ACCESS_DENIED", "Access is invalid");
        }
        // All access mutations use the match advisory lock before mutable row
        // locks, preventing exchange-vs-revocation lock inversion.
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [pass.match_id]);
        pass = (await loadPass(true))[0];
        const lockedStored = input.token ? pass?.secret_hash : pass?.short_code_hash;
        if (!pass || !lockedStored || !safeEqual(Buffer.from(lockedStored), digest)) {
          throw new ApiError(403, "ACCESS_DENIED", "Access is invalid");
        }
        if (pass.competition_status === "archived") {
          throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
        }
        const accessContext = {
          competitionId: pass.competition_id,
          matchId: pass.match_id,
          accessPassId: pass.id,
          organisationId: pass.organisation_id,
        };
        if (pass.revoked_at) {
          throw new ScoringAccessDeniedError(403, "ACCESS_REVOKED", "Access has been revoked", accessContext);
        }
        if (date(pass.expires_at).getTime() <= this.now().getTime())
          throw new ScoringAccessDeniedError(403, "ACCESS_EXPIRED", "Access has expired", accessContext);
        if (input.expectedMatchId && input.expectedMatchId !== pass.match_id) {
          throw new ScoringAccessDeniedError(
            403,
            "ACCESS_WRONG_MATCH",
            "Access does not belong to this match",
            accessContext,
          );
        }
        const sessionSecret = opaqueSecret();
        const lease = await tx.unsafe<{ access_session_id: string; generation: number; expires_at: Date | string }>(
          `SELECT access_session_id,generation,expires_at FROM match_writer_leases WHERE match_id=$1 FOR UPDATE`,
          [pass.match_id],
        );
        const historicalGeneration =
          (
            await tx.unsafe<{ generation: number }>(
              `SELECT COALESCE(max(generation),0)::integer AS generation
               FROM scoring_access_sessions WHERE match_id=$1`,
              [pass.match_id],
            )
          )[0]?.generation ?? 0;
        const now = this.now();
        const expiresAt = new Date(Math.min(date(pass.expires_at).getTime(), now.getTime() + 30 * 60_000));
        const activeLease = Boolean(lease[0] && date(lease[0].expires_at).getTime() > now.getTime());
        if (!input.deviceId && activeLease) {
          throw new ApiError(409, "WRITER_ACTIVE", "Another scorekeeper currently controls this match");
        }
        const mode: ScoringSessionMode = pass.role === "viewer" ? "viewer" : activeLease ? "candidate" : "writer";
        const generation = mode === "writer" ? Math.max(lease[0]?.generation ?? 0, historicalGeneration) + 1 : null;
        const leaseExpiresAt =
          mode === "writer" ? new Date(Math.min(expiresAt.getTime(), now.getTime() + 45_000)) : null;
        const deviceId = input.deviceId ?? opaqueSecret();
        const session = required(
          await tx.unsafe<{ id: string }>(
            `INSERT INTO scoring_access_sessions (
             access_pass_id,competition_id,match_id,session_token_hash,generation,issued_at,expires_at,
             mode,device_id_hash,device_label,last_heartbeat_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6) RETURNING id`,
            [
              pass.id,
              pass.competition_id,
              pass.match_id,
              hashSecret(sessionSecret),
              generation,
              now,
              expiresAt,
              mode,
              hashSecret(deviceId),
              input.deviceLabel?.trim() || null,
            ],
          ),
          "Scoring session was not created",
        );
        if (mode === "writer" && generation && leaseExpiresAt) {
          await tx.unsafe(
            `INSERT INTO match_writer_leases (
             competition_id,match_id,access_session_id,generation,acquired_at,expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (match_id) DO UPDATE SET
             competition_id=EXCLUDED.competition_id,access_session_id=EXCLUDED.access_session_id,
             generation=EXCLUDED.generation,acquired_at=EXCLUDED.acquired_at,expires_at=EXCLUDED.expires_at`,
            [pass.competition_id, pass.match_id, session.id, generation, now, leaseExpiresAt],
          );
        }
        await this.evidence(tx, {
          requestId,
          actorAccountId: null,
          actorType: "access_pass",
          organisationId: pass.organisation_id,
          action: "scoring_access.exchanged",
          targetType: "scoring_session",
          targetId: session.id,
          after: { match_id: pass.match_id, mode, generation, expires_at: expiresAt.toISOString() },
          eventPayload: { competition_id: pass.competition_id, match_id: pass.match_id, mode },
        });
        // External success-accounting happens before PostgreSQL commit. If Redis or
        // attempt persistence fails, the enclosing transaction rolls the session
        // and writer lease back rather than returning an error with a ghost writer.
        await this.scoringAccessRateLimiter.recordSuccess(presented, ipAddress);
        await this.insertAccessAttempt(tx, {
          requestId,
          credential: presented,
          ipAddress,
          credentialKind,
          outcome: "accepted",
          competitionId: pass.competition_id,
          matchId: pass.match_id,
          accessPassId: pass.id,
          organisationId: pass.organisation_id,
        });
        return {
          session_id: session.id,
          session_token: sessionSecret,
          match_id: pass.match_id,
          mode,
          permissions: jsonValue<ScoringPermission[]>(pass.scope),
          generation,
          expires_at: expiresAt.toISOString(),
          lease_expires_at: leaseExpiresAt?.toISOString() ?? null,
          rate_limit: initialLimit,
          access_pass_id: pass.id,
          competition_id: pass.competition_id,
          organisation_id: pass.organisation_id,
        };
      });
      const publicResult: Record<string, unknown> = { ...result };
      delete publicResult.access_pass_id;
      delete publicResult.competition_id;
      delete publicResult.organisation_id;
      return publicResult as ExchangedScoringSession;
    } catch (error) {
      if (
        error instanceof ApiError &&
        [
          "ACCESS_DENIED",
          "ACCESS_WRONG_MATCH",
          "ACCESS_REVOKED",
          "ACCESS_EXPIRED",
          "ACCESS_FALLBACK_ROTATION_REQUIRED",
        ].includes(error.code)
      ) {
        const state = await this.scoringAccessRateLimiter.recordInvalid(presented, ipAddress);
        const accessContext = error instanceof ScoringAccessDeniedError ? error.accessContext : null;
        await this.recordAccessAttempt({
          requestId,
          credential: presented,
          ipAddress,
          credentialKind,
          outcome:
            error.code === "ACCESS_WRONG_MATCH"
              ? "wrong_match"
              : error.code === "ACCESS_REVOKED"
                ? "revoked"
                : error.code === "ACCESS_EXPIRED"
                  ? "expired"
                  : error.code === "ACCESS_FALLBACK_ROTATION_REQUIRED"
                    ? "rotation_required"
                    : "invalid",
          cooldownUntil: state.retryAfterSeconds
            ? new Date(this.now().getTime() + state.retryAfterSeconds * 1_000)
            : null,
          ...(accessContext
            ? {
                competitionId: accessContext.competitionId,
                matchId: accessContext.matchId,
                accessPassId: accessContext.accessPassId,
                organisationId: accessContext.organisationId,
              }
            : {}),
        });
        if (scoringAccessRateLimited(state)) throw new ScoringAccessRateLimitError(state);
        throw new ScoringAccessRejectedError(error.statusCode, error.code, error.message, state);
      }
      throw error;
    }
  }

  private async authenticateScoringSession(
    tx: PostgresJsSql,
    sessionId: string,
    sessionToken: string,
    generation: number | null | undefined,
    requireWriter = true,
    lockSession = true,
  ) {
    const rows = await tx.unsafe<{
      id: string;
      competition_id: string;
      match_id: string;
      session_token_hash: Buffer;
      generation: number | null;
      mode: ScoringSessionMode;
      scope: ScoringPermission[] | string;
      pass_expires_at: Date | string;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      access_pass_id: string;
      lease_session_id: string | null;
      lease_generation: number | null;
      lease_expires_at: Date | string | null;
      organisation_id: string;
      division_id: string;
      competition_status: string;
    }>(
      `SELECT s.id,s.competition_id,s.match_id,s.session_token_hash,s.generation,s.mode,s.expires_at,
              s.revoked_at,s.access_pass_id,p.scope,p.expires_at AS pass_expires_at,
              l.access_session_id AS lease_session_id,l.generation AS lease_generation,l.expires_at AS lease_expires_at,
              c.organisation_id,m.division_id,c.status AS competition_status
       FROM scoring_access_sessions s
       JOIN scoring_access_passes p ON p.id=s.access_pass_id
       LEFT JOIN match_writer_leases l ON l.match_id=s.match_id
       JOIN matches m ON m.id=s.match_id JOIN competitions c ON c.id=m.competition_id
       WHERE s.id=$1 ${lockSession ? "FOR UPDATE OF s" : ""}`,
      [sessionId],
    );
    const session = rows[0];
    if (!session || !safeEqual(Buffer.from(session.session_token_hash), hashSecret(sessionToken))) {
      throw new ApiError(403, "SCORING_SESSION_DENIED", "Scoring session is invalid");
    }
    if (session.competition_status === "archived") {
      throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
    }
    const now = this.now().getTime();
    if (session.revoked_at) {
      throw new ApiError(403, "SCORING_SESSION_REVOKED", "Scoring session has been revoked");
    }
    if (date(session.expires_at).getTime() <= now) {
      throw new ApiError(403, "SCORING_SESSION_EXPIRED", "Scoring session has expired");
    }
    if (requireWriter) {
      if (
        session.mode !== "writer" ||
        generation == null ||
        session.lease_session_id !== session.id ||
        session.lease_generation !== generation ||
        session.generation !== generation ||
        !session.lease_expires_at ||
        date(session.lease_expires_at).getTime() <= now
      ) {
        throw new ApiError(409, "STALE_WRITER_GENERATION", "This session does not hold the active writer lease");
      }
    }
    return session;
  }

  private async canonicalScoringContext(
    tx: PostgresJsSql,
    matchId: string,
    lock = false,
  ): Promise<CanonicalScoringContext> {
    const row = required(
      await tx.unsafe<{
        competition_id: string;
        division_id: string;
        sport_code: SportId;
        pack_version: string;
        division_pack_version: string | null;
        recommended_snapshot: Record<string, unknown> | string;
        competition_override: Record<string, unknown> | string;
        division_override: Record<string, unknown> | string | null;
      }>(
        `SELECT m.competition_id,m.division_id,c.sport_code,settings.pack_version,
                division_settings.pack_version AS division_pack_version,
                settings.recommended_snapshot,settings.settings_override AS competition_override,
                division_settings.settings_override AS division_override
         FROM matches m
         JOIN competitions c ON c.id=m.competition_id
         JOIN competition_sport_settings settings
           ON settings.competition_id=m.competition_id AND settings.sport_code=c.sport_code
         LEFT JOIN division_sport_settings division_settings
           ON division_settings.division_id=m.division_id
          AND division_settings.competition_id=m.competition_id
          AND division_settings.sport_code=c.sport_code
         WHERE m.id=$1 ${lock ? "FOR UPDATE OF m,settings" : ""}`,
        [matchId],
      ),
      "Match scoring settings not found",
    );
    const pack = SPORT_PACKS[row.sport_code];
    if (!pack) throw new ApiError(409, "SPORT_PACK_UNSUPPORTED", "The competition sport is not supported");
    if (!row.pack_version || (row.division_pack_version && row.division_pack_version !== row.pack_version)) {
      throw new ApiError(
        409,
        "SPORT_PACK_REFERENCE_INVALID",
        "Competition and division scoring settings must use the same authoritative sport pack",
      );
    }
    const settings = Object.freeze({
      ...pack.recommendedSettings,
      ...jsonValue<Record<string, unknown>>(row.recommended_snapshot),
      ...jsonValue<Record<string, unknown>>(row.competition_override),
      ...(row.division_override ? jsonValue<Record<string, unknown>>(row.division_override) : {}),
    }) as SportPackSettings;
    try {
      assertFiveSportScoreCommandAllowed(
        row.sport_code,
        {
          clientEventId: "00000000-0000-4000-8000-000000000000",
          type: "match_started",
          occurredAt: this.now().toISOString(),
        },
        settings,
      );
    } catch (error) {
      throw new ApiError(
        409,
        "SPORT_SETTINGS_INVALID",
        error instanceof Error ? error.message : "The effective sport settings are invalid",
      );
    }
    return {
      competition_id: row.competition_id,
      division_id: row.division_id,
      sport_code: row.sport_code,
      pack_version: row.pack_version,
      settings,
      settings_fingerprint: stableHash(settings),
    };
  }

  private async ensureCanonicalStream(
    tx: PostgresJsSql,
    matchId: string,
    context: CanonicalScoringContext,
  ): Promise<CanonicalScoringContext> {
    await tx.unsafe(
      `INSERT INTO match_score_streams (
         match_id,competition_id,division_id,sport_code,pack_version,
         settings_snapshot,settings_fingerprint,current_version,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,0,$8,$8)
       ON CONFLICT (match_id) DO NOTHING`,
      [
        matchId,
        context.competition_id,
        context.division_id,
        context.sport_code,
        context.pack_version,
        context.settings,
        context.settings_fingerprint,
        this.now(),
      ],
    );
    const stream = required(
      await tx.unsafe<{
        competition_id: string;
        division_id: string;
        sport_code: SportId;
        pack_version: string;
        settings_snapshot: SportPackSettings | string;
        settings_fingerprint: string;
      }>(
        `SELECT competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint
         FROM match_score_streams WHERE match_id=$1 FOR UPDATE`,
        [matchId],
      ),
      "Match score stream not found",
    );
    if (
      stream.competition_id !== context.competition_id ||
      stream.division_id !== context.division_id ||
      stream.sport_code !== context.sport_code ||
      stream.pack_version !== context.pack_version ||
      stream.settings_fingerprint !== stableHash(jsonValue(stream.settings_snapshot)) ||
      stream.settings_fingerprint !== context.settings_fingerprint
    ) {
      throw new ApiError(409, "SCORING_STREAM_CONTEXT_MISMATCH", "The match scoring stream context is invalid");
    }
    if (stream.pack_version !== SPORT_PACKS[stream.sport_code].version) {
      throw new ApiError(
        409,
        "SPORT_PACK_VERSION_UNSUPPORTED",
        `Score stream pack ${stream.pack_version} is not supported by reducer ${SPORT_PACKS[stream.sport_code].version}`,
      );
    }
    return {
      competition_id: stream.competition_id,
      division_id: stream.division_id,
      sport_code: stream.sport_code,
      pack_version: stream.pack_version,
      settings: jsonValue<SportPackSettings>(stream.settings_snapshot),
      settings_fingerprint: stream.settings_fingerprint,
    };
  }

  private async canonicalScoreEvents(tx: PostgresJsSql, matchId: string): Promise<FiveSportScoreEvent[]> {
    const rows = await tx.unsafe<CanonicalScoreEventRow>(
      `SELECT id,client_event_id,aggregate_version,sequence,command,actor_access_session_id,actor_account_id
       FROM canonical_score_events WHERE match_id=$1 ORDER BY aggregate_version`,
      [matchId],
    );
    return rows
      .flatMap((row) => {
        const command = parseFiveSportScoreCommand(jsonValue(row.command));
        if (!command || command.type === "legacy_correction") return [];
        const actorId = row.actor_access_session_id ?? row.actor_account_id;
        if (!actorId) throw new Error("Canonical score event actor is missing");
        return [{ row, command, actorId }];
      })
      .map(({ row, command, actorId }) =>
        materialiseFiveSportScoreEvent(command, {
          eventId: row.id,
          matchId,
          sequence: row.sequence,
          actorId,
          scoringSessionId: row.actor_access_session_id ?? actorId,
        }),
      );
  }

  private async canonicalScoreState(
    tx: PostgresJsSql,
    matchId: string,
    options: { readOnlyLegacyProjection?: boolean } = {},
  ): Promise<{
    context: CanonicalScoringContext;
    aggregateVersion: number;
    events: FiveSportScoreEvent[];
    state: FiveSportScoreState;
  }> {
    const stream = required(
      await tx.unsafe<{
        competition_id: string;
        division_id: string;
        sport_code: SportId;
        pack_version: string;
        settings_snapshot: SportPackSettings | string;
        settings_fingerprint: string;
        current_version: number;
      }>(
        `SELECT competition_id,division_id,sport_code,pack_version,settings_snapshot,
                settings_fingerprint,current_version
         FROM match_score_streams WHERE match_id=$1`,
        [matchId],
      ),
      "Match score stream not found",
    );
    const settings = jsonValue<SportPackSettings>(stream.settings_snapshot);
    if (stableHash(settings) !== stream.settings_fingerprint) {
      throw new ApiError(409, "SCORING_STREAM_CONTEXT_MISMATCH", "The score stream settings fingerprint is invalid");
    }
    if (stream.pack_version !== SPORT_PACKS[stream.sport_code].version) {
      throw new ApiError(
        409,
        "SPORT_PACK_VERSION_UNSUPPORTED",
        `Score stream pack ${stream.pack_version} is not supported by reducer ${SPORT_PACKS[stream.sport_code].version}`,
      );
    }
    const events = await this.canonicalScoreEvents(tx, matchId);
    const hasLegacyCorrection = Boolean(
      (
        await tx.unsafe<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM canonical_score_events
             WHERE match_id=$1 AND event_type='legacy_correction'
           ) AS present`,
          [matchId],
        )
      )[0]?.present,
    );
    if (hasLegacyCorrection && !options.readOnlyLegacyProjection) {
      throw new ApiError(
        409,
        "LEGACY_CORRECTION_REQUIRES_REVIEW",
        "This historical corrected result is readable but must be reviewed before canonical scoring can continue",
      );
    }
    let state: FiveSportScoreState;
    try {
      state = reduceFiveSportScoreEvents(stream.sport_code, events, settings);
      if (hasLegacyCorrection) {
        const legacy = required(
          await tx.unsafe<{ home_score: number; away_score: number }>(
            `SELECT home_score,away_score FROM match_result_snapshots
             WHERE match_id=$1 ORDER BY result_version DESC LIMIT 1`,
            [matchId],
          ),
          "Historical corrected result projection not found",
        );
        state = {
          ...state,
          lifecycle: "finalised",
          currentSegment: 1,
          winner:
            legacy.home_score === legacy.away_score ? null : legacy.home_score > legacy.away_score ? "home" : "away",
          exceptionalOutcome: null,
          score: { home: legacy.home_score, away: legacy.away_score },
          totalPoints: { home: legacy.home_score, away: legacy.away_score },
          segmentWins: { home: 0, away: 0 },
          segments: [
            {
              number: 1,
              home: legacy.home_score,
              away: legacy.away_score,
              completed: true,
              winner:
                legacy.home_score === legacy.away_score
                  ? null
                  : legacy.home_score > legacy.away_score
                    ? "home"
                    : "away",
              completionEventId: null,
            },
          ],
          actions: [],
          conflicts: [],
        };
      }
    } catch (error) {
      throw new ApiError(
        409,
        "SCORING_STREAM_INVALID",
        error instanceof Error ? error.message : "The score stream is invalid",
      );
    }
    return {
      context: {
        competition_id: stream.competition_id,
        division_id: stream.division_id,
        sport_code: stream.sport_code,
        pack_version: stream.pack_version,
        settings,
        settings_fingerprint: stream.settings_fingerprint,
      },
      aggregateVersion: stream.current_version,
      events,
      state,
    };
  }

  async appendCanonicalScoreEvent(
    auth: ScoringSessionAuth,
    rawCommand: unknown,
    expectedAggregateVersion: number,
    requestId: string,
  ) {
    const command = parseFiveSportScoreCommand(rawCommand);
    if (!command) throw new ApiError(422, "SCORE_EVENT_INVALID", "Score event command is invalid");
    try {
      return await this.transaction(async (tx) => {
        let session = await this.authenticateScoringSession(
          tx,
          auth.sessionId,
          auth.sessionToken,
          auth.generation,
          true,
          false,
        );
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [session.match_id]);
        session = await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation);
        const permission: ScoringPermission = command.type === "reversal" ? "score:reverse" : "score:write";
        if (!jsonValue<ScoringPermission[]>(session.scope).includes(permission)) {
          throw new ApiError(403, "SCORING_PERMISSION_DENIED", "Scoring session lacks the required permission");
        }
        if (command.type === "match_reopened" || command.type === "finalisation") {
          throw new ApiError(
            command.type === "match_reopened" ? 403 : 422,
            command.type === "match_reopened" ? "ORGANISER_PERMISSION_REQUIRED" : "FINALISATION_ENDPOINT_REQUIRED",
            command.type === "match_reopened" ? "Reopening is organiser-only" : "Use the result finalisation endpoint",
          );
        }
        const currentContext = await this.canonicalScoringContext(tx, session.match_id, true);
        const context = await this.ensureCanonicalStream(tx, session.match_id, currentContext);
        const legacyCorrection = (
          await tx.unsafe<{ present: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM canonical_score_events
               WHERE match_id=$1 AND event_type='legacy_correction'
             ) AS present`,
            [session.match_id],
          )
        )[0]?.present;
        if (legacyCorrection) {
          throw new ApiError(
            409,
            "LEGACY_CORRECTION_REQUIRES_REVIEW",
            "This historical corrected result is readable but cannot accept canonical score events",
          );
        }
        assertFiveSportScoreCommandAllowed(context.sport_code, command, context.settings);
        const fingerprint = stableHash(wireScoreCommand(command));
        const duplicate = (
          await tx.unsafe<{ id: string; aggregate_version: number; command_fingerprint: string }>(
            `SELECT id,aggregate_version,command_fingerprint FROM canonical_score_events
             WHERE match_id=$1 AND client_event_id=$2`,
            [session.match_id, command.clientEventId],
          )
        )[0];
        if (duplicate) {
          if (duplicate.command_fingerprint !== fingerprint) {
            throw new ApiError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "Client event ID was reused with different score-event content",
            );
          }
          return {
            duplicate: true as const,
            event_id: duplicate.id,
            sequence: duplicate.aggregate_version,
            aggregate_version: duplicate.aggregate_version,
          };
        }
        const match = required(
          await tx.unsafe<{ state: string }>(`SELECT state FROM matches WHERE id=$1 FOR UPDATE`, [session.match_id]),
          "Match not found",
        );
        if (match.state === "final" || match.state === "corrected") {
          throw new ApiError(409, "MATCH_FINALISED_READ_ONLY", "Finalised matches require organiser reopening");
        }
        const existing = await this.canonicalScoreEvents(tx, session.match_id);
        const stream = required(
          await tx.unsafe<{ current_version: number }>(
            `SELECT current_version FROM match_score_streams WHERE match_id=$1 FOR UPDATE`,
            [session.match_id],
          ),
          "Match score stream not found",
        );
        if (stream.current_version !== expectedAggregateVersion) {
          throw new ApiError(
            409,
            "SCORE_VERSION_CONFLICT",
            `Expected aggregate version ${expectedAggregateVersion}, current version is ${stream.current_version}`,
          );
        }
        const sequence = stream.current_version + 1;
        const eventId = randomUUID();
        const event = materialiseFiveSportScoreEvent(command, {
          eventId,
          matchId: session.match_id,
          sequence: existing.length + 1,
          actorId: session.id,
          scoringSessionId: session.id,
        });
        try {
          reduceFiveSportScoreEvents(context.sport_code, [...existing, event], context.settings);
        } catch (error) {
          throw new ApiError(
            422,
            "SCORE_EVENT_REJECTED",
            error instanceof Error ? error.message : "Score event is invalid",
          );
        }
        const writerGeneration = session.generation;
        if (!writerGeneration) {
          throw new ApiError(409, "STALE_WRITER_GENERATION", "This session does not hold the active writer lease");
        }
        await tx.unsafe(
          `INSERT INTO canonical_score_events (
             id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
             command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp,
             reversal_target_event_id,reason
           ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
          [
            eventId,
            context.competition_id,
            context.division_id,
            session.match_id,
            command.clientEventId,
            sequence,
            command.type,
            wireScoreCommand(command),
            fingerprint,
            session.id,
            writerGeneration,
            command.occurredAt,
            command.reversalTargetEventId ?? null,
            command.reason ?? null,
          ],
        );
        await tx.unsafe(`UPDATE match_score_streams SET current_version=$2,updated_at=$3 WHERE match_id=$1`, [
          session.match_id,
          sequence,
          this.now(),
        ]);
        await tx.unsafe(
          `UPDATE competition_sport_settings SET locked_at=COALESCE(locked_at,$2) WHERE competition_id=$1`,
          [context.competition_id, this.now()],
        );
        if (command.type === "match_started") {
          await tx.unsafe(`UPDATE matches SET state='in_progress' WHERE id=$1 AND state IN ('pending','ready')`, [
            session.match_id,
          ]);
        }
        await this.evidence(tx, {
          requestId,
          actorAccountId: null,
          actorType: "access_pass",
          organisationId: session.organisation_id,
          action: "scoring_event.appended",
          targetType: "match",
          targetId: session.match_id,
          after: { event_id: eventId, event_type: command.type, aggregate_version: sequence },
          eventPayload: {
            competition_id: context.competition_id,
            match_id: session.match_id,
            aggregate_version: sequence,
            event_type: command.type,
          },
        });
        return { duplicate: false as const, event_id: eventId, sequence, aggregate_version: sequence };
      });
    } catch (error) {
      if (isScoreWriterSessionGuardViolation(error)) {
        await this.recordStaleScoreSubmission(auth, command, requestId);
        throw new ApiError(409, "STALE_WRITER_GENERATION", "This session does not hold the active writer lease");
      }
      if (error instanceof ApiError && error.code === "STALE_WRITER_GENERATION") {
        await this.recordStaleScoreSubmission(auth, command, requestId);
      }
      throw error;
    }
  }

  async transferWriter(auth: ScoringSessionAuth, requestId: string) {
    void requestId;
    return this.transaction(async (tx) => {
      await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation, false);
      throw new ApiError(
        403,
        "SELF_TRANSFER_FORBIDDEN",
        "A writer cannot transfer itself. A candidate must request organiser approval.",
      );
    });
  }

  async heartbeatScoringSession(
    auth: ScoringSessionAuth,
    input: {
      lastAcknowledgedSequence: number;
      pendingEventCount: number;
      pendingThroughSequence: number;
    },
    requestId: string,
  ) {
    try {
      return await this.transaction(async (tx) => {
        let session = await this.authenticateScoringSession(
          tx,
          auth.sessionId,
          auth.sessionToken,
          auth.generation,
          false,
          false,
        );
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [session.match_id]);
        session = await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation, false);
        const now = this.now();
        const renewedSessionExpiry = new Date(
          Math.min(date(session.pass_expires_at).getTime(), now.getTime() + 30 * 60_000),
        );
        await tx.unsafe(
          `UPDATE scoring_access_sessions SET
           last_heartbeat_at=$2,last_acknowledged_sequence=$3,reported_pending_event_count=$4,
           reported_pending_through_sequence=$5,expires_at=$6
         WHERE id=$1`,
          [
            session.id,
            now,
            input.lastAcknowledgedSequence,
            input.pendingEventCount,
            input.pendingThroughSequence,
            renewedSessionExpiry,
          ],
        );
        let leaseExpiresAt: Date | null = null;
        if (session.mode === "writer") {
          if (auth.generation == null || session.generation !== auth.generation) {
            throw new ApiError(409, "STALE_WRITER_GENERATION", "This session does not hold the active writer lease");
          }
          leaseExpiresAt = new Date(Math.min(renewedSessionExpiry.getTime(), now.getTime() + 45_000));
          const lease = await tx.unsafe<{ match_id: string }>(
            `UPDATE match_writer_leases SET expires_at=$4
           WHERE match_id=$1 AND access_session_id=$2 AND generation=$3 AND expires_at>$5
           RETURNING match_id`,
            [session.match_id, session.id, auth.generation, leaseExpiresAt, now],
          );
          if (!lease[0]) {
            throw new ApiError(409, "STALE_WRITER_GENERATION", "This session does not hold the active writer lease");
          }
        }
        await this.evidence(tx, {
          requestId,
          actorAccountId: null,
          actorType: "access_pass",
          organisationId: session.organisation_id,
          action: "scoring_session.heartbeat",
          targetType: "scoring_session",
          targetId: session.id,
          after: {
            mode: session.mode,
            pending_event_count: input.pendingEventCount,
            last_acknowledged_sequence: input.lastAcknowledgedSequence,
          },
          eventPayload: { competition_id: session.competition_id, match_id: session.match_id, mode: session.mode },
        });
        return {
          mode: session.mode,
          generation: session.generation,
          session_expires_at: renewedSessionExpiry.toISOString(),
          lease_expires_at: leaseExpiresAt?.toISOString() ?? null,
          read_only: session.mode !== "writer",
        };
      });
    } catch (error) {
      if (error instanceof ApiError && ["SCORING_SESSION_EXPIRED", "STALE_WRITER_GENERATION"].includes(error.code)) {
        await this.recordScoringSessionDenial(auth, requestId, "scoring_session.heartbeat_denied", error.code);
      }
      throw error;
    }
  }

  async requestTakeover(
    auth: ScoringSessionAuth,
    input: { pendingEventCount: number; pendingThroughSequence: number },
    requestId: string,
  ) {
    try {
      return await this.transaction(async (tx) => {
        let candidate = await this.authenticateScoringSession(
          tx,
          auth.sessionId,
          auth.sessionToken,
          auth.generation,
          false,
          false,
        );
        if (candidate.mode !== "candidate") {
          throw new ApiError(409, "TAKEOVER_CANDIDATE_REQUIRED", "Only a read-only candidate may request takeover");
        }
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [candidate.match_id]);
        candidate = await this.authenticateScoringSession(
          tx,
          auth.sessionId,
          auth.sessionToken,
          auth.generation,
          false,
        );
        if (candidate.mode !== "candidate") {
          throw new ApiError(409, "TAKEOVER_CANDIDATE_REQUIRED", "Only a read-only candidate may request takeover");
        }
        const match = required(
          await tx.unsafe<{ state: string }>(`SELECT state FROM matches WHERE id=$1 FOR UPDATE`, [candidate.match_id]),
          "Match not found",
        );
        if (match.state === "final" || match.state === "corrected") {
          throw new ApiError(409, "MATCH_FINALISED_READ_ONLY", "Finalised matches require organiser reopening");
        }
        const lease = required(
          await tx.unsafe<{ access_session_id: string }>(
            `SELECT access_session_id FROM match_writer_leases
           WHERE match_id=$1 AND expires_at>$2 FOR UPDATE`,
            [candidate.match_id, this.now()],
          ),
          "Active writer lease not found",
        );
        const incumbent = required(
          await tx.unsafe<{
            last_heartbeat_at: Date | string | null;
            reported_pending_event_count: number;
          }>(
            `SELECT last_heartbeat_at,reported_pending_event_count
           FROM scoring_access_sessions WHERE id=$1 FOR UPDATE`,
            [lease.access_session_id],
          ),
          "Incumbent scoring session not found",
        );
        const heartbeatRecent =
          incumbent.last_heartbeat_at && date(incumbent.last_heartbeat_at).getTime() >= this.now().getTime() - 30_000;
        const incumbentPendingState = !heartbeatRecent
          ? "unknown"
          : incumbent.reported_pending_event_count > 0
            ? "present"
            : "none";
        await tx.unsafe(
          `UPDATE scoring_access_sessions SET
           last_heartbeat_at=$2,reported_pending_event_count=$3,reported_pending_through_sequence=$4
         WHERE id=$1`,
          [candidate.id, this.now(), input.pendingEventCount, input.pendingThroughSequence],
        );
        const expiredRequests = await tx.unsafe<{ id: string }>(
          `UPDATE scoring_takeover_requests SET
           status='expired',resolved_at=$3,resolution_reason='Takeover request expired before review'
         WHERE match_id=$1 AND requesting_session_id=$2 AND status='pending' AND expires_at<=$3
         RETURNING id`,
          [candidate.match_id, candidate.id, this.now()],
        );
        for (const expired of expiredRequests) {
          await this.evidence(tx, {
            requestId: `${requestId}:expired:${expired.id}`,
            actorAccountId: null,
            actorType: "access_pass",
            organisationId: candidate.organisation_id,
            action: "scoring_takeover.expired",
            targetType: "scoring_takeover_request",
            targetId: expired.id,
            reason: "Takeover request expired before review",
            eventPayload: { competition_id: candidate.competition_id, match_id: candidate.match_id },
          });
        }
        const insertedTakeover = await tx.unsafe<{ id: string; requested_at: Date | string }>(
          `INSERT INTO scoring_takeover_requests (
             competition_id,match_id,requesting_session_id,incumbent_session_id,status,
             requester_pending_event_count,incumbent_pending_state,requested_at,expires_at
           ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8)
           ON CONFLICT (match_id,requesting_session_id) WHERE status='pending'
           DO NOTHING
           RETURNING id,requested_at`,
          [
            candidate.competition_id,
            candidate.match_id,
            candidate.id,
            lease.access_session_id,
            input.pendingEventCount,
            incumbentPendingState,
            this.now(),
            new Date(Math.min(date(candidate.expires_at).getTime(), this.now().getTime() + this.takeoverRequestTtlMs)),
          ],
        );
        const takeover =
          insertedTakeover[0] ??
          required(
            await tx.unsafe<{ id: string; requested_at: Date | string }>(
              `SELECT id,requested_at FROM scoring_takeover_requests
             WHERE match_id=$1 AND requesting_session_id=$2 AND status='pending'`,
              [candidate.match_id, candidate.id],
            ),
            "Takeover request was not created",
          );
        if (insertedTakeover[0]) {
          await this.evidence(tx, {
            requestId,
            actorAccountId: null,
            actorType: "access_pass",
            organisationId: candidate.organisation_id,
            action: "scoring_takeover.requested",
            targetType: "scoring_takeover_request",
            targetId: takeover.id,
            after: { match_id: candidate.match_id, incumbent_pending_state: incumbentPendingState },
            eventPayload: { competition_id: candidate.competition_id, match_id: candidate.match_id },
          });
        }
        return {
          id: takeover.id,
          status: "pending" as const,
          incumbent_pending_state: incumbentPendingState,
          requested_at: serializedDate(takeover.requested_at),
          duplicate: !insertedTakeover[0],
        };
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "MATCH_FINALISED_READ_ONLY") {
        await this.recordScoringSessionDenial(auth, requestId, "scoring_takeover.request_denied", error.code);
      }
      throw error;
    }
  }

  async listTakeoverRequests(actor: Phase2Actor, competitionId: string) {
    await this.requireCompetitionAccess(this.sql, competitionId, actor);
    return this.sql.unsafe<Record<string, unknown>>(
      `SELECT tr.id,tr.match_id,tr.requesting_session_id,tr.incumbent_session_id,
              CASE WHEN tr.status='pending' AND tr.expires_at<=$2 THEN 'expired' ELSE tr.status END AS status,
              tr.requester_pending_event_count,tr.incumbent_pending_state,tr.requested_at,tr.expires_at,
              tr.resolved_at,tr.resolution_reason,tr.override_acknowledged,
              candidate.device_label AS requesting_device_label,
              incumbent.device_label AS incumbent_device_label
       FROM scoring_takeover_requests tr
       JOIN scoring_access_sessions candidate ON candidate.id=tr.requesting_session_id
       JOIN scoring_access_sessions incumbent ON incumbent.id=tr.incumbent_session_id
       WHERE tr.competition_id=$1 ORDER BY tr.requested_at DESC`,
      [competitionId, this.now()],
    );
  }

  async expireTakeoverRequests(actor: Phase2Actor, competitionId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const expiredMatches = await tx.unsafe<{ match_id: string }>(
        `SELECT DISTINCT match_id FROM scoring_takeover_requests
         WHERE competition_id=$1 AND status='pending' AND expires_at<=$2
         ORDER BY match_id`,
        [competitionId, this.now()],
      );
      let expiredCount = 0;
      for (const { match_id: matchId } of expiredMatches) {
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [matchId]);
        const expired = await tx.unsafe<{ id: string }>(
          `UPDATE scoring_takeover_requests SET
             status='expired',resolved_at=$3,resolution_reason='Takeover request expired before review'
           WHERE competition_id=$1 AND match_id=$2 AND status='pending' AND expires_at<=$3
           RETURNING id`,
          [competitionId, matchId, this.now()],
        );
        expiredCount += expired.length;
        for (const takeover of expired) {
          await this.evidence(tx, {
            requestId: `${requestId}:${takeover.id}`,
            actorAccountId: actor.accountId,
            organisationId: competition.organisation_id,
            action: "scoring_takeover.expired",
            targetType: "scoring_takeover_request",
            targetId: takeover.id,
            reason: "Takeover request expired before review",
            eventPayload: { competition_id: competitionId, match_id: matchId },
          });
        }
      }
      return { expired_count: expiredCount };
    });
  }

  async resolveTakeover(
    actor: Phase2Actor,
    competitionId: string,
    takeoverId: string,
    input: { decision: "approve" | "deny"; overrideAcknowledged: boolean; reason: string },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const discoveredTakeover = required(
        await tx.unsafe<{ id: string; match_id: string }>(
          `SELECT id,match_id FROM scoring_takeover_requests
           WHERE id=$1 AND competition_id=$2`,
          [takeoverId, competitionId],
        ),
        "Takeover request not found",
      );
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [discoveredTakeover.match_id]);
      const takeover = required(
        await tx.unsafe<{
          id: string;
          match_id: string;
          requesting_session_id: string;
          incumbent_session_id: string;
          status: string;
          requester_pending_event_count: number;
          incumbent_pending_state: "unknown" | "none" | "present";
          expires_at: Date | string;
        }>(
          `SELECT id,match_id,requesting_session_id,incumbent_session_id,status,
                  requester_pending_event_count,incumbent_pending_state,expires_at
           FROM scoring_takeover_requests
           WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
          [takeoverId, competitionId],
        ),
        "Takeover request not found",
      );
      if (takeover.status !== "pending") {
        throw new ApiError(409, "TAKEOVER_ALREADY_RESOLVED", "Takeover request is no longer pending");
      }
      if (date(takeover.expires_at).getTime() <= this.now().getTime()) {
        const expiredAt = this.now();
        await tx.unsafe(
          `UPDATE scoring_takeover_requests SET
             status='expired',resolved_at=$2,resolution_reason='Takeover request expired before review'
           WHERE id=$1`,
          [takeover.id, expiredAt],
        );
        await this.evidence(tx, {
          requestId,
          actorAccountId: actor.accountId,
          organisationId: competition.organisation_id,
          action: "scoring_takeover.expired",
          targetType: "scoring_takeover_request",
          targetId: takeover.id,
          reason: "Takeover request expired before review",
          eventPayload: { competition_id: competitionId, match_id: takeover.match_id },
        });
        return { id: takeover.id, status: "expired" as const };
      }
      if (input.reason.trim().length < 3) {
        throw new ApiError(422, "TAKEOVER_REASON_REQUIRED", "A takeover decision requires a reason");
      }
      if (input.decision === "deny") {
        await tx.unsafe(
          `UPDATE scoring_takeover_requests SET
             status='denied',resolved_at=$2,resolved_by_account_id=$3,resolution_reason=$4
           WHERE id=$1`,
          [takeover.id, this.now(), actor.accountId, input.reason.trim()],
        );
        await this.evidence(tx, {
          requestId,
          actorAccountId: actor.accountId,
          organisationId: competition.organisation_id,
          action: "scoring_takeover.denied",
          targetType: "scoring_takeover_request",
          targetId: takeover.id,
          reason: input.reason.trim(),
          eventPayload: { competition_id: competitionId, match_id: takeover.match_id },
        });
        return { id: takeover.id, status: "denied" as const };
      }
      const match = required(
        await tx.unsafe<{ state: string }>(`SELECT state FROM matches WHERE id=$1 FOR UPDATE`, [takeover.match_id]),
        "Match not found",
      );
      if (match.state === "final" || match.state === "corrected") {
        const expiredAt = this.now();
        await tx.unsafe(
          `UPDATE scoring_takeover_requests SET
             status='expired',resolved_at=$2,
             resolution_reason='Match finalised before takeover approval'
           WHERE id=$1`,
          [takeover.id, expiredAt],
        );
        await this.evidence(tx, {
          requestId,
          actorAccountId: actor.accountId,
          organisationId: competition.organisation_id,
          action: "scoring_takeover.expired",
          targetType: "scoring_takeover_request",
          targetId: takeover.id,
          reason: "Match finalised before takeover approval",
          eventPayload: { competition_id: competitionId, match_id: takeover.match_id },
        });
        return { id: takeover.id, status: "expired" as const };
      }
      const lease = required(
        await tx.unsafe<{ generation: number; access_session_id: string; expires_at: Date | string }>(
          `SELECT generation,access_session_id,expires_at
           FROM match_writer_leases WHERE match_id=$1 FOR UPDATE`,
          [takeover.match_id],
        ),
        "Writer lease not found",
      );
      if (lease.access_session_id !== takeover.incumbent_session_id) {
        throw new ApiError(409, "TAKEOVER_STALE", "The active writer changed before approval");
      }
      const now = this.now();
      if (date(lease.expires_at).getTime() <= now.getTime()) {
        throw new ApiError(409, "TAKEOVER_STALE", "The incumbent writer lease expired before approval");
      }
      const candidate = required(
        await tx.unsafe<{
          expires_at: Date | string;
          revoked_at: Date | string | null;
          mode: ScoringSessionMode;
          pass_expires_at: Date | string;
          pass_revoked_at: Date | string | null;
          role: "scorekeeper" | "viewer";
          scope: ScoringPermission[] | string;
        }>(
          `SELECT s.expires_at,s.revoked_at,s.mode,p.expires_at AS pass_expires_at,
                  p.revoked_at AS pass_revoked_at,p.role,p.scope
           FROM scoring_access_sessions s
           JOIN scoring_access_passes p ON p.id=s.access_pass_id
           WHERE s.id=$1 AND s.competition_id=$2 AND s.match_id=$3
           FOR UPDATE OF s,p`,
          [takeover.requesting_session_id, competitionId, takeover.match_id],
        ),
        "Candidate scoring session not found",
      );
      const candidatePermissions = jsonValue<ScoringPermission[]>(candidate.scope);
      if (
        candidate.mode !== "candidate" ||
        candidate.revoked_at ||
        candidate.pass_revoked_at ||
        date(candidate.expires_at).getTime() <= now.getTime() ||
        date(candidate.pass_expires_at).getTime() <= now.getTime() ||
        candidate.role !== "scorekeeper" ||
        !candidatePermissions.includes("score:write")
      ) {
        throw new ApiError(409, "TAKEOVER_CANDIDATE_INACTIVE", "Candidate scoring session is no longer eligible");
      }
      const incumbent = required(
        await tx.unsafe<{
          last_heartbeat_at: Date | string | null;
          reported_pending_event_count: number;
          reported_pending_through_sequence: number;
        }>(
          `SELECT last_heartbeat_at,reported_pending_event_count,reported_pending_through_sequence
           FROM scoring_access_sessions
           WHERE id=$1 AND competition_id=$2 AND match_id=$3 FOR UPDATE`,
          [takeover.incumbent_session_id, competitionId, takeover.match_id],
        ),
        "Incumbent scoring session not found",
      );
      const heartbeatRecent =
        incumbent.last_heartbeat_at && date(incumbent.last_heartbeat_at).getTime() >= now.getTime() - 30_000;
      const authoritativePendingState: "unknown" | "none" | "present" = !heartbeatRecent
        ? "unknown"
        : incumbent.reported_pending_event_count > 0
          ? "present"
          : "none";
      if (authoritativePendingState !== "none" && !input.overrideAcknowledged) {
        throw new ApiError(
          409,
          "TAKEOVER_OVERRIDE_ACKNOWLEDGEMENT_REQUIRED",
          "Current pending or unknown incumbent state requires explicit organiser acknowledgement",
        );
      }
      const generation = lease.generation + 1;
      const leaseExpiresAt = new Date(Math.min(date(candidate.expires_at).getTime(), now.getTime() + 45_000));
      await tx.unsafe(
        `UPDATE scoring_access_sessions SET mode='transferred',transferred_to_session_id=$2 WHERE id=$1`,
        [takeover.incumbent_session_id, takeover.requesting_session_id],
      );
      await tx.unsafe(
        `UPDATE scoring_access_sessions SET mode='writer',generation=$2,last_heartbeat_at=$3 WHERE id=$1`,
        [takeover.requesting_session_id, generation, now],
      );
      await tx.unsafe(
        `UPDATE match_writer_leases SET
           access_session_id=$2,generation=$3,acquired_at=$4,expires_at=$5
         WHERE match_id=$1`,
        [takeover.match_id, takeover.requesting_session_id, generation, now, leaseExpiresAt],
      );
      await tx.unsafe(
        `UPDATE scoring_takeover_requests SET
           status='approved',resolved_at=$2,resolved_by_account_id=$3,resolution_reason=$4,
           override_acknowledged=$5
         WHERE id=$1`,
        [takeover.id, now, actor.accountId, input.reason.trim(), input.overrideAcknowledged],
      );
      let conflictId: string | null = null;
      if (authoritativePendingState !== "none") {
        const conflict = required(
          await tx.unsafe<{ id: string }>(
            `INSERT INTO scoring_transfer_conflicts (
               competition_id,match_id,takeover_request_id,stale_session_id,replacement_session_id,
               stale_generation,pending_event_count,pending_through_sequence,status,created_at
             )
             SELECT $1,$2,$3,$4,$5,$6,reported_pending_event_count,
                    reported_pending_through_sequence,'open',$7
             FROM scoring_access_sessions WHERE id=$4 RETURNING id`,
            [
              competitionId,
              takeover.match_id,
              takeover.id,
              takeover.incumbent_session_id,
              takeover.requesting_session_id,
              lease.generation,
              now,
            ],
          ),
          "Transfer conflict was not created",
        );
        conflictId = conflict.id;
      }
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "scoring_takeover.approved",
        targetType: "scoring_takeover_request",
        targetId: takeover.id,
        reason: input.reason.trim(),
        after: {
          generation,
          conflict_id: conflictId,
          requested_incumbent_pending_state: takeover.incumbent_pending_state,
          authoritative_incumbent_pending_state: authoritativePendingState,
        },
        eventPayload: { competition_id: competitionId, match_id: takeover.match_id, generation },
      });
      return {
        id: takeover.id,
        status: "approved" as const,
        generation,
        lease_expires_at: leaseExpiresAt.toISOString(),
        conflict_id: conflictId,
      };
    });
  }

  async finalise(
    auth: ScoringSessionAuth,
    clientEventId: string,
    requestId: string,
    expectedAggregateVersion?: number,
  ) {
    const stream = await this.sql.unsafe<{ match_id: string }>(
      `SELECT stream.match_id
       FROM scoring_access_sessions session
       JOIN match_score_streams stream ON stream.match_id=session.match_id
       WHERE session.id=$1`,
      [auth.sessionId],
    );
    if (!stream[0]) {
      throw new ApiError(
        409,
        "CANONICAL_SCORE_STREAM_REQUIRED",
        "Finalisation requires a canonical five-sport score stream",
      );
    }
    return this.finaliseCanonical(auth, clientEventId, requestId, expectedAggregateVersion);
  }

  private async finaliseCanonical(
    auth: ScoringSessionAuth,
    clientEventId: string,
    requestId: string,
    expectedAggregateVersion?: number,
  ) {
    try {
      return await this.transaction(async (tx) => {
        let session = await this.authenticateScoringSession(
          tx,
          auth.sessionId,
          auth.sessionToken,
          auth.generation,
          true,
          false,
        );
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [session.match_id]);
        session = await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation);
        if (!jsonValue<ScoringPermission[]>(session.scope).includes("score:finalise")) {
          throw new ApiError(403, "SCORING_PERMISSION_DENIED", "Scoring session cannot finalise this match");
        }
        const finalisationFingerprint = stableHash({
          client_event_id: clientEventId,
          type: "finalisation",
          expected_aggregate_version: expectedAggregateVersion ?? null,
        });
        const duplicate = (
          await tx.unsafe<{
            id: string;
            aggregate_version: number;
            event_type: string;
            command_fingerprint: string;
          }>(
            `SELECT id,aggregate_version,event_type,command_fingerprint FROM canonical_score_events
             WHERE match_id=$1 AND client_event_id=$2`,
            [session.match_id, clientEventId],
          )
        )[0];
        if (duplicate) {
          if (duplicate.event_type !== "finalisation" || duplicate.command_fingerprint !== finalisationFingerprint) {
            throw new ApiError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "Finalisation client event ID is already used by another score event",
            );
          }
          const original = await this.matchResultAtSequence(tx, session.match_id, duplicate.aggregate_version);
          if (!original) throw new ApiError(409, "RESULT_RECEIPT_MISSING", "Finalisation receipt is unavailable");
          return {
            match_id: session.match_id,
            sequence: duplicate.aggregate_version,
            aggregate_version: duplicate.aggregate_version,
            duplicate: true as const,
            home_score: original.home_score,
            away_score: original.away_score,
            result_version: original.result_version,
          };
        }
        const match = required(
          await tx.unsafe<{ state: string }>(`SELECT state FROM matches WHERE id=$1 FOR UPDATE`, [session.match_id]),
          "Match not found",
        );
        if (match.state === "final" || match.state === "corrected") {
          throw new ApiError(409, "MATCH_FINALISED_READ_ONLY", "Finalised matches require organiser reopening");
        }
        const canonical = await this.canonicalScoreState(tx, session.match_id);
        if (expectedAggregateVersion !== undefined && canonical.aggregateVersion !== expectedAggregateVersion) {
          throw new ApiError(
            409,
            "SCORE_VERSION_CONFLICT",
            `Expected aggregate version ${expectedAggregateVersion}, current version is ${canonical.aggregateVersion}`,
          );
        }
        const command: FiveSportScoreCommand = {
          clientEventId,
          type: "finalisation",
          occurredAt: this.now().toISOString(),
        };
        const eventId = randomUUID();
        const event = materialiseFiveSportScoreEvent(command, {
          eventId,
          matchId: session.match_id,
          sequence: canonical.events.length + 1,
          actorId: session.id,
          scoringSessionId: session.id,
        });
        let state: FiveSportScoreState;
        try {
          state = reduceFiveSportScoreEvents(
            canonical.context.sport_code,
            [...canonical.events, event],
            canonical.context.settings,
          );
        } catch (error) {
          throw new ApiError(
            422,
            "FINALISATION_INVALID",
            error instanceof Error ? error.message : "Finalisation is invalid",
          );
        }
        const aggregateVersion = canonical.aggregateVersion + 1;
        const generation = session.generation;
        if (!generation) throw new ApiError(409, "STALE_WRITER_GENERATION", "Writer lease is not active");
        await tx.unsafe(
          `INSERT INTO canonical_score_events (
             id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
             command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
           ) VALUES ($1,$2,$3,$4,$5,$6,$6,'finalisation',$7::jsonb,$8,$9,$10,$11)`,
          [
            eventId,
            canonical.context.competition_id,
            canonical.context.division_id,
            session.match_id,
            clientEventId,
            aggregateVersion,
            wireScoreCommand(command),
            finalisationFingerprint,
            session.id,
            generation,
            command.occurredAt,
          ],
        );
        await tx.unsafe(`UPDATE match_score_streams SET current_version=$2,updated_at=$3 WHERE match_id=$1`, [
          session.match_id,
          aggregateVersion,
          this.now(),
        ]);
        const result = await this.persistResultPublication(tx, {
          matchId: session.match_id,
          divisionId: canonical.context.division_id,
          organisationId: session.organisation_id,
          requestId,
          actorAccountId: null,
          actorType: "access_pass",
          action: "result.finalised",
          reason: null,
          canonical: {
            state,
            settings: canonical.context.settings,
            throughAggregateVersion: aggregateVersion,
            resultState: "final",
          },
        });
        const expiredTakeovers = await tx.unsafe<{ id: string }>(
          `UPDATE scoring_takeover_requests SET
             status='expired',resolved_at=$2,resolution_reason='Match finalised before takeover approval'
           WHERE match_id=$1 AND status='pending'
           RETURNING id`,
          [session.match_id, this.now()],
        );
        for (const takeover of expiredTakeovers) {
          await this.evidence(tx, {
            requestId: `${requestId}:takeover:${takeover.id}`,
            actorAccountId: null,
            actorType: "access_pass",
            organisationId: session.organisation_id,
            action: "scoring_takeover.expired",
            targetType: "scoring_takeover_request",
            targetId: takeover.id,
            reason: "Match finalised before takeover approval",
            eventPayload: { competition_id: session.competition_id, match_id: session.match_id },
          });
        }
        return {
          duplicate: false as const,
          sequence: aggregateVersion,
          aggregate_version: aggregateVersion,
          ...result,
        };
      });
    } catch (error) {
      if (isScoreWriterSessionGuardViolation(error)) {
        await this.recordScoringSessionDenial(
          auth,
          requestId,
          "scoring_result.finalise_denied",
          "STALE_WRITER_GENERATION",
        );
        throw new ApiError(409, "STALE_WRITER_GENERATION", "This session does not hold the active writer lease");
      }
      if (error instanceof ApiError && ["STALE_WRITER_GENERATION", "MATCH_FINALISED_READ_ONLY"].includes(error.code)) {
        await this.recordScoringSessionDenial(auth, requestId, "scoring_result.finalise_denied", error.code);
      }
      throw error;
    }
  }

  async reopenCanonicalMatch(
    actor: Phase2Actor,
    competitionId: string,
    matchId: string,
    input: { clientEventId: string; reason: string; expectedAggregateVersion: number },
    requestId: string,
  ) {
    if (input.reason.trim().length < 3) {
      throw new ApiError(422, "REOPEN_REASON_REQUIRED", "Reopening a match requires a reason");
    }
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [matchId]);
      const match = required(
        await tx.unsafe<{ state: string }>(`SELECT state FROM matches WHERE id=$1 AND competition_id=$2 FOR UPDATE`, [
          matchId,
          competitionId,
        ]),
        "Match not found",
      );
      const canonical = await this.canonicalScoreState(tx, matchId);
      const command: FiveSportScoreCommand = {
        clientEventId: input.clientEventId,
        type: "match_reopened",
        occurredAt: this.now().toISOString(),
        reason: input.reason.trim(),
      };
      const fingerprint = stableHash({
        client_event_id: input.clientEventId,
        type: "match_reopened",
        reason: input.reason.trim(),
        expected_aggregate_version: input.expectedAggregateVersion,
      });
      const duplicate = (
        await tx.unsafe<{ id: string; aggregate_version: number; command_fingerprint: string }>(
          `SELECT id,aggregate_version,command_fingerprint FROM canonical_score_events
           WHERE match_id=$1 AND client_event_id=$2`,
          [matchId, input.clientEventId],
        )
      )[0];
      if (duplicate) {
        if (duplicate.command_fingerprint !== fingerprint) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Reopen idempotency key was reused");
        }
        const originalResult = required(
          await tx.unsafe<{ result_version: number }>(
            `SELECT result_version FROM match_result_snapshots
             WHERE match_id=$1 AND through_sequence < $2
             ORDER BY through_sequence DESC LIMIT 1`,
            [matchId, duplicate.aggregate_version],
          ),
          "Reopen receipt is unavailable",
        );
        return {
          match_id: matchId,
          duplicate: true as const,
          aggregate_version: duplicate.aggregate_version,
          through_sequence: duplicate.aggregate_version,
          result_version: originalResult.result_version,
          publication_version: originalResult.result_version,
          conflicts: [],
        };
      }
      if (canonical.aggregateVersion !== input.expectedAggregateVersion) {
        throw new ApiError(
          409,
          "SCORE_VERSION_CONFLICT",
          `Expected aggregate version ${input.expectedAggregateVersion}, current version is ${canonical.aggregateVersion}`,
        );
      }
      if (!["final", "corrected"].includes(match.state)) {
        throw new ApiError(409, "MATCH_NOT_FINALISED", "Only a finalised match can be reopened");
      }
      const eventId = randomUUID();
      const event = materialiseFiveSportScoreEvent(command, {
        eventId,
        matchId,
        sequence: canonical.events.length + 1,
        actorId: actor.accountId,
        scoringSessionId: actor.accountId,
      });
      try {
        reduceFiveSportScoreEvents(
          canonical.context.sport_code,
          [...canonical.events, event],
          canonical.context.settings,
        );
      } catch (error) {
        throw new ApiError(422, "REOPEN_INVALID", error instanceof Error ? error.message : "Match cannot be reopened");
      }
      const aggregateVersion = canonical.aggregateVersion + 1;
      await tx.unsafe(
        `INSERT INTO canonical_score_events (
           id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
           command,command_fingerprint,actor_account_id,device_timestamp,reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$6,'match_reopened',$7::jsonb,$8,$9,$10,$11)`,
        [
          eventId,
          competitionId,
          canonical.context.division_id,
          matchId,
          input.clientEventId,
          aggregateVersion,
          wireScoreCommand(command),
          fingerprint,
          actor.accountId,
          command.occurredAt,
          input.reason.trim(),
        ],
      );
      await tx.unsafe(`UPDATE match_score_streams SET current_version=$2,updated_at=$3 WHERE match_id=$1`, [
        matchId,
        aggregateVersion,
        this.now(),
      ]);
      await tx.unsafe(`UPDATE matches SET state='in_progress' WHERE id=$1`, [matchId]);
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "result.reopened",
        targetType: "match",
        targetId: matchId,
        reason: input.reason.trim(),
        after: { aggregate_version: aggregateVersion },
        eventPayload: { competition_id: competitionId, match_id: matchId, aggregate_version: aggregateVersion },
      });
      const publication = required(
        await tx.unsafe<{ result_version: number }>(
          `SELECT result_version FROM competition_publications WHERE competition_id=$1`,
          [competitionId],
        ),
        "Publication record not found",
      );
      return {
        match_id: matchId,
        duplicate: false as const,
        aggregate_version: aggregateVersion,
        through_sequence: aggregateVersion,
        result_version: publication.result_version,
        publication_version: publication.result_version,
        conflicts: [],
      };
    });
  }

  async correctCanonicalMatch(
    actor: Phase2Actor,
    competitionId: string,
    matchId: string,
    input: {
      clientEventId: string;
      reason: string;
      expectedAggregateVersion: number;
      events: readonly unknown[];
    },
    requestId: string,
  ) {
    if (input.reason.trim().length < 3) {
      throw new ApiError(422, "CORRECTION_REASON_REQUIRED", "Correction reason is required");
    }
    if (input.events.length < 1 || input.events.length > 25) {
      throw new ApiError(422, "CORRECTION_EVENTS_REQUIRED", "Correction requires between one and 25 events");
    }
    const parsed = input.events.map(parseFiveSportScoreCommand);
    if (parsed.some((command) => !command)) {
      throw new ApiError(422, "CORRECTION_EVENT_INVALID", "A correction event is invalid");
    }
    const commands = parsed as FiveSportScoreCommand[];
    if (commands.some((command) => ["match_started", "match_reopened", "finalisation"].includes(command.type))) {
      throw new ApiError(422, "CORRECTION_EVENT_INVALID", "Correction events cannot control match lifecycle");
    }
    const transactionFingerprint = stableHash({
      reason: input.reason.trim(),
      expected_aggregate_version: input.expectedAggregateVersion,
      events: commands,
    });
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [matchId]);
      const duplicate = (
        await tx.unsafe<{
          command_fingerprint: string;
          through_aggregate_version: number;
          result_version: number;
        }>(
          `SELECT command_fingerprint,through_aggregate_version,result_version
           FROM score_correction_transactions WHERE match_id=$1 AND client_event_id=$2`,
          [matchId, input.clientEventId],
        )
      )[0];
      if (duplicate) {
        if (duplicate.command_fingerprint !== transactionFingerprint) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Correction idempotency key was reused");
        }
        const conflicts = await tx.unsafe<Record<string, unknown>>(
          `SELECT id,corrected_match_id,downstream_match_id,result_version,reason,
                  'open'::text AS status,detail,created_at,
                  NULL::timestamptz AS acknowledged_at,
                  NULL::uuid AS acknowledged_by_account_id,
                  NULL::text AS acknowledgement_reason
           FROM result_conflicts WHERE competition_id=$1 AND corrected_match_id=$2 AND result_version=$3
           ORDER BY created_at,id`,
          [competitionId, matchId, duplicate.result_version],
        );
        return {
          match_id: matchId,
          duplicate: true as const,
          aggregate_version: duplicate.through_aggregate_version,
          through_sequence: duplicate.through_aggregate_version,
          result_version: duplicate.result_version,
          publication_version: duplicate.result_version,
          conflicts,
        };
      }
      const match = required(
        await tx.unsafe<{ state: string }>(`SELECT state FROM matches WHERE id=$1 AND competition_id=$2 FOR UPDATE`, [
          matchId,
          competitionId,
        ]),
        "Match not found",
      );
      const canonical = await this.canonicalScoreState(tx, matchId);
      if (canonical.aggregateVersion !== input.expectedAggregateVersion) {
        throw new ApiError(
          409,
          "SCORE_VERSION_CONFLICT",
          `Expected aggregate version ${input.expectedAggregateVersion}, current version is ${canonical.aggregateVersion}`,
        );
      }
      for (const command of commands) {
        assertFiveSportScoreCommandAllowed(canonical.context.sport_code, command, canonical.context.settings);
      }
      const explicitlyReopened = match.state === "in_progress" && canonical.events.at(-1)?.type === "match_reopened";
      if (!["final", "corrected"].includes(match.state) && !explicitlyReopened) {
        throw new ApiError(
          409,
          "MATCH_NOT_CORRECTION_READY",
          "Correction requires a finalised match or the latest organiser reopen event",
        );
      }
      const reopenCommand: FiveSportScoreCommand | null = explicitlyReopened
        ? null
        : {
            clientEventId: input.clientEventId,
            type: "match_reopened",
            occurredAt: this.now().toISOString(),
            reason: input.reason.trim(),
          };
      const finaliseCommand: FiveSportScoreCommand = {
        clientEventId: derivedUuid(input.clientEventId, "finalisation"),
        type: "finalisation",
        occurredAt: this.now().toISOString(),
      };
      const reservedClientEventIds = [
        input.clientEventId,
        finaliseCommand.clientEventId,
        ...commands.map((command) => command.clientEventId),
      ];
      if (new Set(reservedClientEventIds).size !== reservedClientEventIds.length) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Correction envelope and child client event IDs must be distinct",
        );
      }
      const colliding = await tx.unsafe<{ client_event_id: string }>(
        `SELECT client_event_id FROM canonical_score_events
         WHERE match_id=$1 AND client_event_id=ANY($2::uuid[]) LIMIT 1`,
        [matchId, reservedClientEventIds],
      );
      if (colliding[0]) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "A correction client event ID is already used by the score stream",
        );
      }
      const allCommands = [...(reopenCommand ? [reopenCommand] : []), ...commands, finaliseCommand];
      const staged: Array<{
        id: string;
        aggregateVersion: number;
        command: FiveSportScoreCommand;
        event: FiveSportScoreEvent;
      }> = [];
      let logicalEvents = [...canonical.events];
      for (const command of allCommands) {
        const id = randomUUID();
        const event = materialiseFiveSportScoreEvent(command, {
          eventId: id,
          matchId,
          sequence: logicalEvents.length + 1,
          actorId: actor.accountId,
          scoringSessionId: actor.accountId,
        });
        logicalEvents = [...logicalEvents, event];
        staged.push({
          id,
          aggregateVersion: canonical.aggregateVersion + staged.length + 1,
          command,
          event,
        });
      }
      let state: FiveSportScoreState;
      try {
        state = reduceFiveSportScoreEvents(canonical.context.sport_code, logicalEvents, canonical.context.settings);
      } catch (error) {
        throw new ApiError(422, "CORRECTION_INVALID", error instanceof Error ? error.message : "Correction is invalid");
      }
      for (const item of staged) {
        await tx.unsafe(
          `INSERT INTO canonical_score_events (
             id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
             command,command_fingerprint,actor_account_id,device_timestamp,reversal_target_event_id,reason
           ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
          [
            item.id,
            competitionId,
            canonical.context.division_id,
            matchId,
            item.command.clientEventId,
            item.aggregateVersion,
            item.command.type,
            wireScoreCommand(item.command),
            stableHash(wireScoreCommand(item.command)),
            actor.accountId,
            item.command.occurredAt,
            item.command.reversalTargetEventId ?? null,
            item.command.reason ?? null,
          ],
        );
      }
      const throughAggregateVersion = staged.at(-1)!.aggregateVersion;
      await tx.unsafe(`UPDATE match_score_streams SET current_version=$2,updated_at=$3 WHERE match_id=$1`, [
        matchId,
        throughAggregateVersion,
        this.now(),
      ]);
      const result = await this.persistResultPublication(tx, {
        matchId,
        divisionId: canonical.context.division_id,
        organisationId: competition.organisation_id,
        requestId,
        actorAccountId: actor.accountId,
        actorType: "account",
        action: "result.corrected",
        reason: input.reason.trim(),
        canonical: {
          state,
          settings: canonical.context.settings,
          throughAggregateVersion,
          resultState: "corrected",
        },
      });
      await tx.unsafe(
        `INSERT INTO score_correction_transactions (
           competition_id,division_id,match_id,client_event_id,command_fingerprint,reason,
           from_aggregate_version,through_aggregate_version,result_version,actor_account_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          competitionId,
          canonical.context.division_id,
          matchId,
          input.clientEventId,
          transactionFingerprint,
          input.reason.trim(),
          input.expectedAggregateVersion,
          throughAggregateVersion,
          result.result_version,
          actor.accountId,
        ],
      );
      const conflicts = await tx.unsafe<{
        id: string;
        corrected_match_id: string;
        downstream_match_id: string;
        result_version: number;
        reason: string;
        status: string;
        detail: Record<string, unknown> | string;
        created_at: Date | string;
        acknowledged_at: Date | string | null;
        acknowledged_by_account_id: string | null;
        acknowledgement_reason: string | null;
      }>(
        `WITH RECURSIVE descendants(id) AS (
           SELECT dependency.match_id
           FROM match_dependencies dependency
           WHERE dependency.source_match_id=$1
           UNION
           SELECT dependency.match_id
           FROM match_dependencies dependency
           JOIN descendants parent ON parent.id=dependency.source_match_id
         ), candidates AS (
           SELECT downstream.id,
                  CASE
                    WHEN downstream.state IN ('final','corrected') THEN 'downstream_result_finalised'
                    WHEN downstream.state='in_progress' THEN 'downstream_match_started'
                    ELSE 'manual_slot_preserved'
                  END AS reason
           FROM descendants
           JOIN matches downstream ON downstream.id=descendants.id
           WHERE downstream.state IN ('in_progress','final','corrected')
              OR EXISTS (
                SELECT 1 FROM advancement_slots slot
                WHERE slot.match_id=downstream.id AND slot.control='manual'
              )
         )
         INSERT INTO result_conflicts (
           competition_id,division_id,corrected_match_id,downstream_match_id,
           result_version,reason,detail
         )
         SELECT $2,$3,$1,candidates.id,$4,candidates.reason,
                jsonb_build_object(
                  'affected_slot',NULL,
                  'previous_entry_id',NULL,
                  'proposed_entry_id',NULL
                )
         FROM candidates
         ON CONFLICT DO NOTHING
         RETURNING id,corrected_match_id,downstream_match_id,result_version,reason,status,detail,
                   created_at,acknowledged_at,acknowledged_by_account_id,acknowledgement_reason`,
        [matchId, competitionId, canonical.context.division_id, result.result_version],
      );
      for (const conflict of conflicts) {
        await this.evidence(tx, {
          requestId: `${requestId}:conflict:${conflict.id}`,
          actorAccountId: actor.accountId,
          organisationId: competition.organisation_id,
          action: "result_conflict.created",
          targetType: "result_conflict",
          targetId: conflict.id,
          reason: conflict.reason,
          eventPayload: {
            competition_id: competitionId,
            corrected_match_id: matchId,
            downstream_match_id: conflict.downstream_match_id,
            result_version: result.result_version,
          },
        });
      }
      return {
        match_id: matchId,
        duplicate: false as const,
        aggregate_version: throughAggregateVersion,
        through_sequence: throughAggregateVersion,
        result_version: result.result_version,
        publication_version: result.result_version,
        conflicts,
      };
    });
  }

  private async matchResultAtSequence(tx: PostgresJsSql, matchId: string, throughSequence: number) {
    const row = (
      await tx.unsafe<{
        home_score: number;
        away_score: number;
        result_version: number;
      }>(
        `SELECT home_score,away_score,result_version FROM match_result_snapshots
       WHERE match_id=$1 AND through_sequence=$2`,
        [matchId, throughSequence],
      )
    )[0];
    return row
      ? {
          match_id: matchId,
          home_score: row.home_score,
          away_score: row.away_score,
          result_version: row.result_version,
        }
      : null;
  }

  private async persistResultPublication(
    tx: PostgresJsSql,
    input: {
      matchId: string;
      divisionId: string;
      organisationId: string;
      requestId: string;
      actorAccountId: string | null;
      actorType: "account" | "access_pass";
      action: "result.finalised" | "result.corrected";
      reason: string | null;
      canonical: {
        state: FiveSportScoreState;
        settings: SportPackSettings;
        throughAggregateVersion: number;
        resultState: "final" | "corrected";
      };
    },
  ) {
    const match = required(
      await tx.unsafe<{ competition_id: string; home_entry_id: string | null; away_entry_id: string | null }>(
        `SELECT competition_id,home_entry_id,away_entry_id FROM matches WHERE id=$1 FOR UPDATE`,
        [input.matchId],
      ),
      "Match not found",
    );
    if (!match.home_entry_id || !match.away_entry_id) {
      throw new ApiError(409, "MATCH_PARTICIPANTS_UNRESOLVED", "Match participants are not resolved");
    }
    const reduced: {
      homeScore: number;
      awayScore: number;
      state: "final" | "corrected";
      snapshot: Record<string, unknown>;
    } = (() => {
      const exceptionalWinner =
        input.canonical.state.exceptionalOutcome === "walkover" ? input.canonical.state.winner : null;
      const forfeitWinnerScore = Number(input.canonical.settings.forfeitWinnerScore ?? 0);
      const forfeitLoserScore = Number(input.canonical.settings.forfeitLoserScore ?? 0);
      return {
        homeScore: exceptionalWinner
          ? exceptionalWinner === "home"
            ? forfeitWinnerScore
            : forfeitLoserScore
          : input.canonical.state.score.home,
        awayScore: exceptionalWinner
          ? exceptionalWinner === "away"
            ? forfeitWinnerScore
            : forfeitLoserScore
          : input.canonical.state.score.away,
        state: input.canonical.resultState,
        snapshot: input.canonical.state as unknown as Record<string, unknown>,
      };
    })();
    const publication = required(
      await tx.unsafe<{ schedule_version: number; result_version: number }>(
        `SELECT schedule_version,result_version FROM competition_publications WHERE competition_id=$1 FOR UPDATE`,
        [match.competition_id],
      ),
      "Publication record not found",
    );
    const resultVersion = publication.result_version + 1;
    const throughSequence = input.canonical.throughAggregateVersion;
    await tx.unsafe(
      `INSERT INTO match_result_snapshots (
         match_id,result_version,through_sequence,home_score,away_score,state,snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        input.matchId,
        resultVersion,
        throughSequence,
        reduced.homeScore,
        reduced.awayScore,
        reduced.state,
        JSON.stringify(reduced.snapshot),
      ],
    );
    await tx.unsafe(`UPDATE matches SET state=$2 WHERE id=$1`, [input.matchId, reduced.state]);
    await tx.unsafe(
      `UPDATE competition_publications SET result_version=$2,results_published_at=$3,updated_at=$3 WHERE competition_id=$1`,
      [match.competition_id, resultVersion, this.now()],
    );
    await tx.unsafe(
      `UPDATE competitions SET status=CASE
         WHEN status='draft' AND EXISTS (
           SELECT 1 FROM competition_publications publication
           WHERE publication.competition_id=competitions.id
             AND publication.published_schedule_revision_id IS NOT NULL
         ) THEN 'active'
         ELSE status
       END,updated_at=$2 WHERE id=$1`,
      [match.competition_id, this.now()],
    );
    await this.recalculateDivision(tx, match.competition_id, input.divisionId, resultVersion);
    await this.writePublicProjection(tx, match.competition_id, publication.schedule_version, resultVersion);
    await this.evidence(tx, {
      requestId: input.requestId,
      actorAccountId: input.actorAccountId,
      actorType: input.actorType,
      organisationId: input.organisationId,
      action: input.action,
      targetType: "match",
      targetId: input.matchId,
      reason: input.reason,
      after: { home_score: reduced.homeScore, away_score: reduced.awayScore, result_version: resultVersion },
      eventPayload: { competition_id: match.competition_id, match_id: input.matchId, result_version: resultVersion },
    });
    return {
      match_id: input.matchId,
      home_score: reduced.homeScore,
      away_score: reduced.awayScore,
      result_version: resultVersion,
    };
  }

  private async recalculateDivision(
    tx: PostgresJsSql,
    competitionId: string,
    divisionId: string,
    resultVersion: number,
  ) {
    const entries = await tx.unsafe<EntryRow>(
      `SELECT id,name,seed FROM division_entries
       WHERE division_id=$1 AND status IN ('confirmed','active')
       ORDER BY seed,id`,
      [divisionId],
    );
    if (entries.length === 0) {
      throw new ApiError(409, "STANDINGS_ENTRIES_EMPTY", "Standings require at least one active division entry");
    }
    const results = await this.resultsForDivision(tx, divisionId, resultVersion);
    const effectiveSettings = required(
      await tx.unsafe<{ settings: SportPackSettings | string }>(
        `SELECT settings.recommended_snapshot || settings.settings_override ||
                COALESCE(division.settings_override,'{}'::jsonb) AS settings
         FROM competition_sport_settings settings
         LEFT JOIN division_sport_settings division
           ON division.competition_id=settings.competition_id AND division.division_id=$2
         WHERE settings.competition_id=$1`,
        [competitionId, divisionId],
      ),
      "Effective sport settings not found",
    );
    const sport = required(
      await tx.unsafe<{ sport_code: SportId }>(`SELECT sport_code FROM competitions WHERE id=$1`, [competitionId]),
      "Competition not found",
    );
    const standingsConfig = effectiveStandingsConfig(
      sport.sport_code,
      jsonValue<SportPackSettings>(effectiveSettings.settings),
    );
    const genericResults = await tx.unsafe<{
      match_id: string;
      home_entry_id: string;
      away_entry_id: string;
      home_score: number;
      away_score: number;
      state: "final" | "corrected";
      result_version: number;
      snapshot: Record<string, unknown> | string;
    }>(
      `SELECT DISTINCT ON (m.id) m.id AS match_id,m.home_entry_id,m.away_entry_id,
                snapshot.home_score,snapshot.away_score,snapshot.state,snapshot.result_version,snapshot.snapshot
         FROM matches m
         JOIN match_result_snapshots snapshot ON snapshot.match_id=m.id
       WHERE m.division_id=$1 AND snapshot.result_version<=$2
         AND m.state IN ('final','corrected')
           AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
         ORDER BY m.id,snapshot.result_version DESC`,
      [divisionId, resultVersion],
    );
    const standingsResults: StandingsMatchResult[] = genericResults.map((result) => {
      const snapshot = jsonValue<{
        segments?: Array<{ home?: number; away?: number }>;
        totalPoints?: { home?: number; away?: number };
        exceptionalOutcome?: string | null;
        winner?: "home" | "away" | null;
      }>(result.snapshot);
      const segments = Array.isArray(snapshot.segments) ? snapshot.segments : [];
      const config = standingsConfig;
      const forfeit = snapshot.exceptionalOutcome === "walkover" && Boolean(snapshot.winner);
      const homeWonForfeit = forfeit && snapshot.winner === "home";
      const forfeitHomeSegments = homeWonForfeit ? config.forfeitScore.homeSegments : config.forfeitScore.awaySegments;
      const forfeitAwaySegments = homeWonForfeit ? config.forfeitScore.awaySegments : config.forfeitScore.homeSegments;
      return {
        matchId: result.match_id,
        homeEntryId: result.home_entry_id,
        awayEntryId: result.away_entry_id,
        homeScore: forfeit
          ? homeWonForfeit
            ? config.forfeitScore.homeScore
            : config.forfeitScore.awayScore
          : Number(snapshot.totalPoints?.home ?? result.home_score),
        awayScore: forfeit
          ? homeWonForfeit
            ? config.forfeitScore.awayScore
            : config.forfeitScore.homeScore
          : Number(snapshot.totalPoints?.away ?? result.away_score),
        ...(!forfeit
          ? {
              homeSegments: segments.map((segment) => Number(segment.home ?? 0)),
              awaySegments: segments.map((segment) => Number(segment.away ?? 0)),
            }
          : forfeitHomeSegments && forfeitAwaySegments
            ? { homeSegments: forfeitHomeSegments, awaySegments: forfeitAwaySegments }
            : {}),
        status: forfeit ? ("forfeit" as const) : result.state,
        ...(forfeit
          ? {
              forfeitLoserEntryId: snapshot.winner === "home" ? result.away_entry_id : result.home_entry_id,
            }
          : {}),
        version: result.result_version,
      };
    });
    // V1 and manual entry flows intentionally allow an unseeded entry. The
    // standings engine requires a numeric final tie-breaker, so mirror the
    // Phase 3 normalisation and derive a stable fallback from the deterministic
    // query order instead of passing the database null through at finalisation.
    const standingsEntries = entries.map((entry, index) => ({ ...entry, seed: entry.seed ?? index + 1 }));
    const rows = calculateStandings(standingsEntries, standingsResults, standingsConfig);
    const standings = {
      standings: rows,
      explanation: rows.map((row) => ({ entry_id: row.entryId, criteria: row.explanations })),
    };
    const format = required(
      await tx.unsafe<{ definition: Record<string, unknown> }>(
        `SELECT fr.definition FROM format_revisions fr
         WHERE fr.division_id=$1 AND fr.status='published' ORDER BY fr.revision DESC LIMIT 1`,
        [divisionId],
      ),
      "Format not found",
    );
    const bracket = this.domain.resolveBracket({ format: format.definition, results, entries: standingsEntries });
    const resolved = bracket.bracket as {
      matches?: readonly { matchId: string; homeEntryId: string | null; awayEntryId: string | null }[];
    };
    // C4/V1 format materialisation retains portable graph IDs as `matches.code`.
    // The legacy Canoe adapter only understands its older `groups` format, so
    // resolve canonical `stage_rank` slots here against the persisted graph and
    // database match IDs. This keeps advancement authoritative and transactional.
    const canonicalResolved = await this.resolveCanonicalStageRanks(
      tx,
      divisionId,
      format.definition,
      standingsEntries,
      standingsResults,
      standingsConfig,
    );
    const provenance = required(
      await tx.unsafe<{ source_hash: string }>(`SELECT phase3_standings_source_hash($1,$2,$3) AS source_hash`, [
        competitionId,
        divisionId,
        resultVersion,
      ]),
      "Standings provenance could not be calculated",
    );
    await tx.unsafe(`SELECT set_config('matchday.server_results','on',true)`);
    const snapshot = required(
      await tx.unsafe<{ id: string; row_count: number }>(
        `INSERT INTO standings_snapshots (
         competition_id,division_id,result_version,standings,explanation,calculation_input_hash,
         calculation_provenance,source_result_hash,settings_version,snapshot_fingerprint
       ) VALUES ($1,$2,$3,$4::text::jsonb,$5::text::jsonb,$6,'server_calculated',$6,$7,$6)
       RETURNING id,
         CASE WHEN jsonb_typeof(standings)='array' THEN jsonb_array_length(standings) ELSE -1 END AS row_count`,
        [
          competitionId,
          divisionId,
          resultVersion,
          JSON.stringify(standings.standings),
          JSON.stringify(standings.explanation),
          provenance.source_hash,
          standingsConfig.version,
        ],
      ),
      "Standings snapshot was not created",
    );
    if (snapshot.row_count !== entries.length) {
      throw new ApiError(
        500,
        "STANDINGS_PERSISTENCE_INVALID",
        `Standings snapshot retained ${snapshot.row_count} of ${entries.length} active entries`,
      );
    }
    for (const item of [...(resolved.matches ?? []), ...canonicalResolved]) {
      for (const slot of ["home", "away"] as const) {
        const entryId = slot === "home" ? item.homeEntryId : item.awayEntryId;
        const current = await tx.unsafe<{
          entry_id: string | null;
          control: "manual" | "automatic";
          state: string;
          controlled: boolean;
        }>(
          `SELECT a.entry_id,a.control,m.state,
                  EXISTS (SELECT 1 FROM match_dependencies md WHERE md.match_id=m.id AND md.slot=$2) AS controlled
           FROM matches m
           LEFT JOIN advancement_slots a ON a.match_id=m.id AND a.slot=$2
           WHERE m.id=$1 FOR UPDATE OF m`,
          [item.matchId, slot],
        );
        const state = current[0]?.state;
        if (!current[0]?.controlled && current[0]?.control === undefined) continue;
        if (current[0]?.control === "manual") continue;
        const changed = current[0]?.entry_id !== entryId;
        if (state && !["pending", "ready"].includes(state) && changed) {
          await tx.unsafe(
            `INSERT INTO advancement_conflicts
              (competition_id,division_id,result_version,rule_id,target_slot_id,reason)
             VALUES ($1,$2,$3,$4,$5,'downstream_match_started') ON CONFLICT DO NOTHING`,
            [competitionId, divisionId, resultVersion, `phase2:${item.matchId}:${slot}`, `${item.matchId}:${slot}`],
          );
          continue;
        }
        await tx.unsafe(
          slot === "home"
            ? `UPDATE matches SET home_entry_id=$2,
                 state=CASE
                   WHEN $2::uuid IS NULL THEN 'pending'
                   WHEN away_entry_id IS NOT NULL THEN 'ready'
                   ELSE 'pending'
                 END
               WHERE id=$1 AND state IN ('pending','ready')`
            : `UPDATE matches SET away_entry_id=$2,
                 state=CASE
                   WHEN $2::uuid IS NULL THEN 'pending'
                   WHEN home_entry_id IS NOT NULL THEN 'ready'
                   ELSE 'pending'
                 END
               WHERE id=$1 AND state IN ('pending','ready')`,
          [item.matchId, entryId],
        );
        await tx.unsafe(
          `INSERT INTO advancement_slots
            (competition_id,division_id,match_id,slot,entry_id,control,controlled_by_rule_id,
             source_snapshot_id,source_fingerprint,result_version,updated_at)
           VALUES ($1,$2,$3,$4,$5,'automatic',$6,$7,$8,$9,$10)
           ON CONFLICT (match_id,slot) DO UPDATE SET entry_id=EXCLUDED.entry_id,control='automatic',
             controlled_by_rule_id=EXCLUDED.controlled_by_rule_id,source_snapshot_id=EXCLUDED.source_snapshot_id,
             source_fingerprint=EXCLUDED.source_fingerprint,result_version=EXCLUDED.result_version,updated_at=EXCLUDED.updated_at`,
          [
            competitionId,
            divisionId,
            item.matchId,
            slot,
            entryId,
            `phase2:${item.matchId}:${slot}`,
            entryId ? snapshot.id : null,
            entryId ? provenance.source_hash : null,
            resultVersion,
            this.now(),
          ],
        );
      }
    }
    const resultByMatchId = new Map(results.map((result) => [result.matchId, result]));
    const canonicalBracketMatches = canonicalResolved
      .filter((item) => item.stageId !== "groups")
      .map((item) => {
        const result = resultByMatchId.get(item.matchId);
        const winnerEntryId =
          result && result.homeScore !== result.awayScore
            ? result.homeScore > result.awayScore
              ? result.homeEntryId
              : result.awayEntryId
            : null;
        return {
          matchId: item.matchId,
          stage: item.stageId,
          homeEntryId: item.homeEntryId,
          awayEntryId: item.awayEntryId,
          winnerEntryId,
          loserEntryId:
            winnerEntryId && result
              ? winnerEntryId === result.homeEntryId
                ? result.awayEntryId
                : result.homeEntryId
              : null,
          isTerminal: item.isTerminal,
        };
      });
    const canonicalBracket = {
      matches: canonicalBracketMatches,
      qualifiedEntryIds: [
        ...new Set(
          canonicalBracketMatches
            .flatMap((match) => [match.homeEntryId, match.awayEntryId])
            .filter((entryId): entryId is string => entryId !== null),
        ),
      ],
      championEntryId:
        canonicalBracketMatches.find((match) => match.stage === "championship" && match.isTerminal)?.winnerEntryId ??
        null,
    };
    await tx.unsafe(
      `INSERT INTO bracket_snapshots (
         competition_id,division_id,result_version,bracket,conflicts
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [
        competitionId,
        divisionId,
        resultVersion,
        JSON.stringify(canonicalBracketMatches.length > 0 ? canonicalBracket : bracket.bracket),
        JSON.stringify(bracket.conflicts ?? []),
      ],
    );
  }

  private async resolveCanonicalStageRanks(
    tx: PostgresJsSql,
    divisionId: string,
    definition: Record<string, unknown>,
    entries: readonly { id: string; name: string; seed: number }[],
    results: readonly StandingsMatchResult[],
    config: StandingsEngineConfig,
  ): Promise<
    readonly {
      matchId: string;
      stageId: string;
      isTerminal: boolean;
      homeEntryId: string | null;
      awayEntryId: string | null;
    }[]
  > {
    const graphMatches = Array.isArray(definition.matches)
      ? definition.matches.filter(
          (value): value is Record<string, unknown> =>
            value !== null && typeof value === "object" && !Array.isArray(value),
        )
      : [];
    if (graphMatches.length === 0) return [];
    const persisted = await tx.unsafe<{ id: string; code: string }>(
      `SELECT id,code FROM matches WHERE division_id=$1`,
      [divisionId],
    );
    const idsByCode = new Map(persisted.map((match) => [match.code, match.id]));
    const resultByMatchId = new Map(results.map((result) => [result.matchId, result]));
    const ranks = new Map<string, readonly string[]>();
    const rankKey = (stageId: string, groupId: string) => `${stageId}:${groupId}`;
    const rankSources = new Map(
      graphMatches
        .flatMap((match) => [match.home, match.away])
        .flatMap((source) => {
          const value = source as { type?: unknown; stageId?: unknown; groupId?: unknown } | undefined;
          return value?.type === "stage_rank" && typeof value.stageId === "string" && typeof value.groupId === "string"
            ? [[value.stageId, value.groupId] as const]
            : [];
        })
        .map((value) => [rankKey(value[0], value[1]), value] as const),
    );
    for (const source of rankSources.values()) {
      const [stageId, groupId] = source;
      const poolMatches = graphMatches.filter((match) => match.stageId === stageId && match.poolId === groupId);
      const poolCodes = new Set(poolMatches.map((match) => (typeof match.id === "string" ? match.id : "")));
      const poolResults = persisted
        .flatMap((match) => (poolCodes.has(match.code) ? [resultByMatchId.get(match.id)] : []))
        .filter((result): result is StandingsMatchResult => Boolean(result));
      if (poolResults.length !== poolCodes.size) continue;
      const groupSeeds = new Set(
        poolMatches
          .flatMap((match) => [match.home, match.away])
          .flatMap((source) => {
            const value = source as { type?: unknown; seed?: unknown } | undefined;
            return value?.type === "entry_seed" && Number.isInteger(value.seed) ? [Number(value.seed)] : [];
          }),
      );
      const groupEntries = entries.filter((entry) => groupSeeds.has(entry.seed));
      ranks.set(
        rankKey(stageId, groupId),
        calculateStandings(groupEntries, poolResults, config).map((row) => row.entryId),
      );
    }
    return graphMatches.flatMap((match) => {
      const matchId = typeof match.id === "string" ? idsByCode.get(match.id) : undefined;
      if (!matchId) return [];
      const resolve = (source: unknown): string | null => {
        const value = source as
          | {
              type?: unknown;
              stageId?: unknown;
              groupId?: unknown;
              rank?: unknown;
              seed?: unknown;
              matchId?: unknown;
            }
          | undefined;
        if (value?.type === "entry_seed" && Number.isInteger(value.seed))
          return entries.find((entry) => entry.seed === Number(value.seed))?.id ?? null;
        if (
          value?.type === "stage_rank" &&
          typeof value.stageId === "string" &&
          typeof value.groupId === "string" &&
          Number.isInteger(value.rank)
        )
          return ranks.get(rankKey(value.stageId, value.groupId))?.[Number(value.rank) - 1] ?? null;
        if ((value?.type === "winner" || value?.type === "loser") && typeof value.matchId === "string") {
          const sourceMatchId = idsByCode.get(value.matchId);
          const result = sourceMatchId ? resultByMatchId.get(sourceMatchId) : undefined;
          if (!result || result.homeScore === result.awayScore) return null;
          const winner = result.homeScore > result.awayScore ? result.homeEntryId : result.awayEntryId;
          if (value.type === "winner") return winner;
          return winner === result.homeEntryId ? result.awayEntryId : result.homeEntryId;
        }
        return null;
      };
      const home = resolve(match.home);
      const away = resolve(match.away);
      const hasAutomaticSource = [match.home, match.away].some((source) => {
        const type = (source as { type?: unknown } | undefined)?.type;
        return type === "stage_rank" || type === "winner" || type === "loser";
      });
      return home !== null || away !== null || hasAutomaticSource
        ? [
            {
              matchId,
              stageId: String(match.stageId),
              isTerminal:
                typeof match.id === "string" &&
                Array.isArray(definition.terminalMatchIds) &&
                definition.terminalMatchIds.includes(match.id),
              homeEntryId: home,
              awayEntryId: away,
            },
          ]
        : [];
    });
  }

  private async resultsForDivision(
    tx: PostgresJsSql,
    divisionId: string,
    maximumResultVersion: number | null = null,
  ): Promise<PersistedResult[]> {
    const resultRows = await tx.unsafe<{
      match_id: string;
      home_entry_id: string | null;
      away_entry_id: string | null;
      home_score: number;
      away_score: number;
      state: "final" | "corrected";
    }>(
      `SELECT DISTINCT ON (m.id) m.id AS match_id,m.home_entry_id,m.away_entry_id,
              s.home_score,s.away_score,s.state
       FROM matches m JOIN match_result_snapshots s ON s.match_id=m.id
       WHERE m.division_id=$1 AND m.state IN ('final','corrected')
         AND ($2::integer IS NULL OR s.result_version <= $2)
       ORDER BY m.id,s.result_version DESC`,
      [divisionId, maximumResultVersion],
    );
    return resultRows.map((row) => ({
      matchId: row.match_id,
      homeEntryId: row.home_entry_id,
      awayEntryId: row.away_entry_id,
      homeScore: row.home_score,
      awayScore: row.away_score,
      state: row.state,
    }));
  }

  async writePublicProjection(
    tx: PostgresJsSql,
    competitionId: string,
    scheduleVersion: number,
    resultVersion: number,
  ) {
    const competition = required(
      await tx.unsafe<{
        id: string;
        name: string;
        slug: string;
        sport_code: PublicCompetitionProjection["competition"]["sport_code"];
        timezone: string;
        starts_on: Date | string;
        ends_on: Date | string;
        status: "draft" | "active" | "completed" | "archived";
      }>(`SELECT id,name,slug,sport_code,timezone,starts_on,ends_on,status FROM competitions WHERE id=$1`, [
        competitionId,
      ]),
      "Competition not found",
    );
    if (competition.status === "draft") {
      throw new ApiError(409, "COMPETITION_NOT_PUBLISHED", "Draft competitions cannot have a public projection");
    }
    const publicCompetitionStatus = competition.status;
    const divisions = await tx.unsafe<{ id: string; name: string }>(
      `SELECT id,name FROM divisions WHERE competition_id=$1 ORDER BY created_at,id`,
      [competitionId],
    );
    required(divisions, "Division not found");
    const schedule =
      scheduleVersion > 0
        ? await tx.unsafe<{
            id: string;
            division_id: string;
            code: string;
            stage: string;
            home_entry_id: string | null;
            away_entry_id: string | null;
            home_name: string | null;
            away_name: string | null;
            starts_at: Date | string;
            ends_at: Date | string;
            area_id: string;
            area_name: string;
          }>(
            `SELECT m.id,m.division_id,m.code,m.stage,m.home_entry_id,m.away_entry_id,
                  home.name AS home_name,away.name AS away_name,
                  sm.starts_at,sm.ends_at,pa.id AS area_id,pa.name AS area_name
           FROM competition_publications cp
           JOIN scheduled_matches sm ON sm.schedule_revision_id=cp.published_schedule_revision_id
           JOIN matches m ON m.id=sm.match_id JOIN playing_areas pa ON pa.id=sm.playing_area_id
           LEFT JOIN division_entries home ON home.id=m.home_entry_id
           LEFT JOIN division_entries away ON away.id=m.away_entry_id
           WHERE cp.competition_id=$1 ORDER BY sm.starts_at,pa.sort_order,m.ordinal`,
            [competitionId],
          )
        : [];
    const results =
      resultVersion > 0
        ? await tx.unsafe<{
            id: string;
            division_id: string;
            code: string;
            stage: string;
            home_entry_id: string;
            away_entry_id: string;
            home_name: string;
            away_name: string;
            home_score: number;
            away_score: number;
            state: "final" | "corrected";
            created_at: Date | string;
          }>(
            `SELECT DISTINCT ON (m.id) m.id,m.division_id,m.code,m.stage,m.home_entry_id,m.away_entry_id,
                  home.name AS home_name,away.name AS away_name,
                  s.home_score,s.away_score,s.state,s.created_at
           FROM matches m JOIN match_result_snapshots s ON s.match_id=m.id
           JOIN division_entries home ON home.id=m.home_entry_id
           JOIN division_entries away ON away.id=m.away_entry_id
           WHERE m.competition_id=$1 AND m.state IN ('final','corrected')
             AND s.result_version <= $2
           ORDER BY m.id,s.result_version DESC`,
            [competitionId, resultVersion],
          )
        : [];
    const standings =
      resultVersion > 0
        ? await tx.unsafe<{ division_id: string; standings: unknown; explanation: unknown }>(
            `SELECT DISTINCT ON (division_id) division_id,standings,explanation
           FROM standings_snapshots
           WHERE competition_id=$1 AND result_version <= $2
           ORDER BY division_id,result_version DESC`,
            [competitionId, resultVersion],
          )
        : [];
    const bracket =
      resultVersion > 0
        ? await tx.unsafe<{ division_id: string; bracket: unknown; conflicts: unknown }>(
            `SELECT DISTINCT ON (division_id) division_id,bracket,conflicts
           FROM bracket_snapshots
           WHERE competition_id=$1 AND result_version <= $2
           ORDER BY division_id,result_version DESC`,
            [competitionId, resultVersion],
          )
        : [];
    const standingsByDivision = new Map(standings.map((snapshot) => [snapshot.division_id, snapshot]));
    const bracketByDivision = new Map(bracket.map((snapshot) => [snapshot.division_id, snapshot]));
    const publicDivisions: PublicDivisionProjection[] = divisions.map((division) => {
      const publicSchedule: PublicScheduledMatch[] = schedule
        .filter((match) => match.division_id === division.id)
        .map((match) => ({
          id: match.id,
          code: match.code,
          stage: match.stage,
          home: { id: match.home_entry_id, name: match.home_name ?? "TBD" },
          away: { id: match.away_entry_id, name: match.away_name ?? "TBD" },
          starts_at: serializedDate(match.starts_at),
          ends_at: serializedDate(match.ends_at),
          area: { id: match.area_id, name: match.area_name },
        }));
      const publicResults: PublicMatchResult[] = results
        .filter((match) => match.division_id === division.id)
        .map((match) => ({
          id: match.id,
          code: match.code,
          stage: match.stage,
          home: { id: match.home_entry_id, name: match.home_name },
          away: { id: match.away_entry_id, name: match.away_name },
          home_score: match.home_score,
          away_score: match.away_score,
          state: match.state,
          updated_at: serializedDate(match.created_at),
        }));
      const divisionStandings = standingsByDivision.get(division.id);
      const divisionBracket = bracketByDivision.get(division.id);
      return {
        division,
        schedule: publicSchedule,
        results: publicResults,
        standings: divisionStandings
          ? {
              standings: jsonValue(divisionStandings.standings),
              explanation: jsonValue(divisionStandings.explanation),
            }
          : null,
        bracket: divisionBracket
          ? { bracket: jsonValue(divisionBracket.bracket), conflicts: jsonValue(divisionBracket.conflicts) }
          : null,
      };
    });
    const legacyDivision = required(publicDivisions, "Division projection not found");
    const projection: Omit<PublicCompetitionProjection, "last_updated_at"> = {
      competition: {
        ...competition,
        status: publicCompetitionStatus,
        starts_on: serializedDate(competition.starts_on).slice(0, 10),
        ends_on: serializedDate(competition.ends_on).slice(0, 10),
      },
      divisions: publicDivisions,
      division: legacyDivision.division,
      publication: { schedule_version: scheduleVersion, result_version: resultVersion },
      schedule: legacyDivision.schedule,
      results: legacyDivision.results,
      standings: legacyDivision.standings,
      bracket: legacyDivision.bracket,
    };
    await tx.unsafe(
      `INSERT INTO public_competition_projections (
         competition_id,schedule_version,result_version,projection,generated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (competition_id,schedule_version,result_version)
       DO UPDATE SET projection=EXCLUDED.projection,generated_at=EXCLUDED.generated_at`,
      [competitionId, scheduleVersion, resultVersion, JSON.stringify(projection), this.now()],
    );
  }

  async publicCompetition(slug: string): Promise<PublicCompetitionProjection> {
    const rows = await this.sql.unsafe<{
      projection: Omit<PublicCompetitionProjection, "last_updated_at"> | string;
      generated_at: Date | string;
    }>(
      `SELECT p.projection,p.generated_at
       FROM competitions c JOIN competition_publications cp ON cp.competition_id=c.id
       JOIN public_competition_projections p ON p.competition_id=c.id
         AND p.schedule_version=cp.schedule_version AND p.result_version=cp.result_version
       WHERE c.slug=$1 AND (cp.schedule_version > 0 OR cp.result_version > 0)
       LIMIT 1`,
      [slug],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, "PUBLIC_COMPETITION_NOT_FOUND", "Competition not found");
    const stored = jsonValue<
      Omit<PublicCompetitionProjection, "last_updated_at"> & {
        divisions?: PublicDivisionProjection[];
      }
    >(row.projection);
    const divisions =
      Array.isArray(stored.divisions) && stored.divisions.length > 0
        ? stored.divisions
        : [
            {
              division: stored.division,
              schedule: stored.schedule,
              results: stored.results,
              standings: stored.standings,
              bracket: stored.bracket,
            },
          ];
    return {
      ...stored,
      divisions,
      last_updated_at: date(row.generated_at).toISOString(),
    };
  }

  async competitionWorkspace(actor: Phase2Actor, competitionId: string) {
    const access = await this.requireCompetitionAccess(this.sql, competitionId, actor, false);
    const competition = required(
      await this.sql.unsafe<Record<string, unknown>>(
        `SELECT id,organisation_id,name,slug,sport_code,timezone,starts_on,ends_on,status,created_at,updated_at
         FROM competitions WHERE id=$1`,
        [competitionId],
      ),
      "Competition not found",
    );
    const settings =
      (
        await this.sql.unsafe<Record<string, unknown>>(
          `SELECT period_count,period_minutes,slot_minutes,points_win,points_draw,points_loss,
              tiebreak_order,discipline_weights,customised,locked_at,updated_at
       FROM competition_sport_settings WHERE competition_id=$1`,
          [competitionId],
        )
      )[0] ?? null;
    const divisions = await this.sql.unsafe<Record<string, unknown>>(
      `SELECT d.id,d.name,d.team_limit,
              COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'seed',e.seed,'status',e.status,'revision',e.revision)
                ORDER BY e.seed) FILTER (WHERE e.id IS NOT NULL),'[]'::jsonb) AS entries
       FROM divisions d LEFT JOIN division_entries e ON e.division_id=d.id
       WHERE d.competition_id=$1 GROUP BY d.id ORDER BY d.created_at`,
      [competitionId],
    );
    const capacity = await this.sql.unsafe<Record<string, unknown>>(
      `SELECT pa.id,pa.name,pa.sort_order,
              COALESCE(jsonb_agg(jsonb_build_object('id',w.id,'starts_at',w.starts_at,'ends_at',w.ends_at)
                ORDER BY w.starts_at) FILTER (WHERE w.id IS NOT NULL),'[]'::jsonb) AS windows
       FROM playing_areas pa LEFT JOIN competition_availability_windows w ON w.playing_area_id=pa.id
       WHERE pa.competition_id=$1 GROUP BY pa.id ORDER BY pa.sort_order,pa.id`,
      [competitionId],
    );
    const format =
      (
        await this.sql.unsafe<Record<string, unknown>>(
          `SELECT id,division_id,revision,definition_hash,status,definition,created_at,published_at
       FROM format_revisions WHERE competition_id=$1 ORDER BY revision DESC LIMIT 1`,
          [competitionId],
        )
      )[0] ?? null;
    const privateSchedule =
      (
        await this.sql.unsafe<Record<string, unknown>>(
          `SELECT sr.id,sr.revision,sr.status,sr.warnings,sr.created_at,sr.published_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'match_id',m.id,'code',m.code,'stage',m.stage,'area_id',pa.id,'area',pa.name,
                'home_entry_id',m.home_entry_id,'away_entry_id',m.away_entry_id,
                'starts_at',sm.starts_at,'ends_at',sm.ends_at,'state',m.state,
                'home_score',latest_result.home_score,'away_score',latest_result.away_score,
                'result_version',latest_result.result_version
              ) ORDER BY sm.starts_at,pa.sort_order,m.ordinal) FILTER (WHERE sm.match_id IS NOT NULL),'[]'::jsonb) AS matches
       FROM schedule_revisions sr
       LEFT JOIN scheduled_matches sm ON sm.schedule_revision_id=sr.id
       LEFT JOIN matches m ON m.id=sm.match_id LEFT JOIN playing_areas pa ON pa.id=sm.playing_area_id
       LEFT JOIN LATERAL (
         SELECT snapshot.home_score,snapshot.away_score,snapshot.result_version
         FROM match_result_snapshots snapshot
         WHERE snapshot.match_id=m.id
         ORDER BY snapshot.result_version DESC
         LIMIT 1
       ) latest_result ON true
       WHERE sr.competition_id=$1
       GROUP BY sr.id ORDER BY sr.revision DESC LIMIT 1`,
          [competitionId],
        )
      )[0] ?? null;
    const publication =
      (
        await this.sql.unsafe<Record<string, unknown>>(
          `SELECT published_schedule_revision_id,schedule_version,result_version,
              schedule_published_at,results_published_at,updated_at
       FROM competition_publications WHERE competition_id=$1`,
          [competitionId],
        )
      )[0] ?? null;
    const accessPasses = await this.sql.unsafe<Record<string, unknown>>(
      `SELECT p.id,p.match_id,p.role,p.scope,p.expires_at,p.created_at,p.revoked_at,
              p.fallback_code_rotated_at,p.revocation_reason,
              CASE
                WHEN p.fallback_code_hash_version='rotation_required' THEN 'rotation_required'
                WHEN p.fallback_code_hash_version='unavailable' THEN 'unavailable'
                ELSE 'available'
              END AS fallback_code_status,
              CASE
                WHEN p.revoked_at IS NOT NULL THEN 'revoked'
                WHEN p.expires_at<=now() THEN 'expired'
                ELSE 'active'
              END AS status
       FROM scoring_access_passes p JOIN matches m ON m.id=p.match_id
       WHERE m.competition_id=$1 ORDER BY p.created_at DESC`,
      [competitionId],
    );
    return {
      competition,
      settings,
      divisions,
      capacity,
      current_format: format,
      private_schedule: privateSchedule,
      publication,
      access_passes: accessPasses,
      permission: access.membership_role === "viewer" ? "read" : "write",
      read_only: access.membership_role === "viewer" || access.status === "archived",
    };
  }

  async scoringSessionState(auth: ScoringSessionAuth): Promise<ScoringSessionState> {
    return this.transaction(async (tx) => {
      const session = await this.authenticateScoringSession(
        tx,
        auth.sessionId,
        auth.sessionToken,
        auth.generation,
        false,
      );
      const match = required(
        await tx.unsafe<{
          id: string;
          competition_slug: string;
          code: string;
          stage: string;
          state: ScoringSessionState["match"]["state"];
          home_entry_id: string | null;
          away_entry_id: string | null;
          home_name: string | null;
          away_name: string | null;
          sport_code: SportId;
        }>(
          `SELECT m.id,c.slug AS competition_slug,c.sport_code,m.code,m.stage,m.state,m.home_entry_id,m.away_entry_id,
                  home.name AS home_name,away.name AS away_name
           FROM matches m JOIN competitions c ON c.id=m.competition_id
           LEFT JOIN division_entries home ON home.id=m.home_entry_id
           LEFT JOIN division_entries away ON away.id=m.away_entry_id WHERE m.id=$1`,
          [session.match_id],
        ),
        "Match not found",
      );
      const stream = (
        await tx.unsafe<{ match_id: string }>(`SELECT match_id FROM match_score_streams WHERE match_id=$1`, [
          session.match_id,
        ])
      )[0];
      const canonical = stream
        ? await this.canonicalScoreState(tx, session.match_id, { readOnlyLegacyProjection: true })
        : (() => {
            return null;
          })();
      const currentContext = canonical ? canonical.context : await this.canonicalScoringContext(tx, session.match_id);
      const canonicalState =
        canonical?.state ?? reduceFiveSportScoreEvents(currentContext.sport_code, [], currentContext.settings);
      const writerActive =
        session.mode === "writer" &&
        session.lease_session_id === session.id &&
        session.lease_generation === session.generation &&
        Boolean(session.lease_expires_at && date(session.lease_expires_at).getTime() > this.now().getTime());
      const writerLeaseExpiresAt =
        session.mode === "writer" && session.lease_session_id === session.id && session.lease_expires_at
          ? date(session.lease_expires_at).toISOString()
          : null;
      const canonicalRows = stream
        ? await tx.unsafe<{
            id: string;
            client_event_id: string;
            aggregate_version: number;
            command: Record<string, unknown> | string;
          }>(
            `SELECT id,client_event_id,aggregate_version,command
             FROM canonical_score_events WHERE match_id=$1 ORDER BY aggregate_version`,
            [session.match_id],
          )
        : [];
      return {
        competition: { slug: match.competition_slug, sport_code: match.sport_code },
        sport: { pack_version: currentContext.pack_version, settings: currentContext.settings },
        match: {
          id: match.id,
          code: match.code,
          stage: match.stage,
          state: match.state,
          home: { id: match.home_entry_id, name: match.home_name },
          away: { id: match.away_entry_id, name: match.away_name },
        },
        access: {
          mode: session.mode,
          permissions: jsonValue<ScoringPermission[]>(session.scope),
          session_expires_at: date(session.expires_at).toISOString(),
        },
        writer: {
          generation: session.generation,
          expires_at: writerLeaseExpiresAt,
          read_only: !writerActive,
        },
        score: this.serialisedCanonicalScore(canonicalState),
        aggregate_version: canonical?.aggregateVersion ?? 0,
        through_sequence: canonical?.aggregateVersion ?? 0,
        events: canonicalRows.map((row) => {
          const command = parseFiveSportScoreCommand(jsonValue(row.command));
          return {
            event_id: row.id,
            client_event_id: row.client_event_id,
            sequence: row.aggregate_version,
            type: command?.type ?? "legacy_correction",
            team_slot: command?.side ?? null,
            scorer: command?.participantId ?? null,
            manual_period: command?.segmentNumber ?? null,
            manual_event_seconds: typeof command?.manualTimeSeconds === "number" ? command.manualTimeSeconds : null,
            payload: {},
            correction_reason: command?.reason ?? null,
            occurred_at: command?.occurredAt ?? "",
          };
        }),
      };
    });
  }

  private serialisedCanonicalScore(state: FiveSportScoreState) {
    const pack = SPORT_PACKS[state.sportId];
    return {
      home: state.score.home,
      away: state.score.away,
      lifecycle: state.lifecycle,
      current_segment: state.currentSegment,
      total_points: state.totalPoints,
      segment_wins: state.segmentWins,
      segments: state.segments.map((segment) => ({
        number: segment.number,
        home: segment.home,
        away: segment.away,
        completed: segment.completed,
        winner: segment.winner,
      })),
      actions: state.actions.map((action) => ({
        event_id: action.eventId,
        client_event_id: action.clientEventId,
        event_type: action.eventType,
        label: action.label,
        side: action.side,
        participant_id: action.participantId,
        segment_number: action.segmentNumber,
        score_delta: action.scoreDelta,
        occurred_at: action.occurredAt,
        reversed: action.reversed,
        reversible:
          !action.reversed &&
          Boolean(pack.eventTypes.find((definition) => definition.id === action.eventType)?.reversable),
      })),
      conflicts: state.conflicts.map((conflict) => ({
        code: conflict.code,
        segment_number: conflict.segmentNumber,
        target_event_id: conflict.targetEventId,
        later_segment_numbers: [...conflict.laterSegmentNumbers],
      })),
    };
  }

  async matchScoringAudit(actor: Phase2Actor, competitionId: string, matchId: string) {
    return this.transaction(async (tx) => {
      await this.requireCompetitionAccess(tx, competitionId, actor);
      const match = required(
        await tx.unsafe<{
          id: string;
          code: string;
          state: string;
          home_entry_id: string | null;
          away_entry_id: string | null;
          home_name: string | null;
          away_name: string | null;
          sport_code: SportId;
        }>(
          `SELECT match.id,match.code,match.state,match.home_entry_id,match.away_entry_id,
                  home.name AS home_name,away.name AS away_name,competition.sport_code
           FROM matches match
           JOIN competitions competition ON competition.id=match.competition_id
           LEFT JOIN division_entries home ON home.id=match.home_entry_id
           LEFT JOIN division_entries away ON away.id=match.away_entry_id
           WHERE match.id=$1 AND match.competition_id=$2`,
          [matchId, competitionId],
        ),
        "Match not found",
      );
      const canonical = await this.canonicalScoreState(tx, matchId, { readOnlyLegacyProjection: true });
      const eventRows = await tx.unsafe<{
        id: string;
        client_event_id: string;
        aggregate_version: number;
        event_type: string;
        command: Record<string, unknown> | string;
        device_timestamp: Date | string;
        server_timestamp: Date | string;
        actor_access_session_id: string | null;
      }>(
        `SELECT id,client_event_id,aggregate_version,event_type,command,device_timestamp,
                server_timestamp,actor_access_session_id
         FROM canonical_score_events WHERE match_id=$1 ORDER BY aggregate_version`,
        [matchId],
      );
      const audit = await tx.unsafe<{
        id: string;
        occurred_at: Date | string;
        action: string;
        actor_type: string;
        reason: string | null;
        metadata: Record<string, unknown> | string;
      }>(
        `SELECT id,occurred_at,action,actor_type,reason,metadata
         FROM audit_events
         WHERE target_type='match' AND target_id=$1
         ORDER BY occurred_at,id`,
        [matchId],
      );
      const conflicts = await tx.unsafe<Record<string, unknown>>(
        `SELECT id,corrected_match_id,downstream_match_id,result_version,reason,status,detail,
                created_at,acknowledged_at,acknowledged_by_account_id,acknowledgement_reason
         FROM result_conflicts
         WHERE competition_id=$1 AND (corrected_match_id=$2 OR downstream_match_id=$2)
         ORDER BY created_at,id`,
        [competitionId, matchId],
      );
      const result = (
        await tx.unsafe<{ result_version: number; created_at: Date | string }>(
          `SELECT result_version,created_at FROM match_result_snapshots
           WHERE match_id=$1 ORDER BY result_version DESC LIMIT 1`,
          [matchId],
        )
      )[0];
      return {
        permission: "write" as const,
        aggregate_version: canonical.aggregateVersion,
        through_sequence: canonical.aggregateVersion,
        competition: { id: competitionId, sport_code: match.sport_code },
        sport: {
          pack_version: canonical.context.pack_version,
          settings: canonical.context.settings,
        },
        match: {
          id: match.id,
          code: match.code,
          state:
            match.state === "final"
              ? ("finalised" as const)
              : match.state === "pending" || match.state === "ready"
                ? ("scheduled" as const)
                : match.state,
          home: { id: match.home_entry_id, name: match.home_name },
          away: { id: match.away_entry_id, name: match.away_name },
        },
        score: this.serialisedCanonicalScore(canonical.state),
        result: result
          ? { result_version: result.result_version, updated_at: serializedDate(result.created_at) }
          : null,
        events: eventRows.map((row) => {
          const command = parseFiveSportScoreCommand(jsonValue(row.command));
          return {
            event_id: row.id,
            client_event_id: row.client_event_id,
            aggregate_version: row.aggregate_version,
            event_type: row.event_type,
            side: command?.side ?? null,
            participant_id: command?.participantId ?? null,
            unknown_participant: command?.unknownParticipant ?? false,
            segment_number: command?.segmentNumber ?? null,
            manual_time_seconds: command?.manualTimeSeconds ?? null,
            reversal_target_event_id: command?.reversalTargetEventId ?? null,
            reason: command?.reason ?? null,
            device_timestamp: serializedDate(row.device_timestamp),
            server_timestamp: serializedDate(row.server_timestamp),
            actor_type: row.actor_access_session_id ? ("access_pass" as const) : ("account" as const),
          };
        }),
        audit: audit.map((item) => ({
          ...item,
          occurred_at: serializedDate(item.occurred_at),
          metadata: jsonValue(item.metadata),
        })),
        conflicts,
      };
    });
  }

  async listResultConflicts(actor: Phase2Actor, competitionId: string, status: string | null) {
    await this.requireCompetitionAccess(this.sql, competitionId, actor);
    if (status && !["open", "acknowledged", "resolved"].includes(status)) {
      throw new ApiError(422, "RESULT_CONFLICT_STATUS_INVALID", "Result conflict status is invalid");
    }
    return this.sql.unsafe<Record<string, unknown>>(
      `SELECT id,corrected_match_id,downstream_match_id,result_version,reason,status,detail,
              created_at,acknowledged_at,acknowledged_by_account_id,acknowledgement_reason
       FROM result_conflicts
       WHERE competition_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY created_at,id`,
      [competitionId, status],
    );
  }

  async acknowledgeResultConflict(
    actor: Phase2Actor,
    competitionId: string,
    conflictId: string,
    input: { clientEventId: string; reason: string; expectedRevision: number },
    requestId: string,
  ) {
    if (input.reason.trim().length < 3) {
      throw new ApiError(422, "ACKNOWLEDGEMENT_REASON_REQUIRED", "Acknowledgement reason is required");
    }
    const fingerprint = stableHash({
      client_event_id: input.clientEventId,
      reason: input.reason.trim(),
      expected_revision: input.expectedRevision,
    });
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, [input.clientEventId]);
      const reusedAcknowledgement = (
        await tx.unsafe<{ id: string }>(
          `SELECT id FROM result_conflicts WHERE acknowledgement_client_event_id=$1 FOR UPDATE`,
          [input.clientEventId],
        )
      )[0];
      if (reusedAcknowledgement && reusedAcknowledgement.id !== conflictId) {
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Acknowledgement idempotency key was reused");
      }
      const existing = required(
        await tx.unsafe<{
          status: string;
          result_version: number;
          acknowledgement_client_event_id: string | null;
          acknowledgement_fingerprint: string | null;
        }>(
          `SELECT status,result_version,acknowledgement_client_event_id,acknowledgement_fingerprint
           FROM result_conflicts WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
          [conflictId, competitionId],
        ),
        "Result conflict not found",
      );
      if (existing.acknowledgement_client_event_id === input.clientEventId) {
        if (existing.acknowledgement_fingerprint !== fingerprint) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Acknowledgement idempotency key was reused");
        }
        return required(
          await tx.unsafe<Record<string, unknown>>(
            `SELECT id,corrected_match_id,downstream_match_id,result_version,reason,status,detail,
                    created_at,acknowledged_at,acknowledged_by_account_id,acknowledgement_reason,
                    acknowledgement_client_event_id
             FROM result_conflicts WHERE id=$1 AND competition_id=$2`,
            [conflictId, competitionId],
          ),
          "Result conflict not found",
        );
      }
      if (existing.acknowledgement_client_event_id) {
        throw new ApiError(409, "RESULT_CONFLICT_ALREADY_ACKNOWLEDGED", "Conflict is already acknowledged");
      }
      if (existing.result_version !== input.expectedRevision) {
        throw new ApiError(
          409,
          "RESULT_CONFLICT_VERSION_CONFLICT",
          `Expected conflict revision ${input.expectedRevision}, current revision is ${existing.result_version}`,
        );
      }
      if (existing.status === "resolved") {
        throw new ApiError(409, "RESULT_CONFLICT_RESOLVED", "Resolved conflicts cannot be acknowledged again");
      }
      if (existing.status === "open") {
        await tx.unsafe(
          `UPDATE result_conflicts SET status='acknowledged',acknowledged_at=$3,
             acknowledged_by_account_id=$4,acknowledgement_reason=$5,
             acknowledgement_client_event_id=$6,acknowledgement_fingerprint=$7
           WHERE id=$1 AND competition_id=$2`,
          [
            conflictId,
            competitionId,
            this.now(),
            actor.accountId,
            input.reason.trim(),
            input.clientEventId,
            fingerprint,
          ],
        );
        await this.evidence(tx, {
          requestId,
          actorAccountId: actor.accountId,
          organisationId: competition.organisation_id,
          action: "result_conflict.acknowledged",
          targetType: "result_conflict",
          targetId: conflictId,
          reason: input.reason.trim(),
          eventPayload: { competition_id: competitionId, result_conflict_id: conflictId },
        });
      }
      return required(
        await tx.unsafe<Record<string, unknown>>(
          `SELECT id,corrected_match_id,downstream_match_id,result_version,reason,status,detail,
                  created_at,acknowledged_at,acknowledged_by_account_id,acknowledgement_reason,
                  acknowledgement_client_event_id
           FROM result_conflicts WHERE id=$1 AND competition_id=$2`,
          [conflictId, competitionId],
        ),
        "Result conflict not found",
      );
    });
  }

  async audit(actor: Phase2Actor, competitionId: string) {
    await this.requireCompetitionAccess(this.sql, competitionId, actor, false);
    return this.sql.unsafe<Record<string, unknown>>(
      `SELECT id,occurred_at,actor_type,actor_account_id,action,target_type,target_id,reason,before_state,after_state,metadata
       FROM audit_events WHERE organisation_id=(SELECT organisation_id FROM competitions WHERE id=$1)
         AND (target_id=$1::text OR metadata->>'competition_id'=$1::text OR target_id IN (
           SELECT id::text FROM divisions WHERE competition_id=$1
           UNION SELECT id::text FROM matches WHERE competition_id=$1
           UNION SELECT id::text FROM format_revisions WHERE competition_id=$1
           UNION SELECT id::text FROM schedule_revisions WHERE competition_id=$1
         ))
       ORDER BY occurred_at,id`,
      [competitionId],
    );
  }
}
