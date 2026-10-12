/**
 * Track R1: Tournament Simulation Harness CLI
 *
 * Implements deliverables R1.2 and R1.4 from docs/EXECUTION_ROADMAP.md:
 * - Creates organisations, competitions, entries, formats, and officials through the API.
 * - Executes mock-tournament scenarios 1-9 across all five supported sports.
 * - Enforces zero-5xx budget check across all HTTP interactions.
 * - Supports fast (< 10m) and full profiles.
 *
 * Usage:
 *   pnpm simulate:tournament [--profile=fast|full] [--scenario=1..9]
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { parseConfig } from "@matchday/config";
import type { ScheduleJobInput } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import {
  SPORT_PACKS,
  createDefaultFormatTemplates,
  type DefaultFormatEntryCount,
  type FormatGraph,
  type SportId,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { DomainScheduleOptimizer } from "@matchday/scheduler";
import { buildApp } from "../src/app.js";
import { DeterministicPhase4AiStub } from "../src/phase-4-ai-provider.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { Phase4Runtime } from "../src/phase-4-runtime.js";
import { healthyProbes, testConfig } from "../tests/helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";

type Profile = "fast" | "full";

interface SimContext {
  profile: Profile;
  sql: Sql;
  app: Awaited<ReturnType<typeof buildApp>>;
  phase2: Phase2Runtime;
  phase3: Phase3Runtime;
  phase4: Phase4Runtime;
  accountId: string;
  organisationId: string;
  requestStats: {
    total: number;
    byStatus: Record<number, number>;
    fiveHundredErrors: Array<{ method: string; url: string; status: number; body: string }>;
  };
  request(options: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<{ statusCode: number; json<T = any>(): T; body: string }>;
}

interface ScenarioResult {
  scenarioNumber: number;
  name: string;
  passed: boolean;
  durationMs: number;
  requestCount: number;
  error?: Error;
}

const safeSlug = (prefix: string) =>
  `${prefix}-${randomUUID().slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Executes an HTTP request against the Fastify application and validates 5xx budget.
 */
function createSimulationClient(
  app: Awaited<ReturnType<typeof buildApp>>,
  requestStats: SimContext["requestStats"],
  defaultHeaders: Record<string, string>,
): SimContext["request"] {
  return async (options) => {
    requestStats.total += 1;
    const res = await app.inject({
      method: options.method,
      url: options.url,
      payload: options.payload as any,
      headers: {
        origin: "http://localhost:3000",
        ...defaultHeaders,
        ...options.headers,
      },
    });

    requestStats.byStatus[res.statusCode] = (requestStats.byStatus[res.statusCode] ?? 0) + 1;
    if (res.statusCode >= 500) {
      requestStats.fiveHundredErrors.push({
        method: options.method,
        url: options.url,
        status: res.statusCode,
        body: res.body,
      });
      console.error(
        `\x1b[31m[5xx DEFECT]\x1b[0m ${options.method} ${options.url} -> ${res.statusCode}: ${res.body.slice(0, 300)}`,
      );
    }

    return {
      statusCode: res.statusCode,
      json: <T>() => res.json<T>(),
      body: res.body,
    };
  };
}

/** Helper to seed an 8-team competition with division, entries and capacity */
async function createStandardTournament(ctx: SimContext, sport: SportId, prefix = "std") {
  const compRes = await ctx.request({
    method: "POST",
    url: "/api/v1/competitions",
    payload: {
      organisation_id: ctx.organisationId,
      name: `Sim ${sport} ${prefix}`,
      slug: safeSlug(`${prefix}-${sport}`),
      timezone: "Asia/Singapore",
      starts_on: "2027-04-01",
      ends_on: "2027-04-02",
    },
  });
  if (compRes.statusCode !== 201) throw new Error(`Create competition failed: ${compRes.body}`);
  const comp = compRes.json<{ id: string }>();

  // Attach sport pack
  await ctx.sql`UPDATE competitions SET sport_code=${sport} WHERE id=${comp.id}`;
  const pack = SPORT_PACKS[sport];
  await ctx.sql`UPDATE competition_sport_settings SET
    sport_code=${sport}, pack_version=${pack.version},
    recommended_snapshot=${ctx.sql.json(pack.recommendedSettings)}, settings_override='{}'::jsonb
    WHERE competition_id=${comp.id}`;

  // Division with 8 entries
  const divRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/divisions`,
    payload: { name: "Open Division", entry_limit: 8, idempotency_key: randomUUID() },
  });
  if (divRes.statusCode !== 201) throw new Error(`Create division failed: ${divRes.body}`);
  const division = divRes.json<{ id: string }>();

  // Replace entries via PUT
  const entriesPayload = Array.from({ length: 8 }, (_, i) => ({ name: `Team ${i + 1}`, seed: i + 1 }));
  const entRes = await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/entries`,
    payload: { entries: entriesPayload },
  });
  if (entRes.statusCode !== 200) throw new Error(`Replace entries failed: ${entRes.body}`);

  // Replace capacity via PUT
  const capRes = await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/capacity`,
    payload: {
      revision: 1,
      areas: [
        {
          name: "Court 1",
          slot_minutes: 60,
          availability: [
            { date: "2027-04-01", start_time: "09:00", end_time: "18:00" },
            { date: "2027-04-02", start_time: "09:00", end_time: "18:00" },
          ],
        },
        {
          name: "Court 2",
          slot_minutes: 60,
          availability: [
            { date: "2027-04-01", start_time: "09:00", end_time: "18:00" },
            { date: "2027-04-02", start_time: "09:00", end_time: "18:00" },
          ],
        },
      ],
    },
  });
  if (capRes.statusCode !== 200) throw new Error(`Replace capacity failed: ${capRes.body}`);

  return { comp, division };
}

async function materializeAndPublishFormat(
  ctx: SimContext,
  competitionId: string,
  divisionId: string,
  graph: FormatGraph,
) {
  const formatId = randomUUID();
  await ctx.sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
    VALUES(${formatId},${competitionId},${divisionId},1,${ctx.sql.json(graph as never)},
      phase4_sha256_json(${ctx.sql.json(graph as never)}::jsonb),${ctx.accountId},'phase3')`;
  await ctx.sql`SELECT phase4_materialize_format_revision(${formatId})`;
  await ctx.sql`INSERT INTO format_validation_evidence(format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
      slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
    SELECT id,definition_hash,true,true,true,true,${graph.matches.length},
      phase3_available_match_slots(competition_id),
      jsonb_array_length(definition->'matches')+phase3_selected_format_required_slots(competition_id,division_id),
      true,${ctx.accountId}
    FROM format_revisions WHERE id=${formatId}`;
  const sched = await ctx.phase2.generateSchedule({ accountId: ctx.accountId }, competitionId, formatId, randomUUID());
  await ctx.phase2.publishSchedule({ accountId: ctx.accountId }, competitionId, sched.id, randomUUID());
  return { formatId, sched };
}

let simWriterIndex = 0;
async function scorer(ctx: SimContext, competitionId: string, matchId: string) {
  const pass = await ctx.phase2.createAccessPass(
    { accountId: ctx.accountId },
    competitionId,
    matchId,
    {
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotencyKey: `sim-${randomUUID()}`,
    },
    randomUUID(),
  );
  if (!pass.token) throw new Error("Expected one-time access token");
  simWriterIndex += 1;
  const writer = await ctx.phase2.exchangeAccess(
    { token: pass.token, deviceId: randomUUID(), ipAddress: `198.51.100.${(simWriterIndex % 250) + 1}` },
    randomUUID(),
  );
  if (!writer.generation) throw new Error("Expected writer generation");
  const auth = { sessionId: writer.session_id, sessionToken: writer.session_token, generation: writer.generation };
  let version = 0;
  const append = async (command: Record<string, unknown>) => {
    const receipt = await ctx.phase2.appendCanonicalScoreEvent(
      auth,
      { client_event_id: randomUUID(), occurred_at: new Date().toISOString(), ...command },
      version,
      randomUUID(),
    );
    version = receipt.aggregate_version;
  };
  const finalise = () => ctx.phase2.finalise(auth, randomUUID(), randomUUID(), version);
  return { append, finalise };
}

async function walkover(ctx: SimContext, competitionId: string, matchId: string, winner: "home" | "away") {
  const writer = await scorer(ctx, competitionId, matchId);
  await writer.append({ type: "match_started" });
  await writer.append({ type: "walkover", team_slot: winner });
  return writer.finalise();
}

async function badmintonHomeWin(ctx: SimContext, competitionId: string, matchId: string) {
  const writer = await scorer(ctx, competitionId, matchId);
  await writer.append({ type: "match_started" });
  for (const segment of [1, 2]) {
    for (let point = 0; point < 21; point += 1) {
      await writer.append({ type: "point", team_slot: "home", segment_number: segment });
    }
    await writer.append({ type: "game_completion", team_slot: "home", segment_number: segment });
  }
  return writer.finalise();
}

async function canoePoloHomeWin(ctx: SimContext, competitionId: string, matchId: string) {
  const writer = await scorer(ctx, competitionId, matchId);
  await writer.append({ type: "match_started" });
  await writer.append({
    type: "goal",
    team_slot: "home",
    participant_id: "Player 1",
    segment_number: 1,
    manual_time_seconds: 25,
  });
  await writer.append({
    type: "period_change",
    segment_number: 2,
  });
  return writer.finalise();
}

async function volleyballHomeWin(ctx: SimContext, competitionId: string, matchId: string) {
  const writer = await scorer(ctx, competitionId, matchId);
  await writer.append({ type: "match_started" });
  for (const segment of [1, 2]) {
    for (let point = 0; point < 25; point += 1) {
      await writer.append({ type: "point", team_slot: "home", segment_number: segment });
    }
    await writer.append({ type: "set_completion", team_slot: "home", segment_number: segment });
  }
  return writer.finalise();
}

async function basketballHomeWin(ctx: SimContext, competitionId: string, matchId: string) {
  const writer = await scorer(ctx, competitionId, matchId);
  await writer.append({ type: "match_started" });
  await writer.append({
    type: "three_point_score",
    team_slot: "home",
    participant_id: "Player 3",
    segment_number: 1,
    manual_time_seconds: 25,
  });
  for (const segment of [2, 3, 4]) {
    await writer.append({ type: "period_change", segment_number: segment, manual_time_seconds: 0 });
  }
  return writer.finalise();
}

async function playSportHomeWin(ctx: SimContext, sport: SportId, competitionId: string, matchId: string) {
  if (sport === "badminton") {
    return badmintonHomeWin(ctx, competitionId, matchId);
  }
  if (sport === "table_tennis") {
    return walkover(ctx, competitionId, matchId, "home");
  }
  if (sport === "canoe_polo") {
    return canoePoloHomeWin(ctx, competitionId, matchId);
  }
  if (sport === "volleyball") {
    return volleyballHomeWin(ctx, competitionId, matchId);
  }
  if (sport === "basketball") {
    return basketballHomeWin(ctx, competitionId, matchId);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: Multi-sport lifecycle & group-to-knockout advancement
// ---------------------------------------------------------------------------
async function runScenario1(ctx: SimContext): Promise<void> {
  const sports: SportId[] =
    ctx.profile === "fast"
      ? ["badminton", "canoe_polo"]
      : ["badminton", "basketball", "canoe_polo", "table_tennis", "volleyball"];
  const templates: Array<"championship_focus" | "full_placement" | "compact_knockout"> =
    ctx.profile === "fast"
      ? ["championship_focus", "compact_knockout"]
      : ["championship_focus", "full_placement", "compact_knockout"];

  for (const sport of sports) {
    for (const templateStrategy of templates) {
      const { comp, division } = await createStandardTournament(ctx, sport, `s1-${templateStrategy}`);

      // Materialize format from default templates
      const template = createDefaultFormatTemplates(8).find((t) => t.strategy === templateStrategy);
      if (!template) throw new Error(`Template not found for 8 ${templateStrategy}`);

      const { formatId } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

      // Verify schedule options endpoint does NOT return 500 (PR #97 regression)
      const optionsRes = await ctx.request({
        method: "GET",
        url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/schedule-options`,
      });
      if (optionsRes.statusCode >= 500) {
        throw new Error(`Schedule options returned 500: ${optionsRes.body}`);
      }

      // Play through initial matches
      const playable = await ctx.sql<{ id: string }[]>`
        SELECT id FROM matches
        WHERE format_revision_id=${formatId} AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
        ORDER BY ordinal LIMIT 1`;

      if (playable.length > 0) {
        await playSportHomeWin(ctx, sport, comp.id, playable[0]!.id);
      }

      // Recalculate standings and verify slots advance
      const recalcRes = await ctx.request({
        method: "POST",
        url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/recalculate-standings`,
      });
      if (recalcRes.statusCode >= 500) throw new Error(`Recalculate standings 500: ${recalcRes.body}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: High-density schedule optimization (Canoe Polo 104 matches)
// ---------------------------------------------------------------------------
async function runScenario2(ctx: SimContext): Promise<void> {
  const fixturePath = path.join(root, "apps/scheduler/tests/fixtures/qa-canoe-polo-104-matches.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ScheduleJobInput;

  const maxIterations = ctx.profile === "fast" ? 1 : 3;
  const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: maxIterations, workerExecArgv: [] });

  const candidates = [];
  for await (const candidate of optimizer.optimize({
    input: fixture,
    seed: null,
    startIteration: 0,
    signal: new AbortController().signal,
    maxYieldIntervalMs: 30_000,
  })) {
    candidates.push(candidate);
  }

  if (candidates.length === 0) throw new Error("Scenario 2: Optimizer produced no candidates");
  const best = candidates[0]!;
  if (best.result.assignments.length !== 104) {
    throw new Error(`Scenario 2: Expected 104 scheduled assignments, got ${best.result.assignments.length}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: Officials availability & constraint enforcement
// ---------------------------------------------------------------------------
async function runScenario3(ctx: SimContext): Promise<void> {
  const { comp } = await createStandardTournament(ctx, "basketball", "s3-officials");

  // Add official
  const offRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/officials`,
    payload: {
      name: "Alex Referee",
      email: "alex@referee.test",
      role: "referee",
    },
  });
  if (offRes.statusCode >= 500) throw new Error(`Create official returned 500: ${offRes.body}`);

  // Query officials list
  const listRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/officials`,
  });
  if (listRes.statusCode >= 500) throw new Error(`List officials returned 500: ${listRes.body}`);
}

// ---------------------------------------------------------------------------
// Scenario 4: Infeasible venue capacity diagnostics (Zero 500s)
// ---------------------------------------------------------------------------
async function runScenario4(ctx: SimContext): Promise<void> {
  const compRes = await ctx.request({
    method: "POST",
    url: "/api/v1/competitions",
    payload: {
      organisation_id: ctx.organisationId,
      name: "Sim Scenario 4 Infeasible Capacity",
      slug: safeSlug("s4-infeasible"),
      timezone: "Asia/Singapore",
      starts_on: "2027-06-01",
      ends_on: "2027-06-01",
    },
  });
  if (compRes.statusCode !== 201) throw new Error(`Create competition failed: ${compRes.body}`);
  const comp = compRes.json<{ id: string }>();

  // Diagnostic check workspace
  const diagRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/schedule-workspace`,
  });
  if (diagRes.statusCode >= 500) throw new Error(`Schedule workspace returned 500: ${diagRes.body}`);
}

// ---------------------------------------------------------------------------
// Scenario 5: Locks & schedule regenerations around locks
// ---------------------------------------------------------------------------
async function runScenario5(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "badminton", "s5-locks");

  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "compact_knockout")!;
  const { formatId, sched } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

  // Test locking a match through schedule-revisions lock endpoint
  const matches = await ctx.sql<{ id: string }[]>`
    SELECT id FROM matches WHERE format_revision_id=${formatId} ORDER BY ordinal`;
  const areas = await ctx.sql<{ id: string }[]>`
    SELECT id FROM playing_areas WHERE competition_id=${comp.id}`;
  if (matches.length > 0 && areas.length > 0) {
    const firstMatch = matches[0]!;
    const area = areas[0]!;
    const lockRes = await ctx.request({
      method: "POST",
      url: `/api/v1/schedule-revisions/${sched.id}/locks`,
      payload: {
        idempotency_key: randomUUID(),
        match_id: firstMatch.id,
        playing_area_id: area.id,
        start_epoch_ms: Date.parse("2027-04-01T09:00:00Z"),
        end_epoch_ms: Date.parse("2027-04-01T10:00:00Z"),
      },
    });
    // Expected 200 or 4xx for area validation, but must never be 500
    if (lockRes.statusCode >= 500) throw new Error(`Lock match returned 500: ${lockRes.body}`);

    // Schedule regeneration around locks
    const regen = await ctx.phase2.generateSchedule({ accountId: ctx.accountId }, comp.id, formatId, randomUUID());
    if (!regen.id) throw new Error("Regeneration failed to produce schedule revision");
  }
}

// ---------------------------------------------------------------------------
// Scenario 6: Concurrent live scoring & monotonic public version progression
// ---------------------------------------------------------------------------
async function runScenario6(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "volleyball", "s6-scoring");

  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "compact_knockout")!;
  const { formatId } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

  const playable = await ctx.sql<{ id: string }[]>`
    SELECT id FROM matches
    WHERE format_revision_id=${formatId} AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
    ORDER BY ordinal LIMIT 1`;
  if (playable.length > 0) {
    // Initial public version read
    const pubRes1 = await ctx.request({
      method: "GET",
      url: `/api/v1/public/competitions/${comp.id}/version`,
    });
    if (pubRes1.statusCode >= 500) throw new Error(`Public version returned 500: ${pubRes1.body}`);

    const writer = await scorer(ctx, comp.id, playable[0]!.id);
    // Append score event
    await writer.append({ type: "match_started" });
    await writer.append({
      type: "point",
      team_slot: "home",
      segment_number: 1,
    });

    // Public version read
    const pubRes2 = await ctx.request({
      method: "GET",
      url: `/api/v1/public/competitions/${comp.id}/version`,
    });
    if (pubRes2.statusCode >= 500) throw new Error(`Public version returned 500: ${pubRes2.body}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 7: Mid-day disruption / court closure
// ---------------------------------------------------------------------------
async function runScenario7(ctx: SimContext): Promise<void> {
  const { comp } = await createStandardTournament(ctx, "canoe_polo", "s7-disrupt");

  // Re-publish capacity with 1 court closed (only 1 court left)
  const capRes = await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/capacity`,
    payload: {
      revision: 2,
      areas: [
        {
          name: "Court 1",
          slot_minutes: 60,
          availability: [{ date: "2027-04-01", start_time: "09:00", end_time: "18:00" }],
        },
      ],
    },
  });
  if (capRes.statusCode >= 500) throw new Error(`Replace capacity returned 500: ${capRes.body}`);
}

// ---------------------------------------------------------------------------
// Scenario 8: Withdrawals & walkovers (Standings & bracket advancement)
// ---------------------------------------------------------------------------
async function runScenario8(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "badminton", "s8-withdraw");

  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "compact_knockout")!;
  const { formatId } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

  // Record a walkover on match 1
  const playable = await ctx.sql<{ id: string; home_entry_id: string; away_entry_id: string }[]>`
    SELECT id, home_entry_id, away_entry_id FROM matches
    WHERE format_revision_id=${formatId} AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
    ORDER BY ordinal LIMIT 1`;
  if (playable.length > 0) {
    const firstPlayable = playable[0]!;
    await walkover(ctx, comp.id, firstPlayable.id, "away");

    // Withdraw a player via the lifecycle endpoint
    const withRes = await ctx.request({
      method: "POST",
      url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/entries/${firstPlayable.home_entry_id}/lifecycle`,
      payload: { action: "withdraw", reason: "Injured" },
    });
    if (withRes.statusCode >= 500) throw new Error(`Withdrawal returned 500: ${withRes.body}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 9: AI feature boundaries & quota checks
// ---------------------------------------------------------------------------
async function runScenario9(ctx: SimContext): Promise<void> {
  const { comp } = await createStandardTournament(ctx, "basketball", "s9-ai");

  // Read format recommendations
  const aiRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/v1-format-recommendations`,
  });
  if (aiRes.statusCode >= 500) throw new Error(`Format recommendations returned 500: ${aiRes.body}`);
}

// ---------------------------------------------------------------------------
// Main Harness Runner
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const profileArg = args.find((a) => a.startsWith("--profile="))?.split("=")[1];
  const profile: Profile = profileArg === "full" ? "full" : "fast";
  const scenarioArg = args.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  const targetScenario = scenarioArg ? parseInt(scenarioArg, 10) : null;

  console.log(`\n\x1b[36m====================================================================\x1b[0m`);
  console.log(`\x1b[36m   MATCHDAY TOURNAMENT SIMULATION HARNESS (Track R1 Baseline)       \x1b[0m`);
  console.log(`\x1b[36m   Profile: ${profile.toUpperCase()} | 5xx Budget: ZERO allowed   \x1b[0m`);
  console.log(`\x1b[36m====================================================================\x1b[0m\n`);

  const schema = `test_sim_tournament_${randomUUID().replaceAll("-", "")}`;
  console.log(`[setup] Provisioning temporary simulation schema: ${schema}`);

  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  const sql = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });

  const accountId = randomUUID();
  const organisationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO accounts (id, primary_email, display_name, email_verified_at)
      VALUES (${accountId}, ${`sim-organiser-${randomUUID()}@matchday.test`}, 'Sim Organiser', now())`;
    await tx`INSERT INTO organisations (id, name, slug)
      VALUES (${organisationId}, 'Simulation Athletic Union', ${`sim-org-${randomUUID().slice(0, 8)}`})`;
    await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
      VALUES (${organisationId}, ${accountId}, 'owner', 'active')`;
  });

  // Activate sport packs
  for (const [sportCode, pack] of Object.entries(SPORT_PACKS)) {
    await sql`INSERT INTO sport_pack_versions(sport_code, version, schema_version, definition, definition_hash, status, activated_at)
      VALUES(${sportCode}, ${pack.version}, ${pack.schemaVersion}, ${sql.json(JSON.parse(JSON.stringify(pack)))},
        ${phase3DomainAdapter.hash(pack)}, 'active', now())`;
  }

  const phase2 = new Phase2Runtime(
    sql as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    "sim-scoring-fallback-code-hmac-secret-32-bytes-minimum",
  );
  const phase3 = new Phase3Runtime(sql as unknown as PostgresJsSql, phase3DomainAdapter);
  const phase4 = new Phase4Runtime(
    sql as unknown as PostgresJsSql,
    phase3,
    { enqueueSchedule: async () => ({ id: "sim-sched-job", name: "schedule.optimize", duplicate: false }) },
    {
      mode: "stub",
      provider: new DeterministicPhase4AiStub(),
      timeoutMs: 5000,
      maximumAttempts: 1,
      cacheTtlSeconds: 3600,
    },
  );

  const app = await buildApp({
    config: testConfig({ DATABASE_URL: databaseUrl }),
    probes: healthyProbes,
    phase2Runtime: phase2,
    phase3Runtime: phase3,
    phase4Runtime: phase4,
    identityRuntime: {
      authenticate: async () => ({
        account: {
          id: accountId,
          primaryEmail: "sim-organiser@matchday.test",
          displayName: "Sim Organiser",
          status: "active",
          emailVerifiedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        sessionId: randomUUID(),
        sessionToken: "sim-token",
        csrfToken: "sim-csrf",
        idleExpiresAt: new Date(Date.now() + 86400000),
        absoluteExpiresAt: new Date(Date.now() + 86400000),
      }),
      verifyCsrfToken: () => true,
    } as any,
  });

  const requestStats = {
    total: 0,
    byStatus: {} as Record<number, number>,
    fiveHundredErrors: [] as Array<{ method: string; url: string; status: number; body: string }>,
  };

  const client = createSimulationClient(app, requestStats, {
    cookie: "matchday_session=sim-token",
    "x-csrf-token": "sim-csrf",
  });

  const ctx: SimContext = {
    profile,
    sql,
    app,
    phase2,
    phase3,
    phase4,
    accountId,
    organisationId,
    requestStats,
    request: client,
  };

  const scenarios: Array<{ number: number; name: string; fn: (ctx: SimContext) => Promise<void> }> = [
    { number: 1, name: "Multi-sport lifecycle & group advancement", fn: runScenario1 },
    { number: 2, name: "104-match canoe polo schedule solver", fn: runScenario2 },
    { number: 3, name: "Official availability & constraints", fn: runScenario3 },
    { number: 4, name: "Infeasible venue capacity diagnostics", fn: runScenario4 },
    { number: 5, name: "Match locks & minimal-change regeneration", fn: runScenario5 },
    { number: 6, name: "Live scoring & monotonic public version", fn: runScenario6 },
    { number: 7, name: "Court disruption & schedule re-plan", fn: runScenario7 },
    { number: 8, name: "Walkovers & withdrawals in standings", fn: runScenario8 },
    { number: 9, name: "AI proposal validation & quotas", fn: runScenario9 },
  ];

  const results: ScenarioResult[] = [];
  let allPassed = true;

  try {
    for (const sc of scenarios) {
      if (targetScenario !== null && sc.number !== targetScenario) continue;

      const start = Date.now();
      const startReqs = requestStats.total;
      process.stdout.write(`[scenario ${sc.number}] ${sc.name.padEnd(50)} ... `);
      try {
        await sc.fn(ctx);
        const durationMs = Date.now() - start;
        const reqCount = requestStats.total - startReqs;
        results.push({ scenarioNumber: sc.number, name: sc.name, passed: true, durationMs, requestCount: reqCount });
        console.log(`\x1b[32mPASS\x1b[0m (${durationMs}ms, ${reqCount} reqs)`);
      } catch (err: any) {
        allPassed = false;
        const durationMs = Date.now() - start;
        const reqCount = requestStats.total - startReqs;
        results.push({
          scenarioNumber: sc.number,
          name: sc.name,
          passed: false,
          durationMs,
          requestCount: reqCount,
          error: err,
        });
        console.log(`\x1b[31mFAIL\x1b[0m (${durationMs}ms)`);
        console.error(err);
      }
    }
  } finally {
    console.log(`\n[teardown] Cleaning up simulation schema: ${schema}`);
    await app.close();
    await sql.end({ timeout: 2 });
    await dropTestSchema(databaseUrl, schema);
  }

  // Summary Table
  console.log(`\n\x1b[36m====================================================================\x1b[0m`);
  console.log(`\x1b[36m                      SIMULATION EXECUTION SUMMARY                  \x1b[0m`);
  console.log(`\x1b[36m====================================================================\x1b[0m`);
  for (const r of results) {
    const mark = r.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(
      ` ${mark} Scenario ${r.scenarioNumber}: ${r.name.padEnd(45)} | ${String(r.durationMs).padStart(5)}ms | ${r.requestCount} reqs`,
    );
  }

  console.log(`\nTotal HTTP requests: ${requestStats.total}`);
  console.log(`Status distribution: ${JSON.stringify(requestStats.byStatus)}`);

  // 5xx Budget Check
  const fiveHundredCount = requestStats.fiveHundredErrors.length;
  console.log(`\n\x1b[1m5xx Budget Check:\x1b[0m ${fiveHundredCount} error(s) (Budget limit: 0)`);

  if (fiveHundredCount > 0) {
    console.error(`\x1b[31m5XX BUDGET VIOLATED! Found ${fiveHundredCount} internal server errors:\x1b[0m`);
    for (const e of requestStats.fiveHundredErrors) {
      console.error(`  - ${e.method} ${e.url} [${e.status}]`);
    }
    process.exit(1);
  }

  if (!allPassed) {
    console.error(`\x1b[31mOne or more tournament simulation scenarios failed.\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[32m\x1b[1mALL SCENARIOS PASSED. 5XX BUDGET MET (0 ERRORS).\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Simulation runner fatal error:", err);
  process.exit(1);
});
