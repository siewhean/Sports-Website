import { createHash } from "node:crypto";
import {
  buildEmergencyScoreSheet,
  buildScheduleFallbackDocument,
  renderEmergencyScoreSheetPdf,
  renderScheduleFallbackPdf,
  type FallbackMatch,
  type FallbackSport,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import {
  CompetitionRepository,
  PublicationRepository,
  RepairRepository,
  type PublishedScheduleMatchRecord,
  type RepairQueueItemRecord,
} from "./repositories/index.js";

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
  private readonly competitionRepo: CompetitionRepository;
  private readonly publicationRepo: PublicationRepository;
  private readonly repairRepo: RepairRepository;

  constructor(
    private readonly sql: PostgresJsSql,
    private readonly publicOrigin: string,
    private readonly now: () => Date = () => new Date(),
    competitionRepo?: CompetitionRepository,
    publicationRepo?: PublicationRepository,
    repairRepo?: RepairRepository,
  ) {
    const parsed = new URL(publicOrigin);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Gate C4 public origin must be credential-free HTTP(S)");
    }
    this.competitionRepo = competitionRepo ?? new CompetitionRepository(sql);
    this.publicationRepo = publicationRepo ?? new PublicationRepository(sql);
    this.repairRepo = repairRepo ?? new RepairRepository(sql);
  }

  private async transaction<T>(operation: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    if (!this.sql.begin) throw new Error("Gate C4 operations require a transaction-capable PostgreSQL client");
    return this.sql.begin(operation);
  }

  private async access(tx: PostgresJsSql, actor: Phase3Actor, competitionId: string): Promise<CompetitionAccess> {
    const access = await this.competitionRepo.findCompetitionAccess(
      competitionId,
      actor.accountId,
      ["owner", "organiser"],
      tx,
    );
    if (!access) {
      throw new ApiError(404, ErrorCode.COMPETITION_ACCESS_DENIED, "Competition access denied");
    }
    if (access.competition_status === "archived")
      throw new ApiError(409, ErrorCode.COMPETITION_ARCHIVED, "Archived competitions are immutable");
    return {
      organisation_id: access.organisation_id,
      status: access.competition_status,
      membership_role: access.membership_role as "owner" | "organiser",
    };
  }

  async listRepairs(actor: Phase3Actor, competitionId: string): Promise<readonly GateCC4RepairQueueItem[]> {
    await this.access(this.sql, actor, competitionId);
    const rows = await this.repairRepo.listRepairs(competitionId, this.sql);
    return rows.map((row: RepairQueueItemRecord) => ({ ...row, created_at: instant(row.created_at) }));
  }

  private async publishedCompetition(tx: PostgresJsSql, competitionId: string): Promise<PublishedCompetition> {
    const competition = await this.publicationRepo.findPublishedCompetition(competitionId, tx);
    if (!competition) {
      throw new ApiError(404, ErrorCode.COMPETITION_NOT_FOUND, "Competition not found");
    }
    if (!competition.published_schedule_revision_id || competition.schedule_version < 1) {
      throw new ApiError(
        409,
        ErrorCode.SCHEDULE_NOT_PUBLISHED,
        "Publish a schedule before generating fallback documents",
      );
    }
    return {
      ...competition,
      sport_code: competition.sport_code as FallbackSport,
    };
  }

  private async publishedMatches(tx: PostgresJsSql, competition: PublishedCompetition): Promise<FallbackMatch[]> {
    if (!competition.published_schedule_revision_id) {
      throw new ApiError(
        409,
        ErrorCode.SCHEDULE_NOT_PUBLISHED,
        "Publish a schedule before generating fallback documents",
      );
    }
    const rows = await this.publicationRepo.findPublishedMatches(competition.published_schedule_revision_id, tx);
    if (rows.length < 1)
      throw new ApiError(409, ErrorCode.PUBLISHED_SCHEDULE_EMPTY, "Published schedule has no matches");
    return rows.map((row: PublishedScheduleMatchRecord) => ({
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
    const existing = await this.publicationRepo.findExportManifest(
      {
        competitionId: input.competition.id,
        divisionId: input.divisionId,
        exportKind: input.exportKind,
        sourceFingerprint: input.sourceFingerprint,
      },
      tx,
    );
    if (existing) {
      if (
        existing.content_sha256 !== input.contentSha256 ||
        existing.byte_size !== input.sizeBytes ||
        existing.safe_filename !== input.filename
      ) {
        throw new ApiError(409, ErrorCode.EXPORT_MANIFEST_CONFLICT, "A retained export manifest has different content");
      }
      return { id: existing.id, duplicate: true };
    }
    const retained = await this.publicationRepo.insertExportManifest(
      {
        competitionId: input.competition.id,
        divisionId: input.divisionId,
        exportKind: input.exportKind,
        scheduleVersion: input.competition.schedule_version,
        resultVersion: input.competition.result_version,
        sourceFingerprint: input.sourceFingerprint,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        filename: input.filename,
        createdByAccountId: input.actor.accountId,
      },
      tx,
    );
    return { id: retained.id, duplicate: false };
  }

  async schedulePdf(actor: Phase3Actor, competitionId: string): Promise<GateCC4ExportReceipt> {
    return this.transaction(async (tx) => {
      await this.access(tx, actor, competitionId);
      const competition = await this.publishedCompetition(tx, competitionId);
      const matches = await this.publishedMatches(tx, competition);
      const sourceFingerprint = this.sourceFingerprint(competition, matches);
      const document = buildScheduleFallbackDocument({
        competitionId: competition.id,
        competitionName: competition.name,
        sport: competition.sport_code,
        timezone: competition.timezone,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        generatedAt: this.now().toISOString(),
        publicVerificationUrl: `${this.publicOrigin}/c/${competition.slug}`,
        sourceFingerprint,
        matches,
      });
      const bytes = await renderScheduleFallbackPdf(document);
      const sha = sha256(bytes);
      const sizeBytes = bytes.byteLength;
      const retained = await this.retainManifest(tx, {
        actor,
        competition,
        divisionId: null,
        exportKind: "schedule_a4",
        sourceFingerprint,
        filename: document.filename,
        contentSha256: sha,
        sizeBytes,
      });
      return {
        filename: document.filename,
        contentType: "application/pdf",
        bytes,
        sha256: sha,
        sizeBytes,
        sourceFingerprint,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        manifestId: retained.id,
        duplicate: retained.duplicate,
      };
    });
  }

  async scoreSheetPdf(actor: Phase3Actor, competitionId: string, matchId: string): Promise<GateCC4ExportReceipt> {
    return this.transaction(async (tx) => {
      await this.access(tx, actor, competitionId);
      const competition = await this.publishedCompetition(tx, competitionId);
      const matches = await this.publishedMatches(tx, competition);
      const match = matches.find((candidate) => candidate.matchId === matchId);
      if (!match)
        throw new ApiError(404, ErrorCode.PUBLISHED_MATCH_NOT_FOUND, "Match is not in the published schedule");
      const exportKind = `${competition.sport_code}_score_sheet` as const;
      const sourceFingerprint = sha256(
        stableJson({
          competition_id: competition.id,
          schedule_version: competition.schedule_version,
          result_version: competition.result_version,
          published_schedule_revision_id: competition.published_schedule_revision_id,
          source_updated_at: instant(competition.source_updated_at),
          match,
        }),
      );
      const sheet = buildEmergencyScoreSheet({
        competitionId: competition.id,
        competitionName: competition.name,
        sport: competition.sport_code,
        timezone: competition.timezone,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        generatedAt: this.now().toISOString(),
        sourceFingerprint,
        sheetIdentifier: match.matchCode,
        match,
      });
      const bytes = await renderEmergencyScoreSheetPdf(sheet);
      const sha = sha256(bytes);
      const sizeBytes = bytes.byteLength;
      const retained = await this.retainManifest(tx, {
        actor,
        competition,
        divisionId: match.divisionId,
        exportKind,
        sourceFingerprint,
        filename: sheet.filename,
        contentSha256: sha,
        sizeBytes,
      });
      return {
        filename: sheet.filename,
        contentType: "application/pdf",
        bytes,
        sha256: sha,
        sizeBytes,
        sourceFingerprint,
        scheduleVersion: competition.schedule_version,
        resultVersion: competition.result_version,
        manifestId: retained.id,
        duplicate: retained.duplicate,
      };
    });
  }
}
