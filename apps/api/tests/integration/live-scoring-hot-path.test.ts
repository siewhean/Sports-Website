import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { SPORT_PACKS } from "@matchday/domain";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GateCC4PublicTruthRuntime } from "../../src/gate-c-c4-public-truth.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";

/*
 * Live scoring hot-path benchmark and contention guard.
 *
 * World: one badminton competition with 8 divisions x 16 entries (8 x 32 = 256
 * matches), 12 finalised results per division (96 results with standings), and
 * 8 courts live at once (one per division). Each scored point is measured for
 * wall time and statement count, sequentially and with all 8 courts scoring
 * concurrently. Numbers are logged (console.info) so before/after runs can be
 * compared; assertions only cover the contention contract.
 */
const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_live_hot_path_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const sportId = "badminton" as const;
const divisionCount = 8;
const finalsPerDivision = 12;
const sequentialPointsPerCourt = 20;
const concurrentPointsPerCourt = 10;

type Auth = { sessionId: string; sessionToken: string; generation: number };
type Court = { matchId: string; auth: Auth; version: number; slot: "home" | "away" };
type StatementLog = { statements: number; publicationLockAt: number | null; startedAt: number; endedAt: number };

let sql!: Sql;
let runtime!: Phase2Runtime;
let accountId = "";
let organisationId = "";
let competitionId = "";
let slug = "";
const courts: Court[] = [];
const transactions: StatementLog[] = [];

/** Wraps sql.begin so every transaction records its statement count and publication-row lock time. */
function countingSql(base: Sql): PostgresJsSql {
  const wrapper = Object.create(base) as Record<string, unknown>;
  wrapper.unsafe = base.unsafe.bind(base);
  wrapper.begin = (operation: (tx: PostgresJsSql) => Promise<unknown>) => {
    const log: StatementLog = { statements: 0, publicationLockAt: null, startedAt: performance.now(), endedAt: 0 };
    return base
      .begin(async (tx) => {
        const counted = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== "unsafe") return Reflect.get(target, property, receiver) as unknown;
            return (query: string, parameters?: unknown[]) => {
              log.statements += 1;
              if (log.publicationLockAt === null && /FROM competition_publications[\s\S]*FOR UPDATE/u.test(query)) {
                log.publicationLockAt = performance.now();
              }
              return target.unsafe(query, parameters as never);
            };
          },
        });
        return operation(counted as unknown as PostgresJsSql);
      })
      .finally(() => {
        log.endedAt = performance.now();
        transactions.push(log);
      });
  };
  return wrapper as unknown as PostgresJsSql;
}

async function openWriter(matchId: string): Promise<Auth> {
  const pass = await runtime.createAccessPass(
    { accountId },
    competitionId,
    matchId,
    {
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotencyKey: `hot-path-${randomUUID()}`,
    },
    randomUUID(),
  );
  if (!pass.token) throw new Error("Expected one-time access token");
  const writer = await runtime.exchangeAccess(
    { token: pass.token, deviceId: randomUUID(), ipAddress: "198.51.100.20" },
    randomUUID(),
  );
  if (!writer.generation) throw new Error("Expected writer generation");
  return { sessionId: writer.session_id, sessionToken: writer.session_token, generation: writer.generation };
}

async function append(court: Court, command: Record<string, unknown>) {
  const receipt = await runtime.appendCanonicalScoreEvent(
    court.auth,
    { client_event_id: randomUUID(), occurred_at: new Date().toISOString(), ...command },
    court.version,
    randomUUID(),
  );
  court.version = receipt.aggregate_version;
  return receipt;
}

async function point(court: Court) {
  // Alternate rallies so no game reaches its winning score during the benchmark.
  court.slot = court.slot === "home" ? "away" : "home";
  return append(court, { type: "point", team_slot: court.slot, segment_number: 1 });
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function summarise(label: string, latencies: readonly number[], logs: readonly StatementLog[]) {
  const statements = logs.map((log) => log.statements);
  const lockHolds = logs.flatMap((log) =>
    log.publicationLockAt === null ? [] : [log.endedAt - log.publicationLockAt],
  );
  const summary = {
    label,
    points: latencies.length,
    latency_ms_p50: Number(percentile(latencies, 0.5).toFixed(1)),
    latency_ms_p95: Number(percentile(latencies, 0.95).toFixed(1)),
    latency_ms_max: Number(Math.max(...latencies).toFixed(1)),
    statements_per_point: Number((statements.reduce((sum, value) => sum + value, 0) / statements.length).toFixed(1)),
    publication_lock_points: lockHolds.length,
    publication_lock_hold_ms_p50: Number(percentile(lockHolds, 0.5).toFixed(1)),
    publication_lock_hold_ms_p95: Number(percentile(lockHolds, 0.95).toFixed(1)),
  };
  console.info(`[live-scoring-hot-path] ${JSON.stringify(summary)}`);
  return summary;
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 12, onnotice: () => undefined, connection: { search_path: schema } });
  const [account] = await sql<{ id: string }[]>`
    INSERT INTO accounts(primary_email,display_name,email_verified_at)
    VALUES(${`hot-path-${randomUUID()}@example.test`},'Hot path organiser',now()) RETURNING id`;
  accountId = account!.id;
  await sql.begin(async (tx) => {
    const [organisation] = await tx<{ id: string }[]>`
      INSERT INTO organisations(name,slug) VALUES('Hot path org',${`hot-path-${randomUUID()}`}) RETURNING id`;
    organisationId = organisation!.id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${accountId},'owner','active')`;
  });
  const pack = SPORT_PACKS[sportId];
  const definition = {
    recommendedSettings: pack.recommendedSettings,
    recommendedSlotMinutes: Number(pack.recommendedSettings.slotMinutes ?? 30),
  };
  const [hash] = await sql<{ value: string }[]>`SELECT phase4_sha256_json(${sql.json(definition)}) value`;
  await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
    VALUES(${sportId},${pack.version},1,${sql.json(definition)},${hash!.value},'active',now())`;

  runtime = new Phase2Runtime(
    countingSql(sql),
    phase2DomainAdapter,
    undefined,
    undefined,
    "hot-path-fallback-secret-32-bytes!!",
  );
  const actor = { accountId };
  slug = `hot-path-${randomUUID()}`;
  const competition = await runtime.createCompetition(
    actor,
    {
      organisationId,
      name: "Hot Path Open",
      slug,
      timezone: "Asia/Singapore",
      startsOn: "2027-03-01",
      endsOn: "2027-03-02",
    },
    randomUUID(),
  );
  competitionId = competition.id;
  // 128 entries exceed the free tier; an Event Pass lifts the entry limit for this competition.
  await sql`INSERT INTO entitlement_grants
      (organisation_id,competition_id,tier,feature,source,quantity,idempotency_key,expires_at)
    VALUES (${organisationId},${competitionId},'event_pass','unlimited_entries','purchase',1,
            ${`hot-path-pass-${randomUUID()}`},now() + interval '30 days')`;
  await sql`UPDATE competitions SET sport_code=${sportId} WHERE id=${competitionId}`;
  await sql`UPDATE competition_sport_settings SET
    sport_code=${sportId},pack_version=${pack.version},
    recommended_snapshot=${sql.json(pack.recommendedSettings)},settings_override='{}'::jsonb
    WHERE competition_id=${competitionId}`;
  await runtime.replaceCapacity(
    actor,
    competitionId,
    Array.from({ length: 8 }, (_, index) => ({
      name: `Court ${index + 1}`,
      windows: [{ startsAt: "2027-03-01T00:00:00.000Z", endsAt: "2027-03-01T23:00:00.000Z" }],
    })),
    randomUUID(),
  );
  // The Phase 2 slice creates one division through the API; further divisions
  // are fixture rows (as in the Gate C two-division test) scheduled into the
  // same published revision so the public projection covers all 256 matches.
  const formats: Array<{ id: string; matches: ReadonlyArray<{ id: string }> }> = [];
  for (let index = 0; index < divisionCount; index += 1) {
    const divisionId =
      index === 0
        ? (
            await runtime.createDivision(
              actor,
              competitionId,
              { name: `Division ${index + 1}`, teamLimit: 16 },
              randomUUID(),
            )
          ).id
        : (
            await sql<{ id: string }[]>`
              INSERT INTO divisions(competition_id,name,team_limit)
              VALUES(${competitionId},${`Division ${index + 1}`},16) RETURNING id`
          )[0]!.id;
    await runtime.replaceEntries(
      actor,
      competitionId,
      divisionId,
      Array.from({ length: 16 }, (_, entry) => ({ name: `D${index + 1} Team ${entry + 1}`, seed: entry + 1 })),
      randomUUID(),
    );
    formats.push(await runtime.generateFormat(actor, competitionId, divisionId, randomUUID()));
  }
  const schedule = await runtime.generateSchedule(actor, competitionId, formats[0]!.id, randomUUID());
  const areas = await sql<{ id: string }[]>`
    SELECT id FROM playing_areas WHERE competition_id=${competitionId} ORDER BY sort_order`;
  const dayStart = new Date("2027-03-02T00:00:00.000Z").getTime();
  for (const [divisionIndex, format] of formats.slice(1).entries()) {
    for (const [index, match] of format.matches.entries()) {
      const area = areas[(divisionIndex * format.matches.length + index) % areas.length]!;
      const startsAt = new Date(dayStart + (divisionIndex * format.matches.length + index) * 5 * 60_000);
      await sql`INSERT INTO scheduled_matches(
          schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
        ) VALUES(${schedule.id},${match.id},${competitionId},${area.id},${startsAt},
                 ${new Date(startsAt.getTime() + 30 * 60_000)})`;
    }
  }
  const publishedAt = new Date();
  await sql`UPDATE schedule_revisions SET status='published',published_at=${publishedAt} WHERE id=${schedule.id}`;
  await sql`UPDATE competition_publications
    SET published_schedule_revision_id=${schedule.id},schedule_version=1,
        schedule_published_at=${publishedAt},updated_at=${publishedAt}
    WHERE competition_id=${competitionId}`;
  await sql`UPDATE competitions SET status='active',updated_at=${publishedAt} WHERE id=${competitionId}`;
  await runtime.writePublicProjection(sql as unknown as PostgresJsSql, competitionId, 1, 0);

  const playable = await sql<{ id: string; division_id: string }[]>`
    SELECT id,division_id FROM matches
    WHERE competition_id=${competitionId} AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
    ORDER BY division_id,ordinal`;
  const byDivision = new Map<string, string[]>();
  for (const match of playable)
    byDivision.set(match.division_id, [...(byDivision.get(match.division_id) ?? []), match.id]);
  for (const matchIds of byDivision.values()) {
    for (const matchId of matchIds.slice(0, finalsPerDivision)) {
      const court: Court = { matchId, auth: await openWriter(matchId), version: 0, slot: "home" };
      await append(court, { type: "match_started" });
      await append(court, { type: "walkover", team_slot: "home", segment_number: 1 });
      await runtime.finalise(court.auth, randomUUID(), randomUUID(), court.version);
    }
    const liveMatchId = matchIds[finalsPerDivision]!;
    const court: Court = { matchId: liveMatchId, auth: await openWriter(liveMatchId), version: 0, slot: "home" };
    await append(court, { type: "match_started" });
    courts.push(court);
  }
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("live scoring hot path", () => {
  it("measures per-point cost for 8 live courts on a 256-match competition", async () => {
    const [size] = await sql<{ matches: number; results: number; projection_bytes: number }[]>`
      SELECT (SELECT count(*)::integer FROM matches WHERE competition_id=${competitionId}) AS matches,
             (SELECT count(*)::integer FROM match_result_snapshots s JOIN matches m ON m.id=s.match_id
               WHERE m.competition_id=${competitionId}) AS results,
             (SELECT max(octet_length(projection::text))::integer FROM public_competition_projections
               WHERE competition_id=${competitionId}) AS projection_bytes`;
    console.info(`[live-scoring-hot-path] world ${JSON.stringify({ ...size, live_courts: courts.length })}`);
    expect(courts).toHaveLength(divisionCount);

    transactions.length = 0;
    const sequential: number[] = [];
    for (let round = 0; round < sequentialPointsPerCourt; round += 1) {
      for (const court of courts) {
        const started = performance.now();
        await point(court);
        sequential.push(performance.now() - started);
      }
    }
    summarise("sequential", sequential, transactions.splice(0));

    const concurrent: number[] = [];
    const wallStarted = performance.now();
    await Promise.all(
      courts.map(async (court) => {
        for (let round = 0; round < concurrentPointsPerCourt; round += 1) {
          const started = performance.now();
          await point(court);
          concurrent.push(performance.now() - started);
        }
      }),
    );
    const wall = performance.now() - wallStarted;
    const concurrentSummary = summarise("concurrent-8-courts", concurrent, transactions.splice(0));
    console.info(
      `[live-scoring-hot-path] concurrent wall_ms=${wall.toFixed(0)} points_per_second=${(
        (concurrent.length / wall) *
        1_000
      ).toFixed(1)}`,
    );
    expect(concurrentSummary.points).toBe(divisionCount * concurrentPointsPerCourt);

    // Every point is visible to spectators: the public version moved and the overlay carries the score.
    const publicTruth = new GateCC4PublicTruthRuntime(sql as unknown as PostgresJsSql);
    const before = await publicTruth.version(slug);
    const beforeRead = await publicTruth.read(slug);
    const court = courts[0]!;
    await point(court);
    const after = await publicTruth.version(slug);
    const afterRead = await publicTruth.read(slug);
    expect(after).not.toBe(before);
    expect(afterRead?.version).toBe(after);
    expect(afterRead?.freshness.etag).not.toBe(beforeRead?.freshness.etag);
    const divisions = (afterRead?.payload.divisions ?? []) as Array<{ results: Array<Record<string, unknown>> }>;
    const live = divisions.flatMap((division) => division.results).find((result) => result.id === court.matchId);
    const [stream] = await sql<{ current_version: number }[]>`
      SELECT current_version FROM match_score_streams WHERE match_id=${court.matchId}`;
    expect(stream?.current_version).toBe(court.version);
    expect(live).toMatchObject({ state: "in_progress" });
    // Badminton scores games; the rallies of the current game are the first segment.
    const segment = (live?.segments as Array<{ home: number; away: number }> | undefined)?.[0];
    expect((segment?.home ?? 0) + (segment?.away ?? 0)).toBe(court.version - 1);
  }, 600_000);

  it("scores a point while another transaction holds the competition publication row", async () => {
    const court = courts[1]!;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM competition_publications WHERE competition_id=${competitionId} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;
    try {
      const outcome = await Promise.race([
        point(court).then(() => "scored" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
      ]);
      expect(outcome).toBe("scored");
    } finally {
      release();
      await holder;
    }
  }, 60_000);
});
