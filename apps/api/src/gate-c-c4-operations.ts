import { createHash } from "node:crypto";
import {
  renderEmergencyScoreSheetPdf,
  renderScheduleFallbackPdf,
  safeFallbackFilename,
  type EmergencyScoreSheet,
  type FallbackMatch,
  type FallbackSport,
  type ScheduleFallbackDocument,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

type CompetitionAccess = {
  organisation_id: string;
  status: string;
  membership_role: "owner" | "organiser";
};

type PublishedCompetition = {
  id: string;
  name: string;
  slug: string;
  sport_code: FallbackSport;
  timezone: string;
  starts_on: Date | string;
  ends_on: Date | string;
  schedule_version: number;
  result_version: number;
  published_schedule_revision_id: string | null;
  source_updated_at: Date | string;
};

type PublishedScheduleRow = {
  match_id: string;
  division_id: string;
  division_name: string;
  match_code: string;
  stage: string;
  home_entry_id: string | null;
  home_name: string | null;
  away_entry_id: string | null;
  away_name: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  playing_area: string;
};

export type GateCC4RepairQueueItem = Readonly<{
  repair_id: string;
  corrected_match_id: string;
  corrected_match_code: string;
  division_id: string;
  division_name: string;
  source_result_version: number;
  source_schedule_version: number;
  source_projection_version: number;
  analysis_fingerprint: string;
  latest_revision_id: string | null;
  latest_revision: number | null;
  latest_status: "draft" | "ready" | "published" | "abandoned" | null;
  affected_action_count: number;
  unresolved_action_count: number;
  created_at: string;
}>;

export type GateCC4ExportReceipt = Readonly<{
  filename: string;
  contentType: "application/pdf";
  bytes: Uint8Array;
  sha256: string;
  sizeBytes: number;
  sourceFingerprint: string;
  scheduleVersion: number;
  resultVersion: number;
  manifestId: string;
  duplicate: boolean;
}>;

function required<T>(rows: readonly T[], code: string, message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, code, message);
  return row;
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid persisted timestamp");
  return parsed.toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unsupported export source value");
  return encoded;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class GateCC4Operations {
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly publicOrigin: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const parsed = new URL(publicOrigin);
    if (!(["https:", "http:"].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Gate C4 public origin must be credential-free HTTP(S)");
    }
  }

  private async transaction<T>(operation: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    if (!this.sql.begin) throw new Error("Gate C4 operations require a transaction-capable PostgreSQL client");
    return this.sql.begin(operation);
  }

  private async access(tx: PostgresJsSql, actor: Phase3Actor, competitionId: string): Promise<CompetitionAccess> {
    const access = required(
      await tx.unsafe<CompetitionAccess>(
        `SELECT competition.organisation_id,competition.status,membership.role AS membership_role
         FROM competitions competition
         JOIN organisation_memberships membership
           ON membership.organisation_id=competition.organisation_id
         WHERE competition.id=$1
           AND membership.account_id=$2
           AND membership.status='active'
           AND membership.role IN ('owner','organiser')`,
        [competitionId, actor.accountId],
      ),
      "COMPETITION_ACCESS_DENIED",
      "Competition access denied",
    );
    if (access.status === "archived") throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
    return access;
  }

  async listRepairs(actor: Phase3Actor, competitionId: string): Promise<readonly GateCC4RepairQueueItem[]> {
    await this.access(this.sql, actor, competitionId);
    const rows = await this.sql.unsafe<{
      repair_id: string;
      corrected_match_id: string;
      corrected_match_code: string;
      division_id: string;
      division_name: string;
      source_result_version: number;
      source_schedule_version: number;
      source_projection_version: number;
      analysis_fingerprint: string;
      latest_revision_id: string | null;
      latest_revision: number | null;
      latest_status: GateCC4RepairQueueItem["latest_status"];
      affected_action_count: number;
      unresolved_action_count: number;
      created_at: Date | string;
    }>(
      `SELECT repair.id AS repair_id,
              repair.corrected_match_id,
              match.code AS corrected_match_code,
              repair.corrected_division_id AS division_id,
              division.name AS division_name,
              repair.source_result_version,
              repair.source_schedule_version,
              repair.source_projection_version,
              repair.analysis_fingerprint,
              latest.id AS latest_revision_id,
              latest.revision AS latest_revision,
              latest.status AS latest_status,
              COALESCE(action_counts.affected_action_count,0)::integer AS affected_action_count,
              COALESCE(action_counts.unresolved_action_count,0)::integer AS unresolved_action_count,
              repair.created_at
       FROM schedule_repair_cases repair
       JOIN matches match ON match.id=repair.corrected_match_id
       JOIN divisions division ON division.id=repair.corrected_division_id
       LEFT JOIN LATERAL (
         SELECT revision.id,revision.revision,revision.status
         FROM schedule_repair_revisions revision
         WHERE revision.repair_case_id=repair.id
         ORDER BY revision.revision DESC
         LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS affected_action_count,
                count(*) FILTER (WHERE action.source_action='requires_organiser_decision' AND decision.id IS NULL)::integer
                  AS unresolved_action_count
         FROM schedule_repair_actions action
         LEFT JOIN schedule_repair_decisions decision ON decision.repair_action_id=action.id
         WHERE action.repair_revision_id=latest.id
       ) action_counts ON true
       WHERE repair.competition_id=$1
       ORDER BY
         CASE latest.status WHEN 'draft' THEN 0 WHEN 'ready' THEN 1 WHEN 'published' THEN 2 ELSE 3 END,
         repair.created_at DESC,
         repair.id`,
      [competitionId],
    );
    return rows.map((row) => ({ ...row, created_at: instant(row.created_at) }));
  }

  private async publishedCompetition(tx: PostgresJsSql, competitionId: string): Promise<PublishedCompetition> {
    const competition = required(
      await tx.unsafe<PublishedCompetition>(
        `SELECT competition.id,competition.name,competition.slug,competition.sport_code,competition.timezone,
                competition.starts_on,competition.ends_on,
                publication.schedule_version,publication.result_version,
                publication.published_schedule_revision_id,
                GREATEST(competition.updated_at,publication.updated_at) AS source_updated_at
         FROM competitions competition
         JOIN competition_publications publication ON publication.competition_id=competition.id
         WHERE competition.id=$1`,
        [competitionId],
      ),
      "COMPETITION_NOT_FOUND",
      "Competition not found",
    );
    if (!competition.published_schedule_revision_id || competition.schedule_version < 1) {
      throw new ApiError(409, "SCHEDULE_NOT_PUBLISHED", "Publish a schedule before generating fallback documents");
    }
    return competition;
  }

  private async publishedMatches(tx: PostgresJsSql, competition: PublishedCompetition): Promise<FallbackMatch[]> {
    const rows = await tx.unsafe<PublishedScheduleRow>(
      `SELECT match.id AS match_id,match.division_id,division.name AS division_name,
              match.code AS match_code,match.stage,
              scheduled.home_entry_id,home.name AS home_name,
              scheduled.away_entry_id,away.name AS away_name,
              scheduled.starts_at,scheduled.ends_at,area.name AS playing_area
       FROM scheduled_matches scheduled
       JOIN matches match ON match.id=scheduled.match_id
       JOIN divisions division ON division.id=match.division_id
       JOIN playing_areas area ON area.id=scheduled.playing_area_id
       LEFT JOIN division_entries home ON home.id=scheduled.home_entry_id
       LEFT JOIN division_entries away ON away.id=scheduled.away_entry_id
       WHERE scheduled.schedule_revision_id=$1
       ORDER BY division.name,scheduled.starts_at,area.name,match.ordinal,match.id`,
      [competition.published_schedule_revision_id],
    );
    if (rows.length < 1) throw new ApiError(409, "PUBLISHED_SCHEDULE_EMPTY", "Published schedule has no matches");
    return rows.map((row) => ({
      matchId: row.match_id,
      divisionId: row.division_id,
      divisionName: row.division_name,
      matchCode: row.match_code,
      stage: row.stage,
      home: { entryId: row.home_entry_id, displayName: row.home_name ?? "TBD" },
      away: { entryId: row.away_entry_id, displayName: row.away_name ?? "TBD" },
      startsAt: instant(row.starts_at),
      endsAt: instant(row.ends_at),
      playingArea: row.playing_area,
    }));
  }

  private sourceFingerprint(competition: PublishedCompetition, matches: readonly FallbackMatch[]): string {
    return sha256(
      stableJson({
        competition_id: competition.id,
        schedule_version: competition.schedule_version,
        result_version: competition.result_version,
        published_schedule_revision_id: competition.published_schedule_revision_id,
        source_updated_at: instant(competition.source_updated_at),
        matches,
      }),
    );
  }

  private async retainManifest(
    tx: PostgresJsSql,
    input: {
      actor: Phase3Actor;
      competition: PublishedCompetition;
      divisionId: string | null;
      exportKind:
        | "schedule_a4"
        | "canoe_polo_score_sheet"
        | "badminton_score_sheet"
        | "table_tennis_score_sheet"
        | "volleyball_score_sheet"
        | "basketball_score_sheet";
      sourceFingerprint: string;
      filename: string;
      contentSha256: string;
      sizeBytes: number;
    },
  ): Promise<{ id: string; duplicate: boolean }> {
    const existing = (
      await tx.unsafe<{ id: string; content_sha256: string; byte_size: number; safe_filename: string }>(
        `SELECT id,content_sha256,byte_size::integer,safe_filename
         FROM competition_export_manifests
         WHERE competition_id=$1
           AND division_id IS NOT DISTINCT FROM $2::uuid
           AND export_kind=$3
           AND source_fingerprint=$4`,
        [input.competition.id, input.divisionId, input.exportKind, input.sourceFingerprint],
      )
    )[0];
    if (existing) {
      if (
        existing.content_sha256 !== input.contentSha256 ||
        existing.byte_size !== input.sizeBytes ||
        existing.safe_filename !== input.filename
      ) {
        throw new ApiError(409, "EXPORT_MANIFEST_CONFLICT", "A retained export manifest has different content");
      }
      return { id: existing.id, duplicate: true };
    }
    const retained = required(
      await tx.unsafe<{ id: string }>(
        `INSERT INTO competition_export_manifests(
           competition_id,division_id,export_kind,schedule_version,result_version,
           projection_fingerprint,source_fingerprint,content_sha256,byte_size,
           safe_filename,created_by_account_id,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          input.competition.id,
          input.divisionId,
          input.exportKind,
          input.competition.schedule_version,
          input.competition.result_version,
          input.sourceFingerprint,
          input.contentSha256,
          input.sizeBytes,
          input.filename,
          input.actor.accountId,
          this.now(),
        ],
      ),
      "EXPORT_MANIFEST_CREATE_FAILED",
      "Fallback export manifest was not retained",
    );
    return { id: retained.id, duplicate: false };
  }

  async schedulePdf(actor: Phase3Actor, competitionId: string): Promise<GateCC4ExportReceipt> {
    return this.transaction(async (tx) => {
      await this.access(tx, actor, competitionId);
      const competition = await this.publishedCompetition(tx, competitionId);
      const matches = await this.publishedMatches(tx, competition);
      const sourceFingerprint = this.sourceFingerprint(competition, matches);
      const filename = safeFallbackFilename(`${competition.name}-schedule-v${competition.schedule_version}`);
      const document: ScheduleFallbackDocument = {
        schemaVersion: 1,
        documentType: "schedule_pdf",
        competitionId: competition.id,
        competitionName: competition.name,
        sport: competition.sport_code,
        timezone: competition.timezone,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        generatedAt: this.now().toISOString(),
        publicVerificationUrl: new URL(`/public/${encodeURIComponent(competition.slug)}`, this.publicOrigin).toString(),
        sourceFingerprint,
        filename,
        divisions: [...new Map(matches.map((match) => [match.divisionId, match.divisionName])).entries()].map(
          ([divisionId, divisionName]) => ({
            divisionId,
            divisionName,
            matches: matches.filter((match) => match.divisionId === divisionId),
          }),
        ),
      };
      const bytes = await renderScheduleFallbackPdf(document);
      const contentSha256 = sha256(bytes);
      const manifest = await this.retainManifest(tx, {
        actor,
        competition,
        divisionId: null,
        exportKind: "schedule_a4",
        sourceFingerprint,
        filename,
        contentSha256,
        sizeBytes: bytes.byteLength,
      });
      return {
        filename,
        contentType: "application/pdf",
        bytes,
        sha256: contentSha256,
        sizeBytes: bytes.byteLength,
        sourceFingerprint,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        manifestId: manifest.id,
        duplicate: manifest.duplicate,
      };
    });
  }

  async scoreSheetPdf(actor: Phase3Actor, competitionId: string, matchId: string): Promise<GateCC4ExportReceipt> {
    return this.transaction(async (tx) => {
      await this.access(tx, actor, competitionId);
      const competition = await this.publishedCompetition(tx, competitionId);
      const matches = await this.publishedMatches(tx, competition);
      const match = matches.find((candidate) => candidate.matchId === matchId);
      if (!match) throw new ApiError(404, "PUBLISHED_MATCH_NOT_FOUND", "Match is not in the published schedule");
      const sourceFingerprint = this.sourceFingerprint(competition, matches);
      const sheetIdentifier = `schedule-v${competition.schedule_version}-${match.matchCode}`.replace(/[^A-Za-z0-9._-]/gu, "-");
      const filename = safeFallbackFilename(`${competition.name}-${match.matchCode}-${sheetIdentifier}`);
      const sheet: EmergencyScoreSheet = {
        schemaVersion: 1,
        documentType: "emergency_score_sheet",
        competitionId: competition.id,
        competitionName: competition.name,
        sport: competition.sport_code,
        timezone: competition.timezone,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        generatedAt: this.now().toISOString(),
        sourceFingerprint,
        sheetIdentifier,
        filename,
        match,
        sections: [],
      };
      const sectionDefinitions: Record<FallbackSport, EmergencyScoreSheet["sections"]> = {
        canoe_polo: [
          { kind: "periods", label: "Period score", columns: ["period", "home_goals", "away_goals"], repeatable: true },
          { kind: "discipline", label: "Cards and discipline", columns: ["time", "side", "person", "card", "reason"], repeatable: true },
          { kind: "timeouts", label: "Timeouts", columns: ["time", "side", "period"], repeatable: true },
          { kind: "incidents", label: "Incidents and corrections", columns: ["time", "note"], repeatable: true },
          { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
          { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
        ],
        badminton: [
          { kind: "segments", label: "Games", columns: ["game", "home_points", "away_points", "winner"], repeatable: true },
          { kind: "incidents", label: "Incidents and corrections", columns: ["game", "note"], repeatable: true },
          { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
          { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
        ],
        table_tennis: [
          { kind: "segments", label: "Games", columns: ["game", "home_points", "away_points", "winner"], repeatable: true },
          { kind: "incidents", label: "Incidents and corrections", columns: ["game", "note"], repeatable: true },
          { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
          { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
        ],
        volleyball: [
          { kind: "segments", label: "Sets", columns: ["set", "home_points", "away_points", "winner"], repeatable: true },
          { kind: "timeouts", label: "Timeouts", columns: ["set", "side", "score"], repeatable: true },
          { kind: "incidents", label: "Incidents and corrections", columns: ["set", "note"], repeatable: true },
          { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
          { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
        ],
        basketball: [
          { kind: "quarters", label: "Quarter score", columns: ["quarter", "home_points", "away_points"], repeatable: true },
          { kind: "timeouts", label: "Timeouts", columns: ["quarter", "side", "game_clock"], repeatable: true },
          { kind: "discipline", label: "Fouls", columns: ["quarter", "side", "person", "foul", "game_clock"], repeatable: true },
          { kind: "incidents", label: "Incidents and corrections", columns: ["quarter", "note"], repeatable: true },
          { kind: "officials", label: "Officials", columns: ["role", "name"], repeatable: true },
          { kind: "signatures", label: "Confirmation", columns: ["role", "name", "signature"], repeatable: false },
        ],
      };
      const renderedSheet: EmergencyScoreSheet = { ...sheet, sections: sectionDefinitions[competition.sport_code] };
      const bytes = await renderEmergencyScoreSheetPdf(renderedSheet);
      const contentSha256 = sha256(bytes);
      const exportKind = `${competition.sport_code}_score_sheet` as const;
      const manifest = await this.retainManifest(tx, {
        actor,
        competition,
        divisionId: match.divisionId,
        exportKind,
        sourceFingerprint,
        filename,
        contentSha256,
        sizeBytes: bytes.byteLength,
      });
      return {
        filename,
        contentType: "application/pdf",
        bytes,
        sha256: contentSha256,
        sizeBytes: bytes.byteLength,
        sourceFingerprint,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        manifestId: manifest.id,
        duplicate: manifest.duplicate,
      };
    });
  }
}
