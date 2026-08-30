import type { SqlExecutor, CompetitionRecord, LockMode } from "./types.js";

const COMPETITION_COLUMNS = `id, organisation_id, created_by, name, slug, sport_code, status, venue, address, locality, country_code, starts_on, ends_on, timezone, locale, plan_tier, sport_pack_version, capacity_revision, revision, created_at, updated_at`;

export type OrganiserCompetitionLibraryRecord = {
  id: string;
  organisation_id: string;
  organisation_name: string;
  membership_role: "owner" | "organiser";
  name: string;
  slug: string;
  sport_code: string;
  status: string;
  starts_on: string;
  ends_on: string;
  timezone: string;
  updated_at: string;
  published: boolean;
};

export class CompetitionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<CompetitionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";

    const rows = await executor.unsafe<CompetitionRecord>(
      `SELECT ${COMPETITION_COLUMNS}
       FROM competitions
       WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findBySlug(slug: string, executor: SqlExecutor = this.sql): Promise<CompetitionRecord | null> {
    const rows = await executor.unsafe<CompetitionRecord>(
      `SELECT ${COMPETITION_COLUMNS}
       FROM competitions
       WHERE slug = $1`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async listByAccountId(
    accountId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly OrganiserCompetitionLibraryRecord[]> {
    const rows = await executor.unsafe<Omit<OrganiserCompetitionLibraryRecord, "updated_at"> & { updated_at: Date | string }>(
      `SELECT competition.id,
              competition.organisation_id,
              organisation.name AS organisation_name,
              membership.role AS membership_role,
              competition.name,
              competition.slug,
              competition.sport_code,
              competition.status,
              competition.starts_on::text,
              competition.ends_on::text,
              competition.timezone,
              competition.updated_at,
              (publication.published_schedule_revision_id IS NOT NULL) AS published
       FROM organisation_memberships membership
       JOIN organisations organisation ON organisation.id = membership.organisation_id
       JOIN competitions competition ON competition.organisation_id = organisation.id
       LEFT JOIN competition_publications publication ON publication.competition_id = competition.id
       WHERE membership.account_id = $1
         AND membership.status = 'active'
         AND membership.role IN ('owner', 'organiser')
       ORDER BY
         CASE competition.status
           WHEN 'draft' THEN 0
           WHEN 'active' THEN 1
           WHEN 'completed' THEN 2
           WHEN 'archived' THEN 3
           ELSE 4
         END,
         competition.starts_on,
         lower(competition.name),
         competition.id`,
      [accountId],
    );
    return rows.map((row) => ({
      ...row,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    }));
  }

  async existsBySlug(slug: string, excludeId?: string, executor: SqlExecutor = this.sql): Promise<boolean> {
    if (excludeId) {
      const rows = await executor.unsafe<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM competitions WHERE slug = $1 AND id != $2
         ) AS exists`,
        [slug, excludeId],
      );
      return Boolean(rows[0]?.exists);
    }

    const rows = await executor.unsafe<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM competitions WHERE slug = $1
       ) AS exists`,
      [slug],
    );
    return Boolean(rows[0]?.exists);
  }

  async getCapacityRevision(id: string, executor: SqlExecutor = this.sql): Promise<number | null> {
    const rows = await executor.unsafe<{ capacity_revision: number }>(
      `SELECT capacity_revision FROM competitions WHERE id = $1`,
      [id],
    );
    return rows[0]?.capacity_revision ?? null;
  }

  async incrementCapacityRevision(id: string, executor: SqlExecutor = this.sql): Promise<number> {
    const rows = await executor.unsafe<{ capacity_revision: number }>(
      `UPDATE competitions
       SET capacity_revision = capacity_revision + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING capacity_revision`,
      [id],
    );
    return rows[0]?.capacity_revision ?? 0;
  }

  async create(
    params: {
      id: string;
      organisationId: string;
      createdBy: string;
      name: string;
      slug: string;
      sportCode: string;
      venue: string;
      address: string;
      locality: string | null;
      countryCode: string;
      startsOn: string;
      endsOn: string;
      timezone: string;
      locale: string;
      status?: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ id: string; revision: number }> {
    const rows = await executor.unsafe<{ id: string; revision: number }>(
      `INSERT INTO competitions (
        id, organisation_id, created_by, name, slug, sport_code,
        venue, address, locality, country_code, starts_on, ends_on,
        timezone, locale, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, revision`,
      [
        params.id,
        params.organisationId,
        params.createdBy,
        params.name,
        params.slug,
        params.sportCode,
        params.venue,
        params.address,
        params.locality ?? null,
        params.countryCode,
        params.startsOn,
        params.endsOn,
        params.timezone,
        params.locale,
        params.status ?? "draft",
      ],
    );
    const created = rows[0];
    if (!created) {
      throw new Error("Competition was not created");
    }
    return created;
  }

  async findCompetitionAccess(
    competitionId: string,
    accountId: string,
    roles: readonly string[] = ["owner", "organiser"],
    executor: SqlExecutor = this.sql,
  ): Promise<{
    competition_id: string;
    organisation_id: string;
    competition_status: string;
    membership_role: "owner" | "organiser";
  } | null> {
    const rows = await executor.unsafe<{
      competition_id: string;
      organisation_id: string;
      competition_status: string;
      membership_role: "owner" | "organiser";
    }>(
      `SELECT competition.id AS competition_id, competition.organisation_id,
              competition.status AS competition_status, membership.role AS membership_role
       FROM competitions competition
       JOIN organisation_memberships membership
         ON membership.organisation_id = competition.organisation_id
       WHERE competition.id = $1
         AND membership.account_id = $2
         AND membership.status = 'active'
         AND membership.role = ANY($3::text[])`,
      [competitionId, accountId, roles],
    );
    return rows[0] ?? null;
  }

  async acquireCompetitionUpdateLock(id: string, executor: SqlExecutor = this.sql): Promise<void> {
    await executor.unsafe(`SELECT 1 FROM competitions WHERE id = $1 FOR UPDATE`, [id]);
  }
}
