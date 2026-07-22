import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  PublicCompetitionProjection,
  PublicMatchResult,
  PublicScheduledMatch,
  ScoringSessionState,
} from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";

export type Phase2Actor = { accountId: string };

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

type CompetitionRow = { id: string; organisation_id: string; status: string; division_id?: string };
type EntryRow = { id: string; name: string; seed: number };
type FormatRow = { id: string; definition: Record<string, unknown>; revision: number };
type EventRow = {
  client_event_id: string;
  sequence: number;
  event_type: PersistedScoreEvent["type"];
  team_slot: PersistedScoreEvent["teamSlot"];
  scorer: string | null;
  manual_period: number | null;
  manual_event_seconds: number | null;
  payload: Record<string, unknown>;
  correction_reason: string | null;
  occurred_at: Date | string;
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

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
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

function opaqueSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
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
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly domain: Phase2DomainAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      `SELECT c.id, c.organisation_id, c.status
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
    await tx.unsafe(
      `INSERT INTO audit_events (
         occurred_at, request_id, actor_account_id, actor_type, organisation_id,
         action, target_type, target_id, reason, before_state, after_state, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)`,
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
        JSON.stringify(input.metadata ?? {}),
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
      const generated = this.domain.generateFormat(entries);
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
    expiresAt: string,
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      if (new Date(expiresAt).getTime() <= this.now().getTime()) {
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
      for (let attempt = 0; attempt < 5 && !pass; attempt += 1) {
        shortCode = randomBytes(8).readBigUInt64BE().toString().slice(0, 12).padStart(12, "0");
        const rows = await tx.unsafe<{ id: string }>(
          `INSERT INTO scoring_access_passes (
             match_id,secret_hash,short_code_hash,expires_at,created_by
           ) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING RETURNING id`,
          [match.id, hashSecret(secret), hashSecret(shortCode), expiresAt, actor.accountId],
        );
        pass = rows[0];
      }
      if (!pass) throw new ApiError(503, "ACCESS_CODE_UNAVAILABLE", "A unique access code could not be issued");
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "scoring_access.created",
        targetType: "scoring_access_pass",
        targetId: pass.id,
        after: { match_id: matchId, expires_at: expiresAt },
      });
      // Secrets are returned once and are deliberately absent from audit/outbox/log metadata.
      return { id: pass.id, match_id: matchId, token: secret, short_code: shortCode, expires_at: expiresAt };
    });
  }

  async revokeAccessPass(actor: Phase2Actor, competitionId: string, passId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      const rows = await tx.unsafe<{ id: string }>(
        `UPDATE scoring_access_passes p SET revoked_at=$4,revoked_by=$3
         FROM matches m WHERE p.id=$1 AND p.match_id=m.id AND m.competition_id=$2 AND p.revoked_at IS NULL
         RETURNING p.id`,
        [passId, competitionId, actor.accountId, this.now()],
      );
      required(rows, "Active access pass not found");
      await tx.unsafe(
        `UPDATE scoring_access_sessions SET revoked_at=$2
         WHERE access_pass_id=$1 AND revoked_at IS NULL`,
        [passId, this.now()],
      );
      await this.evidence(tx, {
        requestId,
        actorAccountId: actor.accountId,
        organisationId: competition.organisation_id,
        action: "scoring_access.revoked",
        targetType: "scoring_access_pass",
        targetId: passId,
      });
      return { id: passId, revoked: true as const };
    });
  }

  async exchangeAccess(input: { token?: string; shortCode?: string; expectedMatchId?: string }, requestId: string) {
    return this.transaction(async (tx) => {
      if (Boolean(input.token) === Boolean(input.shortCode)) {
        throw new ApiError(400, "ACCESS_SECRET_AMBIGUOUS", "Provide exactly one access token or short code");
      }
      const presented = input.token ?? input.shortCode;
      if (!presented) throw new ApiError(400, "ACCESS_SECRET_REQUIRED", "Access token or code is required");
      const digest = hashSecret(presented);
      const column = input.token ? "secret_hash" : "short_code_hash";
      const candidates = await tx.unsafe<{
        id: string;
        match_id: string;
        secret_hash: Buffer;
        short_code_hash: Buffer | null;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        organisation_id: string;
        competition_status: string;
      }>(
        `SELECT p.id,p.match_id,p.secret_hash,p.short_code_hash,p.expires_at,p.revoked_at,c.organisation_id,
                c.status AS competition_status
         FROM scoring_access_passes p
         JOIN matches m ON m.id=p.match_id JOIN competitions c ON c.id=m.competition_id
         WHERE p.${column}=$1 LIMIT 1 FOR UPDATE OF p`,
        [digest],
      );
      const pass = candidates[0];
      const stored = input.token ? pass?.secret_hash : pass?.short_code_hash;
      if (!pass || !stored || !safeEqual(Buffer.from(stored), digest)) {
        throw new ApiError(403, "ACCESS_DENIED", "Access is invalid");
      }
      if (pass.competition_status === "archived") {
        throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
      }
      if (pass.revoked_at) throw new ApiError(403, "ACCESS_REVOKED", "Access has been revoked");
      if (date(pass.expires_at).getTime() <= this.now().getTime())
        throw new ApiError(403, "ACCESS_EXPIRED", "Access has expired");
      if (input.expectedMatchId && input.expectedMatchId !== pass.match_id) {
        throw new ApiError(403, "ACCESS_WRONG_MATCH", "Access does not belong to this match");
      }
      const sessionSecret = opaqueSecret();
      const lease = await tx.unsafe<{ generation: number; expires_at: Date | string }>(
        `SELECT generation,expires_at FROM match_writer_leases WHERE match_id=$1 FOR UPDATE`,
        [pass.match_id],
      );
      if (lease[0] && date(lease[0].expires_at).getTime() > this.now().getTime()) {
        throw new ApiError(409, "WRITER_ACTIVE", "Another scorekeeper currently controls this match");
      }
      const generation = (lease[0]?.generation ?? 0) + 1;
      const now = this.now();
      const expiresAt = new Date(Math.min(date(pass.expires_at).getTime(), now.getTime() + 30 * 60_000));
      const session = required(
        await tx.unsafe<{ id: string }>(
          `INSERT INTO scoring_access_sessions (
             access_pass_id,match_id,session_token_hash,generation,issued_at,expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [pass.id, pass.match_id, hashSecret(sessionSecret), generation, now, expiresAt],
        ),
        "Scoring session was not created",
      );
      await tx.unsafe(
        `INSERT INTO match_writer_leases (match_id,access_session_id,generation,acquired_at,expires_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (match_id) DO UPDATE SET
           access_session_id=EXCLUDED.access_session_id,generation=EXCLUDED.generation,
           acquired_at=EXCLUDED.acquired_at,expires_at=EXCLUDED.expires_at`,
        [pass.match_id, session.id, generation, now, expiresAt],
      );
      await this.evidence(tx, {
        requestId,
        actorAccountId: null,
        actorType: "access_pass",
        organisationId: pass.organisation_id,
        action: "scoring_access.exchanged",
        targetType: "scoring_session",
        targetId: session.id,
        after: { match_id: pass.match_id, generation, expires_at: expiresAt.toISOString() },
      });
      return {
        session_id: session.id,
        session_token: sessionSecret,
        match_id: pass.match_id,
        generation,
        expires_at: expiresAt.toISOString(),
      };
    });
  }

  private async authenticateScoringSession(
    tx: PostgresJsSql,
    sessionId: string,
    sessionToken: string,
    generation: number,
  ) {
    const rows = await tx.unsafe<{
      id: string;
      match_id: string;
      session_token_hash: Buffer;
      generation: number;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      access_pass_id: string;
      lease_session_id: string;
      lease_generation: number;
      lease_expires_at: Date | string;
      organisation_id: string;
      division_id: string;
      competition_status: string;
    }>(
      `SELECT s.id,s.match_id,s.session_token_hash,s.generation,s.expires_at,s.revoked_at,s.access_pass_id,
              l.access_session_id AS lease_session_id,l.generation AS lease_generation,l.expires_at AS lease_expires_at,
              c.organisation_id,m.division_id,c.status AS competition_status
       FROM scoring_access_sessions s
       JOIN match_writer_leases l ON l.match_id=s.match_id
       JOIN matches m ON m.id=s.match_id JOIN competitions c ON c.id=m.competition_id
       WHERE s.id=$1 FOR UPDATE OF s,l`,
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
    if (
      session.lease_session_id !== session.id ||
      session.lease_generation !== generation ||
      session.generation !== generation ||
      date(session.lease_expires_at).getTime() <= now
    ) {
      throw new ApiError(409, "STALE_WRITER_GENERATION", "A newer scorekeeper has control of this match");
    }
    if (session.revoked_at || date(session.expires_at).getTime() <= now) {
      throw new ApiError(403, "SCORING_SESSION_EXPIRED", "Scoring session has expired");
    }
    return session;
  }

  async appendScoreEvent(
    auth: { sessionId: string; sessionToken: string; generation: number },
    input: Omit<PersistedScoreEvent, "sequence">,
    requestId: string,
  ) {
    if (input.type === "goal_added" && (!input.teamSlot || !input.scorer?.trim())) {
      throw new ApiError(422, "GOAL_ATTRIBUTION_REQUIRED", "Goals require a team and scorer attribution");
    }
    if (
      (input.type === "goal_reversed" || input.type === "card_reversed") &&
      (!input.correctionReason?.trim() || typeof input.payload.reversal_target_event_id !== "string")
    ) {
      throw new ApiError(422, "REVERSAL_INVALID", "Reversals require a target event and reason");
    }
    if (
      input.type === "card_added" &&
      (!input.teamSlot ||
        typeof input.payload.person_id !== "string" ||
        !["green", "yellow", "red"].includes(String(input.payload.colour)))
    ) {
      throw new ApiError(422, "CARD_ATTRIBUTION_REQUIRED", "Cards require a team, person, and valid colour");
    }
    if (input.type === "timeout_added" && !input.teamSlot) {
      throw new ApiError(422, "TIMEOUT_TEAM_REQUIRED", "Timeouts require a team");
    }
    if (input.type === "incident_added" && !String(input.payload.note ?? "").trim()) {
      throw new ApiError(422, "INCIDENT_NOTE_REQUIRED", "Incidents require a note");
    }
    if (input.type === "match_reopened" && !input.correctionReason?.trim()) {
      throw new ApiError(422, "REOPEN_REASON_REQUIRED", "Reopening a match requires a reason");
    }
    return this.transaction(async (tx) => {
      const session = await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation);
      const duplicate = await tx.unsafe<{ sequence: number }>(
        `SELECT sequence FROM score_events WHERE match_id=$1 AND client_event_id=$2`,
        [session.match_id, input.clientEventId],
      );
      if (duplicate[0]) return { duplicate: true as const, sequence: duplicate[0].sequence };
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [session.match_id]);
      const next = await tx.unsafe<{ sequence: number }>(
        `SELECT COALESCE(max(sequence),0)::integer + 1 AS sequence FROM score_events WHERE match_id=$1`,
        [session.match_id],
      );
      const sequence = next[0]?.sequence ?? 1;
      await tx.unsafe(
        `INSERT INTO score_events (
           match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
           manual_period,manual_event_seconds,payload,actor_access_session_id,correction_reason,occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
        [
          session.match_id,
          input.clientEventId,
          sequence,
          auth.generation,
          input.type,
          input.teamSlot,
          input.scorer,
          input.manualPeriod,
          input.manualEventSeconds,
          JSON.stringify(input.payload),
          session.id,
          input.correctionReason,
          input.occurredAt,
        ],
      );
      await tx.unsafe(
        `UPDATE competition_sport_settings SET locked_at=COALESCE(locked_at,$2)
         WHERE competition_id=(SELECT competition_id FROM matches WHERE id=$1)`,
        [session.match_id, this.now()],
      );
      await this.evidence(tx, {
        requestId,
        actorAccountId: null,
        actorType: "access_pass",
        organisationId: session.organisation_id,
        action: `score.${input.type}.appended`,
        targetType: "match",
        targetId: session.match_id,
        reason: input.correctionReason,
        after: { client_event_id: input.clientEventId, sequence, generation: auth.generation },
      });
      return { duplicate: false as const, sequence };
    });
  }

  async transferWriter(auth: { sessionId: string; sessionToken: string; generation: number }, requestId: string) {
    return this.transaction(async (tx) => {
      const current = await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation);
      const sessionSecret = opaqueSecret();
      const generation = current.generation + 1;
      const now = this.now();
      const expiresAt = new Date(Math.min(date(current.expires_at).getTime(), now.getTime() + 30 * 60_000));
      const replacement = required(
        await tx.unsafe<{ id: string }>(
          `INSERT INTO scoring_access_sessions (
             access_pass_id,match_id,session_token_hash,generation,issued_at,expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [current.access_pass_id, current.match_id, hashSecret(sessionSecret), generation, now, expiresAt],
        ),
        "Replacement scoring session was not created",
      );
      await tx.unsafe(`UPDATE scoring_access_sessions SET revoked_at=$2,transferred_to_session_id=$3 WHERE id=$1`, [
        current.id,
        now,
        replacement.id,
      ]);
      await tx.unsafe(
        `UPDATE match_writer_leases SET access_session_id=$2,generation=$3,acquired_at=$4,expires_at=$5 WHERE match_id=$1`,
        [current.match_id, replacement.id, generation, now, expiresAt],
      );
      await this.evidence(tx, {
        requestId,
        actorAccountId: null,
        actorType: "access_pass",
        organisationId: current.organisation_id,
        action: "scoring_writer.transferred",
        targetType: "match",
        targetId: current.match_id,
        after: { generation, replaced_session_id: current.id },
      });
      return {
        session_id: replacement.id,
        session_token: sessionSecret,
        match_id: current.match_id,
        generation,
        expires_at: expiresAt.toISOString(),
      };
    });
  }

  async finalise(
    auth: { sessionId: string; sessionToken: string; generation: number },
    clientEventId: string,
    requestId: string,
  ) {
    return this.publishResult(auth, { clientEventId, correctionReason: null }, requestId);
  }

  async correct(
    actor: Phase2Actor,
    competitionId: string,
    matchId: string,
    input: { clientEventId: string; reason: string; homeScore: number; awayScore: number },
    requestId: string,
  ) {
    if (input.reason.trim().length < 3)
      throw new ApiError(422, "CORRECTION_REASON_REQUIRED", "Correction reason is required");
    return this.transaction(async (tx) => {
      const competition = await this.requireCompetitionAccess(tx, competitionId, actor);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [matchId]);
      const match = required(
        await tx.unsafe<{ division_id: string }>(
          `SELECT division_id FROM matches WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
          [matchId, competitionId],
        ),
        "Match not found",
      );
      const latestFormat = required(
        await tx.unsafe<{ definition: Record<string, unknown> }>(
          `SELECT fr.definition FROM format_revisions fr JOIN matches m ON m.format_revision_id=fr.id
           WHERE m.id=$1`,
          [matchId],
        ),
        "Format not found",
      );
      const existingResults = await this.resultsForDivision(tx, match.division_id);
      const stateRows = await tx.unsafe<{ id: string; state: string }>(
        `SELECT id,state FROM matches WHERE division_id=$1`,
        [match.division_id],
      );
      const downstreamStates = Object.fromEntries(
        stateRows.map((row) => [
          row.id,
          row.state === "final" || row.state === "corrected"
            ? "finalised"
            : row.state === "in_progress"
              ? "started"
              : "unstarted",
        ]),
      ) as Record<string, "unstarted" | "started" | "finalised">;
      const conflicts = this.domain.correctionConflicts({
        format: latestFormat.definition,
        results: existingResults,
        correctedMatchId: matchId,
        downstreamStates,
      });
      if (conflicts.length > 0) {
        throw new ApiError(
          409,
          "CORRECTION_DOWNSTREAM_CONFLICT",
          "A downstream result must be reopened before correction",
        );
      }
      const duplicate = await tx.unsafe<{ sequence: number }>(
        `SELECT sequence FROM score_events WHERE match_id=$1 AND client_event_id=$2`,
        [matchId, input.clientEventId],
      );
      if (duplicate[0]) {
        const latest = await this.latestMatchResult(tx, matchId);
        return { duplicate: true as const, sequence: duplicate[0].sequence, ...(latest ?? {}) };
      }
      const next = await tx.unsafe<{ sequence: number }>(
        `SELECT COALESCE(max(sequence),0)::integer + 1 AS sequence FROM score_events WHERE match_id=$1`,
        [matchId],
      );
      const sequence = next[0]?.sequence ?? 1;
      await tx.unsafe(
        `INSERT INTO score_events (
           match_id,client_event_id,sequence,writer_generation,event_type,payload,
           actor_account_id,correction_reason,occurred_at
         ) VALUES ($1,$2,$3,1,'correction',$4::jsonb,$5,$6,$7)`,
        [
          matchId,
          input.clientEventId,
          sequence,
          JSON.stringify({ home_score: input.homeScore, away_score: input.awayScore }),
          actor.accountId,
          input.reason.trim(),
          this.now(),
        ],
      );
      const result = await this.persistResultPublication(tx, {
        matchId,
        divisionId: match.division_id,
        organisationId: competition.organisation_id,
        requestId,
        actorAccountId: actor.accountId,
        actorType: "account",
        action: "result.corrected",
        reason: input.reason.trim(),
        forcedScore: { homeScore: input.homeScore, awayScore: input.awayScore, state: "corrected" },
      });
      return { duplicate: false as const, sequence, ...result };
    });
  }

  private async publishResult(
    auth: { sessionId: string; sessionToken: string; generation: number },
    input: { clientEventId: string; correctionReason: string | null },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const session = await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [session.match_id]);
      const duplicate = await tx.unsafe<{ sequence: number }>(
        `SELECT sequence FROM score_events WHERE match_id=$1 AND client_event_id=$2`,
        [session.match_id, input.clientEventId],
      );
      if (duplicate[0]) {
        const latest = await this.latestMatchResult(tx, session.match_id);
        return { duplicate: true as const, sequence: duplicate[0].sequence, ...(latest ?? {}) };
      }
      const next = await tx.unsafe<{ sequence: number }>(
        `SELECT COALESCE(max(sequence),0)::integer + 1 AS sequence FROM score_events WHERE match_id=$1`,
        [session.match_id],
      );
      const sequence = next[0]?.sequence ?? 1;
      const eventContext = (
        await tx.unsafe<{ manual_period: number | null; manual_event_seconds: number | null }>(
          `SELECT manual_period,manual_event_seconds FROM score_events
         WHERE match_id=$1 ORDER BY sequence DESC LIMIT 1`,
          [session.match_id],
        )
      )[0];
      await tx.unsafe(
        `INSERT INTO score_events (
          match_id,client_event_id,sequence,writer_generation,event_type,payload,
           actor_access_session_id,manual_period,manual_event_seconds,occurred_at
         ) VALUES ($1,$2,$3,$4,'match_finalised','{}'::jsonb,$5,$6,$7,$8)`,
        [
          session.match_id,
          input.clientEventId,
          sequence,
          auth.generation,
          session.id,
          eventContext?.manual_period ?? 1,
          eventContext?.manual_event_seconds ?? 0,
          this.now(),
        ],
      );
      const result = await this.persistResultPublication(tx, {
        matchId: session.match_id,
        divisionId: session.division_id,
        organisationId: session.organisation_id,
        requestId,
        actorAccountId: null,
        actorType: "access_pass",
        action: "result.finalised",
        reason: null,
      });
      return { duplicate: false as const, sequence, ...result };
    });
  }

  private async persistedEvents(tx: PostgresJsSql, matchId: string): Promise<PersistedScoreEvent[]> {
    const rows = await tx.unsafe<EventRow>(
      `SELECT client_event_id,sequence,event_type,team_slot,scorer,manual_period,
              manual_event_seconds,payload,correction_reason,occurred_at
       FROM score_events WHERE match_id=$1 ORDER BY sequence`,
      [matchId],
    );
    return rows.map((row) => ({
      clientEventId: row.client_event_id,
      sequence: row.sequence,
      type: row.event_type,
      teamSlot: row.team_slot,
      scorer: row.scorer,
      manualPeriod: row.manual_period,
      manualEventSeconds: row.manual_event_seconds,
      payload: jsonValue(row.payload),
      correctionReason: row.correction_reason,
      occurredAt: date(row.occurred_at),
    }));
  }

  private async latestMatchResult(tx: PostgresJsSql, matchId: string) {
    const row = (
      await tx.unsafe<{
        home_score: number;
        away_score: number;
        result_version: number;
      }>(
        `SELECT home_score,away_score,result_version FROM match_result_snapshots
       WHERE match_id=$1 ORDER BY result_version DESC LIMIT 1`,
        [matchId],
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
      forcedScore?: { homeScore: number; awayScore: number; state: "corrected" };
    },
  ) {
    const events = await this.persistedEvents(tx, input.matchId);
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
    let reduced: {
      homeScore: number;
      awayScore: number;
      state: "final" | "corrected";
      snapshot: Record<string, unknown>;
    };
    try {
      reduced = input.forcedScore
        ? { ...input.forcedScore, snapshot: { corrected: true, ...input.forcedScore } }
        : this.domain.reduceScore(events, {
            matchId: input.matchId,
            homeEntryId: match.home_entry_id,
            awayEntryId: match.away_entry_id,
          });
    } catch (error) {
      throw new ApiError(
        422,
        "FINALISATION_INVALID",
        error instanceof Error ? error.message : "Finalisation is invalid",
      );
    }
    const publication = required(
      await tx.unsafe<{ schedule_version: number; result_version: number }>(
        `SELECT schedule_version,result_version FROM competition_publications WHERE competition_id=$1 FOR UPDATE`,
        [match.competition_id],
      ),
      "Publication record not found",
    );
    const resultVersion = publication.result_version + 1;
    const throughSequence = events.at(-1)?.sequence ?? 1;
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
      `UPDATE competitions SET status=CASE WHEN status='draft' THEN 'active' ELSE status END,updated_at=$2 WHERE id=$1`,
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
      `SELECT id,name,seed FROM division_entries WHERE division_id=$1 AND status='confirmed' ORDER BY seed`,
      [divisionId],
    );
    const results = await this.resultsForDivision(tx, divisionId, resultVersion);
    const settingsRows = await tx.unsafe<Record<string, unknown>>(
      `SELECT period_count AS "periodCount",period_minutes AS "periodMinutes",slot_minutes AS "slotMinutes",
              points_win AS "pointsWin",points_draw AS "pointsDraw",points_loss AS "pointsLoss",
              tiebreak_order AS "tiebreakOrder",discipline_weights AS "disciplineWeights"
       FROM competition_sport_settings WHERE competition_id=$1`,
      [competitionId],
    );
    const standings = this.domain.calculateStandings({ entries, results, settings: settingsRows[0] ?? {} });
    const format = required(
      await tx.unsafe<{ definition: Record<string, unknown> }>(
        `SELECT fr.definition FROM format_revisions fr
         WHERE fr.division_id=$1 ORDER BY fr.revision DESC LIMIT 1`,
        [divisionId],
      ),
      "Format not found",
    );
    const bracket = this.domain.resolveBracket({ format: format.definition, results, entries });
    const resolved = bracket.bracket as {
      matches?: readonly { matchId: string; homeEntryId: string | null; awayEntryId: string | null }[];
    };
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
      await tx.unsafe<{ id: string }>(
        `INSERT INTO standings_snapshots (
         competition_id,division_id,result_version,standings,explanation,calculation_input_hash,
         calculation_provenance,source_result_hash,settings_version,snapshot_fingerprint
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,'server_calculated',$6,'phase2-canoe-polo-v1',$6)
       RETURNING id`,
        [
          competitionId,
          divisionId,
          resultVersion,
          JSON.stringify(standings.standings),
          JSON.stringify(standings.explanation),
          provenance.source_hash,
        ],
      ),
      "Standings snapshot was not created",
    );
    for (const item of resolved.matches ?? []) {
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
                 state=CASE WHEN $2::uuid IS NOT NULL AND away_entry_id IS NOT NULL THEN 'ready' ELSE state END
               WHERE id=$1 AND state IN ('pending','ready')`
            : `UPDATE matches SET away_entry_id=$2,
                 state=CASE WHEN home_entry_id IS NOT NULL AND $2::uuid IS NOT NULL THEN 'ready' ELSE state END
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
    await tx.unsafe(
      `INSERT INTO bracket_snapshots (
         competition_id,division_id,result_version,bracket,conflicts
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [
        competitionId,
        divisionId,
        resultVersion,
        JSON.stringify(bracket.bracket),
        JSON.stringify(bracket.conflicts ?? []),
      ],
    );
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
       WHERE m.division_id=$1 AND ($2::integer IS NULL OR s.result_version <= $2)
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
    const division = required(
      await tx.unsafe<{ id: string; name: string }>(
        `SELECT id,name FROM divisions WHERE competition_id=$1 ORDER BY created_at,id LIMIT 1`,
        [competitionId],
      ),
      "Division not found",
    );
    const schedule =
      scheduleVersion > 0
        ? await tx.unsafe<{
            id: string;
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
            `SELECT m.id,m.code,m.stage,m.home_entry_id,m.away_entry_id,
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
            `SELECT DISTINCT ON (m.id) m.id,m.code,m.stage,m.home_entry_id,m.away_entry_id,
                  home.name AS home_name,away.name AS away_name,
                  s.home_score,s.away_score,s.state,s.created_at
           FROM matches m JOIN match_result_snapshots s ON s.match_id=m.id
           JOIN division_entries home ON home.id=m.home_entry_id
           JOIN division_entries away ON away.id=m.away_entry_id
           WHERE m.competition_id=$1 AND s.result_version <= $2
           ORDER BY m.id,s.result_version DESC`,
            [competitionId, resultVersion],
          )
        : [];
    const standings =
      resultVersion > 0
        ? await tx.unsafe<{ standings: unknown; explanation: unknown }>(
            `SELECT standings,explanation FROM standings_snapshots
           WHERE competition_id=$1 AND result_version <= $2 ORDER BY result_version DESC LIMIT 1`,
            [competitionId, resultVersion],
          )
        : [];
    const bracket =
      resultVersion > 0
        ? await tx.unsafe<{ bracket: unknown; conflicts: unknown }>(
            `SELECT bracket,conflicts FROM bracket_snapshots
           WHERE competition_id=$1 AND result_version <= $2 ORDER BY result_version DESC LIMIT 1`,
            [competitionId, resultVersion],
          )
        : [];
    const publicSchedule: PublicScheduledMatch[] = schedule.map((match) => ({
      id: match.id,
      code: match.code,
      stage: match.stage,
      home: { id: match.home_entry_id, name: match.home_name ?? "TBD" },
      away: { id: match.away_entry_id, name: match.away_name ?? "TBD" },
      starts_at: serializedDate(match.starts_at),
      ends_at: serializedDate(match.ends_at),
      area: { id: match.area_id, name: match.area_name },
    }));
    const publicResults: PublicMatchResult[] = results.map((match) => ({
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
    const projection: Omit<PublicCompetitionProjection, "last_updated_at"> = {
      competition: {
        ...competition,
        status: publicCompetitionStatus,
        starts_on: serializedDate(competition.starts_on).slice(0, 10),
        ends_on: serializedDate(competition.ends_on).slice(0, 10),
      },
      division,
      publication: { schedule_version: scheduleVersion, result_version: resultVersion },
      schedule: publicSchedule,
      results: publicResults,
      standings: standings[0]
        ? { standings: jsonValue(standings[0].standings), explanation: jsonValue(standings[0].explanation) }
        : null,
      bracket: bracket[0]
        ? { bracket: jsonValue(bracket[0].bracket), conflicts: jsonValue(bracket[0].conflicts) }
        : null,
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
    return {
      ...jsonValue<Omit<PublicCompetitionProjection, "last_updated_at">>(row.projection),
      last_updated_at: date(row.generated_at).toISOString(),
    };
  }

  async competitionWorkspace(actor: Phase2Actor, competitionId: string) {
    await this.requireCompetitionAccess(this.sql, competitionId, actor, false);
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
              COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'seed',e.seed,'status',e.status)
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
                'starts_at',sm.starts_at,'ends_at',sm.ends_at
              ) ORDER BY sm.starts_at,pa.sort_order,m.ordinal) FILTER (WHERE sm.match_id IS NOT NULL),'[]'::jsonb) AS matches
       FROM schedule_revisions sr
       LEFT JOIN scheduled_matches sm ON sm.schedule_revision_id=sr.id
       LEFT JOIN matches m ON m.id=sm.match_id LEFT JOIN playing_areas pa ON pa.id=sm.playing_area_id
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
      `SELECT p.id,p.match_id,p.role,p.scope,p.expires_at,p.created_at,p.revoked_at
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
    };
  }

  async scoringSessionState(auth: {
    sessionId: string;
    sessionToken: string;
    generation: number;
  }): Promise<ScoringSessionState> {
    return this.transaction(async (tx) => {
      const session = await this.authenticateScoringSession(tx, auth.sessionId, auth.sessionToken, auth.generation);
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
        }>(
          `SELECT m.id,c.slug AS competition_slug,m.code,m.stage,m.state,m.home_entry_id,m.away_entry_id,
                  home.name AS home_name,away.name AS away_name
           FROM matches m JOIN competitions c ON c.id=m.competition_id
           LEFT JOIN division_entries home ON home.id=m.home_entry_id
           LEFT JOIN division_entries away ON away.id=m.away_entry_id WHERE m.id=$1`,
          [session.match_id],
        ),
        "Match not found",
      );
      const events = await this.persistedEvents(tx, session.match_id);
      const reversed = new Set(
        events
          .filter((event) => event.type === "goal_reversed")
          .map((event) => String(event.payload.reversal_target_event_id ?? "")),
      );
      const goals = events.filter((event) => event.type === "goal_added" && !reversed.has(event.clientEventId));
      return {
        competition: { slug: match.competition_slug },
        match: {
          id: match.id,
          code: match.code,
          stage: match.stage,
          state: match.state,
          home: { id: match.home_entry_id, name: match.home_name },
          away: { id: match.away_entry_id, name: match.away_name },
        },
        writer: {
          generation: session.generation,
          expires_at: date(session.expires_at).toISOString(),
          read_only: false,
        },
        score: {
          home: goals.filter((event) => event.teamSlot === "home").length,
          away: goals.filter((event) => event.teamSlot === "away").length,
        },
        through_sequence: events.at(-1)?.sequence ?? 0,
        events: events.map((event) => ({
          client_event_id: event.clientEventId,
          sequence: event.sequence,
          type: event.type,
          team_slot: event.teamSlot,
          scorer: event.scorer,
          manual_period: event.manualPeriod,
          manual_event_seconds: event.manualEventSeconds,
          payload: event.payload,
          correction_reason: event.correctionReason,
          occurred_at: event.occurredAt.toISOString(),
        })),
      };
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
