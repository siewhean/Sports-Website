/**
 * Track R1: Tournament Simulation Harness CLI
 *
 * Implements deliverables R1.2 and R1.4 from docs/EXECUTION_ROADMAP.md:
 * - Creates organisations, competitions, entries, formats, and officials entirely through the API.
 * - Executes mock-tournament scenarios 1-9 across all five supported sports.
 * - Enforces zero-5xx budget check and fails on any unexpected 4xx response.
 * - Supports fast and full profiles.
 *
 * Usage:
 *   pnpm simulate:tournament [--profile=fast|full] [--scenario=1..9]
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import type { ScheduleJobInput } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS, createDefaultFormatTemplates, type FormatGraph, type SportId } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { DomainScheduleOptimizer } from "@matchday/scheduler";
import { buildApp } from "../src/app.js";
import { DeterministicPhase4AiStub } from "../src/phase-4-ai-provider.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { Phase4Runtime } from "../src/phase-4-runtime.js";
import { GateCC4PublicTruthRuntime } from "../src/gate-c-c4-public-truth.js";
import { healthyProbes, testConfig } from "../tests/helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");

const databaseUrl: string = (() => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required to run tournament simulation");
  }
  return url;
})();

type Profile = "fast" | "full";

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI);
const col = {
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

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
    expectedStatuses?: number[];
  }): Promise<{ statusCode: number; json<T = unknown>(): T; body: string }>;
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
 * Executes an HTTP request against the Fastify application and validates status budgets.
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
      payload: options.payload as Record<string, unknown>,
      headers: {
        origin: "http://localhost:3000",
        ...defaultHeaders,
        ...options.headers,
      },
    });

    requestStats.byStatus[res.statusCode] = (requestStats.byStatus[res.statusCode] ?? 0) + 1;
    const expected = options.expectedStatuses ?? [200, 201, 202, 204];

    if (res.statusCode >= 500) {
      requestStats.fiveHundredErrors.push({
        method: options.method,
        url: options.url,
        status: res.statusCode,
        body: res.body,
      });
      throw new Error(`[5xx DEFECT] ${options.method} ${options.url} -> ${res.statusCode}: ${res.body.slice(0, 500)}`);
    }

    if (!expected.includes(res.statusCode)) {
      throw new Error(
        `[UNEXPECTED STATUS ${res.statusCode}] ${options.method} ${options.url} (expected ${expected.join(",")}): ${res.body.slice(0, 500)}`,
      );
    }

    return {
      statusCode: res.statusCode,
      json: <T>() => res.json<T>(),
      body: res.body,
    };
  };
}

/** Helper to seed an 8-team competition with division, entries and capacity entirely via API */
async function createStandardTournament(ctx: SimContext, sport: SportId, prefix = "std") {
  const slug = safeSlug(`${prefix}-${sport}`);
  const compRes = await ctx.request({
    method: "POST",
    url: "/api/v1/competitions/phase3",
    payload: {
      organisation_id: ctx.organisationId,
      name: `Sim ${sport} ${prefix}`,
      slug,
      sport_code: sport,
      venue: "Jurong West Sports Hall",
      address: "20 Jurong West St 93",
      country_code: "SG",
      starts_on: "2027-04-01",
      ends_on: "2027-04-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
      idempotency_key: randomUUID(),
    },
    expectedStatuses: [201],
  });
  const comp = compRes.json<{ id: string }>();

  // Division with 8 entries
  const divRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/divisions`,
    payload: { name: "Open Division", entry_limit: 8, idempotency_key: randomUUID() },
    expectedStatuses: [201],
  });
  const division = divRes.json<{ id: string }>();

  // Replace entries via PUT
  const entriesPayload = Array.from({ length: 8 }, (_, i) => ({ name: `Team ${i + 1}`, seed: i + 1 }));
  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/entries`,
    payload: { entries: entriesPayload },
    expectedStatuses: [200],
  });

  // Set capacity via PUT (2 courts, 2 days, 9am to 6pm, 60min slots = 18 slots total)
  await ctx.request({
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
    expectedStatuses: [200],
  });

  return { comp: { id: comp.id, slug }, division };
}

/** Pure API helper to create and publish a format revision without generating a schedule */
async function materializeAndPublishFormatOnly(
  ctx: SimContext,
  competitionId: string,
  divisionId: string,
  graph: FormatGraph,
) {
  // 1. Create format revision via API
  const formatRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/format-revisions`,
    payload: { definition: graph },
    expectedStatuses: [201],
  });
  const format = formatRes.json<{ id: string; definition_hash: string }>();

  // 2. Materialise format matches via API
  await ctx.request({
    method: "POST",
    url: `/api/v1/format-revisions/${format.id}/materialise`,
    payload: { idempotency_key: randomUUID() },
    expectedStatuses: [200],
  });

  // 3. Publish format revision via API
  await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${competitionId}/format-revisions/${format.id}/publish`,
    payload: { definition_hash: format.definition_hash },
    expectedStatuses: [200],
  });

  return { formatId: format.id };
}

/** Pure API helper to create format revision, publish format, and generate/publish schedule */
async function materializeAndPublishFormat(
  ctx: SimContext,
  competitionId: string,
  divisionId: string,
  graph: FormatGraph,
) {
  const { formatId } = await materializeAndPublishFormatOnly(ctx, competitionId, divisionId, graph);

  // 4. Generate schedule revision via API
  const schedRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${competitionId}/schedule-revisions/generate`,
    payload: { format_revision_id: formatId },
    expectedStatuses: [200],
  });
  const sched = schedRes.json<{ id: string; revision: number }>();

  // 5. Mark schedule revision ready for review via API
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${sched.id}/ready`,
    payload: { idempotency_key: randomUUID(), expected_revision: sched.revision },
    expectedStatuses: [200],
  });

  // 6. Publish schedule revision via API
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${sched.id}/publish`,
    payload: { idempotency_key: randomUUID(), expected_revision: sched.revision },
    expectedStatuses: [200],
  });

  return { formatId, sched };
}

let simWriterIndex = 0;
/** Scoring helper executing 100% through the HTTP API */
async function scorer(ctx: SimContext, competitionId: string, matchId: string) {
  const passRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${competitionId}/matches/${matchId}/access-passes`,
    payload: {
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotency_key: `sim-${randomUUID()}`,
    },
    expectedStatuses: [201],
  });
  const pass = passRes.json<{ token: string }>();
  if (!pass.token) throw new Error("Expected one-time access token");

  simWriterIndex += 1;
  const exchangeRes = await ctx.request({
    method: "POST",
    url: "/api/v1/scoring/access/exchange",
    payload: {
      token: pass.token,
      device_id: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
    },
    headers: {
      "x-forwarded-for": `198.51.100.${(simWriterIndex % 250) + 1}`,
    },
    expectedStatuses: [200],
  });
  const writer = exchangeRes.json<{ session_id: string; session_token: string; generation: number }>();
  const scoringHeaders = {
    "x-scoring-session-id": writer.session_id,
    "x-scoring-session-token": writer.session_token,
    "x-writer-generation": String(writer.generation),
  };

  let sequence = 0;
  const append = async (command: Record<string, unknown>) => {
    const res = await ctx.request({
      method: "POST",
      url: "/api/v1/scoring/events",
      headers: scoringHeaders,
      payload: {
        client_event_id: randomUUID(),
        expected_sequence: sequence,
        occurred_at: new Date().toISOString(),
        ...command,
      },
      expectedStatuses: [200],
    });
    const receipt = res.json<{ aggregate_version: number }>();
    sequence += 1;
    return receipt;
  };

  const finalise = async () => {
    const res = await ctx.request({
      method: "POST",
      url: "/api/v1/scoring/finalise",
      headers: scoringHeaders,
      payload: {
        client_event_id: randomUUID(),
        expected_sequence: sequence,
        occurred_at: new Date().toISOString(),
      },
      expectedStatuses: [200],
    });
    return res.json();
  };

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

async function tableTennisHomeWin(ctx: SimContext, competitionId: string, matchId: string) {
  const writer = await scorer(ctx, competitionId, matchId);
  await writer.append({ type: "match_started" });
  for (const segment of [1, 2]) {
    for (let point = 0; point < 11; point += 1) {
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
  if (sport === "badminton") return badmintonHomeWin(ctx, competitionId, matchId);
  if (sport === "table_tennis") return tableTennisHomeWin(ctx, competitionId, matchId);
  if (sport === "canoe_polo") return canoePoloHomeWin(ctx, competitionId, matchId);
  if (sport === "volleyball") return volleyballHomeWin(ctx, competitionId, matchId);
  if (sport === "basketball") return basketballHomeWin(ctx, competitionId, matchId);
}

function defaultConstraints(areaId: string) {
  const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
  return {
    minimum_rest: ignored({ minutes: 0 }),
    maximum_matches_per_day: ignored({ matches: 8 }),
    preferred_final_time: ignored({ target_start_epoch_ms: 0, tolerance_minutes: 60 }),
    entry_unavailable: ignored({ by_entry_id: {} }),
    official_availability: ignored({ by_official_id: {} }),
    featured_playing_area: ignored({ area_id: areaId, match_ids: [] }),
    avoid_consecutive_matches: ignored({ minutes: 0 }),
    balance_early_matches: ignored({ before_local_time: "09:00" }),
    balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
    keep_division_together: ignored({ maximum_area_count: 1 }),
    preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Multi-sport lifecycle & group-to-knockout advancement (All 5 sports)
// ---------------------------------------------------------------------------
async function runScenario1(ctx: SimContext): Promise<void> {
  const sports: SportId[] = ["badminton", "basketball", "canoe_polo", "table_tennis", "volleyball"];

  for (const sport of sports) {
    const { comp, division } = await createStandardTournament(ctx, sport, "s1");
    const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "championship_focus");
    if (!template) throw new Error("Template not found for 8 championship_focus");

    const { formatId } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

    // 1. Verify schedule workspace & schedule options route (PR #97 regression check)
    const wsRes = await ctx.request({
      method: "GET",
      url: `/api/v1/competitions/${comp.id}/schedule-workspace`,
      expectedStatuses: [200],
    });
    const ws = wsRes.json<{
      generation: {
        source_revision: number;
        capacity_revision: number;
        objective: string;
        constraints: unknown;
      };
    }>();

    const areas = await ctx.sql<{ id: string }[]>`SELECT id FROM playing_areas WHERE competition_id=${comp.id}`;
    const areaId = areas[0]?.id ?? randomUUID();

    const jobRes = await ctx.request({
      method: "POST",
      url: `/api/v1/competitions/${comp.id}/schedule-jobs`,
      payload: {
        idempotency_key: randomUUID(),
        expected_source_revision: ws.generation.source_revision,
        expected_capacity_revision: ws.generation.capacity_revision,
        objective: ws.generation.objective ?? "balanced",
        constraints: ws.generation.constraints ?? defaultConstraints(areaId),
      },
      expectedStatuses: [202],
    });
    const job = jobRes.json<{ job: { id: string } }>();

    const optionsRes = await ctx.request({
      method: "GET",
      url: `/api/v1/schedule-jobs/${job.job.id}/options`,
      expectedStatuses: [200],
    });
    const options = optionsRes.json<unknown[]>();
    if (!Array.isArray(options)) throw new Error("Expected array of schedule options");

    // 2. Play all group stage matches (matches with populated entry slots)
    const initialMatches = await ctx.sql<{ id: string }[]>`
      SELECT id FROM matches
      WHERE format_revision_id=${formatId} AND graph_stage_id='groups' AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
      ORDER BY ordinal`;

    if (initialMatches.length === 0) throw new Error(`No playable pool matches found for ${sport}`);

    for (const m of initialMatches) {
      await playSportHomeWin(ctx, sport, comp.id, m.id);
    }

    // 3. Recalculate standings via real API route
    await ctx.request({
      method: "POST",
      url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/standings/recalculate`,
      expectedStatuses: [200],
    });

    // 4. Assert standings updated
    const standingsRes = await ctx.request({
      method: "GET",
      url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/standings`,
      expectedStatuses: [200],
    });
    const standings = standingsRes.json<{ standings?: Array<{ entry_id: string; rank: number; played: number }> }>();
    if (!standings || !standings.standings || standings.standings.length < 8) {
      throw new Error(`Standings incomplete for ${sport}`);
    }
    const playedAny = standings.standings.some((s) => s.played > 0);
    if (!playedAny) throw new Error(`Standings do not reflect played matches for ${sport}`);

    // 5. Verify knockout advancement: group winners/runners-up advanced into semifinals!
    const semiMatches = await ctx.sql<{ id: string; home_entry_id: string | null; away_entry_id: string | null }[]>`
      SELECT id, home_entry_id, away_entry_id FROM matches
      WHERE format_revision_id=${formatId} AND graph_stage_id='championship' AND round_number=1
      ORDER BY ordinal`;

    if (semiMatches.length === 0) throw new Error(`No semifinal matches found for ${sport}`);
    for (const sm of semiMatches) {
      if (!sm.home_entry_id || !sm.away_entry_id) {
        throw new Error(`Knockout bracket did not fill participants from pool standings for ${sport}`);
      }
      await playSportHomeWin(ctx, sport, comp.id, sm.id);
    }

    // Recalculate standings to advance semifinal winners to final
    await ctx.request({
      method: "POST",
      url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/standings/recalculate`,
      expectedStatuses: [200],
    });

    // 6. Verify final match participants populated from semifinal winners!
    const finalMatches = await ctx.sql<{ id: string; home_entry_id: string | null; away_entry_id: string | null }[]>`
      SELECT id, home_entry_id, away_entry_id FROM matches
      WHERE format_revision_id=${formatId} AND graph_stage_id='championship' AND round_number=2
      ORDER BY ordinal`;

    if (finalMatches.length === 0) throw new Error(`No final match found for ${sport}`);
    const finalMatch = finalMatches[0]!;
    if (!finalMatch.home_entry_id || !finalMatch.away_entry_id) {
      throw new Error(`Final match did not fill participants from semifinal winners for ${sport}`);
    }

    await playSportHomeWin(ctx, sport, comp.id, finalMatch.id);

    // 7. Verify public truth snapshot: champion is decided and bracket is complete
    const publicRes = await ctx.request({
      method: "GET",
      url: `/api/v1/public/competitions/${comp.slug}/current`,
      expectedStatuses: [200],
    });
    const pub = publicRes.json<{ results: Array<{ match_id: string; state: string }>; bracket: unknown }>();
    const finalResult = pub.results.find((r) => r.match_id === finalMatch.id);
    if (!finalResult || finalResult.state !== "final") {
      throw new Error(`Final match result not final in public projection for ${sport}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: High-density schedule optimization (Canoe Polo 104 matches)
// ---------------------------------------------------------------------------
async function runScenario2(ctx: SimContext): Promise<void> {
  const fixturePath = path.join(root, "apps/scheduler/tests/fixtures/qa-canoe-polo-104-matches.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ScheduleJobInput;

  const maxIterations = ctx.profile === "fast" ? 1 : 4;
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

  // Check 1: No court overlaps
  const byArea = new Map<string, Array<{ start: number; end: number; matchId: string }>>();
  for (const a of best.result.assignments) {
    const list = byArea.get(a.area_id) ?? [];
    list.push({ start: a.start_epoch_ms, end: a.end_epoch_ms, matchId: a.match_id });
    byArea.set(a.area_id, list);
  }
  for (const [areaId, matches] of byArea) {
    matches.sort((a, b) => a.start - b.start);
    for (let i = 1; i < matches.length; i++) {
      if (matches[i]!.start < matches[i - 1]!.end) {
        throw new Error(
          `Scenario 2: Overlapping matches on area ${areaId}: ${matches[i - 1]!.matchId} and ${matches[i]!.matchId}`,
        );
      }
    }
  }

  // Check 2: No team overlaps
  const matchEntryMap = new Map<string, string[]>();
  for (const m of fixture.matches) {
    matchEntryMap.set(m.match_id, [...m.possible_entry_ids]);
  }
  const byTeam = new Map<string, Array<{ start: number; end: number; matchId: string }>>();
  for (const a of best.result.assignments) {
    const teams = matchEntryMap.get(a.match_id) ?? [];
    for (const team of teams) {
      const list = byTeam.get(team) ?? [];
      list.push({ start: a.start_epoch_ms, end: a.end_epoch_ms, matchId: a.match_id });
      byTeam.set(team, list);
    }
  }
  for (const [teamId, matches] of byTeam) {
    matches.sort((a, b) => a.start - b.start);
    for (let i = 1; i < matches.length; i++) {
      if (matches[i]!.start < matches[i - 1]!.end) {
        throw new Error(
          `Scenario 2: Team ${teamId} has overlapping matches: ${matches[i - 1]!.matchId} and ${matches[i]!.matchId}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: Officials availability & constraint enforcement
// ---------------------------------------------------------------------------
async function runScenario3(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "basketball", "s3-officials");
  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "compact_knockout")!;
  const { formatId } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

  // 1. Create official via API
  const offRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/officials`,
    payload: {
      name: "Alex Referee",
      default_role: "referee",
    },
    expectedStatuses: [201],
  });
  const official = offRes.json<{ id: string }>();

  // 2. Set availability window via API
  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/officials/${official.id}/availability`,
    payload: {
      windows: [{ starts_at: "2027-04-01T09:00:00.000Z", ends_at: "2027-04-01T14:00:00.000Z" }],
    },
    expectedStatuses: [200],
  });

  // 3. Assign official to match
  const matches = await ctx.sql<{ id: string }[]>`
    SELECT id FROM matches WHERE format_revision_id=${formatId} ORDER BY ordinal LIMIT 1`;
  if (matches.length > 0) {
    await ctx.request({
      method: "PUT",
      url: `/api/v1/competitions/${comp.id}/matches/${matches[0]!.id}/officials`,
      payload: {
        assignments: [{ official_id: official.id, assigned_role: "referee" }],
      },
      expectedStatuses: [200],
    });
  }

  // 4. Query official workspace via API
  const wsRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/officials/workspace`,
    expectedStatuses: [200],
  });
  const ws = wsRes.json<{ officials: Array<{ id: string }>; assignments: Array<{ official_id: string }> }>();
  if (!ws.officials.some((o) => o.id === official.id)) {
    throw new Error("Created official not found in workspace");
  }
  if (!ws.assignments.some((a) => a.official_id === official.id)) {
    throw new Error("Match assignment not found in workspace");
  }

  // 5. Test schedule constraint enforcement for official availability
  const schedWsRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/schedule-workspace`,
    expectedStatuses: [200],
  });
  const schedWs = schedWsRes.json<{
    generation: {
      source_revision: number;
      capacity_revision: number;
      objective: string;
      constraints: unknown;
    };
  }>();

  const areas = await ctx.sql<{ id: string }[]>`SELECT id FROM playing_areas WHERE competition_id=${comp.id}`;
  const areaId = areas[0]?.id ?? randomUUID();
  const constraints = {
    ...defaultConstraints(areaId),
    official_availability: {
      mode: "required" as const,
      value: { by_official_id: {} },
    },
  };

  const jobRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/schedule-jobs`,
    payload: {
      idempotency_key: randomUUID(),
      expected_source_revision: schedWs.generation.source_revision,
      expected_capacity_revision: schedWs.generation.capacity_revision,
      objective: "balanced",
      constraints,
    },
    expectedStatuses: [202],
  });
  const job = jobRes.json<{ job: { id: string } }>();

  const optRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-jobs/${job.job.id}/options`,
    expectedStatuses: [200],
  });
  const options = optRes.json<unknown[]>();
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("Expected schedule options respecting official availability");
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: Infeasible venue capacity diagnostics (Zero 500s)
// ---------------------------------------------------------------------------
async function runScenario4(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "volleyball", "s4-infeasible");

  // Restrict capacity to only 1 court for 1 hour (available slots = 1)
  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/capacity`,
    payload: {
      revision: 2,
      areas: [
        {
          name: "Court 1",
          slot_minutes: 60,
          availability: [{ date: "2027-04-01", start_time: "09:00", end_time: "10:00" }],
        },
      ],
    },
    expectedStatuses: [200],
  });

  // Create format revision requiring 14 matches
  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "championship_focus")!;
  const formatRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/format-revisions`,
    payload: { definition: template.graph },
    expectedStatuses: [201],
  });
  const format = formatRes.json<{ id: string; definition_hash: string }>();

  // Attempt to publish format: MUST fail with 422 CAPACITY_INSUFFICIENT and zero 500s!
  const pubRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/format-revisions/${format.id}/publish`,
    payload: { definition_hash: format.definition_hash },
    expectedStatuses: [422],
  });

  const errBody = pubRes.json<{ error: { code: string; message: string } }>();
  if (errBody.error.code !== "CAPACITY_INSUFFICIENT") {
    throw new Error(`Expected CAPACITY_INSUFFICIENT, got ${errBody.error.code}`);
  }
  if (!errBody.error.message.toLowerCase().includes("capacity")) {
    throw new Error(`Expected diagnostic message to mention capacity: ${errBody.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5: Locks & schedule regenerations around locks
// ---------------------------------------------------------------------------
async function runScenario5(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "badminton", "s5-locks");
  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "compact_knockout")!;
  const { formatId } = await materializeAndPublishFormatOnly(ctx, comp.id, division.id, template.graph);

  // Generate draft schedule revision (status is 'draft', allowing locks)
  const schedRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/schedule-revisions/generate`,
    payload: { format_revision_id: formatId },
    expectedStatuses: [200],
  });
  const sched = schedRes.json<{ id: string; revision: number }>();

  // Read draft assignments via API
  const draftDetailRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-revisions/${sched.id}`,
    expectedStatuses: [200],
  });
  const draftDetail = draftDetailRes.json<{
    assignments: Array<{
      match_id: string;
      area_id: string;
      slot_id: string;
      start_epoch_ms: number;
      end_epoch_ms: number;
    }>;
  }>();

  if (draftDetail.assignments.length < 2) throw new Error("Expected at least 2 scheduled matches");
  const targetMatch = draftDetail.assignments[0]!;
  const otherMatch = draftDetail.assignments[1]!;

  // 1. Lock first match on draft revision via API
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${sched.id}/locks`,
    payload: {
      idempotency_key: randomUUID(),
      match_id: targetMatch.match_id,
      playing_area_id: targetMatch.area_id,
      start_epoch_ms: targetMatch.start_epoch_ms,
      end_epoch_ms: targetMatch.end_epoch_ms,
    },
    expectedStatuses: [200],
  });

  // 2. Schedule regeneration around locks via API
  const regenRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/schedule-revisions/generate`,
    payload: { format_revision_id: formatId },
    expectedStatuses: [200],
  });
  const regen = regenRes.json<{ id: string; revision: number }>();

  // 3. Test manual move validation (PR #98 fix):
  // Moving the locked match MUST be rejected with fixed_match_moved violation
  const moveLockedRes = await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${regen.id}/moves/validate`,
    payload: {
      match_id: targetMatch.match_id,
      playing_area_id: otherMatch.area_id,
      slot_id: otherMatch.slot_id,
      start_epoch_ms: otherMatch.start_epoch_ms,
      end_epoch_ms: otherMatch.end_epoch_ms,
    },
    expectedStatuses: [200],
  });
  const lockedValidation = moveLockedRes.json<{
    validation: { valid: boolean; violations: Array<{ code: string }> };
  }>();
  if (lockedValidation.validation.valid) {
    throw new Error("Expected moving a locked match to be invalid");
  }
  const hasFixedMatchViolation = lockedValidation.validation.violations.some((v) => v.code === "fixed_match_moved");
  if (!hasFixedMatchViolation) {
    throw new Error(
      `Expected fixed_match_moved violation, got ${JSON.stringify(lockedValidation.validation.violations)}`,
    );
  }

  // Moving an unlocked match to a valid vacant slot must be accepted
  const moveUnlockedRes = await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${regen.id}/moves/validate`,
    payload: {
      match_id: otherMatch.match_id,
      playing_area_id: otherMatch.area_id,
      slot_id: otherMatch.slot_id,
      start_epoch_ms: otherMatch.start_epoch_ms,
      end_epoch_ms: otherMatch.end_epoch_ms,
    },
    expectedStatuses: [200],
  });
  const unlockedValidation = moveUnlockedRes.json<{ validation: { valid: boolean } }>();
  if (!unlockedValidation.validation.valid) {
    throw new Error("Expected moving unlocked match in place to be valid");
  }

  // 4. Actually execute move on unlocked match via API (creates next revision)
  const executeMoveRes = await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${regen.id}/moves`,
    payload: {
      idempotency_key: randomUUID(),
      expected_revision: regen.revision,
      match_id: otherMatch.match_id,
      playing_area_id: otherMatch.area_id,
      slot_id: otherMatch.slot_id,
      start_epoch_ms: otherMatch.start_epoch_ms,
      end_epoch_ms: otherMatch.end_epoch_ms,
    },
    expectedStatuses: [201],
  });
  const moved = executeMoveRes.json<{ id: string; revision: number }>();

  // 5. Mark ready and publish the moved schedule revision
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${moved.id}/ready`,
    payload: { idempotency_key: randomUUID(), expected_revision: moved.revision },
    expectedStatuses: [200],
  });
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${moved.id}/publish`,
    payload: { idempotency_key: randomUUID(), expected_revision: moved.revision },
    expectedStatuses: [200],
  });
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
  if (playable.length === 0) throw new Error("No playable match for Scenario 6");

  // Read initial public truth via real route using slug
  const pubRes1 = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const initTruth = pubRes1.json<{ publication: { result_version: number } }>();
  const initialResultVersion = initTruth.publication.result_version;

  // Live scoring through HTTP API
  const writer = await scorer(ctx, comp.id, playable[0]!.id);
  await writer.append({ type: "match_started" });
  for (let pt = 0; pt < 25; pt++) {
    await writer.append({ type: "point", team_slot: "home", segment_number: 1 });
  }
  await writer.append({ type: "set_completion", team_slot: "home", segment_number: 1 });
  for (let pt = 0; pt < 25; pt++) {
    await writer.append({ type: "point", team_slot: "home", segment_number: 2 });
  }
  await writer.append({ type: "set_completion", team_slot: "home", segment_number: 2 });
  await writer.finalise();

  // Read public truth again: verify monotonic result version increase
  const pubRes2 = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const updatedTruth = pubRes2.json<{
    publication: { result_version: number };
    results: Array<{ match_id: string; state: string }>;
  }>();
  if (updatedTruth.publication.result_version <= initialResultVersion) {
    throw new Error(
      `Result version did not increase monotonically: was ${initialResultVersion}, now ${updatedTruth.publication.result_version}`,
    );
  }
  const matchResult = updatedTruth.results.find((r) => r.match_id === playable[0]!.id);
  if (!matchResult || matchResult.state !== "final") {
    throw new Error("Match result not published as final in public truth");
  }
}

// ---------------------------------------------------------------------------
// Scenario 7: Mid-day disruption / court closure
// ---------------------------------------------------------------------------
async function runScenario7(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "canoe_polo", "s7-disrupt");
  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "compact_knockout")!;
  const { formatId, sched } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

  const areas = await ctx.sql<{ id: string; name: string }[]>`
    SELECT id, name FROM playing_areas WHERE competition_id=${comp.id} ORDER BY name`;
  const court1 = areas.find((a) => a.name === "Court 1")!;
  const court2 = areas.find((a) => a.name === "Court 2")!;

  // Mid-day court closure: replace capacity with revision: 1, keeping both Court 1 and Court 2
  // so existing scheduled_matches foreign keys remain valid, but closing Court 2 (availability: [])
  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/capacity`,
    payload: {
      revision: 1,
      areas: [
        {
          id: court1.id,
          name: "Court 1",
          slot_minutes: 60,
          availability: [
            { date: "2027-04-01", start_time: "09:00", end_time: "18:00" },
            { date: "2027-04-02", start_time: "09:00", end_time: "18:00" },
          ],
        },
        {
          id: court2.id,
          name: "Court 2",
          slot_minutes: 60,
          availability: [],
        },
      ],
    },
    expectedStatuses: [200],
  });

  // Verify workspace detects stale input state following the capacity change
  const wsRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/schedule-workspace`,
    expectedStatuses: [200],
  });
  const ws = wsRes.json<{ current_revision_input_state: string }>();
  if (ws.current_revision_input_state !== "stale") {
    throw new Error(
      `Expected current_revision_input_state to be stale after capacity change, got ${ws.current_revision_input_state}`,
    );
  }

  // Re-plan schedule with updated capacity via real generate route
  const reSchedRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/schedule-revisions/generate`,
    payload: { format_revision_id: formatId },
    expectedStatuses: [200],
  });
  const reSched = reSchedRes.json<{ id: string; revision: number }>();

  // Mark ready and publish updated revision via real routes
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${reSched.id}/ready`,
    payload: { idempotency_key: randomUUID(), expected_revision: reSched.revision },
    expectedStatuses: [200],
  });
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${reSched.id}/publish`,
    payload: { idempotency_key: randomUUID(), expected_revision: reSched.revision },
    expectedStatuses: [200],
  });

  // Verify public projection no longer schedules matches on Court 2
  const pubRes = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const pub = pubRes.json<{ schedule: Array<{ playing_area_id: string }> }>();
  if (pub.schedule.length === 0) {
    throw new Error("Expected scheduled matches in public projection after replan");
  }
  const court2Matches = pub.schedule.filter((s) => s.playing_area_id === court2.id);
  if (court2Matches.length > 0) {
    throw new Error(`Public schedule still contains ${court2Matches.length} matches on closed Court 2`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 8: Withdrawals & walkovers (Standings & bracket advancement)
// ---------------------------------------------------------------------------
async function runScenario8(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "badminton", "s8-withdraw");
  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "compact_knockout")!;
  const { formatId } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

  const playable = await ctx.sql<{ id: string; home_entry_id: string; away_entry_id: string }[]>`
    SELECT id, home_entry_id, away_entry_id FROM matches
    WHERE format_revision_id=${formatId} AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
    ORDER BY ordinal LIMIT 1`;
  if (playable.length === 0) throw new Error("No playable match for Scenario 8");
  const targetMatch = playable[0]!;

  // 1. Record walkover: away team wins
  await walkover(ctx, comp.id, targetMatch.id, "away");

  // 2. Withdraw the losing home entry via lifecycle endpoint
  await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/entries/${targetMatch.home_entry_id}/lifecycle`,
    payload: { action: "withdraw", reason: "Sprained ankle" },
    expectedStatuses: [200],
  });

  // 3. Recalculate standings via real API route
  await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/standings/recalculate`,
    expectedStatuses: [200],
  });

  // 4. Assert standings reflect forfeit and withdrawal
  const standingsRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/standings`,
    expectedStatuses: [200],
  });
  const standings = standingsRes.json<{
    standings: unknown;
    advancement_slots: Array<{ match_id: string; entry_id: string | null }>;
  }>();
  if (!standings || !standings.standings) throw new Error("Standings missing after recalculate");

  const hasAdvancedWinner = standings.advancement_slots?.some((s) => s.entry_id === targetMatch.away_entry_id);
  if (!hasAdvancedWinner) {
    throw new Error("Walkover winner was not advanced in division advancement slots");
  }

  // Verify winning away team advanced into knockout match in database
  const advancedMatches = await ctx.sql<{ id: string; home_entry_id: string | null; away_entry_id: string | null }[]>`
    SELECT id, home_entry_id, away_entry_id FROM matches
    WHERE format_revision_id=${formatId} AND (home_entry_id=${targetMatch.away_entry_id} OR away_entry_id=${targetMatch.away_entry_id})`;
  if (advancedMatches.length < 2) {
    throw new Error("Walkover winner was not advanced to downstream knockout match");
  }
}

// ---------------------------------------------------------------------------
// Scenario 9: AI feature boundaries & quota checks
// ---------------------------------------------------------------------------
async function runScenario9(ctx: SimContext): Promise<void> {
  const { comp } = await createStandardTournament(ctx, "basketball", "s9-ai");

  // 1. Resume setup draft to ensure draft exists
  const resumeRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/setup-draft/resume`,
    payload: { idempotency_key: randomUUID() },
    expectedStatuses: [200],
  });
  const draft = resumeRes.json<{ revision: number }>();

  // 2. Set format_preferences on the setup draft so recommendV1Format has required preferences
  await ctx.request({
    method: "PATCH",
    url: `/api/v1/competitions/${comp.id}/setup-draft`,
    payload: {
      expected_revision: draft.revision,
      idempotency_key: randomUUID(),
      step: {
        step_id: "format_preferences",
        value: {
          minimum_matches: { per_entry: 1 },
          ranking: { rank_all_entries: false },
          knockout: { required: true },
          placement: { required: false },
          qualification: { cross_group_allowed: true },
          priority: { value: "speed" },
        },
      },
    },
    expectedStatuses: [200],
  });

  // 3. Read rules-based format recommendations via API
  const recRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/v1-format-recommendations`,
    payload: { idempotency_key: randomUUID() },
    expectedStatuses: [200],
  });
  const recDoc = recRes.json<{
    values: {
      format_recommendations?: {
        recommendations: Array<{ id: string; name: string }>;
      };
    };
  }>();
  const recs = recDoc.values?.format_recommendations?.recommendations;
  if (!Array.isArray(recs) || recs.length === 0) {
    throw new Error("Expected rules-based format recommendations in setup document");
  }

  // 4. Read AI usage & quota boundaries via API
  const usageRes = await ctx.request({
    method: "GET",
    url: `/api/v1/organisations/${ctx.organisationId}/ai/usage`,
    expectedStatuses: [200],
  });
  const usage = usageRes.json<{ organisation_id: string; actions: unknown[] }>();
  if (usage.organisation_id !== ctx.organisationId) {
    throw new Error("AI usage organisation ID mismatch");
  }

  // 5. Call AI competition-brief via API (exercises quota check, ledger, and fallback boundaries)
  const briefRes = await ctx.request({
    method: "POST",
    url: `/api/v1/organisations/${ctx.organisationId}/ai/competition-brief`,
    payload: {
      idempotency_key: randomUUID(),
      text: "Basketball tournament for 8 teams over 2 days with 2 pools and championship finals",
      competition_id: comp.id,
    },
    expectedStatuses: [200],
  });
  const brief = briefRes.json<{
    status: string;
    usage?: { actions: Array<{ action: string; remaining_units: number }> };
  }>();
  if (!brief || !brief.status) throw new Error("AI competition brief returned empty response");
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

  console.log(`\n${col.cyan("====================================================================")}`);
  console.log(`${col.cyan("   MATCHDAY TOURNAMENT SIMULATION HARNESS (Track R1 Baseline)       ")}`);
  console.log(`${col.cyan(`   Profile: ${profile.toUpperCase()} | 5xx Budget: ZERO allowed   `)}`);
  console.log(`${col.cyan("====================================================================")}\n`);

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
    undefined,
    {
      writePublicProjection: async (tx, comp, schedVer, resVer, opts) =>
        phase2.writePublicProjection(tx, comp, schedVer, resVer, opts),
    },
  );

  const publicTruthRuntime = new GateCC4PublicTruthRuntime(sql as unknown as PostgresJsSql);

  const app = await buildApp({
    config: testConfig({ DATABASE_URL: databaseUrl }),
    probes: healthyProbes,
    phase2Runtime: phase2,
    phase3Runtime: phase3,
    phase4Runtime: phase4,
    gateCC4PublicTruthRuntime: publicTruthRuntime,
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
    } as unknown as any,
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
        console.log(`${col.green("PASS")} (${durationMs}ms, ${reqCount} reqs)`);
      } catch (err: unknown) {
        allPassed = false;
        const durationMs = Date.now() - start;
        const reqCount = requestStats.total - startReqs;
        results.push({
          scenarioNumber: sc.number,
          name: sc.name,
          passed: false,
          durationMs,
          requestCount: reqCount,
          error: err as Error,
        });
        console.log(`${col.red("FAIL")} (${durationMs}ms)`);
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
  console.log(`\n${col.cyan("====================================================================")}`);
  console.log(`${col.cyan("                      SIMULATION EXECUTION SUMMARY                  ")}`);
  console.log(`${col.cyan("====================================================================")}`);
  for (const r of results) {
    const mark = r.passed ? col.green("✓") : col.red("✗");
    console.log(
      ` ${mark} Scenario ${r.scenarioNumber}: ${r.name.padEnd(45)} | ${String(r.durationMs).padStart(5)}ms | ${r.requestCount} reqs`,
    );
  }

  console.log(`\nTotal HTTP requests: ${requestStats.total}`);
  console.log(`Status distribution: ${JSON.stringify(requestStats.byStatus)}`);

  // 5xx Budget Check
  if (requestStats.fiveHundredErrors.length > 0) {
    console.error(
      `\n${col.red(`FAILED: 5xx Error Budget Exceeded! Found ${requestStats.fiveHundredErrors.length} server errors:`)}`,
    );
    for (const e of requestStats.fiveHundredErrors) {
      console.error(`  - ${e.method} ${e.url} -> ${e.status}: ${e.body.slice(0, 200)}`);
    }
    process.exit(1);
  }

  if (!allPassed) {
    console.error(`\n${col.red("FAILED: One or more simulation scenarios failed.")}`);
    process.exit(1);
  }

  console.log(`\n${col.green("SUCCESS: All tournament simulation scenarios passed with ZERO 5xx errors.")}\n`);
}

main().catch((err) => {
  console.error("Tournament simulation failed fatally:", err);
  process.exit(1);
});
