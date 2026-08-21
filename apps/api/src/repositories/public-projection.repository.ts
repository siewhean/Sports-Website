import type { SqlExecutor } from "./types.js";

export type PublicTruthRecord = {
  competition_id: string;
  payload: Record<string, unknown> | string;
  schedule_version: number;
  result_version: number;
  projection_version: number;
  division_projection_versions: Record<string, unknown> | string;
  generated_at: Date | string;
  source_updated_at: Date | string;
};

export type PublicCompetitionProjectionRecord = {
  projection: Record<string, unknown> | string;
  generated_at: Date | string;
  updated_at: Date | string;
  schedule_version: number;
  result_version: number;
};

export type PublicProjectionRecord = {
  id: string;
  competition_id: string;
  division_id: string;
  projection_version: number;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
};

export class PublicProjectionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findPublicTruth(slug: string, executor: SqlExecutor = this.sql): Promise<PublicTruthRecord | null> {
    const rows = await executor.unsafe<PublicTruthRecord>(
      `SELECT competition.id AS competition_id,
              current_projection.projection AS payload,
              publication.schedule_version,
              publication.result_version,
              COALESCE((
                SELECT max(version.projection_version)
                FROM public_projection_versions version
                WHERE version.competition_id = competition.id
                  AND version.schedule_version = publication.schedule_version
                  AND version.result_version = publication.result_version
              ), 1)::integer AS projection_version,
              COALESCE((
                SELECT jsonb_object_agg(version.division_id::text, version.projection_version)
                FROM (
                  SELECT division_id, max(projection_version)::integer AS projection_version
                  FROM public_projection_versions
                  WHERE competition_id = competition.id
                    AND schedule_version = publication.schedule_version
                    AND result_version = publication.result_version
                  GROUP BY division_id
                ) version
              ), '{}'::jsonb) AS division_projection_versions,
              current_projection.generated_at,
              publication.updated_at AS source_updated_at
       FROM competitions competition
       JOIN competition_publications publication
         ON publication.competition_id=competition.id
       JOIN public_competition_projections current_projection
         ON current_projection.competition_id=competition.id
        AND current_projection.schedule_version=publication.schedule_version
        AND current_projection.result_version=publication.result_version
       WHERE competition.slug = $1
         AND competition.status IN ('active', 'published', 'live', 'completed', 'archived')`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async findLatestProjectionVersionsByCompetitionId(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly { division_id: string; projection_version: number }[]> {
    return executor.unsafe<{ division_id: string; projection_version: number }>(
      `SELECT division_id, max(projection_version)::integer AS projection_version
       FROM public_projection_versions
       WHERE competition_id = $1
       GROUP BY division_id
       ORDER BY division_id`,
      [competitionId],
    );
  }

  async findCompetitionProjection(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<PublicCompetitionProjectionRecord | null> {
    const rows = await executor.unsafe<PublicCompetitionProjectionRecord>(
      `SELECT projection.projection, projection.generated_at, publication.updated_at,
              publication.schedule_version, publication.result_version
       FROM public_competition_projections projection
       JOIN competition_publications publication ON publication.competition_id = projection.competition_id
       WHERE projection.competition_id = $1
         AND projection.schedule_version = publication.schedule_version
         AND projection.result_version = publication.result_version`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async allocateProjectionVersion(
    competitionId: string,
    divisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<number> {
    const rows = await executor.unsafe<{ projection_version: number }>(
      `SELECT COALESCE(max(projection_version), 0)::integer + 1 AS projection_version
       FROM public_projection_versions WHERE competition_id = $1 AND division_id = $2`,
      [competitionId, divisionId],
    );
    return rows[0]?.projection_version ?? 1;
  }

  async insertProjectionVersion(
    input: {
      competitionId: string;
      divisionId: string;
      scheduleVersion: number;
      resultVersion: number;
      projectionVersion: number;
      scheduleRevisionId: string;
      sourceRepairRevisionId: string;
      projection: unknown;
      projectionFingerprint: string;
      etag: string;
      generatedAt: Date | string;
      sourceUpdatedAt: Date | string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ id: string }> {
    const rows = await executor.unsafe<{ id: string }>(
      `INSERT INTO public_projection_versions(
         competition_id, division_id, schedule_version, result_version, projection_version,
         schedule_revision_id, source_repair_revision_id, projection, projection_fingerprint, etag,
         generated_at, source_updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING id`,
      [
        input.competitionId,
        input.divisionId,
        input.scheduleVersion,
        input.resultVersion,
        input.projectionVersion,
        input.scheduleRevisionId,
        input.sourceRepairRevisionId,
        typeof input.projection === "string" ? input.projection : JSON.stringify(input.projection),
        input.projectionFingerprint,
        input.etag,
        input.generatedAt,
        input.sourceUpdatedAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to insert public projection version");
    return row;
  }

  async findMaxProjectionVersion(
    competitionId: string,
    divisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<number | null> {
    const rows = await executor.unsafe<{ max_version: number | null }>(
      `SELECT max(projection_version)::integer AS max_version
       FROM public_projection_versions
       WHERE competition_id = $1 AND division_id = $2`,
      [competitionId, divisionId],
    );
    return rows[0]?.max_version ?? null;
  }

  async findDivisionProjection(
    competitionId: string,
    divisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<PublicProjectionRecord | null> {
    const rows = await executor.unsafe<PublicProjectionRecord>(
      `SELECT id, competition_id, division_id, projection_version, projection AS payload, generated_at AS created_at
       FROM public_projection_versions
       WHERE competition_id = $1 AND division_id = $2
       ORDER BY projection_version DESC LIMIT 1`,
      [competitionId, divisionId],
    );
    return rows[0] ?? null;
  }

  async findAllByCompetitionId(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly PublicProjectionRecord[]> {
    return executor.unsafe<PublicProjectionRecord>(
      `SELECT id, competition_id, division_id, projection_version, projection AS payload, generated_at AS created_at
       FROM public_projection_versions
       WHERE competition_id = $1
       ORDER BY division_id ASC, projection_version DESC`,
      [competitionId],
    );
  }

  async upsertDivisionProjection(
    input: {
      competitionId: string;
      divisionId: string;
      projectionVersion: number;
      payload: string | Record<string, unknown>;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<PublicProjectionRecord> {
    const payloadStr = typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload);
    const rows = await executor.unsafe<PublicProjectionRecord>(
      `INSERT INTO public_projection_versions (
         competition_id, division_id, projection_version, schedule_version, result_version,
         projection, projection_fingerprint, etag, generated_at, source_updated_at
       ) VALUES ($1, $2, $3, 1, 1, $4::jsonb, repeat('0', 64), 'compat', now(), now())
       RETURNING id, competition_id, division_id, projection_version, projection AS payload, generated_at AS created_at`,
      [input.competitionId, input.divisionId, input.projectionVersion, payloadStr],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert public division projection");
    return row;
  }
}
