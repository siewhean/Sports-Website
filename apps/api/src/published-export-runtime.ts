import type { PostgresJsSql } from "@matchday/identity";
import type { Phase3Actor } from "./phase-3-runtime.js";
import { ApiError, ErrorCode } from "./errors.js";
import { ExportRuntime } from "./export-runtime.js";

const escapeCsv = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

type PublicExportContext = {
  scheduleRevisionId: string;
  formatRevisionId: string;
  resultsPublishedAt: Date | null;
};

/**
 * Public exports must be projections of immutable published state. Organiser
 * exports deliberately keep the existing draft-capable ExportRuntime behavior.
 */
export class PublishedExportRuntime extends ExportRuntime {
  constructor(private readonly publishedSql: PostgresJsSql) {
    super(publishedSql);
  }

  private async publicContext(competitionId: string): Promise<PublicExportContext> {
    const row = (
      await this.publishedSql.unsafe<{
        status: string;
        published_schedule_revision_id: string | null;
        schedule_published_at: Date | null;
        results_published_at: Date | null;
        format_revision_id: string | null;
      }>(
        `SELECT c.status,
                cp.published_schedule_revision_id,
                cp.schedule_published_at,
                cp.results_published_at,
                sr.format_revision_id
         FROM competitions c
         LEFT JOIN competition_publications cp ON cp.competition_id=c.id
         LEFT JOIN schedule_revisions sr
           ON sr.id=cp.published_schedule_revision_id AND sr.competition_id=c.id
         WHERE c.id=$1`,
        [competitionId],
      )
    )[0];

    if (!row) throw new ApiError(404, ErrorCode.COMPETITION_NOT_FOUND, "Competition not found");
    if (
      !row.published_schedule_revision_id ||
      !row.schedule_published_at ||
      !row.format_revision_id ||
      !["published", "active", "live", "completed", "archived"].includes(row.status)
    ) {
      throw new ApiError(403, ErrorCode.ACCESS_DENIED, "Competition has no published schedule export");
    }

    return {
      scheduleRevisionId: row.published_schedule_revision_id,
      formatRevisionId: row.format_revision_id,
      resultsPublishedAt: row.results_published_at,
    };
  }

  override async generateCompetitionCsv(competitionId: string, actor?: Phase3Actor): Promise<string> {
    if (actor) return super.generateCompetitionCsv(competitionId, actor);
    const context = await this.publicContext(competitionId);
    const rows = await this.publishedSql.unsafe<{
      division_name: string;
      stage_name: string;
      match_code: string;
      home_name: string | null;
      away_name: string | null;
      state: string;
      pitch_name: string | null;
      start_time: Date;
    }>(
      `SELECT d.name division_name,
              COALESCE(m.stage,'Main') stage_name,
              m.code match_code,
              home.name home_name,
              away.name away_name,
              COALESCE(result.state,'ready') state,
              pa.name pitch_name,
              sm.starts_at start_time
       FROM scheduled_matches sm
       JOIN matches m ON m.id=sm.match_id
         AND m.competition_id=sm.competition_id
         AND m.format_revision_id=$3
       JOIN divisions d ON d.id=m.division_id
       LEFT JOIN division_entries home ON home.id=sm.home_entry_id
       LEFT JOIN division_entries away ON away.id=sm.away_entry_id
       JOIN playing_areas pa ON pa.id=sm.playing_area_id
       LEFT JOIN LATERAL (
         SELECT snapshot.state
         FROM match_result_snapshots snapshot
         WHERE snapshot.match_id=m.id
           AND snapshot.state IN ('final','corrected')
           AND $4::timestamptz IS NOT NULL
           AND snapshot.created_at <= $4
         ORDER BY snapshot.result_version DESC
         LIMIT 1
       ) result ON true
       WHERE sm.competition_id=$1 AND sm.schedule_revision_id=$2
       ORDER BY d.created_at,d.name,sm.starts_at,m.code`,
      [competitionId, context.scheduleRevisionId, context.formatRevisionId, context.resultsPublishedAt],
    );

    const headers = ["Division", "Stage", "Match", "Home Team", "Away Team", "Status", "Court/Pitch", "Scheduled Start"];
    const body = rows.map((row) =>
      [
        row.division_name,
        row.stage_name,
        row.match_code,
        row.home_name ?? "TBD",
        row.away_name ?? "TBD",
        row.state,
        row.pitch_name ?? "Unassigned",
        row.start_time.toISOString(),
      ]
        .map(escapeCsv)
        .join(","),
    );
    return [headers.join(","), ...body].join("\n");
  }

  override async generateStandingsCsv(competitionId: string, actor?: Phase3Actor): Promise<string> {
    if (actor) return super.generateStandingsCsv(competitionId, actor);
    const context = await this.publicContext(competitionId);
    const rows = await this.publishedSql.unsafe<{
      division_name: string;
      team_name: string;
      rank: number;
      played: number;
      won: number;
      drawn: number;
      lost: number;
      goals_for: number;
      goals_against: number;
      goal_diff: number;
      points: number;
    }>(
      `WITH published_results AS (
         SELECT DISTINCT ON (snapshot.match_id)
                snapshot.match_id,snapshot.home_score,snapshot.away_score
         FROM match_result_snapshots snapshot
         JOIN scheduled_matches sm ON sm.match_id=snapshot.match_id
           AND sm.competition_id=$1 AND sm.schedule_revision_id=$2
         JOIN matches m ON m.id=sm.match_id AND m.format_revision_id=$3
         WHERE snapshot.state IN ('final','corrected')
           AND $4::timestamptz IS NOT NULL
           AND snapshot.created_at <= $4
         ORDER BY snapshot.match_id,snapshot.result_version DESC
       ), records AS (
         SELECT m.home_entry_id entry_id,
                (r.home_score>r.away_score) won,(r.home_score=r.away_score) drawn,(r.home_score<r.away_score) lost,
                r.home_score goals_for,r.away_score goals_against,
                CASE WHEN r.home_score>r.away_score THEN 3 WHEN r.home_score=r.away_score THEN 1 ELSE 0 END points
         FROM published_results r JOIN matches m ON m.id=r.match_id
         UNION ALL
         SELECT m.away_entry_id,
                (r.away_score>r.home_score),(r.home_score=r.away_score),(r.away_score<r.home_score),
                r.away_score,r.home_score,
                CASE WHEN r.away_score>r.home_score THEN 3 WHEN r.home_score=r.away_score THEN 1 ELSE 0 END
         FROM published_results r JOIN matches m ON m.id=r.match_id
       ), totals AS (
         SELECT entry_id,count(*)::integer played,
                count(*) FILTER (WHERE won)::integer won,
                count(*) FILTER (WHERE drawn)::integer drawn,
                count(*) FILTER (WHERE lost)::integer lost,
                COALESCE(sum(goals_for),0)::integer goals_for,
                COALESCE(sum(goals_against),0)::integer goals_against,
                COALESCE(sum(goals_for-goals_against),0)::integer goal_diff,
                COALESCE(sum(points),0)::integer points
         FROM records WHERE entry_id IS NOT NULL GROUP BY entry_id
       ), published_entries AS (
         SELECT DISTINCT entry_id
         FROM (
           SELECT sm.home_entry_id entry_id FROM scheduled_matches sm WHERE sm.competition_id=$1 AND sm.schedule_revision_id=$2
           UNION
           SELECT sm.away_entry_id FROM scheduled_matches sm WHERE sm.competition_id=$1 AND sm.schedule_revision_id=$2
         ) source WHERE entry_id IS NOT NULL
       )
       SELECT d.name division_name,e.name team_name,COALESCE(e.seed,1) rank,
              COALESCE(t.played,0) played,COALESCE(t.won,0) won,COALESCE(t.drawn,0) drawn,COALESCE(t.lost,0) lost,
              COALESCE(t.goals_for,0) goals_for,COALESCE(t.goals_against,0) goals_against,COALESCE(t.goal_diff,0) goal_diff,
              COALESCE(t.points,0) points
       FROM published_entries pe
       JOIN division_entries e ON e.id=pe.entry_id
       JOIN divisions d ON d.id=e.division_id AND d.competition_id=$1
       LEFT JOIN totals t ON t.entry_id=e.id
       ORDER BY d.name,COALESCE(t.points,0) DESC,COALESCE(t.goal_diff,0) DESC,e.name`,
      [competitionId, context.scheduleRevisionId, context.formatRevisionId, context.resultsPublishedAt],
    );

    const headers = ["Division", "Rank", "Team", "Played", "Won", "Drawn", "Lost", "Goals For", "Goals Against", "Goal Difference", "Points"];
    const body = rows.map((row) =>
      [row.division_name,row.rank,row.team_name,row.played,row.won,row.drawn,row.lost,row.goals_for,row.goals_against,row.goal_diff,row.points]
        .map(escapeCsv)
        .join(","),
    );
    return [headers.join(","), ...body].join("\n");
  }

  override async generateBracketCsv(competitionId: string, actor?: Phase3Actor): Promise<string> {
    if (actor) return super.generateBracketCsv(competitionId, actor);
    const context = await this.publicContext(competitionId);
    const rows = await this.publishedSql.unsafe<{
      division_name: string;
      match_id: string;
      stage: string;
      home_name: string | null;
      away_name: string | null;
      state: string;
    }>(
      `SELECT d.name division_name,m.code match_id,COALESCE(m.stage,'Bracket') stage,
              home.name home_name,away.name away_name,COALESCE(result.state,'ready') state
       FROM scheduled_matches sm
       JOIN matches m ON m.id=sm.match_id AND m.competition_id=sm.competition_id AND m.format_revision_id=$3
       JOIN divisions d ON d.id=m.division_id
       LEFT JOIN division_entries home ON home.id=sm.home_entry_id
       LEFT JOIN division_entries away ON away.id=sm.away_entry_id
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM match_result_snapshots snapshot
         WHERE snapshot.match_id=m.id AND snapshot.state IN ('final','corrected')
           AND $4::timestamptz IS NOT NULL AND snapshot.created_at <= $4
         ORDER BY snapshot.result_version DESC LIMIT 1
       ) result ON true
       WHERE sm.competition_id=$1 AND sm.schedule_revision_id=$2
       ORDER BY d.name,m.ordinal,m.code`,
      [competitionId, context.scheduleRevisionId, context.formatRevisionId, context.resultsPublishedAt],
    );
    const headers = ["Division", "Stage", "Match", "Home Team", "Away Team", "State"];
    return [
      headers.join(","),
      ...rows.map((row) => [row.division_name,row.stage,row.match_id,row.home_name ?? "TBD",row.away_name ?? "TBD",row.state].map(escapeCsv).join(",")),
    ].join("\n");
  }

  override async generateCompetitionJson(competitionId: string, actor?: Phase3Actor): Promise<Record<string, unknown>> {
    if (actor) return super.generateCompetitionJson(competitionId, actor);
    const context = await this.publicContext(competitionId);
    const comp = (
      await this.publishedSql.unsafe<{ id: string; name: string; sport_code: string; status: string; created_at: Date }>(
        `SELECT id,name,sport_code,status,created_at FROM competitions WHERE id=$1`,
        [competitionId],
      )
    )[0]!;
    const matches = await this.publishedSql.unsafe<{
      id: string; division_id: string; division_name: string; code: string; stage: string;
      home_entry_id: string | null; away_entry_id: string | null; state: string; scheduled_start: Date;
    }>(
      `SELECT m.id,m.division_id,d.name division_name,m.code,m.stage,
              sm.home_entry_id,sm.away_entry_id,COALESCE(result.state,'ready') state,sm.starts_at scheduled_start
       FROM scheduled_matches sm
       JOIN matches m ON m.id=sm.match_id AND m.competition_id=sm.competition_id AND m.format_revision_id=$3
       JOIN divisions d ON d.id=m.division_id
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM match_result_snapshots snapshot
         WHERE snapshot.match_id=m.id AND snapshot.state IN ('final','corrected')
           AND $4::timestamptz IS NOT NULL AND snapshot.created_at <= $4
         ORDER BY snapshot.result_version DESC LIMIT 1
       ) result ON true
       WHERE sm.competition_id=$1 AND sm.schedule_revision_id=$2
       ORDER BY d.created_at,d.name,sm.starts_at,m.code`,
      [competitionId, context.scheduleRevisionId, context.formatRevisionId, context.resultsPublishedAt],
    );
    const entryIds = [...new Set(matches.flatMap((match) => [match.home_entry_id,match.away_entry_id]).filter((id): id is string => Boolean(id)))];
    const entries = entryIds.length
      ? await this.publishedSql.unsafe<{ id: string; division_id: string; name: string; seed: number | null }>(
          `SELECT id,division_id,name,seed FROM division_entries WHERE id=ANY($1::uuid[]) ORDER BY seed NULLS LAST,name`,
          [entryIds],
        )
      : [];
    const branding = (
      await this.publishedSql.unsafe<Record<string, unknown>>(
        `SELECT primary_color,secondary_color,logo_url,banner_url,hide_platform_badge FROM competition_branding WHERE competition_id=$1`,
        [competitionId],
      )
    )[0] ?? null;
    const sponsors = await this.publishedSql.unsafe<Record<string, unknown>>(
      `SELECT name,tier,logo_url,website_url,sort_order FROM competition_sponsors WHERE competition_id=$1 ORDER BY sort_order`,
      [competitionId],
    );
    const divisionIds = [...new Set(matches.map((match) => match.division_id))];
    return {
      schema_version: "1.0",
      exported_at: new Date().toISOString(),
      competition: { id: comp.id, name: comp.name, sport_code: comp.sport_code, status: comp.status, created_at: comp.created_at.toISOString() },
      branding,
      sponsors,
      divisions: divisionIds.map((divisionId) => ({
        id: divisionId,
        name: matches.find((match) => match.division_id === divisionId)!.division_name,
        entries: entries.filter((entry) => entry.division_id === divisionId).map((entry) => ({ id: entry.id, name: entry.name, seed: entry.seed })),
        matches: matches.filter((match) => match.division_id === divisionId).map((match) => ({
          id: match.id, code: match.code, stage: match.stage, home_entry_id: match.home_entry_id,
          away_entry_id: match.away_entry_id, state: match.state, scheduled_start: match.scheduled_start.toISOString(),
        })),
      })),
    };
  }
}
