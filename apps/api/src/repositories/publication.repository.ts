import type { LockMode, PublicationRecord, SqlExecutor } from "./types.js";

export type PublishedScheduleRevisionRecord = {
  id: string;
  competition_id: string;
  format_revision_id: string;
  revision: number;
  input_hash: string;
  status: string;
  warnings: unknown | string;
  quality: unknown | string;
};

export type PublishedCompetitionRecord = {
  id: string;
  name: string;
  slug: string;
  sport_code: string;
  timezone: string;
  starts_on: Date | string;
  ends_on: Date | string;
  schedule_version: number;
  result_version: number;
  published_schedule_revision_id: string | null;
  source_updated_at: Date | string;
};

export type PublishedScheduleMatchRecord = {
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

export type ExportManifestRecord = {
  id: string;
  content_sha256: string;
  byte_size: number;
  safe_filename: string;
};

export class PublicationRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findByCompetitionId(
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<PublicationRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<PublicationRecord>(
      `SELECT competition_id, schedule_version, result_version, published_at
       FROM competition_publications
       WHERE competition_id = $1${lockClause}`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async getVersions(
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<{ schedule_version: number; result_version: number } | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<{ schedule_version: number; result_version: number }>(
      `SELECT schedule_version, result_version
       FROM competition_publications
       WHERE competition_id = $1${lockClause}`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async findPublicationStatus(
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<{ schedule_version: number; result_version: number; updated_at: Date | string } | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<{
      schedule_version: number;
      result_version: number;
      updated_at: Date | string;
    }>(
      `SELECT schedule_version, result_version, updated_at
       FROM competition_publications
       WHERE competition_id = $1${lockClause}`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async findPublishedScheduleRevision(
    competitionId: string,
    expectedScheduleVersion: number,
    expectedResultVersion: number,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<PublishedScheduleRevisionRecord | null> {
    const lockClause =
      lock === "for_update" ? " FOR UPDATE OF revision, publication" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<PublishedScheduleRevisionRecord>(
      `SELECT revision.*
       FROM competition_publications publication
       JOIN schedule_revisions revision ON revision.id = publication.published_schedule_revision_id
       WHERE publication.competition_id = $1
         AND publication.schedule_version = $2
         AND publication.result_version = $3
         AND revision.status = 'published'${lockClause}`,
      [competitionId, expectedScheduleVersion, expectedResultVersion],
    );
    return rows[0] ?? null;
  }

  async findPublishedCompetition(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<PublishedCompetitionRecord | null> {
    const rows = await executor.unsafe<PublishedCompetitionRecord>(
      `SELECT competition.id, competition.name, competition.slug, competition.sport_code, competition.timezone,
              competition.starts_on, competition.ends_on,
              publication.schedule_version, publication.result_version,
              publication.published_schedule_revision_id,
              GREATEST(competition.updated_at, publication.updated_at) AS source_updated_at
       FROM competitions competition
       JOIN competition_publications publication ON publication.competition_id = competition.id
       WHERE competition.id = $1`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async findPublishedMatches(
    scheduleRevisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly PublishedScheduleMatchRecord[]> {
    return executor.unsafe<PublishedScheduleMatchRecord>(
      `SELECT match.id AS match_id, match.division_id, division.name AS division_name,
              match.code AS match_code, match.stage,
              scheduled.home_entry_id, home.name AS home_name,
              scheduled.away_entry_id, away.name AS away_name,
              scheduled.starts_at, scheduled.ends_at, area.name AS playing_area
       FROM scheduled_matches scheduled
       JOIN matches match ON match.id = scheduled.match_id
       JOIN divisions division ON division.id = match.division_id
       JOIN playing_areas area ON area.id = scheduled.playing_area_id
       LEFT JOIN division_entries home ON home.id = scheduled.home_entry_id
       LEFT JOIN division_entries away ON away.id = scheduled.away_entry_id
       WHERE scheduled.schedule_revision_id = $1
       ORDER BY division.name, scheduled.starts_at, area.name, match.ordinal, match.id`,
      [scheduleRevisionId],
    );
  }

  async findExportManifest(
    input: {
      competitionId: string;
      divisionId: string | null;
      exportKind: string;
      sourceFingerprint: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<ExportManifestRecord | null> {
    const rows = await executor.unsafe<ExportManifestRecord>(
      `SELECT id, content_sha256, byte_size::integer, safe_filename
       FROM competition_export_manifests
       WHERE competition_id = $1
         AND division_id IS NOT DISTINCT FROM $2::uuid
         AND export_kind = $3
         AND source_fingerprint = $4`,
      [input.competitionId, input.divisionId, input.exportKind, input.sourceFingerprint],
    );
    return rows[0] ?? null;
  }

  async insertExportManifest(
    input: {
      competitionId: string;
      divisionId: string | null;
      exportKind: string;
      scheduleVersion: number;
      resultVersion: number;
      sourceFingerprint: string;
      contentSha256: string;
      sizeBytes: number;
      filename: string;
      createdByAccountId: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ id: string }> {
    const rows = await executor.unsafe<{ id: string }>(
      `INSERT INTO competition_export_manifests(
         competition_id, division_id, export_kind, schedule_version, result_version,
         projection_fingerprint, source_fingerprint, content_sha256, byte_size,
         safe_filename, created_by_account_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, now())
       RETURNING id`,
      [
        input.competitionId,
        input.divisionId,
        input.exportKind,
        input.scheduleVersion,
        input.resultVersion,
        input.sourceFingerprint,
        input.contentSha256,
        input.sizeBytes,
        input.filename,
        input.createdByAccountId,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to insert export manifest");
    return row;
  }

  async upsert(
    input: {
      competitionId: string;
      scheduleVersion: number;
      resultVersion: number;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<PublicationRecord> {
    const rows = await executor.unsafe<PublicationRecord>(
      `INSERT INTO competition_publications (competition_id, schedule_version, result_version, published_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (competition_id) DO UPDATE
       SET schedule_version = EXCLUDED.schedule_version,
           result_version = EXCLUDED.result_version,
           published_at = EXCLUDED.published_at
       RETURNING competition_id, schedule_version, result_version, published_at`,
      [input.competitionId, input.scheduleVersion, input.resultVersion],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert publication");
    return row;
  }
}
