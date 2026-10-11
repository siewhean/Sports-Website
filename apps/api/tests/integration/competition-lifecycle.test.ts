import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import { CompetitionLifecycleSweeper } from "../../src/competition-lifecycle-sweeper.js";
import { GateCC4PublicTruthRuntime } from "../../src/gate-c-c4-public-truth.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_lifecycle_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const HOUR = 60 * 60 * 1000;
const packVersion = "lifecycle-v1";
let sql: Sql;
let accountId: string;
let organisationId: string;

type World = {
  competitionId: string;
  slug: string;
  divisionId: string;
  liveMatchId: string;
  pendingMatchId: string;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedCompetition(input: {
  endsOn: string;
  timezone: string;
  liveActivityAt: Date;
  initialProjection?: { generatedAt: Date };
}): Promise<World> {
  const competitionId = randomUUID();
  const slug = `lifecycle-${competitionId}`;
  const divisionId = randomUUID();
  const homeId = randomUUID();
  const awayId = randomUUID();
  const formatRevisionId = randomUUID();
  const liveMatchId = randomUUID();
  const pendingMatchId = randomUUID();
  const graph = {
    id: formatRevisionId,
    schemaVersion: 1,
    entryCount: 2,
    stages: [
      {
        id: "final-stage",
        label: "Final",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 2,
        matchIds: [liveMatchId],
      },
    ],
    matches: [
      {
        id: liveMatchId,
        stageId: "final-stage",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: [liveMatchId],
  };
  await sql.begin(async (tx) => {
    await tx`INSERT INTO competitions(
        id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
        venue,address,country_code,locale,plan_tier,status
      ) VALUES(
        ${competitionId},${organisationId},${accountId},'Lifecycle Cup',${slug},'canoe_polo',${input.timezone},
        ${input.endsOn},${input.endsOn},'Arena','1 Road','SG','en-SG','organiser_pro','active'
      )`;
    await tx`INSERT INTO competition_sport_settings(
        competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
      ) VALUES(${competitionId},${accountId},'canoe_polo',${packVersion},1,'{}'::jsonb,'{}'::jsonb)`;
    await tx`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',16)`;
    await tx`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status)
      VALUES (${homeId},${divisionId},'Marina Blue',1,'team','confirmed'),
             (${awayId},${divisionId},'Harbour Gold',2,'team','confirmed')`;
    const [definitionHash] = await tx<{ hash: string }[]>`SELECT phase4_sha256_json(${tx.json(graph)}) AS hash`;
    await tx`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract
      ) VALUES(${formatRevisionId},${competitionId},${divisionId},1,${tx.json(graph)},${definitionHash!.hash},${accountId},'phase3')`;
    await tx`INSERT INTO matches(
        id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id,state
      ) VALUES
        (${liveMatchId},${competitionId},${divisionId},${formatRevisionId},'LC-1','final',1,1,${homeId},${awayId},'in_progress'),
        (${pendingMatchId},${competitionId},${divisionId},${formatRevisionId},'LC-2','final',1,2,${homeId},${awayId},'ready')`;
    await tx`INSERT INTO match_score_streams(
        match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint,
        current_version,created_at,updated_at
      ) VALUES(
        ${liveMatchId},${competitionId},${divisionId},'canoe_polo',${packVersion},'{}'::jsonb,${digest(liveMatchId)},
        3,${input.liveActivityAt},${input.liveActivityAt}
      )`;
    await tx`INSERT INTO competition_publications(competition_id,result_version,updated_at)
      VALUES(${competitionId},1,${new Date(Date.now() - 30 * 24 * HOUR)})`;
    if (input.initialProjection) {
      const division = {
        division: { id: divisionId, name: "Open" },
        schedule: [],
        results: [
          {
            id: liveMatchId,
            code: "LC-1",
            stage: "final",
            home: { id: homeId, name: "Marina Blue" },
            away: { id: awayId, name: "Harbour Gold" },
            home_score: 1,
            away_score: 0,
            state: "in_progress",
            updated_at: input.liveActivityAt.toISOString(),
          },
        ],
        standings: null,
        bracket: null,
      };
      await tx`INSERT INTO public_competition_projections(
          competition_id,schedule_version,result_version,projection,generated_at
        ) VALUES(${competitionId},0,1,${tx.json({
          competition: {
            id: competitionId,
            name: "Lifecycle Cup",
            slug,
            sport_code: "canoe_polo",
            timezone: input.timezone,
            starts_on: input.endsOn,
            ends_on: input.endsOn,
            status: "active",
          },
          divisions: [division],
          division: division.division,
          publication: { schedule_version: 0, result_version: 1 },
          schedule: [],
          results: division.results,
          standings: null,
          bracket: null,
        } as postgres.JSONValue)},${input.initialProjection.generatedAt})`;
    }
  });
  return { competitionId, slug, divisionId, liveMatchId, pendingMatchId };
}

function projectionWriter() {
  return new Phase2Runtime(
    sql as unknown as PostgresJsSql,
    phase2DomainAdapter,
    () => new Date(),
    undefined,
    "competition-lifecycle-integration-hmac-secret",
  );
}

function sweeper(writer = projectionWriter()) {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  return new CompetitionLifecycleSweeper(
    sql as unknown as PostgresJsSql,
    writer,
    { enabled: true, completionGraceMs: 24 * HOUR, liveMatchStaleAfterMs: 6 * HOUR, intervalMs: 60_000, batchSize: 50 },
    silent,
  );
}

async function currentProjection(competitionId: string) {
  const [row] = await sql<
    { projection: Record<string, unknown> | string; live_revision: number; generated_at: Date }[]
  >`
    SELECT projection, live_revision, generated_at FROM public_competition_projections
    WHERE competition_id=${competitionId} AND schedule_version=0 AND result_version=1`;
  if (!row) return row;
  // The runtime writes the projection as a JSON string parameter, so it can come back as a jsonb string.
  const projection =
    typeof row.projection === "string" ? (JSON.parse(row.projection) as Record<string, unknown>) : row.projection;
  return { ...row, projection };
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  accountId = randomUUID();
  organisationId = randomUUID();
  const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
  await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${accountId},${`${accountId}@example.test`},'Lifecycle owner')`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'Lifecycle org',${`lifecycle-${organisationId}`})`;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${accountId},'owner','active')`;
  });
  const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
  await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
    VALUES('canoe_polo',${packVersion},1,${sql.json(pack)},${packHash!.hash},'active',now())`;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describe("public live revision", () => {
  it("advances the public version on every projection content change and never on a no-op upsert", async () => {
    const world = await seedCompetition({
      endsOn: "2099-12-31",
      timezone: "Asia/Singapore",
      liveActivityAt: new Date(),
      initialProjection: { generatedAt: new Date() },
    });
    const publicTruth = new GateCC4PublicTruthRuntime(sql as unknown as PostgresJsSql);
    const opening = await publicTruth.version(world.slug);
    expect(opening).toBe("0:1:1:1");
    expect((await publicTruth.read(world.slug))?.version).toBe(opening);

    // Reading is free of side effects.
    await publicTruth.read(world.slug);
    expect(await publicTruth.version(world.slug)).toBe(opening);

    // The same ON CONFLICT upsert live scoring performs: same publication versions, new score.
    const upsert = (homeScore: number) => sql`
      INSERT INTO public_competition_projections(competition_id,schedule_version,result_version,projection,generated_at)
      SELECT competition_id,schedule_version,result_version,
             jsonb_set(jsonb_set(projection,'{results,0,home_score}',to_jsonb(${homeScore}::int)),
                       '{divisions,0,results,0,home_score}',to_jsonb(${homeScore}::int)),
             now()
      FROM public_competition_projections WHERE competition_id=${world.competitionId}
      ON CONFLICT (competition_id,schedule_version,result_version)
      DO UPDATE SET projection=EXCLUDED.projection,generated_at=EXCLUDED.generated_at`;
    const etagBefore = (await publicTruth.read(world.slug))?.freshness.etag;
    await upsert(2);
    const afterPoint = await publicTruth.version(world.slug);
    expect(afterPoint).toBe("0:1:1:2");
    expect((await publicTruth.read(world.slug))?.freshness.etag).not.toBe(etagBefore);

    await upsert(2);
    expect(await publicTruth.version(world.slug)).toBe(afterPoint);

    await upsert(3);
    expect(await publicTruth.version(world.slug)).toBe("0:1:1:3");

    // The writer cannot forge or rewind the revision.
    await sql`UPDATE public_competition_projections SET live_revision=1 WHERE competition_id=${world.competitionId}`;
    expect((await currentProjection(world.competitionId))?.live_revision).toBe(3);
  });
});

describe("competition lifecycle sweep", () => {
  it("keeps the scoring-driven completion guard for competitions that are not over", async () => {
    const world = await seedCompetition({ endsOn: "2099-12-31", timezone: "UTC", liveActivityAt: new Date() });
    await sql`UPDATE competitions SET status='completed' WHERE id=${world.competitionId}`;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('matchday.competition_schedule_elapsed','on',true)`;
      await tx`UPDATE competitions SET status='completed' WHERE id=${world.competitionId}`;
    });
    const [row] = await sql<{ status: string }[]>`SELECT status FROM competitions WHERE id=${world.competitionId}`;
    expect(row?.status).toBe("active");
  });

  it("completes an elapsed competition, audits it, refreshes the projection and is idempotent", async () => {
    const elapsed = await seedCompetition({
      endsOn: "2026-09-20",
      timezone: "Asia/Singapore",
      liveActivityAt: new Date("2026-09-20T08:00:00.000Z"),
    });
    const future = await seedCompetition({
      endsOn: "2099-12-31",
      timezone: "Asia/Singapore",
      liveActivityAt: new Date(),
    });

    const first = await sweeper().sweep();
    expect(first.completed).toContain(elapsed.competitionId);
    expect(first.completed).not.toContain(future.competitionId);

    const [competition] = await sql<{ status: string; revision: number }[]>`
      SELECT status, revision FROM competitions WHERE id=${elapsed.competitionId}`;
    expect(competition?.status).toBe("completed");
    const [futureCompetition] = await sql<{ status: string }[]>`
      SELECT status FROM competitions WHERE id=${future.competitionId}`;
    expect(futureCompetition?.status).toBe("active");

    // Abandoned matches are not finalised and stay recoverable.
    const matches = await sql<{ id: string; state: string }[]>`
      SELECT id, state FROM matches WHERE competition_id=${elapsed.competitionId} ORDER BY code`;
    expect(matches.map((match) => match.state)).toEqual(["in_progress", "ready"]);

    const audits = await sql<{ actor_type: string; action: string; after_state: { status: string } }[]>`
      SELECT actor_type, action, after_state FROM audit_events
      WHERE target_type='competition' AND target_id=${elapsed.competitionId}`;
    expect(audits).toEqual([
      expect.objectContaining({
        actor_type: "system",
        action: "competition.transitioned",
        after_state: expect.objectContaining({ status: "completed" }),
      }),
    ]);

    const projection = await currentProjection(elapsed.competitionId);
    const payload = projection?.projection as {
      competition: { status: string };
      results: Array<{ id: string; state: string }>;
    };
    expect(payload.competition.status).toBe("completed");
    expect(payload.results.some((result) => result.state === "in_progress")).toBe(false);

    const publicTruth = new GateCC4PublicTruthRuntime(sql as unknown as PostgresJsSql);
    const publicVersion = await publicTruth.version(elapsed.slug);
    expect((await publicTruth.read(elapsed.slug))?.payload).toMatchObject({ competition: { status: "completed" } });

    const second = await sweeper().sweep();
    expect(second.completed).not.toContain(elapsed.competitionId);
    expect(second.refreshed).not.toContain(elapsed.competitionId);
    expect(await publicTruth.version(elapsed.slug)).toBe(publicVersion);
    const [auditCount] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events WHERE target_id=${elapsed.competitionId}`;
    expect(auditCount?.count).toBe(1);
  });

  it("stops showing an abandoned live match as live without finalising it", async () => {
    const world = await seedCompetition({
      endsOn: "2099-12-31",
      timezone: "Asia/Singapore",
      liveActivityAt: new Date(Date.now() - 7 * HOUR),
      initialProjection: { generatedAt: new Date(Date.now() - 7 * 24 * HOUR) },
    });
    const publicTruth = new GateCC4PublicTruthRuntime(sql as unknown as PostgresJsSql);
    const before = await publicTruth.version(world.slug);

    const result = await sweeper().sweep();
    expect(result.refreshed).toContain(world.competitionId);

    const projection = await currentProjection(world.competitionId);
    const payload = projection?.projection as { results: Array<{ id: string }> };
    expect(payload.results.map((entry) => entry.id)).not.toContain(world.liveMatchId);
    const after = await publicTruth.version(world.slug);
    expect(after).not.toBe(before);

    const [match] = await sql<{ state: string }[]>`SELECT state FROM matches WHERE id=${world.liveMatchId}`;
    expect(match?.state).toBe("in_progress");
    const [competition] = await sql<
      { status: string }[]
    >`SELECT status FROM competitions WHERE id=${world.competitionId}`;
    expect(competition?.status).toBe("active");

    // The regenerated projection is past the stale threshold, so the next sweep leaves it alone.
    const again = await sweeper().sweep();
    expect(again.refreshed).not.toContain(world.competitionId);
    expect(await publicTruth.version(world.slug)).toBe(after);
  });
});
