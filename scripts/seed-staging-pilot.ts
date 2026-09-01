/**
 * Gate D staging fixture seeder.
 *
 * Core competition/scoring state is created through the existing Phase 3 / Phase 2
 * runtimes so the fixture inherits the current sport-settings, entry, format,
 * materialisation, publication, and scoring-access contracts. Direct SQL is kept
 * to bootstrap identity/organisation rows and to combine two runtime-generated
 * draft schedules into the multi-division schedule that Phase 7 needs to qualify.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPORT_PACKS } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres from "postgres";
import { phase2DomainAdapter } from "../apps/api/src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../apps/api/src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../apps/api/src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../apps/api/src/phase-3-runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const targetUrl = (process.env.TARGET_URL ?? "http://127.0.0.1:4101").replace(/\/$/, "");
const scoringPassTtlMs = 7 * 24 * 60 * 60_000;

async function requireApiResponse(url: string, init: RequestInit | undefined, label: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(`Post-seed API verification failed for ${label}: ${url} was unreachable`, { cause: error });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Post-seed API verification failed for ${label}: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`,
    );
  }
  return response;
}

async function main() {
  const sql = postgres(databaseUrl, { max: 8, onnotice: () => undefined });
  const db = sql as unknown as PostgresJsSql;
  const accountId = randomUUID();
  const organisationId = randomUUID();
  const competitionSlug = `pilot-vball-${Date.now()}`;
  const actor = { accountId };

  try {
    console.log("════════════════════════════════════════════════════════════");
    console.log(" Gate D staging pilot seeder — runtime-backed fixture");
    console.log(` Database: ${databaseUrl.replace(/:[^:@]+@/, ":***@")}`);
    console.log(` API:      ${targetUrl}`);
    console.log("════════════════════════════════════════════════════════════\n");

    for (const [sportId, pack] of Object.entries(SPORT_PACKS)) {
      const hash = phase3DomainAdapter.hash(pack);
      await sql`
        INSERT INTO sport_pack_versions(
          sport_code,version,schema_version,definition,definition_hash,status,revision,activated_at
        ) VALUES(
          ${sportId},${pack.version},${pack.schemaVersion},${sql.json(pack)},${hash},'active',1,now()
        )
        ON CONFLICT (sport_code,version) DO UPDATE SET
          definition=EXCLUDED.definition,
          definition_hash=EXCLUDED.definition_hash,
          schema_version=EXCLUDED.schema_version,
          status='active',
          activated_at=now();
      `;
    }

    await sql`
      INSERT INTO accounts(id,primary_email,display_name,email_verified_at)
      VALUES(${accountId},${`pilot-${accountId}@matchday.test`},'Gate D Pilot Organiser',now());
    `;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO organisations(id,name,slug)
        VALUES(${organisationId},'Gate D National Volleyball League',${`gate-d-nvl-${randomUUID().slice(0, 8)}`});
      `;
      await tx`
        INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisationId},${accountId},'owner','active');
      `;
    });

    const phase3 = new Phase3Runtime(db, phase3DomainAdapter);
    const phase2 = new Phase2Runtime(
      db,
      phase2DomainAdapter,
      () => new Date(),
      undefined,
      "gate-d-staging-fallback-hmac-secret-at-least-32-chars",
    );

    const competition = await phase3.createCompetition(
      actor,
      {
        organisationId,
        name: "National Volleyball Championship 2026",
        slug: competitionSlug,
        sportCode: "volleyball",
        venue: "Singapore Indoor Stadium",
        address: "2 Stadium Walk",
        countryCode: "SG",
        startsOn: "2026-09-01",
        endsOn: "2026-09-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
      `gate-d-competition-${randomUUID()}`,
    );
    const competitionId = String(competition.id);

    await sql`
      INSERT INTO competition_publications(competition_id)
      VALUES(${competitionId}) ON CONFLICT (competition_id) DO NOTHING;
    `;

    const divisionDefinitions = [
      { name: "Men Open", code: "MEN" },
      { name: "Women Open", code: "WOMEN" },
    ] as const;
    const divisions: Array<{ id: string; name: string; code: string }> = [];

    for (const definition of divisionDefinitions) {
      const created = await phase3.createDivision(
        actor,
        competitionId,
        { name: definition.name, code: definition.code, entryLimit: 8 },
        randomUUID(),
        `gate-d-division-${definition.code.toLowerCase()}-${randomUUID()}`,
      );
      const divisionId = String((created as Record<string, unknown>).id);
      divisions.push({ id: divisionId, ...definition });

      await phase2.replaceEntries(
        actor,
        competitionId,
        divisionId,
        Array.from({ length: 8 }, (_, index) => ({
          name: `${definition.name} Team ${index + 1}`,
          seed: index + 1,
        })),
        randomUUID(),
      );
    }

    const gateDVolleyballSettings = {
      bestOf: 1,
      regularTargetPoints: 1,
      decidingTargetPoints: 1,
      winBy: 1,
      pointCap: 1,
    };
    await sql`
      UPDATE division_sport_settings
      SET settings_override=${sql.json(gateDVolleyballSettings)},revision=revision+1,
          updated_by=${accountId},updated_at=now()
      WHERE competition_id=${competitionId};
    `;

    await phase2.replaceCapacity(
      actor,
      competitionId,
      [
        {
          name: "Court 1",
          windows: [{ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-02T10:00:00.000Z" }],
        },
        {
          name: "Court 2",
          windows: [{ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-02T10:00:00.000Z" }],
        },
      ],
      randomUUID(),
    );

    const formats: Array<{ id: string; divisionId: string }> = [];
    const schedules: Array<{ id: string; divisionId: string; formatId: string }> = [];
    for (const division of divisions) {
      const format = await phase2.generateFormat(actor, competitionId, division.id, randomUUID());
      formats.push({ id: format.id, divisionId: division.id });
      const schedule = await phase2.generateSchedule(actor, competitionId, format.id, randomUUID());
      schedules.push({ id: schedule.id, divisionId: division.id, formatId: format.id });
    }

    const aggregate = schedules[0];
    const secondary = schedules[1];
    if (!aggregate || !secondary) throw new Error("Gate D fixture requires two generated schedules");

    await sql.begin(async (tx) => {
      for (const format of formats) {
        await tx`
          INSERT INTO schedule_revision_formats(
            schedule_revision_id,competition_id,division_id,format_revision_id
          ) VALUES(${aggregate.id},${competitionId},${format.divisionId},${format.id})
          ON CONFLICT DO NOTHING;
        `;
      }
      await tx`
        INSERT INTO scheduled_matches(
          schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
        )
        SELECT ${aggregate.id},match_id,competition_id,playing_area_id,
               starts_at + interval '8 hours',ends_at + interval '8 hours'
        FROM scheduled_matches WHERE schedule_revision_id=${secondary.id};
      `;
    });

    const publication = await phase2.publishSchedule(actor, competitionId, aggregate.id, randomUUID());

    await sql`
      UPDATE format_revisions
      SET status='published',published_at=COALESCE(published_at,now())
      WHERE id=${secondary.formatId} AND status='draft';
    `;

    const scoreableRows = await sql<{ match_id: string; division_id: string }[]>`
      SELECT DISTINCT m.id AS match_id,m.division_id
      FROM matches m
      JOIN scheduled_matches sm ON sm.match_id=m.id AND sm.schedule_revision_id=${aggregate.id}
      WHERE m.competition_id=${competitionId}
        AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
      ORDER BY m.division_id,m.id;
    `;
    if (scoreableRows.length < 2) throw new Error("Gate D fixture did not produce enough scoreable matches");

    const scoreableMatches: Array<{ matchId: string; divisionId: string; rawToken: string }> = [];
    for (const row of scoreableRows) {
      const pass = await phase2.createAccessPass(
        actor,
        competitionId,
        row.match_id,
        {
          expiresAt: new Date(Date.now() + scoringPassTtlMs).toISOString(),
          role: "scorekeeper",
          idempotencyKey: `gate-d-pass-${row.match_id}-${randomUUID()}`,
        },
        randomUUID(),
      );
      if (!pass.token) throw new Error(`Scoring access pass for ${row.match_id} did not return its one-time token`);
      scoreableMatches.push({ matchId: row.match_id, divisionId: row.division_id, rawToken: pass.token });
    }

    const [counts] = await sql<
      {
        divisions: number;
        entries: number;
        scheduled_matches: number;
        linked_formats: number;
        published_schedule: string | null;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM divisions WHERE competition_id=${competitionId}) AS divisions,
        (SELECT count(*)::int FROM division_entries e JOIN divisions d ON d.id=e.division_id
          WHERE d.competition_id=${competitionId} AND e.status IN ('confirmed','active')) AS entries,
        (SELECT count(*)::int FROM scheduled_matches WHERE schedule_revision_id=${aggregate.id}) AS scheduled_matches,
        (SELECT count(*)::int FROM schedule_revision_formats WHERE schedule_revision_id=${aggregate.id}) AS linked_formats,
        (SELECT published_schedule_revision_id::text FROM competition_publications
          WHERE competition_id=${competitionId}) AS published_schedule;
    `;
    if (
      !counts ||
      counts.divisions !== 2 ||
      counts.entries !== 16 ||
      counts.scheduled_matches < 2 ||
      counts.linked_formats !== 2 ||
      counts.published_schedule !== aggregate.id
    ) {
      throw new Error(`Post-seed database verification failed: ${JSON.stringify(counts)}`);
    }

    await requireApiResponse(`${targetUrl}/api/v1/public/competitions/${competitionId}`, undefined, "public competition");
    await requireApiResponse(
      `${targetUrl}/api/v1/public/competitions/${competitionId}/schedule`,
      undefined,
      "public multi-division schedule",
    );

    const exchangeCandidate = scoreableMatches[0]!;
    const exchangeResponse = await requireApiResponse(
      `${targetUrl}/api/v1/scoring/access/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: exchangeCandidate.rawToken,
          expected_match_id: exchangeCandidate.matchId,
          device_id: `seed-verification-${randomUUID()}`,
          device_label: "Gate D staging seed verification",
        }),
      },
      "scoring access exchange",
    );
    const exchange = (await exchangeResponse.json()) as {
      match_id?: string;
      session_id?: string;
      session_token?: string;
    };
    if (
      exchange.match_id !== exchangeCandidate.matchId ||
      typeof exchange.session_id !== "string" ||
      typeof exchange.session_token !== "string"
    ) {
      throw new Error(`Post-seed scoring exchange verification returned invalid state: ${JSON.stringify(exchange)}`);
    }

    const artifactDir = path.join(root, "artifacts");
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, "staging-pilot-seed.json");
    const output = {
      generated_at_utc: new Date().toISOString(),
      target_url: targetUrl,
      organisation_id: organisationId,
      competition_id: competitionId,
      competition_slug: competitionSlug,
      schedule_revision_id: aggregate.id,
      schedule_version: publication.schedule_version,
      divisions,
      matches: scoreableMatches.map(({ matchId, rawToken }) => ({ matchId, rawToken })),
      scoreable_matches: scoreableMatches.map(({ matchId, divisionId, rawToken }) => ({
        match_id: matchId,
        division_id: divisionId,
        pass_token: rawToken,
      })),
    };
    await writeFile(artifactPath, JSON.stringify(output, null, 2), "utf8");

    console.log(`✓ Runtime-backed competition: ${competitionId}`);
    console.log(`✓ Published schedule:          ${aggregate.id}`);
    console.log("✓ Divisions / entries:        2 / 16");
    console.log(`✓ Scoreable matches:          ${scoreableMatches.length}`);
    console.log("✓ Deployed API verification:  PASS");
    console.log(`✓ Artifact:                    ${artifactPath}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((error) => {
  console.error("❌ Gate D staging pilot seeder failed:", error);
  process.exitCode = 1;
});
