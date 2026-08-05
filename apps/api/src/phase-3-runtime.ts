import { randomUUID } from "node:crypto";
import type { Phase3SportCode } from "@matchday/contracts";
import {
  competitionDomain,
  type AdvancementRule,
  type AdvancementSlot,
  type FormatGraph,
  type StandingsMatchResult,
  type StandingsParticipant,
  type StandingsSnapshot,
  type ScheduledStandingsMatch,
  type SportPack,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import type { Phase3DomainAdapter } from "./phase-3-domain-adapter.js";

export type Phase3Actor = { accountId: string };

export type Phase3OrganisationOption = {
  id: string;
  name: string;
  role: "owner" | "organiser";
};

export type Phase3OrganiserCompetition = {
  id: string;
  name: string;
  slug: string;
  sport_code: Phase3SportCode;
  status: string;
  starts_on: string;
  ends_on: string;
  organisation_name: string;
  membership_role: "owner" | "organiser" | "viewer";
};

export type Phase3CompetitionCreateInput = {
  organisationId: string;
  name: string;
  slug: string;
  sportCode: Phase3SportCode;
  venue: string;
  address: string;
  locality?: string | null;
  countryCode: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  locale: string;
};

export type Phase3CompetitionUpdateInput = {
  name?: string;
  slug?: string;
  sportCode?: Phase3SportCode;
  venue?: string;
  address?: string;
  locality?: string | null;
  countryCode?: string;
  startsOn?: string;
  endsOn?: string;
  timezone?: string;
  locale?: string;
};

export type Phase3AvailabilityInput = { start: string; end: string };

export type Phase3CapacityWindowInput = {
  id?: string;
  date: string;
  startTime: string;
  endTime: string;
  crossMidnight?: boolean;
};

export type Phase3CapacityReplaceInput = {
  revision: number;
  timezone?: string;
  areas: Array<{
    id?: string;
    name: string;
    sortOrder?: number;
    slotMinutes: number;
    fixedReserveSlots?: number;
    availability: Phase3CapacityWindowInput[];
    unavailable?: Phase3CapacityWindowInput[];
  }>;
};

export type Phase3CapacityResponse = {
  competition_id: string;
  revision: number;
  timezone: string;
  permission: "read" | "write";
  read_only: boolean;
  areas: Array<{
    id: string;
    name: string;
    sort_order: number;
    slot_minutes: number;
    fixed_reserve_slots: number;
    availability: Array<{
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      cross_midnight: boolean;
      starts_at: string;
      ends_at: string;
    }>;
    unavailable: Array<{
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      cross_midnight: boolean;
      starts_at: string;
      ends_at: string;
    }>;
  }>;
  effective: ReturnType<Phase3DomainAdapter["capacity"]>;
};

type DomainCompetition = competitionDomain.Competition;
type DomainCommandResult<T> = competitionDomain.CommandResult<T>;

function required<T>(rows: readonly T[], message: string): T {
  const value = rows[0];
  if (!value) throw new ApiError(404, "NOT_FOUND", message);
  return value;
}

function decodedJson<T>(value: T | string): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function expectDomain<T>(result: DomainCommandResult<T>): T {
  if (result.ok) return result.value;
  const validation = ["VALIDATION_ERROR", "IMPORT_VALIDATION_FAILED", "FREE_ENTRY_LIMIT_REACHED"].includes(
    result.error.code,
  );
  throw new ApiError(validation ? 422 : 409, result.error.code, result.error.message);
}

export class Phase3Runtime {
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly domain: Phase3DomainAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(operation: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    if (!this.sql.begin) throw new Error("Phase 3 mutations require a transaction-capable PostgreSQL client.");
    return this.sql.begin(operation);
  }

  private async persistedJsonHash(tx: PostgresJsSql, value: unknown): Promise<string> {
    const row = required(
      await tx.unsafe<{ definition_hash: string }>(
        `SELECT encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb($1::jsonb),'UTF8')),'hex') AS definition_hash`,
        [value],
      ),
      "Canonical JSON hash could not be calculated",
    );
    return row.definition_hash;
  }

  private async mutationReplay<T>(
    tx: PostgresJsSql,
    organisationId: string,
    idempotencyKey: string,
    operation: string,
    input: unknown,
  ): Promise<T | undefined> {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `${operation}:${organisationId}:${idempotencyKey}`,
    ]);
    const requestHash = this.domain.hash(input);
    const receipt = (
      await tx.unsafe<{ operation: string; request_hash: string; response: unknown }>(
        `SELECT operation,request_hash,response
         FROM phase4_mutation_receipts WHERE organisation_id=$1 AND idempotency_key=$2`,
        [organisationId, idempotencyKey],
      )
    )[0];
    if (!receipt) return undefined;
    if (receipt.operation !== operation || receipt.request_hash !== requestHash) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different request");
    }
    return decodedJson(receipt.response) as T;
  }

  private async recordMutationReceipt(
    tx: PostgresJsSql,
    organisationId: string,
    idempotencyKey: string,
    operation: string,
    input: unknown,
    response: unknown,
  ): Promise<void> {
    await tx.unsafe(
      `INSERT INTO phase4_mutation_receipts
        (organisation_id,idempotency_key,operation,request_hash,response)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [organisationId, idempotencyKey, operation, this.domain.hash(input), response],
    );
  }

  /**
   * One capacity claim per division: its latest published format wins;
   * otherwise its latest structurally validated revision is selected.
   */
  private async requiredFormatSlots(
    database: PostgresJsSql,
    competitionId: string,
    excludedDivisionId?: string,
  ): Promise<number> {
    const row = required(
      await database.unsafe<{ required_match_slots: number }>(
        `SELECT COALESCE(sum(jsonb_array_length(selected.definition->'matches')),0)::int AS required_match_slots
         FROM divisions d
         CROSS JOIN LATERAL (
           SELECT fr.definition
           FROM format_revisions fr
           LEFT JOIN format_validation_evidence e ON e.format_revision_id=fr.id
           WHERE fr.competition_id=d.competition_id AND fr.division_id=d.id
             AND (fr.status='published' OR (fr.validation_contract='phase3' AND e.valid))
           ORDER BY (fr.status='published') DESC,
                    CASE WHEN fr.status='published' THEN fr.published_at END DESC NULLS LAST,
                    fr.revision DESC,fr.id DESC
           LIMIT 1
         ) selected
         WHERE d.competition_id=$1 AND ($2::uuid IS NULL OR d.id<>$2::uuid)`,
        [competitionId, excludedDivisionId ?? null],
      ),
      "Competition capacity could not be calculated",
    );
    return row.required_match_slots;
  }

  private async competitionAccess(tx: PostgresJsSql, id: string, actor: Phase3Actor, mutable: boolean) {
    const roles = mutable ? ["owner", "organiser"] : ["owner", "organiser", "viewer"];
    const rows = await tx.unsafe<{
      id: string;
      organisation_id: string;
      sport_code: Phase3SportCode;
      status: string;
      membership_role: "owner" | "organiser" | "viewer";
    }>(
      `SELECT c.id,c.organisation_id,c.sport_code,c.status,m.role AS membership_role FROM competitions c
       JOIN organisation_memberships m ON m.organisation_id=c.organisation_id
       WHERE c.id=$1 AND m.account_id=$2 AND m.status='active' AND m.role=ANY($3::text[])`,
      [id, actor.accountId, roles],
    );
    if (!rows[0]) throw new ApiError(403, "COMPETITION_ACCESS_DENIED", "Competition access denied");
    return rows[0];
  }

  private async organisationAccess(tx: PostgresJsSql, id: string, actor: Phase3Actor) {
    const rows = await tx.unsafe(
      `SELECT 1 FROM organisation_memberships
      WHERE organisation_id=$1 AND account_id=$2 AND status='active' AND role IN ('owner','organiser')`,
      [id, actor.accountId],
    );
    if (!rows[0]) throw new ApiError(403, "ORGANISATION_ACCESS_DENIED", "Organisation access denied");
  }

  private async platformAdminAccess(tx: PostgresJsSql, actor: Phase3Actor) {
    const rows = await tx.unsafe(
      `SELECT 1 FROM account_platform_roles
       WHERE account_id=$1 AND role='platform_admin' AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > $2)`,
      [actor.accountId, this.now()],
    );
    if (!rows[0]) throw new ApiError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access required");
  }

  private context(actor: Phase3Actor): competitionDomain.CommandContext {
    return { actorId: actor.accountId, occurredAt: this.now().toISOString() };
  }

  private assertMutable(competition: { status: string }): void {
    if (competition.status === "archived") {
      throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
    }
  }

  async listWritableOrganisations(actor: Phase3Actor): Promise<readonly Phase3OrganisationOption[]> {
    return this.sql.unsafe<Phase3OrganisationOption>(
      `SELECT organisation.id,organisation.name,membership.role
       FROM organisation_memberships membership
       JOIN organisations organisation ON organisation.id=membership.organisation_id
       WHERE membership.account_id=$1
         AND membership.status='active'
         AND membership.role IN ('owner','organiser')
       ORDER BY lower(organisation.name),organisation.id`,
      [actor.accountId],
    );
  }

  async listOrganiserCompetitions(actor: Phase3Actor): Promise<readonly Phase3OrganiserCompetition[]> {
    return this.sql.unsafe<Phase3OrganiserCompetition>(
      `SELECT competition.id,competition.name,competition.slug,competition.sport_code,competition.status,
              competition.starts_on::text,competition.ends_on::text,organisation.name AS organisation_name,
              membership.role AS membership_role
       FROM competitions competition
       JOIN organisation_memberships membership ON membership.organisation_id=competition.organisation_id
       JOIN organisations organisation ON organisation.id=competition.organisation_id
       WHERE membership.account_id=$1 AND membership.status='active'
       ORDER BY competition.starts_on DESC,competition.created_at DESC,competition.id DESC`,
      [actor.accountId],
    );
  }

  private async sportPack(tx: PostgresJsSql, sportCode: Phase3SportCode, version: string): Promise<SportPack> {
    const rows = await tx.unsafe<{ definition: SportPack }>(
      `SELECT definition FROM sport_pack_versions WHERE sport_code=$1 AND version=$2`,
      [sportCode, version],
    );
    return decodedJson(required(rows, "Sport pack version not found").definition);
  }

  private async currentSportPack(tx: PostgresJsSql, sportCode: Phase3SportCode, actor: Phase3Actor) {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`sport-pack:${sportCode}`]);
    let row = (
      await tx.unsafe<{
        version: string;
        schema_version: number;
        definition: SportPack;
        definition_hash: string;
      }>(
        `SELECT version,schema_version,definition,definition_hash FROM sport_pack_versions
         WHERE sport_code=$1 AND status='active' FOR SHARE`,
        [sportCode],
      )
    )[0];
    if (!row) {
      const count = required(
        await tx.unsafe<{ count: number }>(
          `SELECT count(*)::int AS count FROM sport_pack_versions WHERE sport_code=$1`,
          [sportCode],
        ),
        "Sport pack state not found",
      ).count;
      if (count > 0) throw new ApiError(409, "SPORT_PACK_NOT_ACTIVE", "No active sport pack version exists");
      const bootstrap = this.domain.sportPack(sportCode);
      const bootstrapHash = await this.persistedJsonHash(tx, bootstrap);
      await tx.unsafe(
        `INSERT INTO sport_pack_versions
         (sport_code,version,schema_version,definition,definition_hash,created_by,status,revision,activated_at,activated_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,'draft',1,NULL,NULL)`,
        [sportCode, bootstrap.version, bootstrap.schemaVersion, bootstrap, bootstrapHash, actor.accountId],
      );
      await tx.unsafe(
        `UPDATE sport_pack_versions SET status='active',revision=2,activated_at=$4,activated_by=$3
         WHERE sport_code=$1 AND version=$2`,
        [sportCode, bootstrap.version, actor.accountId, this.now()],
      );
      row = {
        version: bootstrap.version,
        schema_version: bootstrap.schemaVersion,
        definition: bootstrap,
        definition_hash: bootstrapHash,
      };
    }
    const pack = decodedJson(row.definition);
    if (
      this.domain.validateSportPack(pack).length ||
      (await this.persistedJsonHash(tx, pack)) !== row.definition_hash
    ) {
      throw new ApiError(409, "SPORT_PACK_CORRUPT", "The active sport pack failed immutable validation");
    }
    return { ...row, pack };
  }

  private async domainCompetition(tx: PostgresJsSql, competitionId: string): Promise<DomainCompetition> {
    const competition = required(
      await tx.unsafe<{
        id: string;
        organisation_id: string;
        name: string;
        slug: string;
        sport_code: Phase3SportCode;
        status: string;
        venue: string;
        address: string;
        locality: string | null;
        country_code: string;
        starts_on: string;
        ends_on: string;
        timezone: string;
        locale: string;
        first_match_started_at: Date | string | null;
        archived_from_status: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT id,organisation_id,name,slug,sport_code,status,venue,address,locality,country_code,
                starts_on::text,ends_on::text,timezone,locale,first_match_started_at,archived_from_status,
                created_at,updated_at
         FROM competitions WHERE id=$1`,
        [competitionId],
      ),
      "Competition not found",
    );
    const divisions = await tx.unsafe<{
      id: string;
      name: string;
      code: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(`SELECT id,name,code,created_at,updated_at FROM divisions WHERE competition_id=$1 ORDER BY created_at,id`, [
      competitionId,
    ]);
    const entries = await tx.unsafe<{
      id: string;
      division_id: string;
      name: string;
      entry_type: competitionDomain.EntryType;
      status: "confirmed" | "active" | "withdrawn" | "replaced";
      seed: number | null;
      metadata: Record<string, unknown>;
      availability: Phase3AvailabilityInput[];
      replacement_entry_id: string | null;
      replaces_entry_id: string | null;
      revision: number;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT e.id,e.division_id,e.name,e.entry_type,e.status,e.seed,e.metadata,e.availability,
              e.replacement_entry_id,e.replaces_entry_id,e.revision,e.created_at,e.updated_at
       FROM division_entries e JOIN divisions d ON d.id=e.division_id
       WHERE d.competition_id=$1 ORDER BY e.created_at,e.id`,
      [competitionId],
    );
    const instant = (value: Date | string | null): string | null =>
      value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    const restoredStatus = (value: string | null): competitionDomain.RestorableCompetitionStatus | null => {
      if (value === null) return null;
      return (value === "active" ? "live" : value) as competitionDomain.RestorableCompetitionStatus;
    };
    return {
      id: competition.id,
      organisationId: competition.organisation_id,
      name: competition.name,
      slug: competition.slug,
      sport: competition.sport_code,
      status: (competition.status === "active" ? "live" : competition.status) as competitionDomain.CompetitionStatus,
      location: {
        venue: competition.venue,
        address: competition.address,
        locality: competition.locality,
        countryCode: competition.country_code,
      },
      startDate: competition.starts_on,
      endDate: competition.ends_on,
      timeZone: competition.timezone,
      locale: competition.locale,
      firstMatchStartedAt: instant(competition.first_match_started_at),
      archivedFromStatus: restoredStatus(competition.archived_from_status),
      divisions: divisions.map((division) => ({
        id: division.id,
        name: division.name,
        code: division.code,
        entries: entries
          .filter((entry) => entry.division_id === division.id)
          .map((entry) => ({
            id: entry.id,
            divisionId: entry.division_id,
            name: entry.name,
            type: entry.entry_type,
            status: entry.status === "confirmed" ? "active" : entry.status,
            seed: entry.seed,
            revision: entry.revision,
            metadata: {
              club:
                typeof decodedJson(entry.metadata).club === "string"
                  ? (decodedJson(entry.metadata).club as string)
                  : null,
              association:
                typeof decodedJson(entry.metadata).association === "string"
                  ? (decodedJson(entry.metadata).association as string)
                  : null,
              countryCode:
                typeof decodedJson(entry.metadata).countryCode === "string"
                  ? (decodedJson(entry.metadata).countryCode as string)
                  : null,
            },
            availability: Array.isArray(decodedJson(entry.availability)) ? decodedJson(entry.availability) : [],
            replacementEntryId: entry.replacement_entry_id,
            replacesEntryId: entry.replaces_entry_id,
            createdAt: instant(entry.created_at)!,
            updatedAt: instant(entry.updated_at)!,
          })),
        createdAt: instant(division.created_at)!,
        updatedAt: instant(division.updated_at)!,
      })),
      createdAt: instant(competition.created_at)!,
      updatedAt: instant(competition.updated_at)!,
    };
  }

  private async evidence(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    organisationId: string | null,
    requestId: string,
    action: string,
    targetType: string,
    targetId: string,
    after: unknown,
    actorType: "account" | "platform_admin" = "account",
  ) {
    const occurredAt = this.now();
    await tx.unsafe(
      `INSERT INTO audit_events (occurred_at,request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [occurredAt, requestId, actor.accountId, actorType, organisationId, action, targetType, targetId, after],
    );
    await tx.unsafe(
      `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload,idempotency_key,created_at,available_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$6)`,
      [targetType, targetId, action, { target_id: targetId }, `${requestId}:${action}:${targetId}`, occurredAt],
    );
  }

  async readCompetition(actor: Phase3Actor, competitionId: string) {
    await this.competitionAccess(this.sql, competitionId, actor, false);
    const rows = await this.sql.unsafe<Record<string, unknown>>(
      `SELECT id,organisation_id,name,slug,sport_code,status,venue,address,locality,country_code,
              starts_on,ends_on,timezone,locale,plan_tier,revision
       FROM competitions WHERE id=$1`,
      [competitionId],
    );
    const row = required(rows, "Competition not found");
    return {
      ...row,
      location: { venue: row.venue, address: row.address, locality: row.locality, country_code: row.country_code },
    };
  }

  async mutateCompetition(
    actor: Phase3Actor,
    competitionId: string,
    input: {
      revision: number;
      action: "update" | "archive" | "restore";
      patch?: Phase3CompetitionUpdateInput;
      name?: string;
    },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      if (competition.status === "archived" && input.action !== "restore")
        throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
      const current = await this.domainCompetition(tx, competitionId);
      const context = this.context(actor);
      const patch = input.patch ?? (input.name === undefined ? {} : { name: input.name });
      if (input.action === "update") {
        expectDomain(
          this.domain.updateCompetition(
            current,
            {
              ...(patch.name === undefined ? {} : { name: patch.name }),
              ...(patch.slug === undefined ? {} : { slug: patch.slug }),
              ...(patch.sportCode === undefined ? {} : { sport: patch.sportCode }),
              ...(patch.venue === undefined &&
              patch.address === undefined &&
              patch.locality === undefined &&
              patch.countryCode === undefined
                ? {}
                : {
                    location: {
                      venue: patch.venue ?? current.location.venue,
                      address: patch.address ?? current.location.address,
                      locality: patch.locality === undefined ? current.location.locality : patch.locality,
                      countryCode: patch.countryCode ?? current.location.countryCode,
                    },
                  }),
              ...(patch.startsOn === undefined ? {} : { startDate: patch.startsOn }),
              ...(patch.endsOn === undefined ? {} : { endDate: patch.endsOn }),
              ...(patch.timezone === undefined ? {} : { timeZone: patch.timezone }),
              ...(patch.locale === undefined ? {} : { locale: patch.locale }),
            },
            context,
          ),
        );
      } else if (input.action === "archive") {
        expectDomain(competitionDomain.archiveCompetition(current, context));
      } else {
        expectDomain(competitionDomain.restoreCompetition(current, context));
      }
      const occurredAt = this.now();
      const rows = await tx.unsafe<Record<string, unknown>>(
        `UPDATE competitions SET
          name=CASE WHEN $3='update' THEN COALESCE($4,name) ELSE name END,
          slug=CASE WHEN $3='update' THEN COALESCE($5,slug) ELSE slug END,
          sport_code=CASE WHEN $3='update' THEN COALESCE($6,sport_code) ELSE sport_code END,
          venue=CASE WHEN $3='update' THEN COALESCE($7,venue) ELSE venue END,
          address=CASE WHEN $3='update' THEN COALESCE($8,address) ELSE address END,
          locality=CASE WHEN $3='update' AND $9 THEN $10 ELSE locality END,
          country_code=CASE WHEN $3='update' THEN COALESCE($11,country_code) ELSE country_code END,
          starts_on=CASE WHEN $3='update' THEN COALESCE($12::date,starts_on) ELSE starts_on END,
          ends_on=CASE WHEN $3='update' THEN COALESCE($13::date,ends_on) ELSE ends_on END,
          timezone=CASE WHEN $3='update' THEN COALESCE($14,timezone) ELSE timezone END,
          locale=CASE WHEN $3='update' THEN COALESCE($15,locale) ELSE locale END,
          archived_from_status=CASE WHEN $3='archive' THEN status WHEN $3='restore' THEN NULL ELSE archived_from_status END,
          status=CASE WHEN $3='archive' THEN 'archived' WHEN $3='restore' THEN COALESCE(archived_from_status,'draft') ELSE status END,
          archived_at=CASE WHEN $3='archive' THEN $16 ELSE archived_at END,
          restored_at=CASE WHEN $3='restore' THEN $16 ELSE restored_at END,
          revision=revision+1,updated_at=$16
         WHERE id=$1 AND revision=$2
           AND ($3<>'restore' OR status='archived') AND ($3<>'archive' OR status<>'archived')
         RETURNING id,status,revision,name,slug,sport_code,venue,address,locality,country_code,starts_on,ends_on,timezone,locale`,
        [
          competitionId,
          input.revision,
          input.action,
          patch.name?.trim() ?? null,
          patch.slug ?? null,
          patch.sportCode ?? null,
          patch.venue?.trim() ?? null,
          patch.address?.trim() ?? null,
          patch.locality !== undefined,
          patch.locality?.trim() || null,
          patch.countryCode ?? null,
          patch.startsOn ?? null,
          patch.endsOn ?? null,
          patch.timezone ?? null,
          patch.locale ?? null,
          occurredAt,
        ],
      );
      const result = rows[0];
      if (!result) throw new ApiError(409, "REVISION_CONFLICT", "Competition revision or lifecycle state is stale");
      if (input.action === "update" && patch.sportCode !== undefined && patch.sportCode !== current.sport) {
        const pack = this.domain.sportPack(patch.sportCode);
        const packHash = this.domain.hash(pack);
        await tx.unsafe(
          `INSERT INTO sport_pack_versions (sport_code,version,schema_version,definition,definition_hash)
           VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (sport_code,version) DO NOTHING`,
          [patch.sportCode, pack.version, pack.schemaVersion, pack, packHash],
        );
        await tx.unsafe(
          `UPDATE competition_sport_settings SET sport_code=$2,pack_version=$3,pack_schema_version=$4,
             recommended_snapshot=$5::jsonb,settings_override='{}'::jsonb,customised=false,
             revision=revision+1,updated_by=$6,updated_at=$7 WHERE competition_id=$1`,
          [
            competitionId,
            patch.sportCode,
            pack.version,
            pack.schemaVersion,
            pack.recommendedSettings,
            actor.accountId,
            occurredAt,
          ],
        );
        await tx.unsafe(
          `UPDATE division_sport_settings SET sport_code=$2,pack_version=$3,settings_override='{}'::jsonb,
             revision=revision+1,updated_by=$4,updated_at=$5 WHERE competition_id=$1`,
          [competitionId, patch.sportCode, pack.version, actor.accountId, occurredAt],
        );
      }
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        `competition.${input.action}d`,
        "competition",
        competitionId,
        result,
      );
      return result;
    });
  }

  async createDivision(
    actor: Phase3Actor,
    competitionId: string,
    input: { name: string; code?: string; entryLimit: 8 | 12 | 16 | 24 | 48 },
    requestId: string,
    idempotencyKey: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      const operation = "division.create";
      const replay = await this.mutationReplay<Record<string, unknown>>(
        tx,
        competition.organisation_id,
        idempotencyKey,
        operation,
        { competitionId, input },
      );
      if (replay) return replay;
      if (competition.status === "archived")
        throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
      const rows = await tx.unsafe<Record<string, unknown>>(
        `INSERT INTO divisions (competition_id,name,code,team_limit) VALUES ($1,$2,$3,$4)
         RETURNING id,competition_id,name,code,team_limit,revision`,
        [competitionId, input.name.trim(), input.code ?? null, input.entryLimit],
      );
      const division = required(rows, "Division was not created");
      await tx.unsafe(
        `INSERT INTO division_sport_settings (division_id,competition_id,sport_code,pack_version,settings_override,updated_by)
         SELECT $1,competition_id,sport_code,pack_version,'{}'::jsonb,$2
         FROM competition_sport_settings WHERE competition_id=$3`,
        [division.id, actor.accountId, competitionId],
      );
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "division.created",
        "division",
        String(division.id),
        division,
      );
      await this.recordMutationReceipt(
        tx,
        competition.organisation_id,
        idempotencyKey,
        operation,
        { competitionId, input },
        division,
      );
      return division;
    });
  }

  async listDivisions(actor: Phase3Actor, competitionId: string) {
    await this.competitionAccess(this.sql, competitionId, actor, false);
    return this.sql.unsafe<Record<string, unknown>>(
      `SELECT id,competition_id,name,code,team_limit,settings_override,revision,created_at,updated_at
       FROM divisions WHERE competition_id=$1 ORDER BY created_at,id`,
      [competitionId],
    );
  }

  async updateDivision(
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    input: { revision: number; name?: string; code?: string | null; entryLimit?: 8 | 12 | 16 | 24 | 48 },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      if (competition.status === "archived")
        throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
      const rows = await tx.unsafe<Record<string, unknown>>(
        `UPDATE divisions SET name=COALESCE($4,name),code=CASE WHEN $5 THEN $6 ELSE code END,
           team_limit=COALESCE($7,team_limit),revision=revision+1,updated_at=$8
         WHERE id=$1 AND competition_id=$2 AND revision=$3 RETURNING id,competition_id,name,code,team_limit,revision`,
        [
          divisionId,
          competitionId,
          input.revision,
          input.name?.trim() ?? null,
          input.code !== undefined,
          input.code ?? null,
          input.entryLimit ?? null,
          this.now(),
        ],
      );
      const division = rows[0];
      if (!division) throw new ApiError(409, "REVISION_CONFLICT", "Division revision is stale");
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "division.updated",
        "division",
        divisionId,
        division,
      );
      return division;
    });
  }

  async deleteDivision(actor: Phase3Actor, competitionId: string, divisionId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      const rows = await tx.unsafe<{ id: string }>(
        `DELETE FROM divisions d WHERE d.id=$1 AND d.competition_id=$2
         AND NOT EXISTS (SELECT 1 FROM division_entries e WHERE e.division_id=d.id)
         AND NOT EXISTS (SELECT 1 FROM format_revisions f WHERE f.division_id=d.id) RETURNING d.id`,
        [divisionId, competitionId],
      );
      required(rows, "Division not found");
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "division.deleted",
        "division",
        divisionId,
        { id: divisionId },
      );
      return { id: divisionId, deleted: true };
    });
  }

  async listEntries(actor: Phase3Actor, competitionId: string, divisionId: string) {
    await this.competitionAccess(this.sql, competitionId, actor, false);
    required(
      await this.sql.unsafe(`SELECT id FROM divisions WHERE id=$1 AND competition_id=$2`, [divisionId, competitionId]),
      "Division not found",
    );
    return this.sql.unsafe<Record<string, unknown>>(
      `SELECT id,division_id,name,entry_type,status,seed,metadata,availability,replacement_entry_id,replaces_entry_id,revision,created_at,updated_at
       FROM division_entries WHERE division_id=$1 ORDER BY created_at,id`,
      [divisionId],
    );
  }

  private async assertEntriesEditable(tx: PostgresJsSql, competitionId: string, divisionId: string) {
    const format = (
      await tx.unsafe<{ id: string }>(
        `SELECT id FROM format_revisions WHERE competition_id=$1 AND division_id=$2 LIMIT 1 FOR KEY SHARE`,
        [competitionId, divisionId],
      )
    )[0];
    if (format) throw new ApiError(409, "ENTRY_MUTATION_LOCKED_BY_FORMAT", "Entries are locked after format creation");
  }

  async updateEntry(
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    entryId: string,
    input: {
      revision: number;
      name?: string;
      seed?: number | null;
      metadata?: Record<string, unknown>;
      availability?: unknown[];
    },
    requestId: string,
    idempotencyKey: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      const operation = "entry.update";
      const replay = await this.mutationReplay<Record<string, unknown>>(
        tx,
        competition.organisation_id,
        idempotencyKey,
        operation,
        { competitionId, divisionId, entryId, input },
      );
      if (replay) return replay;
      this.assertMutable(competition);
      required(
        await tx.unsafe(`SELECT id FROM divisions WHERE id=$1 AND competition_id=$2 FOR UPDATE`, [
          divisionId,
          competitionId,
        ]),
        "Division not found",
      );
      await this.assertEntriesEditable(tx, competitionId, divisionId);
      const current = await this.domainCompetition(tx, competitionId);
      expectDomain(
        this.domain.updateEntry(
          current,
          divisionId,
          entryId,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.seed === undefined ? {} : { seed: input.seed }),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            ...(input.availability === undefined
              ? {}
              : { availability: input.availability as Phase3AvailabilityInput[] }),
          },
          this.context(actor),
        ),
      );
      const rows = await tx.unsafe<Record<string, unknown>>(
        `UPDATE division_entries SET name=COALESCE($4,name),seed=CASE WHEN $5 THEN $6::int ELSE seed END,
          metadata=COALESCE($7::jsonb,metadata),availability=COALESCE($8::jsonb,availability),revision=revision+1,updated_at=$9
         WHERE id=$1 AND division_id=$2 AND revision=$3 AND status IN ('confirmed','active')
         RETURNING id,division_id,name,entry_type,status,seed,metadata,availability,revision`,
        [
          entryId,
          divisionId,
          input.revision,
          input.name?.trim() ?? null,
          input.seed !== undefined,
          input.seed ?? null,
          input.metadata ?? null,
          input.availability ?? null,
          this.now(),
        ],
      );
      const entry = rows[0];
      if (!entry) throw new ApiError(409, "REVISION_CONFLICT", "Entry revision or status is stale");
      await this.evidence(tx, actor, competition.organisation_id, requestId, "entry.updated", "entry", entryId, entry);
      await this.recordMutationReceipt(
        tx,
        competition.organisation_id,
        idempotencyKey,
        operation,
        { competitionId, divisionId, entryId, input },
        entry,
      );
      return entry;
    });
  }

  async deleteEntry(
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    entryId: string,
    revision: number,
    requestId: string,
    idempotencyKey: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      const operation = "entry.delete";
      const input = { competitionId, divisionId, entryId, revision };
      const replay = await this.mutationReplay<{ id: string; deleted: true }>(
        tx,
        competition.organisation_id,
        idempotencyKey,
        operation,
        input,
      );
      if (replay) return replay;
      this.assertMutable(competition);
      required(
        await tx.unsafe(`SELECT id FROM divisions WHERE id=$1 AND competition_id=$2 FOR UPDATE`, [
          divisionId,
          competitionId,
        ]),
        "Division not found",
      );
      await this.assertEntriesEditable(tx, competitionId, divisionId);
      const rows = await tx.unsafe<{ id: string }>(
        `DELETE FROM division_entries e WHERE e.id=$1 AND e.division_id=$2 AND e.revision=$3 AND e.status IN ('confirmed','active')
         AND e.replacement_entry_id IS NULL AND e.replaces_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.home_entry_id=e.id OR m.away_entry_id=e.id) RETURNING e.id`,
        [entryId, divisionId, revision],
      );
      if (!rows[0]) throw new ApiError(409, "REVISION_CONFLICT", "Entry revision or status is stale");
      await this.evidence(tx, actor, competition.organisation_id, requestId, "entry.deleted", "entry", entryId, {
        id: entryId,
      });
      const result = { id: entryId, deleted: true as const };
      await this.recordMutationReceipt(tx, competition.organisation_id, idempotencyKey, operation, input, result);
      return result;
    });
  }

  private async applyWithdrawalResultsInTransaction(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    competition: { organisation_id: string },
    competitionId: string,
    divisionId: string,
    entryId: string,
    reason: string,
    requestId: string,
  ) {
    const publishedFormat = await tx.unsafe<{ id: string }>(
      `SELECT id FROM format_revisions WHERE division_id=$1 AND status='published' ORDER BY revision DESC LIMIT 1`,
      [divisionId],
    );
    if (!publishedFormat[0]) return null;
    const divisionPlay = required(
      await tx.unsafe<{ started: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.competition_id=$1 AND m.division_id=$2
             AND (m.state IN ('in_progress','final','corrected')
               OR EXISTS (SELECT 1 FROM match_result_snapshots result WHERE result.match_id=m.id))
         ) AS started`,
        [competitionId, divisionId],
      ),
      "Division play state could not be determined",
    );
    if (!divisionPlay.started) return null;

    const publication = required(
      await tx.unsafe<{ result_version: number }>(
        `SELECT result_version FROM competition_publications WHERE competition_id=$1 FOR UPDATE`,
        [competitionId],
      ),
      "Competition publication state not found",
    );
    const settings = required(
      await tx.unsafe<{
        pack_version: string;
        definition: SportPack;
        recommended_snapshot: Record<string, unknown>;
        competition_override: Record<string, unknown>;
        division_override: Record<string, unknown> | null;
      }>(
        `SELECT css.pack_version,sp.definition,css.recommended_snapshot,
                css.settings_override AS competition_override,dss.settings_override AS division_override
         FROM competition_sport_settings css
         JOIN sport_pack_versions sp ON sp.sport_code=css.sport_code AND sp.version=css.pack_version
         LEFT JOIN division_sport_settings dss ON dss.division_id=$2
         WHERE css.competition_id=$1`,
        [competitionId, divisionId],
      ),
      "Pinned sport settings not found",
    );
    const pack = decodedJson(settings.definition);
    const effective = this.domain.resolveSettings(
      pack,
      decodedJson(settings.recommended_snapshot),
      decodedJson(settings.competition_override),
      settings.division_override ? decodedJson(settings.division_override) : {},
    );
    if (effective.issues.length > 0)
      throw new ApiError(409, "SPORT_SETTINGS_INVALID", "Pinned sport settings are not valid for withdrawal");
    const engineConfig = this.domain.standingsConfig(pack, effective.effective);

    const entryRows = await tx.unsafe<{
      id: string;
      name: string;
      seed: number | null;
      status: "confirmed" | "active" | "withdrawn" | "replaced";
    }>(`SELECT id,name,seed,status FROM division_entries WHERE division_id=$1 ORDER BY seed NULLS LAST,id`, [
      divisionId,
    ]);
    const entries: StandingsParticipant[] = entryRows
      .filter((entry) => entry.status !== "replaced")
      .map((entry, index) => ({
        id: entry.id,
        name: entry.name,
        seed: entry.seed ?? index + 1,
        status: entry.status === "withdrawn" ? "withdrawn" : "active",
      }));
    const matches = await tx.unsafe<{
      id: string;
      home_entry_id: string;
      away_entry_id: string;
      state: string;
    }>(
      `SELECT id,home_entry_id,away_entry_id,state FROM matches
       WHERE competition_id=$1 AND division_id=$2
         AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
         AND (home_entry_id=$3 OR away_entry_id=$3)
         AND NOT EXISTS (
           SELECT 1 FROM advancement_slots controlled
           WHERE controlled.match_id=matches.id AND controlled.control='automatic' AND controlled.entry_id=$3
         )
       ORDER BY id FOR UPDATE`,
      [competitionId, divisionId, entryId],
    );
    const latestResults = await tx.unsafe<{
      match_id: string;
      home_entry_id: string;
      away_entry_id: string;
      home_score: number;
      away_score: number;
      state: "final" | "corrected";
      result_version: number;
      snapshot: Record<string, unknown>;
    }>(
      `SELECT DISTINCT ON (m.id) m.id AS match_id,m.home_entry_id,m.away_entry_id,
              s.home_score,s.away_score,s.state,s.result_version,s.snapshot
       FROM matches m JOIN match_result_snapshots s ON s.match_id=m.id
       WHERE m.competition_id=$1 AND m.division_id=$2
         AND (m.home_entry_id=$3 OR m.away_entry_id=$3)
         AND s.result_version <= $4
       ORDER BY m.id,s.result_version DESC`,
      [competitionId, divisionId, entryId, publication.result_version],
    );
    const completedIds = new Set(latestResults.map((row) => row.match_id));
    const persistedResults: StandingsMatchResult[] = latestResults.map((row) => {
      const detail = decodedJson(row.snapshot);
      const forfeitLoser = typeof detail.forfeitLoserEntryId === "string" ? detail.forfeitLoserEntryId : undefined;
      return {
        matchId: row.match_id,
        homeEntryId: row.home_entry_id,
        awayEntryId: row.away_entry_id,
        homeScore: row.home_score,
        awayScore: row.away_score,
        ...(Array.isArray(detail.homeSegments) && Array.isArray(detail.awaySegments)
          ? { homeSegments: detail.homeSegments as number[], awaySegments: detail.awaySegments as number[] }
          : {}),
        status: forfeitLoser ? "forfeit" : row.state,
        version: row.result_version,
        ...(forfeitLoser ? { forfeitLoserEntryId: forfeitLoser } : {}),
      };
    });
    const scheduledMatches: ScheduledStandingsMatch[] = matches
      .filter((match) => completedIds.has(match.id) || ["pending", "ready"].includes(match.state))
      .map((match) => ({
        matchId: match.id,
        homeEntryId: match.home_entry_id,
        awayEntryId: match.away_entry_id,
      }));
    const withdrawal = this.domain.applyWithdrawal(entries, persistedResults, scheduledMatches, entryId, engineConfig);
    const generatedIds = new Set(withdrawal.generatedForfeitMatchIds);
    const generatedForfeits = withdrawal.results.filter((result) => generatedIds.has(result.matchId));

    if (publication.result_version === 0 && generatedForfeits.length === 0) return null;
    const resultVersion = publication.result_version + 1;
    for (const result of generatedForfeits) {
      await tx.unsafe(
        `INSERT INTO match_result_snapshots
          (match_id,result_version,through_sequence,home_score,away_score,state,snapshot)
         VALUES ($1,$2,
           COALESCE((SELECT max(through_sequence)+1 FROM match_result_snapshots WHERE match_id=$1),1),
           $3,$4,'final',$5::jsonb)`,
        [
          result.matchId,
          resultVersion,
          result.homeScore,
          result.awayScore,
          {
            forfeitLoserEntryId: entryId,
            homeSegments: result.homeSegments ?? [],
            awaySegments: result.awaySegments ?? [],
            generatedBy: "entry_withdrawal",
            withdrawalReason: reason,
            settingsVersion: engineConfig.version,
          },
        ],
      );
      await tx.unsafe(`UPDATE matches SET state='final' WHERE id=$1 AND state IN ('pending','ready')`, [
        result.matchId,
      ]);
    }
    await tx.unsafe(
      `UPDATE competition_publications
       SET result_version=$2,results_published_at=$3,updated_at=$3 WHERE competition_id=$1`,
      [competitionId, resultVersion, this.now()],
    );
    const snapshot = await this.recalculateStandingsInTransaction(
      tx,
      actor,
      competitionId,
      divisionId,
      `${requestId}:standings`,
    );
    await this.evidence(
      tx,
      actor,
      competition.organisation_id,
      requestId,
      "entry.withdrawal_results_applied",
      "entry",
      entryId,
      {
        result_version: resultVersion,
        generated_forfeit_match_ids: withdrawal.generatedForfeitMatchIds,
        explanation: withdrawal.explanation,
        standings_snapshot_id: String((snapshot as Record<string, unknown>).id),
      },
    );
    return snapshot;
  }

  async mutateEntry(
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    input: {
      action: "create" | "withdraw" | "replace";
      entryId?: string;
      name?: string;
      entryType?: string;
      seed?: number | null;
      metadata?: Record<string, unknown>;
      availability?: Phase3AvailabilityInput[];
      reason?: string;
      replacementName?: string;
      replacementAvailability?: Phase3AvailabilityInput[];
    },
    requestId: string,
    idempotencyKey: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      const operation = `entry.${input.action}`;
      const replay = await this.mutationReplay<Record<string, unknown>>(
        tx,
        competition.organisation_id,
        idempotencyKey,
        operation,
        { competitionId, divisionId, input },
      );
      if (replay) return replay;
      this.assertMutable(competition);
      required(
        await tx.unsafe(`SELECT id FROM divisions WHERE id=$1 AND competition_id=$2 FOR UPDATE`, [
          divisionId,
          competitionId,
        ]),
        "Division not found",
      );
      if (input.action === "create") await this.assertEntriesEditable(tx, competitionId, divisionId);
      const current = await this.domainCompetition(tx, competitionId);
      const plan = required(
        await tx.unsafe<{ plan_tier: competitionDomain.PlanTier }>(`SELECT plan_tier FROM competitions WHERE id=$1`, [
          competitionId,
        ]),
        "Competition not found",
      ).plan_tier;
      const context = this.context(actor);
      let rows: readonly Record<string, unknown>[];
      if (input.action === "create") {
        const id = randomUUID();
        const entryType = (input.entryType ?? "team") as competitionDomain.EntryType;
        expectDomain(
          this.domain.addEntry(
            current,
            divisionId,
            {
              id,
              name: input.name ?? "",
              type: entryType,
              ...(input.seed === undefined ? {} : { seed: input.seed }),
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
              ...(input.availability === undefined ? {} : { availability: input.availability }),
            },
            plan,
            context,
          ),
        );
        rows = await tx.unsafe(
          `INSERT INTO division_entries (id,division_id,name,entry_type,seed,metadata,availability,status)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'active') RETURNING *`,
          [
            id,
            divisionId,
            input.name?.trim(),
            entryType,
            input.seed ?? null,
            input.metadata ?? {},
            input.availability ?? [],
          ],
        );
      } else if (input.action === "withdraw") {
        expectDomain(this.domain.withdrawEntry(current, divisionId, input.entryId ?? "", input.reason ?? "", context));
        rows = await tx.unsafe(
          `UPDATE division_entries SET status='withdrawn',withdrawn_at=$3,withdrawal_reason=$4,revision=revision+1,updated_at=$3
           WHERE id=$1 AND division_id=$2 AND status IN ('confirmed','active') RETURNING *`,
          [input.entryId, divisionId, this.now(), input.reason!.trim()],
        );
        required(rows, "Entry withdrawal failed");
        await this.applyWithdrawalResultsInTransaction(
          tx,
          actor,
          competition,
          competitionId,
          divisionId,
          input.entryId!,
          input.reason!.trim(),
          requestId,
        );
      } else {
        const replacementId = randomUUID();
        const sourceState = current.divisions
          .find((division) => division.id === divisionId)
          ?.entries.find((entry) => entry.id === input.entryId);
        expectDomain(
          this.domain.replaceEntry(
            current,
            divisionId,
            input.entryId ?? "",
            {
              id: replacementId,
              name: input.replacementName ?? "",
              type: sourceState?.type ?? "team",
              ...(sourceState?.seed === undefined ? {} : { seed: sourceState.seed }),
              ...(sourceState?.metadata === undefined ? {} : { metadata: sourceState.metadata }),
              ...(input.replacementAvailability === undefined && sourceState?.availability === undefined
                ? {}
                : { availability: input.replacementAvailability ?? sourceState?.availability ?? [] }),
            },
            plan,
            context,
          ),
        );
        const source = required(
          await tx.unsafe<{
            id: string;
            seed: number | null;
            entry_type: string;
            metadata: unknown;
            availability: unknown;
          }>(
            `UPDATE division_entries SET status='replaced',revision=revision+1,updated_at=$3
           WHERE id=$1 AND division_id=$2 AND status IN ('confirmed','active','withdrawn')
           RETURNING id,seed,entry_type,metadata,availability`,
            [input.entryId, divisionId, this.now()],
          ),
          "Entry not found",
        );
        const replacement = required(
          await tx.unsafe<{ id: string }>(
            `INSERT INTO division_entries (id,division_id,name,seed,entry_type,status,replaces_entry_id,metadata,availability)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7::jsonb,$8::jsonb) RETURNING id`,
            [
              replacementId,
              divisionId,
              input.replacementName?.trim(),
              source.seed,
              source.entry_type,
              source.id,
              decodedJson(source.metadata),
              input.replacementAvailability ?? decodedJson(source.availability),
            ],
          ),
          "Replacement entry was not created",
        );
        rows = await tx.unsafe(
          `UPDATE division_entries SET replacement_entry_id=$3 WHERE id=$1 AND division_id=$2 RETURNING *`,
          [input.entryId, divisionId, replacement.id],
        );
        await this.evidence(
          tx,
          actor,
          competition.organisation_id,
          requestId,
          "entry.created",
          "entry",
          replacement.id,
          { id: replacement.id, replaces_entry_id: source.id },
        );
      }
      const entry = required(rows, "Entry mutation failed");
      const action =
        input.action === "withdraw"
          ? "entry.withdrawn"
          : input.action === "replace"
            ? "entry.replaced"
            : "entry.created";
      await this.evidence(tx, actor, competition.organisation_id, requestId, action, "entry", String(entry.id), entry);
      await this.recordMutationReceipt(
        tx,
        competition.organisation_id,
        idempotencyKey,
        operation,
        { competitionId, divisionId, input },
        entry,
      );
      return entry;
    });
  }

  async createCompetition(
    actor: Phase3Actor,
    input: Phase3CompetitionCreateInput,
    requestId: string,
    idempotencyKey = requestId,
  ) {
    return this.transaction(async (tx) => {
      await this.organisationAccess(tx, input.organisationId, actor);
      const requestHash = this.domain.hash(input);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `competition.create:${input.organisationId}:${idempotencyKey}`,
      ]);
      const existing = (
        await tx.unsafe<{ operation: string; request_hash: string; response: unknown }>(
          `SELECT operation,request_hash,response
           FROM phase4_mutation_receipts
           WHERE organisation_id=$1 AND idempotency_key=$2`,
          [input.organisationId, idempotencyKey],
        )
      )[0];
      if (existing) {
        if (existing.operation !== "competition.create" || existing.request_hash !== requestHash) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was already used for a different competition request",
          );
        }
        return decodedJson(existing.response) as {
          id: string;
          status: "draft";
          sport_code: Phase3SportCode;
          revision: number;
          account_default_applied: boolean;
        };
      }
      const competitionId = randomUUID();
      expectDomain(
        this.domain.createCompetition(
          {
            id: competitionId,
            organisationId: input.organisationId,
            name: input.name,
            slug: input.slug,
            sport: input.sportCode,
            location: {
              venue: input.venue,
              address: input.address,
              locality: input.locality ?? null,
              countryCode: input.countryCode,
            },
            startDate: input.startsOn,
            endDate: input.endsOn,
            timeZone: input.timezone,
            locale: input.locale,
          },
          this.context(actor),
        ),
      );
      const activePack = await this.currentSportPack(tx, input.sportCode, actor);
      const pack = activePack.pack;
      const savedDefault = (
        await tx.unsafe<{ source_pack_version: string; settings: Record<string, unknown> }>(
          `SELECT source_pack_version,settings FROM account_sport_defaults WHERE account_id=$1 AND sport_code=$2`,
          [actor.accountId, input.sportCode],
        )
      )[0];
      const compatibleDefault =
        savedDefault?.source_pack_version === pack.version &&
        this.domain.validateSettings(pack, decodedJson(savedDefault.settings)).length === 0
          ? decodedJson(savedDefault.settings)
          : null;
      const settingsOverride = compatibleDefault
        ? this.domain.settingsDifference(compatibleDefault, pack.recommendedSettings)
        : {};
      const rows = await tx.unsafe<{ id: string; revision: number }>(
        `INSERT INTO competitions (id,organisation_id,created_by,name,slug,sport_code,venue,address,locality,country_code,
          starts_on,ends_on,timezone,locale,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft') RETURNING id,revision`,
        [
          competitionId,
          input.organisationId,
          actor.accountId,
          input.name.trim(),
          input.slug,
          input.sportCode,
          input.venue.trim(),
          input.address.trim(),
          input.locality?.trim() || null,
          input.countryCode,
          input.startsOn,
          input.endsOn,
          input.timezone,
          input.locale,
        ],
      );
      const competition = required(rows, "Competition was not created");
      await tx.unsafe(
        `INSERT INTO competition_sport_settings (competition_id,sport_code,pack_version,pack_schema_version,
          recommended_snapshot,settings_override,updated_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [
          competition.id,
          input.sportCode,
          pack.version,
          pack.schemaVersion,
          pack.recommendedSettings,
          settingsOverride,
          actor.accountId,
        ],
      );
      await tx.unsafe(`INSERT INTO competition_publications (competition_id) VALUES ($1)`, [competition.id]);
      await this.evidence(
        tx,
        actor,
        input.organisationId,
        requestId,
        "competition.created",
        "competition",
        competition.id,
        {
          sport_code: input.sportCode,
        },
      );
      const response = {
        id: competition.id,
        status: "draft" as const,
        sport_code: input.sportCode,
        revision: competition.revision,
        account_default_applied: compatibleDefault !== null,
      };
      await tx.unsafe(
        `INSERT INTO phase4_mutation_receipts
          (organisation_id,idempotency_key,operation,request_hash,response)
         VALUES ($1,$2,'competition.create',$3,$4::jsonb)`,
        [input.organisationId, idempotencyKey, requestHash, response],
      );
      return response;
    });
  }

  async transitionCompetition(
    actor: Phase3Actor,
    competitionId: string,
    input: { revision: number; status: "draft" | "ready" | "published" | "live" | "completed" },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      required(
        await tx.unsafe<{ status: string }>(`SELECT status FROM competitions WHERE id=$1 FOR UPDATE`, [competitionId]),
        "Competition not found",
      );
      const domainState = await this.domainCompetition(tx, competitionId);
      expectDomain(competitionDomain.transitionCompetition(domainState, input.status, this.context(actor)));
      const rows = await tx.unsafe<Record<string, unknown>>(
        `UPDATE competitions SET status=$3,revision=revision+1,updated_at=$4 WHERE id=$1 AND revision=$2 RETURNING id,status,revision`,
        [competitionId, input.revision, input.status, this.now()],
      );
      const result = rows[0];
      if (!result) throw new ApiError(409, "REVISION_CONFLICT", "Competition revision is stale");
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "competition.transitioned",
        "competition",
        competitionId,
        result,
      );
      return result;
    });
  }

  async deleteCompetition(actor: Phase3Actor, competitionId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      const rows = await tx.unsafe<{ id: string }>(
        `DELETE FROM competitions WHERE id=$1 AND status='draft' AND first_match_started_at IS NULL RETURNING id`,
        [competitionId],
      );
      if (!rows[0]) throw new ApiError(409, "LIFECYCLE_CONFLICT", "Only unstarted draft competitions can be deleted");
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "competition.deleted",
        "competition",
        competitionId,
        { id: competitionId },
      );
      return { id: competitionId, deleted: true };
    });
  }

  async duplicateCompetition(
    actor: Phase3Actor,
    competitionId: string,
    input: { name: string; slug: string; startsOn?: string; endsOn?: string },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const source = await this.competitionAccess(tx, competitionId, actor, true);
      const rows = await tx.unsafe<{ id: string }>(
        `INSERT INTO competitions (organisation_id,created_by,name,slug,sport_code,venue,address,locality,country_code,starts_on,ends_on,timezone,locale,status,plan_tier)
         SELECT organisation_id,$2,$3,$4,sport_code,venue,address,locality,country_code,COALESCE($5,starts_on),COALESCE($6,ends_on),timezone,locale,'draft','free'
         FROM competitions WHERE id=$1 RETURNING id`,
        [competitionId, actor.accountId, input.name.trim(), input.slug, input.startsOn ?? null, input.endsOn ?? null],
      );
      const copy = required(rows, "Competition was not duplicated");
      await tx.unsafe(
        `INSERT INTO competition_sport_settings (competition_id,period_count,period_minutes,slot_minutes,points_win,points_draw,points_loss,tiebreak_order,discipline_weights,customised,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override)
         SELECT $2,period_count,period_minutes,slot_minutes,points_win,points_draw,points_loss,tiebreak_order,discipline_weights,customised,$3,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
         FROM competition_sport_settings WHERE competition_id=$1`,
        [competitionId, copy.id, actor.accountId],
      );
      await tx.unsafe(`INSERT INTO competition_publications (competition_id) VALUES ($1)`, [copy.id]);
      const sourceDivisions = await tx.unsafe<{
        id: string;
        name: string;
        code: string | null;
        team_limit: number;
        settings_override: unknown;
      }>(
        `SELECT id,name,code,team_limit,settings_override FROM divisions WHERE competition_id=$1 ORDER BY created_at,id`,
        [competitionId],
      );
      for (const division of sourceDivisions) {
        const inserted = required(
          await tx.unsafe<{ id: string }>(
            `INSERT INTO divisions (competition_id,name,code,team_limit,settings_override) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
            [copy.id, division.name, division.code, division.team_limit, decodedJson(division.settings_override)],
          ),
          "Division copy failed",
        );
        await tx.unsafe(
          `INSERT INTO division_sport_settings (division_id,competition_id,sport_code,pack_version,settings_override,updated_by)
           SELECT $2,$3,sport_code,pack_version,settings_override,$4 FROM division_sport_settings WHERE division_id=$1`,
          [division.id, inserted.id, copy.id, actor.accountId],
        );
        await tx.unsafe(
          `INSERT INTO division_entries (division_id,name,seed,status,entry_type,metadata,availability)
           SELECT $2,name,seed,'active',entry_type,metadata,'[]'::jsonb
           FROM division_entries WHERE division_id=$1 AND status IN ('confirmed','active') ORDER BY created_at,id`,
          [division.id, inserted.id],
        );
      }
      await this.evidence(
        tx,
        actor,
        source.organisation_id,
        requestId,
        "competition.duplicated",
        "competition",
        copy.id,
        { id: copy.id, source_id: competitionId },
      );
      return { id: copy.id, source_id: competitionId, status: "draft" };
    });
  }

  async importEntries(
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    input: { sourceKind: "paste" | "csv"; mapping?: Record<string, string>; rows: Array<Record<string, unknown>> },
    requestId: string,
  ) {
    const rows = input.rows.map((row) => {
      const mapped: Record<string, unknown> = { ...row };
      for (const field of ["name", "entry_type", "seed", "metadata", "availability"]) {
        const source = input.mapping?.[field];
        if (source) mapped[field] = row[source];
      }
      return mapped;
    });
    const seenNames = new Set<string>();
    const seenSeeds = new Set<number>();
    const errors = rows.flatMap((row, index) => {
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const type = row.entry_type ?? "team";
      const seed = row.seed;
      const rowErrors: Array<{ row: number; path: string; code: string; message: string }> = [];
      if (!name) rowErrors.push({ row: index + 1, path: "name", code: "invalid", message: "Entry name is required" });
      else if (seenNames.has(name.toLocaleLowerCase()))
        rowErrors.push({
          row: index + 1,
          path: "name",
          code: "duplicate",
          message: "Entry name is duplicated in import",
        });
      else seenNames.add(name.toLocaleLowerCase());
      if (!["team", "individual", "placeholder"].includes(String(type)))
        rowErrors.push({ row: index + 1, path: "entry_type", code: "invalid", message: "Entry type is invalid" });
      if (seed !== undefined && seed !== null && (!Number.isInteger(seed) || Number(seed) < 1 || Number(seed) > 48))
        rowErrors.push({
          row: index + 1,
          path: "seed",
          code: "invalid",
          message: "Seed must be an integer from 1 to 48",
        });
      else if (typeof seed === "number" && seenSeeds.has(seed))
        rowErrors.push({ row: index + 1, path: "seed", code: "duplicate", message: "Seed is duplicated in import" });
      else if (typeof seed === "number") seenSeeds.add(seed);
      if (
        row.metadata !== undefined &&
        (row.metadata === null || Array.isArray(row.metadata) || typeof row.metadata !== "object")
      )
        rowErrors.push({ row: index + 1, path: "metadata", code: "invalid", message: "Metadata must be an object" });
      if (row.availability !== undefined && !Array.isArray(row.availability))
        rowErrors.push({
          row: index + 1,
          path: "availability",
          code: "invalid",
          message: "Availability must be an array",
        });
      return rowErrors;
    });
    if (rows.length === 0) {
      errors.push({ row: 1, path: "rows", code: "empty", message: "At least one import row is required" });
    }
    if (errors.length) return { ok: false as const, errors };
    const prepared = rows.map((row) => ({ id: randomUUID(), row }));
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      const division = await tx.unsafe<{ id: string }>(
        `SELECT id FROM divisions WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
        [divisionId, competitionId],
      );
      required(division, "Division not found");
      let candidate = await this.domainCompetition(tx, competitionId);
      const plan = required(
        await tx.unsafe<{ plan_tier: competitionDomain.PlanTier }>(`SELECT plan_tier FROM competitions WHERE id=$1`, [
          competitionId,
        ]),
        "Competition not found",
      ).plan_tier;
      for (const [index, item] of prepared.entries()) {
        const row = item.row;
        const result = this.domain.addEntry(
          candidate,
          divisionId,
          {
            id: item.id,
            name: String(row.name),
            type: String(row.entry_type ?? "team") as competitionDomain.EntryType,
            ...(row.seed === undefined ? {} : { seed: row.seed as number | null }),
            ...(row.metadata === undefined
              ? {}
              : { metadata: row.metadata as Partial<competitionDomain.EntryMetadata> }),
            ...(row.availability === undefined ? {} : { availability: row.availability as Phase3AvailabilityInput[] }),
          },
          plan,
          this.context(actor),
        );
        if (!result.ok) {
          return {
            ok: false as const,
            errors: result.error.issues.length
              ? result.error.issues.map((issue) => ({
                  row: index + 1,
                  path: issue.path,
                  code: issue.code,
                  message: issue.message,
                }))
              : [
                  {
                    row: index + 1,
                    path: "rows",
                    code: result.error.code.toLocaleLowerCase(),
                    message: result.error.message,
                  },
                ],
          };
        }
        candidate = result.value;
      }
      const conflicts = await tx.unsafe<{ row_number: number; path: string; message: string }>(
        `SELECT source.row_number,CASE WHEN existing_name.id IS NOT NULL THEN 'name' ELSE 'seed' END AS path,
          CASE WHEN existing_name.id IS NOT NULL THEN 'Entry name already exists' ELSE 'Entry seed already exists' END AS message
         FROM jsonb_to_recordset($2::jsonb) AS source(row_number int,name text,seed int)
         LEFT JOIN division_entries existing_name ON existing_name.division_id=$1 AND lower(existing_name.name)=lower(source.name) AND existing_name.status IN ('confirmed','active')
         LEFT JOIN division_entries existing_seed ON existing_seed.division_id=$1 AND existing_seed.seed=source.seed AND existing_seed.status IN ('confirmed','active')
         WHERE existing_name.id IS NOT NULL OR existing_seed.id IS NOT NULL`,
        [divisionId, rows.map((row, index) => ({ row_number: index + 1, name: row.name, seed: row.seed ?? null }))],
      );
      const countRows = await tx.unsafe<{ active_count: number; plan_tier: string }>(
        `SELECT count(e.id)::int AS active_count,c.plan_tier FROM competitions c JOIN divisions d ON d.competition_id=c.id
         LEFT JOIN division_entries e ON e.division_id=d.id AND e.status IN ('confirmed','active') WHERE c.id=$1 GROUP BY c.plan_tier`,
        [competitionId],
      );
      if (
        conflicts.length ||
        (countRows[0]?.plan_tier === "free" && (countRows[0]?.active_count ?? 0) + rows.length > 16)
      ) {
        return {
          ok: false as const,
          errors: conflicts.length
            ? conflicts.map((item) => ({
                row: item.row_number,
                path: item.path,
                code: "duplicate",
                message: item.message,
              }))
            : [{ row: 1, path: "rows", code: "free_limit", message: "Free plan permits at most 16 active entries" }],
        };
      }
      const importId = randomUUID();
      await tx.unsafe(
        `INSERT INTO entry_imports (id,competition_id,division_id,source_kind,mapping,row_count,created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [importId, competitionId, divisionId, input.sourceKind, input.mapping ?? {}, rows.length, actor.accountId],
      );
      const entries: Record<string, unknown>[] = [];
      for (const { id, row } of prepared) {
        const inserted = await tx.unsafe<Record<string, unknown>>(
          `INSERT INTO division_entries (id,division_id,name,entry_type,seed,metadata,availability,status,entry_import_id)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'active',$8)
           RETURNING id,division_id,name,entry_type,status,seed,metadata,availability,replacement_entry_id,revision`,
          [
            id,
            divisionId,
            String(row.name).trim(),
            row.entry_type ?? "team",
            row.seed ?? null,
            row.metadata ?? {},
            row.availability ?? [],
            importId,
          ],
        );
        entries.push(required(inserted, "Entry import failed"));
      }
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "entry_import.committed",
        "entry_import",
        importId,
        {
          inserted: entries.length,
        },
      );
      return { ok: true as const, import_id: importId, inserted: entries.length, entries };
    });
  }

  async rollbackEntryImport(
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    importId: string,
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      const entryImport = required(
        await tx.unsafe<{ id: string; row_count: number; rolled_back_at: Date | string | null }>(
          `SELECT id,row_count,rolled_back_at FROM entry_imports
           WHERE id=$1 AND competition_id=$2 AND division_id=$3 FOR UPDATE`,
          [importId, competitionId, divisionId],
        ),
        "Entry import not found",
      );
      if (entryImport.rolled_back_at !== null) {
        return { import_id: importId, rolled_back: true, idempotent_replay: true, removed: 0 };
      }
      const rollbackState = required(
        await tx.unsafe<{ imported: number; safe: number }>(
          `SELECT count(*)::int AS imported,
                  count(*) FILTER (WHERE e.status IN ('confirmed','active')
                    AND e.replacement_entry_id IS NULL AND e.replaces_entry_id IS NULL
                    AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.home_entry_id=e.id OR m.away_entry_id=e.id))::int AS safe
           FROM division_entries e WHERE e.entry_import_id=$1 AND e.division_id=$2`,
          [importId, divisionId],
        ),
        "Entry import state not found",
      );
      if (rollbackState.imported !== entryImport.row_count || rollbackState.safe !== rollbackState.imported) {
        throw new ApiError(
          409,
          "IMPORT_ROLLBACK_CONFLICT",
          "Imported entries changed or acquired match history and cannot be rolled back",
        );
      }
      const removed = await tx.unsafe<{ id: string }>(
        `DELETE FROM division_entries WHERE entry_import_id=$1 AND division_id=$2 RETURNING id`,
        [importId, divisionId],
      );
      const rolledBackAt = this.now();
      await tx.unsafe(
        `UPDATE entry_imports SET rolled_back_at=$2,rolled_back_by=$3,rollback_request_id=$4 WHERE id=$1`,
        [importId, rolledBackAt, actor.accountId, requestId],
      );
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "entry_import.rolled_back",
        "entry_import",
        importId,
        { removed: removed.length },
      );
      return { import_id: importId, rolled_back: true, idempotent_replay: false, removed: removed.length };
    });
  }

  async readSettings(actor: Phase3Actor, competitionId: string, divisionId?: string) {
    const competition = await this.competitionAccess(this.sql, competitionId, actor, false);
    const rows = divisionId
      ? await this.sql.unsafe<Record<string, unknown>>(
          `SELECT d.competition_id,d.division_id,d.sport_code,d.pack_version,p.schema_version AS pack_schema_version,
                  c.recommended_snapshot,c.settings_override AS competition_override,d.settings_override AS override,
                  d.revision,p.definition_hash,p.definition
           FROM division_sport_settings d JOIN competition_sport_settings c ON c.competition_id=d.competition_id
           JOIN sport_pack_versions p ON p.sport_code=d.sport_code AND p.version=d.pack_version
           WHERE d.competition_id=$1 AND d.division_id=$2`,
          [competitionId, divisionId],
        )
      : await this.sql.unsafe<Record<string, unknown>>(
          `SELECT c.competition_id,NULL::uuid AS division_id,c.sport_code,c.pack_schema_version,c.pack_version,
                  c.recommended_snapshot,'{}'::jsonb AS competition_override,c.settings_override AS override,
                  c.revision,p.definition_hash,p.definition
           FROM competition_sport_settings c JOIN sport_pack_versions p ON p.sport_code=c.sport_code AND p.version=c.pack_version
           WHERE c.competition_id=$1`,
          [competitionId],
        );
    const row = required(rows, "Sport settings not found");
    const recommended = decodedJson(row.recommended_snapshot as Record<string, unknown>);
    const competitionOverride = decodedJson(row.competition_override as Record<string, unknown>);
    const override = decodedJson(row.override as Record<string, unknown>);
    const resolved = this.domain.resolveSettings(
      decodedJson(row.definition as SportPack),
      recommended,
      competitionOverride,
      override,
    );
    if (resolved.issues.length) {
      throw new ApiError(409, "SETTINGS_CORRUPT", "Persisted sport settings do not satisfy their pinned pack");
    }
    return {
      competition_id: row.competition_id,
      division_id: row.division_id,
      sport_code: row.sport_code,
      pack_version: row.pack_version,
      pack_schema_version: row.pack_schema_version,
      pack_definition_hash: row.definition_hash,
      pack_definition: decodedJson(row.definition as SportPack),
      recommended_snapshot: recommended,
      competition_override: competitionOverride,
      override,
      revision: row.revision,
      effective: resolved.effective,
      mode: Object.keys(override).length ? "customised" : "recommended",
      permission: competition.membership_role === "viewer" ? "read" : "write",
      read_only: competition.membership_role === "viewer",
      organisation_id: competition.organisation_id,
    };
  }

  async updateSettings(
    actor: Phase3Actor,
    competitionId: string,
    input: { revision: number; packVersion: string; override: Record<string, unknown>; divisionId?: string },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      const settings = required(
        await tx.unsafe<{
          pack_version: string;
          recommended_snapshot: Record<string, unknown>;
          competition_override: Record<string, unknown>;
          division_override: Record<string, unknown>;
        }>(
          input.divisionId
            ? `SELECT c.pack_version,c.recommended_snapshot,c.settings_override AS competition_override,
                      d.settings_override AS division_override
               FROM competition_sport_settings c JOIN division_sport_settings d ON d.competition_id=c.competition_id
               WHERE c.competition_id=$1 AND d.division_id=$2`
            : `SELECT c.pack_version,c.recommended_snapshot,'{}'::jsonb AS competition_override,
                      c.settings_override AS division_override
               FROM competition_sport_settings c WHERE c.competition_id=$1`,
          input.divisionId ? [competitionId, input.divisionId] : [competitionId],
        ),
        "Sport settings not found",
      );
      if (settings.pack_version !== input.packVersion) {
        throw new ApiError(409, "REVISION_CONFLICT", "Sport pack version is stale");
      }
      const pack = await this.sportPack(tx, competition.sport_code, settings.pack_version);
      const recommended = decodedJson(settings.recommended_snapshot);
      const competitionOverride = decodedJson(settings.competition_override);
      const resolved = input.divisionId
        ? this.domain.resolveSettings(pack, recommended, competitionOverride, input.override)
        : this.domain.resolveSettings(pack, recommended, input.override);
      if (resolved.issues.length) throw new ApiError(422, "SETTINGS_INVALID", "Sport settings are invalid");
      const id = input.divisionId ?? competitionId;
      const updated = input.divisionId
        ? await tx.unsafe<{ revision: number }>(
            `UPDATE division_sport_settings SET settings_override=$2::jsonb,revision=revision+1,updated_by=$3,updated_at=$4
             WHERE division_id=$1 AND competition_id=$7 AND revision=$5 AND pack_version=$6 RETURNING revision`,
            [id, input.override, actor.accountId, this.now(), input.revision, input.packVersion, competitionId],
          )
        : await tx.unsafe<{ revision: number }>(
            `UPDATE competition_sport_settings SET settings_override=$2::jsonb,customised=true,revision=revision+1,updated_by=$3,updated_at=$4
             WHERE competition_id=$1 AND revision=$5 AND pack_version=$6 RETURNING revision`,
            [id, input.override, actor.accountId, this.now(), input.revision, input.packVersion],
          );
      if (!updated[0]) throw new ApiError(409, "REVISION_CONFLICT", "Sport settings revision is stale");
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "sport_settings.updated",
        "competition",
        competitionId,
        {
          revision: updated[0].revision,
        },
      );
      return {
        competition_id: competitionId,
        division_id: input.divisionId ?? null,
        revision: updated[0].revision,
        override: input.override,
        effective: resolved.effective,
      };
    });
  }

  async readAccountDefault(actor: Phase3Actor, sportCode: Phase3SportCode) {
    const rows = await this.sql.unsafe<Record<string, unknown>>(
      `SELECT account_id,sport_code,source_pack_version,settings,updated_at FROM account_sport_defaults WHERE account_id=$1 AND sport_code=$2`,
      [actor.accountId, sportCode],
    );
    const value = rows[0];
    return value
      ? { ...value, settings: decodedJson(value.settings as Record<string, unknown> | string) }
      : { account_id: actor.accountId, sport_code: sportCode, settings: null };
  }

  async saveAccountDefault(
    actor: Phase3Actor,
    sportCode: Phase3SportCode,
    input: { packVersion: string; settings: Record<string, unknown> },
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const pack = await this.sportPack(tx, sportCode, input.packVersion);
      const issues = this.domain.validateSettings(pack, input.settings);
      if (issues.length) throw new ApiError(422, "SETTINGS_INVALID", "Sport settings are invalid");
      const rows = await tx.unsafe<Record<string, unknown>>(
        `INSERT INTO account_sport_defaults (account_id,sport_code,source_pack_version,settings,updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (account_id,sport_code) DO UPDATE SET
         source_pack_version=EXCLUDED.source_pack_version,settings=EXCLUDED.settings,updated_at=EXCLUDED.updated_at
         RETURNING account_id,sport_code,source_pack_version,settings,updated_at`,
        [actor.accountId, sportCode, input.packVersion, input.settings, this.now()],
      );
      const saved = required(rows, "Sport default was not saved");
      const value = {
        ...saved,
        settings: decodedJson(saved.settings as Record<string, unknown> | string),
      };
      await this.evidence(
        tx,
        actor,
        null as never,
        requestId,
        "sport_default.saved",
        "account_sport_default",
        `${actor.accountId}:${sportCode}`,
        value,
      );
      return value;
    });
  }

  async deleteAccountDefault(actor: Phase3Actor, sportCode: Phase3SportCode, requestId: string) {
    return this.transaction(async (tx) => {
      const rows = await tx.unsafe(
        `DELETE FROM account_sport_defaults WHERE account_id=$1 AND sport_code=$2 RETURNING account_id`,
        [actor.accountId, sportCode],
      );
      required(rows, "Sport default not found");
      await this.evidence(
        tx,
        actor,
        null as never,
        requestId,
        "sport_default.deleted",
        "account_sport_default",
        `${actor.accountId}:${sportCode}`,
        { sport_code: sportCode },
      );
      return { sport_code: sportCode, deleted: true };
    });
  }

  async copyPreviousSettings(actor: Phase3Actor, competitionId: string, requestId: string) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      const rows = await tx.unsafe<{
        source_recommended: Record<string, unknown>;
        source_override: Record<string, unknown>;
        target_recommended: Record<string, unknown>;
        target_pack_version: string;
        target_pack_schema_version: number;
        target_pack: SportPack;
      }>(
        `SELECT s.recommended_snapshot AS source_recommended,s.settings_override AS source_override,
                target.recommended_snapshot AS target_recommended,target.pack_version AS target_pack_version,
                target.pack_schema_version AS target_pack_schema_version,p.definition AS target_pack
         FROM competitions current
         JOIN competitions previous ON previous.organisation_id=current.organisation_id AND previous.sport_code=current.sport_code
           AND previous.id<>current.id AND previous.starts_on<current.starts_on
         JOIN competition_sport_settings s ON s.competition_id=previous.id
         JOIN competition_sport_settings target ON target.competition_id=current.id
         JOIN sport_pack_versions p ON p.sport_code=target.sport_code AND p.version=target.pack_version
         WHERE current.id=$1 ORDER BY previous.starts_on DESC,previous.created_at DESC LIMIT 1`,
        [competitionId],
      );
      const previous = required(rows, "Previous competition settings not found");
      const effective = { ...decodedJson(previous.source_recommended), ...decodedJson(previous.source_override) };
      const targetPack = decodedJson(previous.target_pack);
      const targetRecommended = decodedJson(previous.target_recommended);
      const issues = this.domain.validateSettings(targetPack, effective);
      if (issues.length) {
        throw new ApiError(
          422,
          "SETTINGS_INCOMPATIBLE",
          "Previous effective settings are incompatible with the target pack",
        );
      }
      const override = this.domain.settingsDifference(effective, targetRecommended);
      const updated = required(
        await tx.unsafe<{ revision: number }>(
          `UPDATE competition_sport_settings SET settings_override=$2::jsonb,customised=$3,
          revision=revision+1,updated_by=$4,updated_at=$5
          WHERE competition_id=$1 AND pack_version=$6 AND pack_schema_version=$7 RETURNING revision`,
          [
            competitionId,
            override,
            Object.keys(override).length > 0,
            actor.accountId,
            this.now(),
            previous.target_pack_version,
            previous.target_pack_schema_version,
          ],
        ),
        "Sport settings not found",
      );
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "sport_settings.copied",
        "competition",
        competitionId,
        updated,
      );
      return {
        competition_id: competitionId,
        revision: updated.revision,
        pack_version: previous.target_pack_version,
        pack_schema_version: previous.target_pack_schema_version,
        effective,
      };
    });
  }

  async readSportPackAdmin(actor: Phase3Actor, sportCode: Phase3SportCode, version: string) {
    await this.platformAdminAccess(this.sql, actor);
    const row = required(
      await this.sql.unsafe<Record<string, unknown>>(
        `SELECT sport_code,version,schema_version,definition,definition_hash,status,revision,
                created_by,created_at,activated_by,activated_at,superseded_at,superseded_by,superseded_by_version
         FROM sport_pack_versions WHERE sport_code=$1 AND version=$2`,
        [sportCode, version],
      ),
      "Sport pack version not found",
    );
    return { ...row, definition: decodedJson(row.definition as Record<string, unknown> | string), read_only: true };
  }

  async listSportPackAdmin(actor: Phase3Actor, sportCode: Phase3SportCode) {
    await this.platformAdminAccess(this.sql, actor);
    const versions = await this.sql.unsafe<Record<string, unknown>>(
      `SELECT version,schema_version,definition_hash,status,revision,created_at,activated_at,superseded_at
       FROM sport_pack_versions WHERE sport_code=$1 ORDER BY created_at DESC,version DESC`,
      [sportCode],
    );
    const active = versions.find((version) => version.status === "active");
    return { sport_code: sportCode, active_version: (active?.version as string | undefined) ?? null, versions };
  }

  async createSportPackDraft(actor: Phase3Actor, definition: unknown, requestId: string) {
    return this.transaction(async (tx) => {
      await this.platformAdminAccess(tx, actor);
      const replay = (
        await tx.unsafe<{ after_state: Record<string, unknown> | string }>(
          `SELECT after_state FROM audit_events
           WHERE request_id=$1 AND actor_account_id=$2 AND action='sport_pack.drafted'
           ORDER BY occurred_at DESC,id DESC LIMIT 1`,
          [requestId, actor.accountId],
        )
      )[0];
      if (replay) return { ...decodedJson(replay.after_state), idempotent_replay: true };
      const issues = this.domain.validateSportPack(definition);
      if (issues.length) throw new ApiError(422, "SPORT_PACK_INVALID", "Sport pack definition is invalid");
      const pack = definition as SportPack;
      const hash = this.domain.hash(pack);
      const row = (
        await tx.unsafe<Record<string, unknown>>(
          `INSERT INTO sport_pack_versions
           (sport_code,version,schema_version,definition,definition_hash,created_by,status,revision,activated_at,activated_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,'draft',1,NULL,NULL)
           ON CONFLICT (sport_code,version) DO NOTHING
           RETURNING sport_code,version,schema_version,definition_hash,status,revision,created_by,created_at`,
          [pack.sportId, pack.version, pack.schemaVersion, pack, hash, actor.accountId],
        )
      )[0];
      if (!row) throw new ApiError(409, "SPORT_PACK_VERSION_CONFLICT", "Sport pack version already exists");
      const result = { ...row, idempotent_replay: false };
      await this.evidence(
        tx,
        actor,
        null,
        requestId,
        "sport_pack.drafted",
        "sport_pack_version",
        `${pack.sportId}:${pack.version}`,
        result,
        "platform_admin",
      );
      return result;
    });
  }

  async activateSportPack(
    actor: Phase3Actor,
    sportCode: Phase3SportCode,
    version: string,
    revision: number,
    expectedActiveVersion: string | null,
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      await this.platformAdminAccess(tx, actor);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`sport-pack:${sportCode}`]);
      const replay = (
        await tx.unsafe<{ after_state: Record<string, unknown> | string }>(
          `SELECT after_state FROM audit_events
           WHERE request_id=$1 AND actor_account_id=$2 AND action='sport_pack.activated'
             AND target_id=$3
           ORDER BY occurred_at DESC,id DESC LIMIT 1`,
          [requestId, actor.accountId, `${sportCode}:${version}`],
        )
      )[0];
      if (replay) return { ...decodedJson(replay.after_state), idempotent_replay: true };
      const currentActive = (
        await tx.unsafe<{ version: string; definition_hash: string }>(
          `SELECT version,definition_hash FROM sport_pack_versions
           WHERE sport_code=$1 AND status='active' FOR UPDATE`,
          [sportCode],
        )
      )[0];
      if ((currentActive?.version ?? null) !== expectedActiveVersion) {
        throw new ApiError(409, "SPORT_PACK_ACTIVE_VERSION_CONFLICT", "The current active sport pack changed");
      }
      const target = required(
        await tx.unsafe<{ definition: SportPack; definition_hash: string; status: string; revision: number }>(
          `SELECT definition,definition_hash,status,revision FROM sport_pack_versions
           WHERE sport_code=$1 AND version=$2 FOR UPDATE`,
          [sportCode, version],
        ),
        "Sport pack version not found",
      );
      const targetDefinition = decodedJson(target.definition);
      if (
        this.domain.validateSportPack(targetDefinition).length ||
        this.domain.hash(targetDefinition) !== target.definition_hash
      ) {
        throw new ApiError(409, "SPORT_PACK_CORRUPT", "The sport pack failed immutable validation");
      }
      if (target.status !== "draft" || target.revision !== revision) {
        throw new ApiError(409, "SPORT_PACK_REVISION_CONFLICT", "Sport pack revision or state is stale");
      }
      if (currentActive) {
        await tx.unsafe(
          `UPDATE sport_pack_versions SET status='superseded',revision=revision+1,
             superseded_at=$4,superseded_by=$3,superseded_by_version=$2
           WHERE sport_code=$1 AND version=$5 AND status='active'`,
          [sportCode, version, actor.accountId, this.now(), currentActive.version],
        );
        await this.evidence(
          tx,
          actor,
          null,
          `${requestId}:superseded`,
          "sport_pack.superseded",
          "sport_pack_version",
          `${sportCode}:${currentActive.version}`,
          { sport_code: sportCode, previous_active_version: currentActive.version, active_version: version },
          "platform_admin",
        );
      }
      const row = (
        await tx.unsafe<Record<string, unknown>>(
          `UPDATE sport_pack_versions
           SET status='active',revision=revision+1,activated_at=$5,activated_by=$4
           WHERE sport_code=$1 AND version=$2 AND status='draft' AND revision=$3
           RETURNING sport_code,version,schema_version,definition_hash,status,revision,activated_by,activated_at`,
          [sportCode, version, revision, actor.accountId, this.now()],
        )
      )[0];
      if (!row) throw new ApiError(409, "SPORT_PACK_REVISION_CONFLICT", "Sport pack revision or state is stale");
      const result = { ...row, previous_active_version: currentActive?.version ?? null, idempotent_replay: false };
      await this.evidence(
        tx,
        actor,
        null,
        requestId,
        "sport_pack.activated",
        "sport_pack_version",
        `${sportCode}:${version}`,
        result,
        "platform_admin",
      );
      return result;
    });
  }

  async replaceCapacity(
    actor: Phase3Actor,
    competitionId: string,
    input: Phase3CapacityReplaceInput,
    requestId: string,
  ): Promise<Phase3CapacityResponse & { idempotent_replay: boolean }> {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      const replay = (
        await tx.unsafe<{ after_state: Record<string, unknown> | string }>(
          `SELECT after_state FROM audit_events
           WHERE request_id=$1 AND actor_account_id=$2 AND action='capacity.replaced'
             AND target_type='competition' AND target_id=$3
           ORDER BY occurred_at DESC,id DESC LIMIT 1`,
          [requestId, actor.accountId, competitionId],
        )
      )[0];
      if (replay)
        return {
          ...decodedJson<Phase3CapacityResponse>(replay.after_state as Phase3CapacityResponse | string),
          idempotent_replay: true,
        };
      const full = required(
        await tx.unsafe<{
          timezone: string;
          capacity_timezone: string | null;
          starts_on: string;
          ends_on: string;
          capacity_revision: number;
        }>(
          `SELECT timezone,capacity_timezone,starts_on::text,ends_on::text,capacity_revision::int
           FROM competitions WHERE id=$1 FOR UPDATE`,
          [competitionId],
        ),
        "Competition not found",
      );
      if (full.capacity_revision !== input.revision) {
        throw new ApiError(409, "CAPACITY_REVISION_CONFLICT", "Capacity revision is stale");
      }
      const timezone = input.timezone ?? full.capacity_timezone ?? full.timezone;
      const slotDurations = new Set(input.areas.map((area) => area.slotMinutes));
      if (slotDurations.size > 1) {
        throw new ApiError(422, "CAPACITY_SLOT_MISMATCH", "All playing areas must use one competition slot duration");
      }
      const preparedAreas = input.areas.map((area, index) => ({
        ...area,
        id: area.id ?? randomUUID(),
        sortOrder: area.sortOrder ?? index,
      }));
      const availability = preparedAreas.flatMap((area) =>
        area.availability.map((window) => ({
          id: window.id ?? randomUUID(),
          areaId: area.id,
          ...window,
        })),
      );
      const unavailable = preparedAreas.flatMap((area) =>
        (area.unavailable ?? []).map((window) => ({
          id: window.id ?? randomUUID(),
          areaId: area.id,
          ...window,
        })),
      );
      const identifiers = [
        ...preparedAreas.map((area) => area.id),
        ...availability.map((window) => window.id),
        ...unavailable.map((window) => window.id),
      ];
      if (new Set(identifiers).size !== identifiers.length) {
        throw new ApiError(422, "CAPACITY_ID_DUPLICATE", "Capacity resource identifiers must be unique");
      }
      const domainInput = {
        timeZone: timezone,
        areas: preparedAreas.map((area) => ({
          id: area.id,
          name: area.name,
          sortOrder: area.sortOrder,
          fixedReserveSlots: area.fixedReserveSlots ?? 0,
        })),
        availability,
        unavailable,
        slotMinutes: preparedAreas[0]?.slotMinutes ?? 30,
      };
      let resolved: ReturnType<Phase3DomainAdapter["resolveCapacityWindows"]>;
      try {
        this.domain.capacity(domainInput);
        resolved = this.domain.resolveCapacityWindows(domainInput);
      } catch (error) {
        throw new ApiError(
          422,
          "CAPACITY_INVALID",
          error instanceof Error ? error.message : "Capacity input is invalid",
        );
      }
      const outsideCompetitionDates = [...availability, ...unavailable].some((window) => {
        const endDate = window.crossMidnight ? new Date(`${window.date}T00:00:00.000Z`) : null;
        if (endDate) endDate.setUTCDate(endDate.getUTCDate() + 1);
        const resolvedEndDate = endDate?.toISOString().slice(0, 10) ?? window.date;
        return window.date < full.starts_on || resolvedEndDate > full.ends_on;
      });
      if (outsideCompetitionDates) {
        throw new ApiError(422, "CAPACITY_INVALID", "Capacity windows must stay within competition dates");
      }
      await tx.unsafe(`DELETE FROM playing_areas WHERE competition_id=$1`, [competitionId]);
      for (const area of preparedAreas) {
        await tx.unsafe(
          `INSERT INTO playing_areas (id,competition_id,name,sort_order,slot_minutes,fixed_reserve_slots)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [area.id, competitionId, area.name.trim(), area.sortOrder, area.slotMinutes, area.fixedReserveSlots ?? 0],
        );
      }
      for (const window of resolved.availability) {
        const source = required(
          availability.filter((value) => value.id === window.id),
          "Availability source not found",
        );
        await tx.unsafe(
          `INSERT INTO competition_availability_windows
           (id,competition_id,playing_area_id,starts_at,ends_at,source_date,source_start_time,source_end_time,source_cross_midnight)
           VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::date,$7::time,$8::time,$9)`,
          [
            window.id,
            competitionId,
            window.areaId,
            window.startIso,
            window.endIso,
            source.date,
            source.startTime,
            source.endTime,
            source.crossMidnight ?? false,
          ],
        );
      }
      for (const window of resolved.unavailable) {
        const source = required(
          unavailable.filter((value) => value.id === window.id),
          "Unavailable source not found",
        );
        await tx.unsafe(
          `INSERT INTO playing_area_unavailable_intervals
           (id,competition_id,playing_area_id,starts_at,ends_at,source_date,source_start_time,source_end_time,source_cross_midnight)
           VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::date,$7::time,$8::time,$9)`,
          [
            window.id,
            competitionId,
            window.areaId,
            window.startIso,
            window.endIso,
            source.date,
            source.startTime,
            source.endTime,
            source.crossMidnight ?? false,
          ],
        );
      }
      const revision = required(
        await tx.unsafe<{ capacity_revision: number }>(
          `UPDATE competitions SET capacity_revision=capacity_revision+1,capacity_timezone=$3
           WHERE id=$1 AND capacity_revision=$2 RETURNING capacity_revision::int`,
          [competitionId, input.revision, timezone],
        ),
        "Competition not found",
      ).capacity_revision;
      const result = { ...(await this.capacity(actor, competitionId, tx)), revision, idempotent_replay: false };
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "capacity.replaced",
        "competition",
        competitionId,
        result,
      );
      return result;
    });
  }

  async createFormatRevision(
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    graph: FormatGraph,
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      await tx.unsafe(`SELECT id FROM competitions WHERE id=$1 FOR UPDATE`, [competitionId]);
      const validation = this.domain.validateFormat(graph);
      if (!validation.valid) throw new ApiError(422, "FORMAT_INVALID", "Format graph is invalid");
      const hash = this.domain.hash(graph);
      const lockedDivision = await tx.unsafe<{ id: string }>(
        `SELECT id FROM divisions WHERE id=$1 AND competition_id=$2 FOR UPDATE`,
        [divisionId, competitionId],
      );
      required(lockedDivision, "Division not found");
      const revisionRows = await tx.unsafe<{ revision: number }>(
        `SELECT COALESCE(max(revision),0)+1 AS revision FROM format_revisions WHERE division_id=$1`,
        [divisionId],
      );
      const revision = revisionRows[0]?.revision ?? 1;
      const rows = await tx.unsafe<{ id: string }>(
        `INSERT INTO format_revisions (competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,'phase3') RETURNING id`,
        [competitionId, divisionId, revision, graph, hash, actor.accountId],
      );
      const format = required(rows, "Format revision was not created");
      const valid = validation.valid;
      const otherDivisionSlots = await this.requiredFormatSlots(tx, competitionId, divisionId);
      const requiredMatchSlots = otherDivisionSlots + graph.matches.length;
      const capacity = await this.capacity(actor, competitionId, tx);
      const availableMatchSlots = capacity.effective.availableMatchSlots;
      const capacityFits = availableMatchSlots >= requiredMatchSlots;
      await tx.unsafe(
        `INSERT INTO format_validation_evidence (format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
          slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,
          recommendation_fits_capacity,issues,validated_by)
         VALUES ($1,$2,$3,$3,$3,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          format.id,
          hash,
          valid,
          graph.matches.length,
          availableMatchSlots,
          requiredMatchSlots,
          capacityFits,
          validation.issues,
          actor.accountId,
        ],
      );
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "format_revision.created",
        "format_revision",
        format.id,
        {
          revision,
          valid,
        },
      );
      return {
        id: format.id,
        competition_id: competitionId,
        division_id: divisionId,
        revision,
        definition_hash: hash,
        status: "draft",
        valid,
        issues: validation.issues,
        deterministic_match_count: graph.matches.length,
        available_match_slots: availableMatchSlots,
        required_match_slots: requiredMatchSlots,
        recommendation_fits_capacity: capacityFits,
      };
    });
  }

  async publishFormat(
    actor: Phase3Actor,
    competitionId: string,
    formatId: string,
    definitionHash: string,
    requestId: string,
  ) {
    return this.transaction(async (tx) => {
      const competition = await this.competitionAccess(tx, competitionId, actor, true);
      this.assertMutable(competition);
      await tx.unsafe(`SELECT id FROM competitions WHERE id=$1 FOR UPDATE`, [competitionId]);
      const candidate = required(
        await tx.unsafe<{
          id: string;
          division_id: string;
          definition_hash: string;
          required_match_slots: number;
          available_match_slots: number;
          recommendation_fits_capacity: boolean;
        }>(
          `SELECT fr.id,fr.division_id,fr.definition_hash,
             jsonb_array_length(fr.definition->'matches')::int AS required_match_slots,
             e.available_match_slots::int,e.recommendation_fits_capacity
           FROM format_revisions fr
           JOIN format_validation_evidence e ON e.format_revision_id=fr.id
           WHERE fr.id=$1 AND fr.competition_id=$2 AND fr.status='draft'
           FOR UPDATE OF fr`,
          [formatId, competitionId],
        ),
        "Format revision not found",
      );
      if (candidate.definition_hash !== definitionHash) {
        throw new ApiError(409, "FORMAT_REVISION_CONFLICT", "Format revision or hash is stale");
      }
      const capacity = await this.capacity(actor, competitionId, tx);
      const requiredMatchSlots =
        (await this.requiredFormatSlots(tx, competitionId, candidate.division_id)) + candidate.required_match_slots;
      if (
        candidate.available_match_slots !== capacity.effective.availableMatchSlots ||
        requiredMatchSlots !==
          Number(
            required(
              await tx.unsafe<{ required_match_slots: number }>(
                `SELECT required_match_slots::int FROM format_validation_evidence WHERE format_revision_id=$1`,
                [formatId],
              ),
              "Format validation evidence not found",
            ).required_match_slots,
          )
      ) {
        throw new ApiError(409, "FORMAT_CAPACITY_STALE", "Format capacity evidence is stale");
      }
      if (!candidate.recommendation_fits_capacity || capacity.effective.availableMatchSlots < requiredMatchSlots) {
        throw new ApiError(422, "CAPACITY_INSUFFICIENT", "Combined division formats do not fit available capacity");
      }
      const rows = await tx.unsafe<{ id: string; definition_hash: string }>(
        `UPDATE format_revisions SET status='published',published_at=$3
         WHERE id=$1 AND competition_id=$2 AND definition_hash=$4 AND status='draft' RETURNING id,definition_hash`,
        [formatId, competitionId, this.now(), definitionHash],
      );
      if (!rows[0]) throw new ApiError(409, "FORMAT_REVISION_CONFLICT", "Format revision or hash is stale");
      await this.evidence(
        tx,
        actor,
        competition.organisation_id,
        requestId,
        "format_revision.published",
        "format_revision",
        formatId,
        {
          definition_hash: definitionHash,
        },
      );
      return { id: formatId, status: "published", definition_hash: definitionHash };
    });
  }

  async capacity(
    actor: Phase3Actor,
    competitionId: string,
    database: PostgresJsSql = this.sql,
  ): Promise<Phase3CapacityResponse> {
    const access = await this.competitionAccess(database, competitionId, actor, false);
    const competition = required(
      await database.unsafe<{ timezone: string; capacity_timezone: string | null; capacity_revision: number }>(
        `SELECT timezone,capacity_timezone,capacity_revision::int FROM competitions WHERE id=$1`,
        [competitionId],
      ),
      "Competition not found",
    );
    const timezone = competition.capacity_timezone ?? competition.timezone;
    const areas = await database.unsafe<{
      id: string;
      name: string;
      sort_order: number;
      slot_minutes: number;
      fixed_reserve_slots: number;
    }>(
      `SELECT id,name,sort_order,COALESCE(slot_minutes,30)::int AS slot_minutes,fixed_reserve_slots FROM playing_areas WHERE competition_id=$1 ORDER BY sort_order,id`,
      [competitionId],
    );
    const available = await database.unsafe<{
      id: string;
      area_id: string;
      date: string;
      start_time: string;
      end_time: string;
      cross_midnight: boolean;
      starts_at: Date | string;
      ends_at: Date | string;
    }>(
      `SELECT id,playing_area_id AS area_id,source_date::text AS date,
        to_char(source_start_time,'HH24:MI') AS start_time,to_char(source_end_time,'HH24:MI') AS end_time,
        source_cross_midnight AS cross_midnight,starts_at,ends_at
       FROM competition_availability_windows WHERE competition_id=$1 ORDER BY starts_at,id`,
      [competitionId],
    );
    const unavailable = await database.unsafe<{
      id: string;
      area_id: string;
      date: string;
      start_time: string;
      end_time: string;
      cross_midnight: boolean;
      starts_at: Date | string;
      ends_at: Date | string;
    }>(
      `SELECT id,playing_area_id AS area_id,source_date::text AS date,
        to_char(source_start_time,'HH24:MI') AS start_time,to_char(source_end_time,'HH24:MI') AS end_time,
        source_cross_midnight AS cross_midnight,starts_at,ends_at
       FROM playing_area_unavailable_intervals WHERE competition_id=$1 ORDER BY starts_at,id`,
      [competitionId],
    );
    const slotMinutes = areas[0]?.slot_minutes ?? 30;
    if (areas.some((area) => area.slot_minutes !== slotMinutes))
      throw new ApiError(409, "CAPACITY_SLOT_MISMATCH", "All playing areas must use one competition slot duration");
    const summary = this.domain.capacity({
      timeZone: timezone,
      availability: available.map((window) => ({
        id: window.id,
        areaId: window.area_id,
        date: window.date,
        startTime: window.start_time,
        endTime: window.end_time,
        crossMidnight: window.cross_midnight,
      })),
      unavailable: unavailable.map((window) => ({
        id: window.id,
        areaId: window.area_id,
        date: window.date,
        startTime: window.start_time,
        endTime: window.end_time,
        crossMidnight: window.cross_midnight,
      })),
      slotMinutes,
      areas: areas.map((area) => ({
        id: area.id,
        name: area.name,
        sortOrder: area.sort_order,
        fixedReserveSlots: area.fixed_reserve_slots,
      })),
      requiredMatchSlots: await this.requiredFormatSlots(database, competitionId),
    });
    const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
    return {
      competition_id: competitionId,
      revision: competition.capacity_revision,
      timezone,
      permission: access.membership_role === "viewer" || access.status === "archived" ? "read" : "write",
      read_only: access.membership_role === "viewer" || access.status === "archived",
      areas: areas.map((area) => ({
        id: area.id,
        name: area.name,
        sort_order: area.sort_order,
        slot_minutes: area.slot_minutes,
        fixed_reserve_slots: area.fixed_reserve_slots,
        availability: available
          .filter((window) => window.area_id === area.id)
          .map((window) => ({
            id: window.id,
            date: window.date,
            start_time: window.start_time,
            end_time: window.end_time,
            cross_midnight: window.cross_midnight,
            starts_at: iso(window.starts_at),
            ends_at: iso(window.ends_at),
          })),
        unavailable: unavailable
          .filter((window) => window.area_id === area.id)
          .map((window) => ({
            id: window.id,
            date: window.date,
            start_time: window.start_time,
            end_time: window.end_time,
            cross_midnight: window.cross_midnight,
            starts_at: iso(window.starts_at),
            ends_at: iso(window.ends_at),
          })),
      })),
      effective: summary,
    };
  }

  private async recalculateStandingsInTransaction(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    competitionId: string,
    divisionId: string,
    requestId: string,
  ) {
    const competition = await this.competitionAccess(tx, competitionId, actor, true);
    this.assertMutable(competition);
    const publication = required(
      await tx.unsafe<{ result_version: number }>(
        `SELECT result_version FROM competition_publications WHERE competition_id=$1 FOR UPDATE`,
        [competitionId],
      ),
      "Competition publication state not found",
    );
    if (publication.result_version < 1)
      throw new ApiError(409, "RESULTS_NOT_FINALISED", "No persisted final result is available to calculate standings");
    const source = required(
      await tx.unsafe<{ source_hash: string }>(`SELECT phase3_standings_source_hash($1,$2,$3) AS source_hash`, [
        competitionId,
        divisionId,
        publication.result_version,
      ]),
      "Standings provenance could not be calculated",
    );
    const existing = await tx.unsafe<Record<string, unknown>>(
      `SELECT id,competition_id,division_id,result_version,standings,explanation,calculation_input_hash,
                source_result_hash,settings_version,snapshot_fingerprint,created_at
         FROM standings_snapshots WHERE division_id=$1 AND result_version=$2`,
      [divisionId, publication.result_version],
    );
    if (existing[0]) {
      if (existing[0].source_result_hash === source.source_hash) return existing[0];
      throw new ApiError(
        409,
        "STANDINGS_SOURCE_STALE",
        "Persisted standings no longer match the result or settings source for this version",
      );
    }
    const settings = required(
      await tx.unsafe<{
        pack_version: string;
        definition: SportPack;
        recommended_snapshot: Record<string, unknown>;
        competition_override: Record<string, unknown>;
        division_override: Record<string, unknown> | null;
      }>(
        `SELECT css.pack_version,sp.definition,css.recommended_snapshot,
                  css.settings_override AS competition_override,dss.settings_override AS division_override
           FROM competition_sport_settings css
           JOIN sport_pack_versions sp ON sp.sport_code=css.sport_code AND sp.version=css.pack_version
           LEFT JOIN division_sport_settings dss ON dss.division_id=$2
           WHERE css.competition_id=$1`,
        [competitionId, divisionId],
      ),
      "Pinned sport settings not found",
    );
    const pack = decodedJson(settings.definition);
    const effective = this.domain.resolveSettings(
      pack,
      decodedJson(settings.recommended_snapshot),
      decodedJson(settings.competition_override),
      settings.division_override ? decodedJson(settings.division_override) : {},
    );
    if (effective.issues.length > 0)
      throw new ApiError(409, "SPORT_SETTINGS_INVALID", "Pinned sport settings are not valid for standings");
    const engineConfig = this.domain.standingsConfig(pack, effective.effective);
    const entries = await tx.unsafe<{
      id: string;
      name: string;
      seed: number | null;
      status: "confirmed" | "active" | "withdrawn" | "replaced";
    }>(`SELECT id,name,seed,status FROM division_entries WHERE division_id=$1 ORDER BY seed NULLS LAST,id`, [
      divisionId,
    ]);
    const participants: StandingsParticipant[] = entries
      .filter((entry) => entry.status !== "replaced")
      .map((entry, index) => ({
        id: entry.id,
        name: entry.name,
        seed: entry.seed ?? index + 1,
        status: entry.status === "withdrawn" ? "withdrawn" : "active",
      }));
    const resultRows = await tx.unsafe<{
      match_id: string;
      code: string;
      stage_id: string;
      pool_id: string | null;
      home_entry_id: string;
      away_entry_id: string;
      home_score: number;
      away_score: number;
      state: "final" | "corrected";
      result_version: number;
      snapshot: Record<string, unknown>;
    }>(
      `SELECT DISTINCT ON (m.id) m.id AS match_id,m.code,m.stage AS stage_id,NULL::text AS pool_id,
                m.home_entry_id,m.away_entry_id,s.home_score,s.away_score,s.state,s.result_version,s.snapshot
         FROM matches m JOIN match_result_snapshots s ON s.match_id=m.id
         WHERE m.competition_id=$1 AND m.division_id=$2 AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
           AND s.result_version <= $3
         ORDER BY m.id,s.result_version DESC`,
      [competitionId, divisionId, publication.result_version],
    );
    const format = required(
      await tx.unsafe<{ id: string; definition: FormatGraph }>(
        `SELECT id,definition FROM format_revisions WHERE division_id=$1 AND status='published'
           ORDER BY revision DESC LIMIT 1`,
        [divisionId],
      ),
      "Published format not found",
    );
    const graph = decodedJson(format.definition);
    const results: StandingsMatchResult[] = resultRows.map((row) => {
      const detail = decodedJson(row.snapshot);
      const forfeitLoser = typeof detail.forfeitLoserEntryId === "string" ? detail.forfeitLoserEntryId : undefined;
      return {
        matchId: row.match_id,
        homeEntryId: row.home_entry_id,
        awayEntryId: row.away_entry_id,
        homeScore: row.home_score,
        awayScore: row.away_score,
        ...(Array.isArray(detail.homeSegments) && Array.isArray(detail.awaySegments)
          ? { homeSegments: detail.homeSegments as number[], awaySegments: detail.awaySegments as number[] }
          : {}),
        ...(typeof detail.homeDisciplinePoints === "number"
          ? { homeDisciplinePoints: detail.homeDisciplinePoints }
          : {}),
        ...(typeof detail.awayDisciplinePoints === "number"
          ? { awayDisciplinePoints: detail.awayDisciplinePoints }
          : {}),
        status: forfeitLoser ? "forfeit" : row.state,
        version: row.result_version,
        ...(forfeitLoser ? { forfeitLoserEntryId: forfeitLoser } : {}),
      };
    });
    const sourceGroups = new Set<string>();
    for (const stage of graph.stages) {
      if (stage.kind === "group") {
        for (const groupId of stage.groupIds) sourceGroups.add(groupId);
      } else if (stage.kind === "round_robin") {
        sourceGroups.add(stage.id);
      }
    }
    for (const match of graph.matches) {
      for (const source of [match.home, match.away]) {
        if (source.type === "stage_rank" && source.groupId !== undefined) sourceGroups.add(source.groupId);
      }
    }
    if (sourceGroups.size === 0) sourceGroups.add(graph.stages[0]?.id ?? "division");
    const calculatedAt = this.now().toISOString();
    const groupSnapshots: Record<string, StandingsSnapshot> = {};
    const groupCompleteness = new Map<string, boolean>();
    for (const groupId of sourceGroups) {
      const groupGraphMatches = graph.matches.filter(
        (match) => match.poolId === groupId || (match.stageId === groupId && !match.poolId),
      );
      const groupCodes = new Set(groupGraphMatches.map((match) => match.id));
      const groupResults = results.filter((_, index) => groupCodes.has(resultRows[index]!.code));
      groupCompleteness.set(groupId, groupCodes.size > 0 && groupResults.length === groupCodes.size);
      const groupEntryIds = new Set(groupResults.flatMap((result) => [result.homeEntryId, result.awayEntryId]));
      for (const match of groupGraphMatches) {
        for (const source of [match.home, match.away]) {
          if (source.type !== "entry_seed") continue;
          const participant = participants.find((entry) => entry.seed === source.seed);
          if (participant) groupEntryIds.add(participant.id);
        }
      }
      const groupEntries =
        groupEntryIds.size > 0 ? participants.filter((entry) => groupEntryIds.has(entry.id)) : participants;
      const rows = this.domain.calculateStandings(groupEntries, groupResults, engineConfig);
      groupSnapshots[groupId] = this.domain.standings({
        competitionId,
        divisionId,
        groupId,
        resultVersion: publication.result_version,
        configVersion: engineConfig.version,
        calculatedAt,
        rows,
      });
    }
    const crossGroupDepth = Math.max(
      1,
      ...graph.matches.flatMap((match) =>
        [match.home, match.away]
          .filter((source) => source.type === "stage_rank" && source.groupId === undefined)
          .map((source) => (source.type === "stage_rank" ? source.rank : 1)),
      ),
    );
    const crossGroup = this.domain.compareAcrossGroups(
      Object.entries(groupSnapshots).flatMap(([groupId, snapshot]) =>
        snapshot.rows
          .slice(0, crossGroupDepth)
          .map((row) => ({ groupId, row, groupComplete: groupCompleteness.get(groupId) ?? false })),
      ),
    );
    const snapshotFingerprint = this.domain.hash(
      Object.fromEntries(Object.entries(groupSnapshots).map(([groupId, snapshot]) => [groupId, snapshot.fingerprint])),
    );
    await tx.unsafe(`SELECT set_config('matchday.server_results','on',true)`);
    const snapshots = await tx.unsafe<Record<string, unknown>>(
      `INSERT INTO standings_snapshots
          (competition_id,division_id,result_version,standings,explanation,calculation_input_hash,
           calculation_provenance,source_result_hash,settings_version,snapshot_fingerprint)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,'server_calculated',$6,$7,$8)
         RETURNING id,competition_id,division_id,result_version,standings,explanation,calculation_input_hash,
                   source_result_hash,settings_version,snapshot_fingerprint,created_at`,
      [
        competitionId,
        divisionId,
        publication.result_version,
        { groups: groupSnapshots, cross_group: crossGroup },
        { config_version: engineConfig.version, group_count: Object.keys(groupSnapshots).length },
        source.source_hash,
        engineConfig.version,
        snapshotFingerprint,
      ],
    );
    const snapshot = required(snapshots, "Standings snapshot was not created");
    const snapshotId = String(snapshot.id);
    const rules: AdvancementRule[] = [];
    const currentSlots: AdvancementSlot[] = [];
    const slotMeta = new Map<string, { matchId: string; slot: "home" | "away"; state: string }>();
    const persistedSlots = await tx.unsafe<{
      match_id: string;
      slot: "home" | "away";
      entry_id: string | null;
      control: "manual" | "automatic";
      controlled_by_rule_id: string | null;
      source_fingerprint: string | null;
    }>(
      `SELECT match_id,slot,entry_id,control,controlled_by_rule_id,source_fingerprint FROM advancement_slots WHERE division_id=$1`,
      [divisionId],
    );
    const persistedBySlot = new Map(persistedSlots.map((slot) => [`${slot.match_id}:${slot.slot}`, slot]));
    const matchesByCode = new Map(
      (
        await tx.unsafe<{
          id: string;
          code: string;
          state: string;
          home_entry_id: string | null;
          away_entry_id: string | null;
        }>(`SELECT id,code,state,home_entry_id,away_entry_id FROM matches WHERE division_id=$1`, [divisionId])
      ).map((match) => [match.code, match]),
    );
    for (const graphMatch of graph.matches) {
      const match = matchesByCode.get(graphMatch.id);
      if (!match) continue;
      for (const slot of ["home", "away"] as const) {
        const sourceDefinition = graphMatch[slot];
        if (sourceDefinition.type !== "stage_rank") continue;
        const slotId = `${match.id}:${slot}`;
        const ruleId = `${graphMatch.id}:${slot}:${sourceDefinition.stageId}:${sourceDefinition.groupId ?? "*"}:${sourceDefinition.rank}`;
        const sourceStage = graph.stages.find((stage) => stage.id === sourceDefinition.stageId);
        rules.push({
          ruleId,
          source:
            sourceStage?.kind === "group" && sourceDefinition.groupId === undefined
              ? { type: "cross_group_rank", rank: sourceDefinition.rank }
              : {
                  type: "group_rank",
                  groupId: sourceDefinition.groupId ?? sourceDefinition.stageId,
                  rank: sourceDefinition.rank,
                },
          targetSlotId: slotId,
        });
        const existingSlot = persistedBySlot.get(slotId);
        currentSlots.push(
          existingSlot
            ? {
                slotId,
                entryId: existingSlot.entry_id,
                control: existingSlot.control,
                ...(existingSlot.controlled_by_rule_id
                  ? { controlledByRuleId: existingSlot.controlled_by_rule_id }
                  : {}),
                ...(existingSlot.source_fingerprint ? { sourceFingerprint: existingSlot.source_fingerprint } : {}),
              }
            : { slotId, entryId: match[`${slot}_entry_id`], control: "automatic", controlledByRuleId: ruleId },
        );
        slotMeta.set(slotId, { matchId: match.id, slot, state: match.state });
      }
    }
    const advancement = this.domain.advance({ rules, groupSnapshots, currentSlots, crossGroupStandings: crossGroup });
    const conflicts = [...advancement.conflicts];
    for (const slot of advancement.slots) {
      const meta = slotMeta.get(slot.slotId);
      if (!meta || slot.control === "manual") continue;
      const current = currentSlots.find((candidate) => candidate.slotId === slot.slotId);
      const protectedMatch = !["pending", "ready"].includes(meta.state) && current?.entryId !== slot.entryId;
      if (protectedMatch) {
        conflicts.push({
          ruleId: slot.controlledByRuleId ?? "unknown",
          targetSlotId: slot.slotId,
          reason: "downstream_match_started",
        });
        // The downstream match is already underway. Keep the persisted
        // qualifier aligned with the participant that remains on the match;
        // the conflict is the durable signal that manual resolution is
        // required for this corrected source result.
        continue;
      } else {
        await tx.unsafe(
          meta.slot === "home"
            ? `UPDATE matches SET home_entry_id=$2,
                   state=CASE WHEN state IN ('pending','ready') AND $2::uuid IS NOT NULL AND away_entry_id IS NOT NULL THEN 'ready' ELSE state END
                 WHERE id=$1`
            : `UPDATE matches SET away_entry_id=$2,
                   state=CASE WHEN state IN ('pending','ready') AND home_entry_id IS NOT NULL AND $2::uuid IS NOT NULL THEN 'ready' ELSE state END
                 WHERE id=$1`,
          [meta.matchId, slot.entryId],
        );
      }
      await tx.unsafe(
        `INSERT INTO advancement_slots
            (competition_id,division_id,match_id,slot,entry_id,control,controlled_by_rule_id,source_snapshot_id,
             source_fingerprint,result_version,updated_at)
           VALUES ($1,$2,$3,$4,$5,'automatic',$6,$7,$8,$9,$10)
           ON CONFLICT (match_id,slot) DO UPDATE SET entry_id=EXCLUDED.entry_id,control='automatic',
             controlled_by_rule_id=EXCLUDED.controlled_by_rule_id,source_snapshot_id=EXCLUDED.source_snapshot_id,
             source_fingerprint=EXCLUDED.source_fingerprint,result_version=EXCLUDED.result_version,updated_at=EXCLUDED.updated_at`,
        [
          competitionId,
          divisionId,
          meta.matchId,
          meta.slot,
          slot.entryId,
          slot.controlledByRuleId,
          slot.entryId ? snapshotId : null,
          slot.entryId ? slot.sourceFingerprint : null,
          publication.result_version,
          this.now(),
        ],
      );
    }
    for (const conflict of conflicts) {
      await tx.unsafe(
        `INSERT INTO advancement_conflicts (competition_id,division_id,result_version,rule_id,target_slot_id,reason)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          competitionId,
          divisionId,
          publication.result_version,
          conflict.ruleId,
          conflict.targetSlotId,
          conflict.reason,
        ],
      );
    }
    await this.evidence(
      tx,
      actor,
      competition.organisation_id,
      requestId,
      "standings_snapshot.recalculated",
      "standings_snapshot",
      String(snapshot.id),
      {
        result_version: publication.result_version,
        calculation_input_hash: source.source_hash,
        advancement_conflicts: conflicts.length,
      },
    );
    return { ...snapshot, advancement: { changes: advancement.changes, conflicts } };
  }

  async recalculateStandings(actor: Phase3Actor, competitionId: string, divisionId: string, requestId: string) {
    return this.transaction((tx) =>
      this.recalculateStandingsInTransaction(tx, actor, competitionId, divisionId, requestId),
    );
  }

  async readStandings(actor: Phase3Actor, competitionId: string, divisionId: string) {
    await this.competitionAccess(this.sql, competitionId, actor, false);
    const rows = await this.sql.unsafe<Record<string, unknown>>(
      `SELECT snapshot.id,snapshot.competition_id,snapshot.division_id,snapshot.result_version,
              snapshot.standings,snapshot.explanation,snapshot.calculation_input_hash,
              snapshot.source_result_hash,snapshot.settings_version,snapshot.snapshot_fingerprint,snapshot.created_at,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'match_id',slot.match_id,'slot',slot.slot,'entry_id',slot.entry_id,'control',slot.control,
                  'controlled_by_rule_id',slot.controlled_by_rule_id,'source_snapshot_id',slot.source_snapshot_id,
                  'source_fingerprint',slot.source_fingerprint,'result_version',slot.result_version,
                  'updated_at',slot.updated_at
                ) ORDER BY slot.match_id,slot.slot)
                FROM advancement_slots slot
                WHERE slot.competition_id=$1 AND slot.division_id=$2
                  AND slot.result_version<=snapshot.result_version
              ),'[]'::jsonb) AS advancement_slots,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id',conflict.id,'rule_id',conflict.rule_id,'target_slot_id',conflict.target_slot_id,
                  'reason',conflict.reason,'status','open','result_version',conflict.result_version,
                  'created_at',conflict.created_at
                ) ORDER BY conflict.created_at,conflict.id)
                FROM advancement_conflicts conflict
                WHERE conflict.competition_id=$1 AND conflict.division_id=$2
                  AND conflict.result_version=snapshot.result_version
              ),'[]'::jsonb) AS advancement_conflicts
       FROM standings_snapshots snapshot
       JOIN competition_publications publication ON publication.competition_id=snapshot.competition_id
       WHERE snapshot.competition_id=$1 AND snapshot.division_id=$2
         AND snapshot.calculation_provenance='server_calculated'
         AND snapshot.result_version<=publication.result_version
       ORDER BY snapshot.result_version DESC LIMIT 1`,
      [competitionId, divisionId],
    );
    const row = required(rows, "Standings snapshot not found");
    return {
      ...row,
      standings: decodedJson(row.standings as Record<string, unknown> | string),
      explanation: decodedJson(row.explanation as Record<string, unknown> | string),
      advancement_slots: decodedJson(row.advancement_slots as unknown[] | string),
      advancement_conflicts: decodedJson(row.advancement_conflicts as unknown[] | string),
    };
  }
}
