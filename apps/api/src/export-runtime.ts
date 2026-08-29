import { randomUUID } from "node:crypto";
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
        `SELECT role FROM account_platform_roles
         WHERE account_id=$1
           AND role='platform_admin'
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`,
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
         AND ($2::uuid IS NULL OR sm.schedule_revision_id = $2)
       LEFT JOIN playing_areas pa ON pa.id = sm.playing_area_id
       WHERE d.competition_id = $1
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
    await this.assertExportAccess(competitionId, actor);

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
           SELECT m.home_entry_id as entry_id,
                  mrs.home_score > mrs.away_score as won,
                  mrs.home_score = mrs.away_score as drawn,
                  mrs.home_score < mrs.away_score as lost,
                  mrs.home_score as goals_for,
                  mrs.away_score as goals_against,
                  CASE WHEN mrs.home_score > mrs.away_score THEN 3
                       WHEN mrs.home_score = mrs.away_score THEN 1
                       ELSE 0 END as points
           FROM matches m
           JOIN divisions d2 ON d2.id = m.division_id
           JOIN (
             SELECT DISTINCT ON (match_id) match_id, home_score, away_score
             FROM match_result_snapshots
             WHERE state IN ('final', 'corrected')
             ORDER BY match_id, result_version DESC
           ) mrs ON mrs.match_id = m.id
           WHERE d2.competition_id = $1
           UNION ALL
           SELECT m.away_entry_id as entry_id,
                  mrs.away_score > mrs.home_score as won,
                  mrs.home_score = mrs.away_score as drawn,
                  mrs.away_score < mrs.home_score as lost,
                  mrs.away_score as goals_for,
                  mrs.home_score as goals_against,
                  CASE WHEN mrs.away_score > mrs.home_score THEN 3
                       WHEN mrs.home_score = mrs.away_score THEN 1
                       ELSE 0 END as points
           FROM matches m
           JOIN divisions d2 ON d2.id = m.division_id
           JOIN (
             SELECT DISTINCT ON (match_id) match_id, home_score, away_score
             FROM match_result_snapshots
             WHERE state IN ('final', 'corrected')
             ORDER BY match_id, result_version DESC
           ) mrs ON mrs.match_id = m.id
           WHERE d2.competition_id = $1
         ) match_records
         GROUP BY entry_id
       ) s ON s.entry_id = e.id
       WHERE d.competition_id = $1
       ORDER BY d.name, COALESCE(s.points, 0) DESC, COALESCE(s.goal_difference, 0) DESC, e.name`,
      [competitionId],
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
    await this.assertExportAccess(competitionId, actor);

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
       ORDER BY d.name, m.code`,
      [competitionId],
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
         AND ($2::uuid IS NULL OR sm.schedule_revision_id = $2)
       WHERE d.competition_id=$1
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

  async importCompetitionArchive(
    actor: Phase3Actor,
    organisationId: string,
    archive: unknown,
    renameSuffix?: string,
  ): Promise<{
    competition_id: string;
    name: string;
    divisions_count: number;
    entries_count: number;
    matches_count: number;
  }> {
    const validation = this.validateCompetitionArchive(archive);
    if (!validation.valid || !validation.competition) {
      throw new ApiError(400, ErrorCode.REQUEST_INVALID, validation.error ?? "Invalid competition archive");
    }

    const doc = archive as {
      schema_version: string;
      competition: { id: string; name: string; sport_code: string; status?: string };
      branding?: {
        primary_color?: string | null;
        secondary_color?: string | null;
        logo_url?: string | null;
        banner_url?: string | null;
        hide_platform_badge?: boolean;
      } | null;
      sponsors?: Array<{
        name: string;
        tier: "headline" | "tier1" | "tier2" | "community";
        logo_url?: string | null;
        website_url?: string | null;
        sort_order: number;
      }>;
      divisions?: Array<{
        id: string;
        name: string;
        entries?: Array<{ id: string; name: string; seed?: number | null }>;
        matches?: Array<{
          id: string;
          code: string;
          stage: string;
          home_entry_id?: string | null;
          away_entry_id?: string | null;
          state?: string;
          scheduled_start?: string | null;
        }>;
      }>;
    };

    const sqlInstance = this.sql as unknown as {
      begin?: <T>(cb: (tx: PostgresJsSql) => Promise<T>) => Promise<T>;
    };
    const beginFn =
      typeof sqlInstance.begin === "function"
        ? sqlInstance.begin.bind(sqlInstance)
        : async <T>(cb: (tx: PostgresJsSql) => Promise<T>) => cb(this.sql);

    return beginFn(async (tx: PostgresJsSql) => {
      const member = (
        await tx.unsafe<{ role: string }>(
          `SELECT role FROM organisation_memberships
           WHERE organisation_id=$1 AND account_id=$2 AND status='active' AND role IN ('owner','organiser')`,
          [organisationId, actor.accountId],
        )
      )[0];
      const platformAdmin = (
        await tx.unsafe<{ role: string }>(
          `SELECT role FROM account_platform_roles
           WHERE account_id=$1
             AND role='platform_admin'
             AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())`,
          [actor.accountId],
        )
      )[0];

      if (!member && !platformAdmin) {
        throw new ApiError(403, ErrorCode.ORGANISATION_ACCESS_DENIED, "Access denied to target organisation");
      }

      const compId = randomUUID();
      const baseName = doc.competition.name.trim();
      const compName = renameSuffix ? `${baseName} ${renameSuffix}`.slice(0, 160) : baseName;
      const baseSlug = compName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 80);
      const slug = `${baseSlug || "competition"}-${compId.slice(0, 8)}`;
      const startsOn = new Date().toISOString().slice(0, 10);
      const endsOn = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);

      await tx.unsafe(
        `INSERT INTO competitions (
           id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on, status, plan_tier
         ) VALUES ($1, $2, $3, $4, $5, $6, 'UTC', $7, $8, 'draft', 'free')`,
        [compId, organisationId, actor.accountId, compName, slug, doc.competition.sport_code, startsOn, endsOn],
      );

      await tx.unsafe(
        `INSERT INTO competition_sport_settings (competition_id, updated_by, sport_code)
         VALUES ($1, $2, $3)`,
        [compId, actor.accountId, doc.competition.sport_code],
      );

      await tx.unsafe(`INSERT INTO competition_publications (competition_id) VALUES ($1)`, [compId]);

      if (doc.branding) {
        await tx.unsafe(
          `INSERT INTO competition_branding (
             competition_id, primary_color, secondary_color, logo_url, banner_url, hide_platform_badge
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            compId,
            doc.branding.primary_color ?? null,
            doc.branding.secondary_color ?? null,
            doc.branding.logo_url ?? null,
            doc.branding.banner_url ?? null,
            doc.branding.hide_platform_badge ?? false,
          ],
        );
      }

      if (Array.isArray(doc.sponsors)) {
        for (const s of doc.sponsors) {
          await tx.unsafe(
            `INSERT INTO competition_sponsors (
               competition_id, name, tier, logo_url, website_url, sort_order
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [compId, s.name.trim(), s.tier, s.logo_url ?? null, s.website_url ?? null, s.sort_order],
          );
        }
      }

      let totalEntries = 0;
      let totalMatches = 0;

      if (Array.isArray(doc.divisions)) {
        for (const div of doc.divisions) {
          const divId = randomUUID();
          await tx.unsafe(
            `INSERT INTO divisions (id, competition_id, name, team_limit)
             VALUES ($1, $2, $3, 16)`,
            [divId, compId, div.name.trim()],
          );

          const entryIdMap = new Map<string, string>();

          if (Array.isArray(div.entries)) {
            let seedCounter = 1;
            for (const entry of div.entries) {
              const entryId = randomUUID();
              const seed = entry.seed ?? seedCounter++;
              await tx.unsafe(
                `INSERT INTO division_entries (id, division_id, name, seed, status)
                 VALUES ($1, $2, $3, $4, 'confirmed')`,
                [entryId, divId, entry.name.trim(), seed],
              );
              entryIdMap.set(entry.id, entryId);
              totalEntries++;
            }
          }

          if (Array.isArray(div.matches)) {
            for (const match of div.matches) {
              const matchId = randomUUID();
              const homeId = match.home_entry_id ? (entryIdMap.get(match.home_entry_id) ?? null) : null;
              const awayId = match.away_entry_id ? (entryIdMap.get(match.away_entry_id) ?? null) : null;
              await tx.unsafe(
                `INSERT INTO matches (
                   id, competition_id, division_id, code, stage, state, home_entry_id, away_entry_id
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [matchId, compId, divId, match.code, match.stage ?? "Main", match.state ?? "draft", homeId, awayId],
              );
              totalMatches++;
            }
          }
        }
      }

      return {
        competition_id: compId,
        name: compName,
        divisions_count: doc.divisions?.length ?? 0,
        entries_count: totalEntries,
        matches_count: totalMatches,
      };
    });
  }

  compareSemanticEquivalence(archiveA: unknown, archiveB: unknown): { equivalent: boolean; differences: string[] } {
    const diffs: string[] = [];
    const vA = this.validateCompetitionArchive(archiveA);
    const vB = this.validateCompetitionArchive(archiveB);

    if (!vA.valid || !vB.valid) {
      return { equivalent: false, differences: ["One or both archives failed validation"] };
    }

    interface ArchivePayload {
      competition: { sport_code: string; name: string };
      divisions?: Array<{
        name: string;
        entries?: Array<{ name: string }>;
        matches?: Array<{ code: string }>;
      }>;
    }

    const a = archiveA as ArchivePayload;
    const b = archiveB as ArchivePayload;

    if (a.competition.sport_code !== b.competition.sport_code) {
      diffs.push(`Sport code mismatch: ${a.competition.sport_code} vs ${b.competition.sport_code}`);
    }

    const divA = a.divisions ?? [];
    const divB = b.divisions ?? [];

    if (divA.length !== divB.length) {
      diffs.push(`Division count mismatch: ${divA.length} vs ${divB.length}`);
    } else {
      for (const da of divA) {
        const db = divB.find((d) => d.name === da.name);
        if (!db) {
          diffs.push(`Missing division in second archive: ${da.name}`);
          continue;
        }

        const entriesA = da.entries ?? [];
        const entriesB = db.entries ?? [];
        if (entriesA.length !== entriesB.length) {
          diffs.push(`Entry count mismatch in division ${da.name}: ${entriesA.length} vs ${entriesB.length}`);
        } else {
          for (const ea of entriesA) {
            const eb = entriesB.find((e) => e.name === ea.name);
            if (!eb) {
              diffs.push(`Missing entry ${ea.name} in division ${da.name}`);
            }
          }
        }

        const matchesA = da.matches ?? [];
        const matchesB = db.matches ?? [];
        if (matchesA.length !== matchesB.length) {
          diffs.push(`Match count mismatch in division ${da.name}: ${matchesA.length} vs ${matchesB.length}`);
        } else {
          for (const ma of matchesA) {
            const mb = matchesB.find((m) => m.code === ma.code);
            if (!mb) {
              diffs.push(`Missing match ${ma.code} in division ${da.name}`);
            }
          }
        }
      }
    }

    return {
      equivalent: diffs.length === 0,
      differences: diffs,
    };
  }
}
