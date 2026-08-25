import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";

export class ExportRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  async generateCompetitionCsv(competitionId: string): Promise<string> {
    const comp = (
      await this.sql.unsafe<{ id: string; name: string; sport_code: string }>(
        `SELECT id, name, sport_code FROM competitions WHERE id=$1`,
        [competitionId],
      )
    )[0];
    if (!comp) {
      throw new ApiError(404, ErrorCode.COMPETITION_NOT_FOUND, "Competition not found");
    }

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
       ORDER BY d.created_at, d.name, sm.starts_at NULLS LAST, m.code`,
      [competitionId],
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

    const escapeCsv = (val: string | number | null | undefined) => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

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

  async generateCompetitionJson(competitionId: string): Promise<Record<string, unknown>> {
    const comp = (
      await this.sql.unsafe<{ id: string; name: string; sport_code: string; status: string; created_at: Date }>(
        `SELECT id, name, sport_code, status, created_at FROM competitions WHERE id=$1`,
        [competitionId],
      )
    )[0];
    if (!comp) {
      throw new ApiError(404, ErrorCode.COMPETITION_NOT_FOUND, "Competition not found");
    }

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
       ORDER BY d.created_at, d.name, sm.starts_at NULLS LAST, m.code`,
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
}
