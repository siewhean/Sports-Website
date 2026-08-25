import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

const escapeCsv = (val: string | number | null | undefined): string => {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export class ExportRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  private async assertExportAccess(
    competitionId: string,
    actor?: Phase3Actor,
  ): Promise<{ organisationId: string; isPublished: boolean; publishedRevisionId: string | null }> {
    const comp = (
      await this.sql.unsafe<{ id: string; organisation_id: string; status: string }>(
        `SELECT id, organisation_id, status FROM competitions WHERE id=$1`,
        [competitionId],
      )
    )[0];
    if (!comp) {
      throw new ApiError(404, ErrorCode.COMPETITION_NOT_FOUND, "Competition not found");
    }

    const publication = (
      await this.sql.unsafe<{
        published_schedule_revision_id: string | null;
        schedule_published_at: Date | null;
      }>(
        `SELECT published_schedule_revision_id, schedule_published_at
         FROM competition_publications
         WHERE competition_id=$1`,
        [competitionId],
      )
    )[0];
    const isPublished = Boolean(
      publication?.published_schedule_revision_id &&
      publication?.schedule_published_at &&
      ["published", "active", "live", "completed", "archived"].includes(comp.status),
    );

    if (!actor) {
      // Unauthenticated / public caller: strictly requires published schedule
      if (!isPublished) {
        throw new ApiError(
          403,
          ErrorCode.ACCESS_DENIED,
          "Unpublished competition schedule cannot be exported without organiser authentication",
        );
      }
      return {
        organisationId: comp.organisation_id,
        isPublished: true,
        publishedRevisionId: publication!.published_schedule_revision_id,
      };
    }

    // Authenticated caller: assert organisation membership or platform admin
    const member = (
      await this.sql.unsafe<{ role: string }>(
        `SELECT role FROM organisation_memberships WHERE organisation_id=$1 AND account_id=$2 AND status='active'`,
        [comp.organisation_id, actor.accountId],
      )
    )[0];

    const platformAdmin = (
      await this.sql.unsafe<{ role: string }>(
        `SELECT role FROM account_platform_roles WHERE account_id=$1 AND role='platform_admin'`,
        [actor.accountId],
      )
    )[0];

    if (!member && !platformAdmin && !isPublished) {
      throw new ApiError(403, ErrorCode.ORGANISATION_ACCESS_DENIED, "Access denied to unpublished competition");
    }

    return {
      organisationId: comp.organisation_id,
      isPublished,
      publishedRevisionId: publication?.published_schedule_revision_id ?? null,
    };
  }

  async generateCompetitionCsv(competitionId: string, actor?: Phase3Actor): Promise<string> {
    const { isPublished, publishedRevisionId } = await this.assertExportAccess(competitionId, actor);
    const restrictToPublished = !actor && isPublished && Boolean(publishedRevisionId);

    const matches = await this.sql.unsafe<{
      division_name: string;
      stage_name: string;
      match_code: string;
      home_name: string | null;
      away_name: string | null;
      state: string;
      pitch_name: string | null;
      start_time: Date | null;
    }>(
      `SELECT
         d.name as division_name,
         COALESCE(m.stage, 'Main') as stage_name,
         m.code as match_code,
         e_home.name as home_name,
         e_away.name as away_name,
         m.state,
         pa.name as pitch_name,
         sm.starts_at as start_time
       FROM matches m
       JOIN divisions d ON d.id = m.division_id
       LEFT JOIN division_entries e_home ON e_home.id = m.home_entry_id
       LEFT JOIN division_entries e_away ON e_away.id = m.away_entry_id
       LEFT JOIN scheduled_matches sm ON sm.match_id = m.id
       LEFT JOIN playing_areas pa ON pa.id = sm.playing_area_id
       WHERE d.competition_id = $1
         AND ($2::uuid IS NULL OR m.schedule_revision_id = $2)
       ORDER BY d.created_at, d.name, sm.starts_at NULLS LAST, m.code`,
      [competitionId, restrictToPublished ? publishedRevisionId : null],
    );

    const headers = [
      "Division",
      "Stage",
      "Match",
      "Home Team",
      "Away Team",
      "Status",
      "Court/Pitch",
      "Scheduled Start",
    ];

    const rows = matches.map((m) => [
      escapeCsv(m.division_name),
      escapeCsv(m.stage_name),
      escapeCsv(m.match_code),
      escapeCsv(m.home_name ?? "TBD"),
      escapeCsv(m.away_name ?? "TBD"),
      escapeCsv(m.state),
      escapeCsv(m.pitch_name ?? "Unassigned"),
      escapeCsv(m.start_time ? m.start_time.toISOString() : ""),
    ]);

    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  }

  async generateStandingsCsv(competitionId: string, actor?: Phase3Actor): Promise<string> {
    const { isPublished, publishedRevisionId } = await this.assertExportAccess(competitionId, actor);
    const restrictToPublished = !actor && isPublished && Boolean(publishedRevisionId);

    const standings = await this.sql.unsafe<{
      division_name: string;
      rank: number;
      team_name: string;
      played: number;
      won: number;
      drawn: number;
      lost: number;
      goals_for: number;
      goals_against: number;
      goal_diff: number;
      points: number;
    }>(
      `SELECT
         d.name as division_name,
         e.name as team_name,
         COALESCE(e.seed, 1) as rank,
         COALESCE(s.played, 0) as played,
         COALESCE(s.won, 0) as won,
         COALESCE(s.drawn, 0) as drawn,
         COALESCE(s.lost, 0) as lost,
         COALESCE(s.goals_for, 0) as goals_for,
         COALESCE(s.goals_against, 0) as goals_against,
         COALESCE(s.goal_difference, 0) as goal_diff,
         COALESCE(s.points, 0) as points
       FROM division_entries e
       JOIN divisions d ON d.id = e.division_id
       LEFT JOIN (
         SELECT entry_id, count(*)::integer as played,
                count(*) FILTER (WHERE won)::integer as won,
                count(*) FILTER (WHERE drawn)::integer as drawn,
                count(*) FILTER (WHERE lost)::integer as lost,
                sum(goals_for)::integer as goals_for,
                sum(goals_against)::integer as goals_against,
                sum(goals_for - goals_against)::integer as goal_difference,
                sum(points)::integer as points
         FROM (
           SELECT home_entry_id as entry_id,
                  home_score > away_score as won,
                  home_score = away_score as drawn,
                  home_score < away_score as lost,
                  home_score as goals_for,
                  away_score as goals_against,
                  CASE WHEN home_score > away_score THEN 3 WHEN home_score = away_score THEN 1 ELSE 0 END as points
           FROM matches
           WHERE state = 'completed' AND home_score IS NOT NULL AND away_score IS NOT NULL
             AND ($2::uuid IS NULL OR schedule_revision_id = $2)
           UNION ALL
           SELECT away_entry_id as entry_id,
                  away_score > home_score as won,
                  home_score = away_score as drawn,
                  away_score < home_score as lost,
                  away_score as goals_for,
                  home_score as goals_against,
                  CASE WHEN away_score > home_score THEN 3 WHEN home_score = away_score THEN 1 ELSE 0 END as points
           FROM matches
           WHERE state = 'completed' AND home_score IS NOT NULL AND away_score IS NOT NULL
             AND ($2::uuid IS NULL OR schedule_revision_id = $2)
         ) match_records
         GROUP BY entry_id
       ) s ON s.entry_id = e.id
       WHERE d.competition_id = $1
       ORDER BY d.name, COALESCE(s.points, 0) DESC, COALESCE(s.goal_difference, 0) DESC, e.name`,
      [competitionId, restrictToPublished ? publishedRevisionId : null],
    );

    const headers = [
      "Division",
      "Rank",
      "Team",
      "Played",
      "Won",
      "Drawn",
      "Lost",
      "Goals For",
      "Goals Against",
      "Goal Difference",
      "Points",
    ];

    const rows = standings.map((s) => [
      escapeCsv(s.division_name),
      escapeCsv(s.rank),
      escapeCsv(s.team_name),
      escapeCsv(s.played),
      escapeCsv(s.won),
      escapeCsv(s.drawn),
      escapeCsv(s.lost),
      escapeCsv(s.goals_for),
      escapeCsv(s.goals_against),
      escapeCsv(s.goal_diff),
      escapeCsv(s.points),
    ]);

    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  }

  async generateBracketCsv(competitionId: string, actor?: Phase3Actor): Promise<string> {
    const { isPublished, publishedRevisionId } = await this.assertExportAccess(competitionId, actor);
    const restrictToPublished = !actor && isPublished && Boolean(publishedRevisionId);

    const bracketMatches = await this.sql.unsafe<{
      division_name: string;
      match_id: string;
      stage: string;
      home_name: string | null;
      away_name: string | null;
      state: string;
    }>(
      `SELECT
         d.name as division_name,
         m.code as match_id,
         COALESCE(m.stage, 'Bracket') as stage,
         e_home.name as home_name,
         e_away.name as away_name,
         m.state
       FROM matches m
       JOIN divisions d ON d.id = m.division_id
       LEFT JOIN division_entries e_home ON e_home.id = m.home_entry_id
       LEFT JOIN division_entries e_away ON e_away.id = m.away_entry_id
       WHERE d.competition_id = $1
         AND ($2::uuid IS NULL OR m.schedule_revision_id = $2)
       ORDER BY d.name, m.code`,
      [competitionId, restrictToPublished ? publishedRevisionId : null],
    );

    const headers = ["Division", "Stage", "Match", "Home Team", "Away Team", "State"];
    const rows = bracketMatches.map((b) => [
      escapeCsv(b.division_name),
      escapeCsv(b.stage),
      escapeCsv(b.match_id),
      escapeCsv(b.home_name ?? "TBD"),
      escapeCsv(b.away_name ?? "TBD"),
      escapeCsv(b.state),
    ]);

    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  }

  async generateAuditHistoryExport(actor: Phase3Actor, competitionId: string): Promise<string> {
    const { organisationId } = await this.assertExportAccess(competitionId, actor);

    const events = await this.sql.unsafe<{
      id: string;
      action: string;
      actor_account_id: string;
      actor_type: string;
      target_type: string;
      target_id: string;
      occurred_at: Date;
    }>(
      `SELECT id, action, actor_account_id, actor_type, target_type, target_id, occurred_at
       FROM audit_events
       WHERE (target_id = $1 OR metadata->>'competition_id' = $1)
         AND (organisation_id = $2 OR organisation_id IS NULL)
       ORDER BY occurred_at DESC
       LIMIT 500`,
      [competitionId, organisationId],
    );

    const headers = ["Timestamp", "Action", "Actor ID", "Actor Type", "Target Type", "Target ID"];
    const rows = events.map((e) => [
      escapeCsv(e.occurred_at.toISOString()),
      escapeCsv(e.action),
      escapeCsv(e.actor_account_id),
      escapeCsv(e.actor_type),
      escapeCsv(e.target_type),
      escapeCsv(e.target_id),
    ]);

    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  }

  async generateCompetitionJson(competitionId: string, actor?: Phase3Actor): Promise<Record<string, unknown>> {
    const { isPublished, publishedRevisionId } = await this.assertExportAccess(competitionId, actor);
    const restrictToPublished = !actor && isPublished && Boolean(publishedRevisionId);

    const comp = (
      await this.sql.unsafe<{ id: string; name: string; sport_code: string; status: string; created_at: Date }>(
        `SELECT id, name, sport_code, status, created_at FROM competitions WHERE id=$1`,
        [competitionId],
      )
    )[0]!;

    const divisions = await this.sql.unsafe<{ id: string; name: string }>(
      `SELECT id, name FROM divisions WHERE competition_id=$1 ORDER BY created_at, name`,
      [competitionId],
    );

    const entries = await this.sql.unsafe<{ id: string; division_id: string; name: string; seed: number | null }>(
      `SELECT e.id, e.division_id, e.name, e.seed
       FROM division_entries e
       JOIN divisions d ON d.id = e.division_id
       WHERE d.competition_id=$1
       ORDER BY d.created_at, d.name, e.seed NULLS LAST, e.name`,
      [competitionId],
    );

    const matches = await this.sql.unsafe<{
      id: string;
      division_id: string;
      code: string;
      stage: string;
      home_entry_id: string | null;
      away_entry_id: string | null;
      state: string;
      scheduled_start: Date | null;
    }>(
      `SELECT m.id, m.division_id, m.code, m.stage, m.home_entry_id, m.away_entry_id, m.state, sm.starts_at as scheduled_start
       FROM matches m
       JOIN divisions d ON d.id = m.division_id
       LEFT JOIN scheduled_matches sm ON sm.match_id = m.id
       WHERE d.competition_id=$1
         AND ($2::uuid IS NULL OR m.schedule_revision_id = $2)
       ORDER BY d.created_at, d.name, sm.starts_at NULLS LAST, m.code`,
      [competitionId, restrictToPublished ? publishedRevisionId : null],
    );

    const branding = (
      await this.sql.unsafe<{
        primary_color: string | null;
        secondary_color: string | null;
        logo_url: string | null;
        banner_url: string | null;
        hide_platform_badge: boolean;
      }>(
        `SELECT primary_color, secondary_color, logo_url, banner_url, hide_platform_badge
         FROM competition_branding WHERE competition_id=$1`,
        [competitionId],
      )
    )[0];

    const sponsors = await this.sql.unsafe<{
      name: string;
      tier: string;
      logo_url: string | null;
      website_url: string | null;
      sort_order: number;
    }>(
      `SELECT name, tier, logo_url, website_url, sort_order
       FROM competition_sponsors WHERE competition_id=$1 ORDER BY sort_order`,
      [competitionId],
    );

    return {
      schema_version: "1.0",
      exported_at: new Date().toISOString(),
      competition: {
        id: comp.id,
        name: comp.name,
        sport_code: comp.sport_code,
        status: comp.status,
        created_at: comp.created_at.toISOString(),
      },
      branding: branding ?? null,
      sponsors: sponsors.map((s) => ({
        name: s.name,
        tier: s.tier,
        logo_url: s.logo_url,
        website_url: s.website_url,
        sort_order: s.sort_order,
      })),
      divisions: divisions.map((d) => ({
        id: d.id,
        name: d.name,
        entries: entries
          .filter((e) => e.division_id === d.id)
          .map((e) => ({
            id: e.id,
            name: e.name,
            seed: e.seed,
          })),
        matches: matches
          .filter((m) => m.division_id === d.id)
          .map((m) => ({
            id: m.id,
            code: m.code,
            stage: m.stage,
            home_entry_id: m.home_entry_id,
            away_entry_id: m.away_entry_id,
            state: m.state,
            scheduled_start: m.scheduled_start ? m.scheduled_start.toISOString() : null,
          })),
      })),
    };
  }

  validateCompetitionArchive(archive: unknown): {
    valid: boolean;
    competition?: { id: string; name: string; sport_code: string };
    divisionsCount?: number;
    entriesCount?: number;
    matchesCount?: number;
    error?: string;
  } {
    if (!archive || typeof archive !== "object") {
      return { valid: false, error: "Archive must be a non-null object" };
    }
    const doc = archive as Record<string, unknown>;
    if (doc.schema_version !== "1.0") {
      return { valid: false, error: "Unsupported schema_version, expected '1.0'" };
    }
    const comp = doc.competition as Record<string, unknown> | undefined;
    if (!comp || typeof comp.id !== "string" || typeof comp.name !== "string" || typeof comp.sport_code !== "string") {
      return { valid: false, error: "Missing or invalid competition metadata in archive" };
    }
    const divisions = doc.divisions;
    if (!Array.isArray(divisions)) {
      return { valid: false, error: "Archive divisions must be an array" };
    }

    let entriesCount = 0;
    let matchesCount = 0;

    for (const div of divisions) {
      if (!div || typeof div !== "object") {
        return { valid: false, error: "Invalid division object in archive" };
      }
      const divisionObj = div as Record<string, unknown>;
      if (typeof divisionObj.name !== "string") {
        return { valid: false, error: "Invalid division object in archive" };
      }
      if (Array.isArray(divisionObj.entries)) {
        entriesCount += divisionObj.entries.length;
      }
      if (Array.isArray(divisionObj.matches)) {
        matchesCount += divisionObj.matches.length;
      }
    }

    return {
      valid: true,
      competition: {
        id: comp.id,
        name: comp.name,
        sport_code: comp.sport_code,
      },
      divisionsCount: divisions.length,
      entriesCount,
      matchesCount,
    };
  }
}
