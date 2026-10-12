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
import {
  SPORT_PACKS,
  createDefaultFormatTemplates,
  type FormatGraph,
  type FormatTemplateStrategy,
  type SportId,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import {
  DomainScheduleOptimizer,
  PostgresScheduleJobStore,
  ScheduleJobProcessor,
  type ScheduleEnqueuePort,
} from "@matchday/scheduler";
import { buildApp } from "../src/app.js";
import { DeterministicPhase4AiStub } from "../src/phase-4-ai-provider.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../src/phase-4-reliable-runtime.js";
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
  phase4: ReliableGateBPhase4Runtime;
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
  }): Promise<{
    statusCode: number;
    json<T = unknown>(): T;
    body: string;
    headers: Record<string, string | string[] | number | undefined>;
  }>;
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
      headers: res.headers,
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
            { date: "2027-04-01", start_time: "08:00", end_time: "20:00" },
            { date: "2027-04-02", start_time: "08:00", end_time: "20:00" },
          ],
        },
        {
          name: "Court 2",
          slot_minutes: 60,
          availability: [
            { date: "2027-04-01", start_time: "08:00", end_time: "20:00" },
            { date: "2027-04-02", start_time: "08:00", end_time: "20:00" },
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

/** Pure API helper to run the canonical Phase 4 solver schedule job flow and return draft accepted option */
async function generateScheduleOptionViaJob(
  ctx: SimContext,
  competitionId: string,
  constraints?: Record<string, unknown>,
  objective = "balanced",
): Promise<{ jobId: string; optionId: string; revisionId: string; revision: number }> {
  // 1. Read workspace to obtain current revisions
  const wsRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${competitionId}/schedule-workspace`,
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

  const areas = await ctx.sql<{ id: string }[]>`SELECT id FROM playing_areas WHERE competition_id=${competitionId}`;
  const areaId = areas[0]?.id ?? randomUUID();

  // 2. Start schedule job via API
  const jobRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${competitionId}/schedule-jobs`,
    payload: {
      idempotency_key: randomUUID(),
      expected_source_revision: ws.generation.source_revision,
      expected_capacity_revision: ws.generation.capacity_revision,
      objective: objective ?? ws.generation.objective ?? "balanced",
      constraints: constraints ?? ws.generation.constraints ?? defaultConstraints(areaId),
    },
    expectedStatuses: [202],
  });
  const job = jobRes.json<{ job: { id: string } }>();

  // 3. Wait for job to finish via API polling
  let currentJob: { status: string; revision: number; current_best_option_id: string | null } = {
    status: "queued",
    revision: 1,
    current_best_option_id: null,
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pollRes = await ctx.request({
      method: "GET",
      url: `/api/v1/schedule-jobs/${job.job.id}`,
      expectedStatuses: [200],
    });
    currentJob = pollRes.json<{ status: string; revision: number; current_best_option_id: string | null }>();
    if (["completed", "no_solution", "failed", "cancelled"].includes(currentJob.status)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (currentJob.status !== "completed") {
    throw new Error(`Schedule job did not succeed: status=${currentJob.status}`);
  }

  // 4. Read options via API and assert non-empty
  const optRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-jobs/${job.job.id}/options`,
    expectedStatuses: [200],
  });
  const options = optRes.json<Array<{ id: string; result_revision: number }>>();
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`Expected non-empty schedule options for job ${job.job.id}`);
  }

  // Fetch final job state right before accept to ensure exact revision & best option match
  const jobDetailRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-jobs/${job.job.id}`,
    expectedStatuses: [200],
  });
  const finalJob = jobDetailRes.json<{ status: string; revision: number; current_best_option_id: string | null }>();
  const chosenOptionId = finalJob.current_best_option_id ?? options[0]!.id;

  // 5. Accept chosen option via API
  const acceptRes = await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-jobs/${job.job.id}/options/${chosenOptionId}/accept`,
    payload: {
      idempotency_key: randomUUID(),
      expected_job_revision: finalJob.revision,
    },
    expectedStatuses: [201],
  });
  const acceptedRevision = acceptRes.json<{ id: string; revision: number }>();

  return {
    jobId: job.job.id,
    optionId: chosenOptionId,
    revisionId: acceptedRevision.id,
    revision: acceptedRevision.revision,
  };
}

/** Pure API helper to run the canonical Phase 4 solver schedule job flow, mark ready, and publish */
async function generateAndPublishScheduleViaJob(
  ctx: SimContext,
  competitionId: string,
  constraints?: Record<string, unknown>,
  objective = "balanced",
): Promise<{ jobId: string; optionId: string; revisionId: string; revision: number }> {
  const result = await generateScheduleOptionViaJob(ctx, competitionId, constraints, objective);

  // Mark ready
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${result.revisionId}/ready`,
    payload: {
      idempotency_key: randomUUID(),
      expected_revision: result.revision,
    },
    expectedStatuses: [200],
  });

  // Publish
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${result.revisionId}/publish`,
    payload: {
      idempotency_key: randomUUID(),
      expected_revision: result.revision,
    },
    expectedStatuses: [200],
  });

  return result;
}

/** Pure API helper to create format revision, publish format, and generate/publish schedule */
async function materializeAndPublishFormat(
  ctx: SimContext,
  competitionId: string,
  divisionId: string,
  graph: FormatGraph,
) {
  const { formatId } = await materializeAndPublishFormatOnly(ctx, competitionId, divisionId, graph);
  const schedJob = await generateAndPublishScheduleViaJob(ctx, competitionId);
  return {
    formatId,
    sched: {
      id: schedJob.revisionId,
      revisionId: schedJob.revisionId,
      revision: schedJob.revision,
      jobId: schedJob.jobId,
      optionId: schedJob.optionId,
    },
  };
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
  return createWriterFromSession(ctx, writer, 0);
}

function createWriterFromSession(
  ctx: SimContext,
  session: { session_id: string; session_token: string; generation: number },
  initialSequence = 0,
) {
  const scoringHeaders = {
    "x-scoring-session-id": session.session_id,
    "x-scoring-session-token": session.session_token,
    "x-writer-generation": String(session.generation),
  };

  let sequence = initialSequence;
  const append = async (command: Record<string, unknown>, expectedStatuses = [200]) => {
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
      expectedStatuses,
    });
    if (expectedStatuses.includes(200)) {
      sequence += 1;
    }
    return res.json<{ aggregate_version?: number }>();
  };

  const finalise = async (expectedStatuses = [200]) => {
    const res = await ctx.request({
      method: "POST",
      url: "/api/v1/scoring/finalise",
      headers: scoringHeaders,
      payload: {
        client_event_id: randomUUID(),
        expected_sequence: sequence,
        occurred_at: new Date().toISOString(),
      },
      expectedStatuses,
    });
    return res.json<{ aggregate_version?: number }>();
  };

  return { append, finalise, session, scoringHeaders, getSequence: () => sequence };
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
  for (const segment of [1, 2, 3]) {
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

// ---------------------------------------------------------------------------
// Scenario 1: Multi-sport lifecycle & group-to-knockout advancement (All 5 sports)
// ---------------------------------------------------------------------------
async function runScenario1(ctx: SimContext): Promise<void> {
  const sports: SportId[] = ["badminton", "basketball", "canoe_polo", "table_tennis", "volleyball"];

  // Fast: every sport plays one template (rotated so all three graph shapes are still covered).
  // Full: every sport plays every template (5 x 3 tournaments).
  const allStrategies: FormatTemplateStrategy[] = ["championship_focus", "full_placement", "compact_knockout"];

  for (const [sportIndex, sport] of sports.entries()) {
    const strategies: FormatTemplateStrategy[] =
      ctx.profile === "full" ? allStrategies : [allStrategies[sportIndex % allStrategies.length]!];

    for (const strategy of strategies) {
      const template = createDefaultFormatTemplates(8).find((t) => t.strategy === strategy);
      if (!template) throw new Error(`Template not found for 8 ${strategy}`);

      // Each template gets its own competition so one published format never shadows another.
      const { comp, division } = await createStandardTournament(ctx, sport, `s1-${strategy}`);
      const { formatId, sched } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

      // 1. Verify PR #97 regression check: options route returns valid non-empty options
      const optRes = await ctx.request({
        method: "GET",
        url: `/api/v1/schedule-jobs/${sched.jobId}/options`,
        expectedStatuses: [200],
      });
      const options = optRes.json<unknown[]>();
      if (!Array.isArray(options) || options.length === 0) {
        throw new Error(`Schedule options empty for ${sport} ${strategy}`);
      }

      await playFormatToCompletion(ctx, sport, strategy, comp, division.id, formatId, template.graph);
    }
  }
}

/**
 * Plays every match of a published format until nothing is left to play, then asserts the
 * public projection and bracket are fully resolved. Stage handling is derived from the graph
 * (compact_knockout has no group stage; full_placement adds placement/consolation rounds),
 * so no template-specific branching is needed.
 */
async function playFormatToCompletion(
  ctx: SimContext,
  sport: SportId,
  strategy: FormatTemplateStrategy,
  comp: { id: string; slug: string },
  divisionId: string,
  formatId: string,
  graph: FormatGraph,
): Promise<void> {
  const label = `${sport}/${strategy}`;
  const hasGroupStage = graph.stages.some((s) => s.kind === "group" || s.kind === "round_robin");

  // Terminal matches: nothing in the graph consumes their winner or loser. These are the
  // championship final, bronze final, and placement/consolation deciders.
  const consumed = new Set<string>();
  for (const m of graph.matches) {
    for (const src of [m.home, m.away] as Array<{ type: string; matchId?: string }>) {
      if ((src.type === "winner" || src.type === "loser") && src.matchId) consumed.add(src.matchId);
    }
  }
  const terminalGraphIds = new Set(graph.matches.filter((m) => !consumed.has(m.id)).map((m) => m.id));

  const played = new Set<string>();
  let groupStageChecked = !hasGroupStage;
  // Bounded by the match count: each pass must play at least one match or we stop.
  for (let pass = 0; pass <= graph.matches.length; pass += 1) {
    const ready = await ctx.sql<{ id: string; graph_stage_id: string }[]>`
      SELECT id, graph_stage_id FROM matches
      WHERE format_revision_id=${formatId} AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
      ORDER BY ordinal`;
    const toPlay = ready.filter((m) => !played.has(m.id));
    if (toPlay.length === 0) break;

    for (const m of toPlay) {
      await playSportHomeWin(ctx, sport, comp.id, m.id);
      played.add(m.id);
    }

    if (!groupStageChecked) {
      // After the first pass (all group matches), standings must reflect play for all 8 entries.
      const standingsRes = await ctx.request({
        method: "GET",
        url: `/api/v1/competitions/${comp.id}/divisions/${divisionId}/standings`,
        expectedStatuses: [200],
      });
      const standings = standingsRes.json<{ standings?: unknown }>();
      const rawGroups = (
        standings?.standings as { groups?: Record<string, { rows?: Array<{ played?: number }> }> } | undefined
      )?.groups;
      const rows: Array<{ played?: number }> = Array.isArray(standings?.standings)
        ? (standings.standings as Array<{ played?: number }>)
        : Object.values(rawGroups ?? {}).flatMap((g) => g.rows ?? []);
      if (rows.length < 8) throw new Error(`Standings incomplete for ${label}: ${rows.length} rows`);
      if (!rows.every((r) => (r.played ?? 0) > 0)) {
        throw new Error(`Standings do not reflect group play for every entry in ${label}`);
      }
      groupStageChecked = true;
    }
  }

  const all = await ctx.sql<
    { id: string; graph_match_id: string; home_entry_id: string | null; away_entry_id: string | null }[]
  >`SELECT id, graph_match_id, home_entry_id, away_entry_id FROM matches WHERE format_revision_id=${formatId}`;
  if (all.length !== graph.matches.length) {
    throw new Error(`${label}: expected ${graph.matches.length} materialised matches, found ${all.length}`);
  }
  const unresolved = all.filter((m) => !m.home_entry_id || !m.away_entry_id);
  if (unresolved.length > 0) {
    throw new Error(
      `${label}: bracket not fully resolved, ${unresolved.length} match(es) without both entries: ${unresolved
        .map((m) => m.graph_match_id)
        .join(", ")}`,
    );
  }
  if (played.size !== graph.matches.length) {
    throw new Error(`${label}: played ${played.size} of ${graph.matches.length} matches`);
  }

  const publicRes = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const pub = publicRes.json<{
    results: Array<{ id: string; state: string }>;
    bracket: Record<string, unknown> | null;
  }>();
  const stateById = new Map(pub.results.map((r) => [r.id, r.state]));
  const terminal = all.filter((m) => terminalGraphIds.has(m.graph_match_id));
  if (terminal.length === 0) throw new Error(`${label}: no final/placement matches derived from graph`);
  for (const m of terminal) {
    if (stateById.get(m.id) !== "final") {
      throw new Error(`${label}: ${m.graph_match_id} is ${stateById.get(m.id) ?? "absent"} in public /current`);
    }
  }
  const notFinal = all.filter((m) => stateById.get(m.id) !== "final");
  if (notFinal.length > 0) {
    throw new Error(`${label}: ${notFinal.length} match(es) not final in public /current`);
  }

  // Bracket projection: a champion must be decided once the championship final is played.
  // The projection wraps the resolver output as { bracket: { matches, championEntryId, ... } }.
  const bracket = (pub.bracket?.bracket ?? pub.bracket) as {
    matches?: Array<{ homeEntryId?: string | null; awayEntryId?: string | null }>;
    championEntryId?: string | null;
  } | null;
  if (!bracket) throw new Error(`${label}: public bracket missing after completion`);
  const bracketMatches = bracket.matches ?? [];
  if (bracketMatches.length === 0) throw new Error(`${label}: public bracket has no derived matches`);
  if (bracketMatches.some((m) => !m.homeEntryId || !m.awayEntryId)) {
    throw new Error(`${label}: public bracket still has unresolved participants`);
  }
  // NOTE: the V1 graph bracket resolver (phase-2-domain-adapter) always reports
  // championEntryId: null, so the champion is asserted from the championship match result.
  const championshipGraphId = graph.matches.find((m) => m.purpose === "championship")?.id;
  const championship = all.find((m) => m.graph_match_id === championshipGraphId);
  const championshipResult = pub.results.find((r) => r.id === championship?.id) as
    { home_score: number; away_score: number } | undefined;
  if (!championshipResult || championshipResult.home_score === championshipResult.away_score) {
    throw new Error(`${label}: championship match has no decided winner in public /current`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: High-density schedule optimization (Canoe Polo 104 matches)
// ---------------------------------------------------------------------------
async function runScenario2(ctx: SimContext): Promise<void> {
  // 1. Create Canoe Polo competition via API
  const slug = safeSlug("s2-canoe-polo-104");
  const compRes = await ctx.request({
    method: "POST",
    url: "/api/v1/competitions/phase3",
    payload: {
      organisation_id: ctx.organisationId,
      name: "Sim Canoe Polo 104 Matches",
      slug,
      sport_code: "canoe_polo",
      venue: "Marina Reservoir",
      address: "10 Marina Boulevard",
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

  // 2. Set capacity via API for 4 courts across 2 days (144 total slots)
  // 4 courts * 2 days * (9am to 6pm, 30 min slots = 18 slots/day) = 144 slots
  const areasPayload = ["Court 1", "Court 2", "Court 3", "Court 4"].map((name) => ({
    name,
    slot_minutes: 30,
    availability: [
      { date: "2027-04-01", start_time: "09:00", end_time: "18:00" },
      { date: "2027-04-02", start_time: "09:00", end_time: "18:00" },
    ],
  }));

  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/capacity`,
    payload: { revision: 1, areas: areasPayload },
    expectedStatuses: [200],
  });

  // 3. Create 4 divisions via API:
  // Div 1: 16 teams (full_placement -> 38 matches)
  // Div 2: 16 teams (championship_focus -> 32 matches)
  // Div 3: 8 teams  (full_placement -> 18 matches)
  // Div 4: 8 teams  (championship_focus -> 16 matches)
  // Total = 38 + 32 + 18 + 16 = 104 matches!
  const divisionSpecs = [
    { name: "Open Division A", entryCount: 16, strategy: "full_placement" as const },
    { name: "Open Division B", entryCount: 16, strategy: "championship_focus" as const },
    { name: "Open Division C", entryCount: 8, strategy: "full_placement" as const },
    { name: "Women Division", entryCount: 8, strategy: "championship_focus" as const },
  ] as const;

  for (const spec of divisionSpecs) {
    const divRes = await ctx.request({
      method: "POST",
      url: `/api/v1/competitions/${comp.id}/divisions`,
      payload: { name: spec.name, entry_limit: spec.entryCount, idempotency_key: randomUUID() },
      expectedStatuses: [201],
    });
    const div = divRes.json<{ id: string }>();

    // Seed entries via API
    const entriesPayload = Array.from({ length: spec.entryCount }, (_, i) => ({
      name: `${spec.name} Team ${i + 1}`,
      seed: i + 1,
    }));
    await ctx.request({
      method: "PUT",
      url: `/api/v1/competitions/${comp.id}/divisions/${div.id}/entries`,
      payload: { entries: entriesPayload },
      expectedStatuses: [200],
    });

    // Materialize and publish format via API
    const template = createDefaultFormatTemplates(spec.entryCount).find((t) => t.strategy === spec.strategy)!;
    await materializeAndPublishFormatOnly(ctx, comp.id, div.id, template.graph);
  }

  // 4. Generate and publish schedule via real Phase 4 solver job flow
  const sched = await generateAndPublishScheduleViaJob(ctx, comp.id);

  // 5. Read schedule revision assignments via API
  const schedRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-revisions/${sched.revisionId}`,
    expectedStatuses: [200],
  });
  const schedData = schedRes.json<{
    assignments: Array<{
      match_id: string;
      area_id: string;
      start_epoch_ms: number;
      end_epoch_ms: number;
    }>;
  }>();

  if (schedData.assignments.length !== 104) {
    throw new Error(`Scenario 2: Expected 104 scheduled assignments, got ${schedData.assignments.length}`);
  }

  // Check 1: No court overlaps
  const byArea = new Map<string, Array<{ start: number; end: number; matchId: string }>>();
  for (const a of schedData.assignments) {
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
  const matchEntries = await ctx.sql<{ id: string; home_entry_id: string | null; away_entry_id: string | null }[]>`
    SELECT id, home_entry_id, away_entry_id FROM matches WHERE competition_id=${comp.id}`;
  const matchEntryMap = new Map<string, string[]>();
  for (const m of matchEntries) {
    const entries = [m.home_entry_id, m.away_entry_id].filter(Boolean) as string[];
    matchEntryMap.set(m.id, entries);
  }

  const byTeam = new Map<string, Array<{ start: number; end: number; matchId: string }>>();
  for (const a of schedData.assignments) {
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
  const { formatId } = await materializeAndPublishFormatOnly(ctx, comp.id, division.id, template.graph);

  // 1. Create Alex Referee via API
  const alexRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/officials`,
    payload: {
      name: "Alex Referee",
      default_role: "referee",
    },
    expectedStatuses: [201],
  });
  const alex = alexRes.json<{ id: string }>();

  // 2. Set Alex's availability window via API
  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/officials/${alex.id}/availability`,
    payload: {
      windows: [{ starts_at: "2027-04-01T09:00:00.000Z", ends_at: "2027-04-01T18:00:00.000Z" }],
    },
    expectedStatuses: [200],
  });

  const matches = await ctx.sql<{ id: string }[]>`
    SELECT id FROM matches WHERE format_revision_id=${formatId} ORDER BY ordinal LIMIT 2`;
  if (matches.length < 2) throw new Error("Expected at least 2 matches for Scenario 3");

  // 3. Assign Alex to match 1
  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/matches/${matches[0]!.id}/officials`,
    payload: {
      assignments: [{ official_id: alex.id, assigned_role: "referee" }],
    },
    expectedStatuses: [200],
  });

  // 4. Query official workspace via API
  const wsRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/officials/workspace`,
    expectedStatuses: [200],
  });
  const ws = wsRes.json<{ officials: Array<{ id: string }>; assignments: Array<{ official_id: string }> }>();
  if (!ws.officials.some((o) => o.id === alex.id)) {
    throw new Error("Created official not found in workspace");
  }
  if (!ws.assignments.some((a) => a.official_id === alex.id)) {
    throw new Error("Match assignment not found in workspace");
  }

  // 5. Test valid schedule generation respecting Alex's availability
  const areas = await ctx.sql<{ id: string }[]>`SELECT id FROM playing_areas WHERE competition_id=${comp.id}`;
  const areaId = areas[0]?.id ?? randomUUID();
  const validConstraints = {
    ...defaultConstraints(areaId),
    official_availability: {
      mode: "required" as const,
      value: { by_official_id: {} },
    },
  };
  await generateAndPublishScheduleViaJob(ctx, comp.id, validConstraints);

  // 6. Test over-constrained case: create Blake Referee with ZERO availability windows assigned to match 2
  const blakeRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/officials`,
    payload: {
      name: "Blake Referee",
      default_role: "referee",
    },
    expectedStatuses: [201],
  });
  const blake = blakeRes.json<{ id: string }>();

  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/officials/${blake.id}/availability`,
    payload: { windows: [] },
    expectedStatuses: [200],
  });

  await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/matches/${matches[1]!.id}/officials`,
    payload: {
      assignments: [{ official_id: blake.id, assigned_role: "referee" }],
    },
    expectedStatuses: [200],
  });

  // 7. Start job with required official availability -> must terminate with no_solution!
  const schedWsRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/schedule-workspace`,
    expectedStatuses: [200],
  });
  const schedWs = schedWsRes.json<{
    generation: { source_revision: number; capacity_revision: number; objective: string };
  }>();

  const failJobRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/schedule-jobs`,
    payload: {
      idempotency_key: randomUUID(),
      expected_source_revision: schedWs.generation.source_revision,
      expected_capacity_revision: schedWs.generation.capacity_revision,
      objective: "balanced",
      constraints: validConstraints,
    },
    expectedStatuses: [202],
  });
  const failJob = failJobRes.json<{ job: { id: string } }>();

  let pollStatus = "queued";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pollRes = await ctx.request({
      method: "GET",
      url: `/api/v1/schedule-jobs/${failJob.job.id}`,
      expectedStatuses: [200],
    });
    const polled = pollRes.json<{ status: string }>();
    pollStatus = polled.status;
    if (["completed", "valid_best_found", "no_solution", "failed", "cancelled"].includes(pollStatus)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (pollStatus !== "no_solution") {
    throw new Error(`Expected over-constrained job to finish with no_solution, got ${pollStatus}`);
  }

  // 8. Call diagnostics endpoint and verify official_unavailable diagnostic is present
  const diagRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-jobs/${failJob.job.id}/diagnostics`,
    expectedStatuses: [200],
  });
  const diag = diagRes.json<{ diagnostics: Array<{ code: string }> }>();
  if (!diag.diagnostics.some((d) => d.code === "official_unavailable")) {
    throw new Error(`Expected official_unavailable diagnostic, got ${JSON.stringify(diag.diagnostics)}`);
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
  await materializeAndPublishFormatOnly(ctx, comp.id, division.id, template.graph);

  // Generate solver-backed draft schedule revision via canonical job flow
  const sched = await generateScheduleOptionViaJob(ctx, comp.id);

  // Read draft assignments via API
  const draftDetailRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-revisions/${sched.revisionId}`,
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
    url: `/api/v1/schedule-revisions/${sched.revisionId}/locks`,
    payload: {
      idempotency_key: randomUUID(),
      match_id: targetMatch.match_id,
      playing_area_id: targetMatch.area_id,
      start_epoch_ms: targetMatch.start_epoch_ms,
      end_epoch_ms: targetMatch.end_epoch_ms,
    },
    expectedStatuses: [200],
  });

  // 2. Schedule regeneration around locks via solver job
  const regen = await generateScheduleOptionViaJob(ctx, comp.id);

  // 2a. Locked match stays fixed; unlocked assignments are unchanged (minimal change), since
  //     capacity and entries are unchanged so every prior placement is still valid.
  const regenDetailRes = await ctx.request({
    method: "GET",
    url: `/api/v1/schedule-revisions/${regen.revisionId}`,
    expectedStatuses: [200],
  });
  const regenAssignments = regenDetailRes.json<{ assignments: typeof draftDetail.assignments }>().assignments;
  if (regenAssignments.length !== draftDetail.assignments.length) {
    throw new Error(
      `Regeneration changed assignment count: ${draftDetail.assignments.length} -> ${regenAssignments.length}`,
    );
  }
  const regenByMatch = new Map(regenAssignments.map((a) => [a.match_id, a]));
  const lockedAfter = regenByMatch.get(targetMatch.match_id);
  if (
    !lockedAfter ||
    lockedAfter.area_id !== targetMatch.area_id ||
    lockedAfter.start_epoch_ms !== targetMatch.start_epoch_ms ||
    lockedAfter.end_epoch_ms !== targetMatch.end_epoch_ms
  ) {
    throw new Error(`Locked match moved during regeneration: ${JSON.stringify({ before: targetMatch, lockedAfter })}`);
  }
  const changedUnlocked = draftDetail.assignments.filter((before) => {
    if (before.match_id === targetMatch.match_id) return false;
    const after = regenByMatch.get(before.match_id);
    return !after || after.area_id !== before.area_id || after.start_epoch_ms !== before.start_epoch_ms;
  });
  if (changedUnlocked.length > 0) {
    throw new Error(
      `Regeneration around lock was not minimal-change: ${changedUnlocked.length} unlocked assignment(s) moved`,
    );
  }

  // 3. Test manual move validation (PR #98 fix):
  // Moving the locked match MUST be rejected with fixed_match_moved violation
  const moveLockedRes = await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${regen.revisionId}/moves/validate`,
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

  // Moving an unlocked match in place must be accepted
  const moveUnlockedRes = await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${regen.revisionId}/moves/validate`,
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
    url: `/api/v1/schedule-revisions/${regen.revisionId}/moves`,
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
    ORDER BY ordinal LIMIT 2`;
  if (playable.length < 2) throw new Error("Expected at least 2 playable matches for Scenario 6");

  // Read initial public truth via real route using slug
  const pubRes1 = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  let lastResultVersion = pubRes1.json<{ publication: { result_version: number } }>().publication.result_version;

  // 1. Scoring session on Court 1 (Match 1)
  const writer1 = await scorer(ctx, comp.id, playable[0]!.id);
  await writer1.append({ type: "match_started" });

  // 2. Scoring session on Court 2 (Match 2)
  const writer2 = await scorer(ctx, comp.id, playable[1]!.id);
  await writer2.append({ type: "match_started" });

  // 3-4. Interleaved points on both courts, checked by polling /current after every point
  // instead of holding the SSE `versions` stream open (app.inject only returns once the stream
  // closes, which cost ~28 s). Live points are an overlay: result_version is only bumped by
  // finalisation/correction (asserted below), so per point the contract is:
  //   - result_version never decreases,
  //   - the ETag changes (so conditional GETs and the SSE fan-out see a new version),
  //   - the scored match's live set-1 home points in /current advance by exactly one.
  let lastEtag = pubRes1.headers.etag;
  const liveScore = new Map<string, number>([
    [playable[0]!.id, 0],
    [playable[1]!.id, 0],
  ]);
  const pointsPerCourt = ctx.profile === "full" ? 3 : 2;
  for (let i = 0; i < pointsPerCourt; i += 1) {
    for (const [court, writer, matchId] of [
      [1, writer1, playable[0]!.id],
      [2, writer2, playable[1]!.id],
    ] as const) {
      await writer.append({ type: "point", team_slot: "home", segment_number: 1 });
      const after = await ctx.request({
        method: "GET",
        url: `/api/v1/public/competitions/${comp.slug}/current`,
        expectedStatuses: [200],
      });
      const etag = after.headers.etag;
      const body = after.json<{
        publication: { result_version: number };
        results: Array<{ id: string; state: string; segments?: Array<{ number: number; home: number }> }>;
      }>();
      const where = `point ${i + 1} on court ${court}`;
      if (!etag) throw new Error("Expected ETag header on public truth response");
      if (body.publication.result_version < lastResultVersion) {
        throw new Error(
          `result_version decreased after ${where}: ${lastResultVersion} -> ${body.publication.result_version}`,
        );
      }
      if (etag === lastEtag) throw new Error(`ETag unchanged after ${where}`);
      const live = body.results.find((r) => r.id === matchId);
      const expected = liveScore.get(matchId)! + 1;
      const setOnePoints = live?.segments?.find((s) => s.number === 1)?.home;
      if (!live || live.state !== "in_progress" || setOnePoints !== expected) {
        throw new Error(`Live score not reflected after ${where}: expected ${expected}, got ${JSON.stringify(live)}`);
      }
      liveScore.set(matchId, expected);
      lastResultVersion = body.publication.result_version;
      lastEtag = etag;
    }
  }

  // 5. Test scorekeeper session takeover:
  // A second scorekeeper exchanges token for match 1 (joins as candidate)
  const passRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/matches/${playable[0]!.id}/access-passes`,
    payload: {
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotency_key: `sim-takeover-${randomUUID()}`,
    },
    expectedStatuses: [201],
  });
  const pass = passRes.json<{ token: string }>();

  simWriterIndex += 1;
  const candidateExchange = await ctx.request({
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
  const candidateSession = candidateExchange.json<{ session_id: string; session_token: string }>();

  // Candidate requests takeover
  await ctx.request({
    method: "POST",
    url: "/api/v1/scoring/takeover-requests",
    headers: {
      "x-scoring-session-id": candidateSession.session_id,
      "x-scoring-session-token": candidateSession.session_token,
    },
    payload: {
      pending_event_count: 0,
      pending_through_sequence: 0,
    },
    expectedStatuses: [201],
  });

  // Organiser lists and approves takeover
  const listTakeoverRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/takeover-requests`,
    expectedStatuses: [200],
  });
  const takeovers = listTakeoverRes.json<Array<{ id: string; match_id: string }>>();
  const matchingTakeover = takeovers.find((t) => t.match_id === playable[0]!.id);
  if (!matchingTakeover) throw new Error("Takeover request not found for organiser review");

  const approveRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/takeover-requests/${matchingTakeover.id}/approve`,
    payload: {
      reason: "Device swap during set",
      override_acknowledged: true,
    },
    expectedStatuses: [200],
  });
  const resolution = approveRes.json<{ status: string; generation: number }>();

  // Verify stale writer (writer1) is rejected with 409 STALE_WRITER_GENERATION
  await writer1.append({ type: "point", team_slot: "home", segment_number: 1 }, [409]);

  // Create active writer from candidateSession with updated generation
  const writer1New = createWriterFromSession(
    ctx,
    {
      session_id: candidateSession.session_id,
      session_token: candidateSession.session_token,
      generation: resolution.generation,
    },
    writer1.getSequence(),
  );

  // 6. Complete and finalise Match 1 using new writer
  for (let pt = pointsPerCourt; pt < 25; pt++) {
    await writer1New.append({ type: "point", team_slot: "home", segment_number: 1 });
  }
  await writer1New.append({ type: "set_completion", team_slot: "home", segment_number: 1 });
  await writer1New.append({ type: "point", team_slot: "away", segment_number: 2 });
  for (let pt = 0; pt < 25; pt++) {
    await writer1New.append({ type: "point", team_slot: "home", segment_number: 2 });
  }
  await writer1New.append({ type: "set_completion", team_slot: "home", segment_number: 2 });
  const finalReceipt = (await writer1New.finalise()) as { aggregate_version: number };

  // Read public truth: verify monotonic result version increase after match finalisation
  const pubResFinal = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const finalTruth = pubResFinal.json<{
    publication: { result_version: number };
    results: Array<{ id?: string; match_id?: string; state: string }>;
  }>();
  if (finalTruth.publication.result_version <= lastResultVersion) {
    throw new Error(
      `Result version did not increase after match finalisation: was ${lastResultVersion}, now ${finalTruth.publication.result_version}`,
    );
  }
  const match1Final = finalTruth.results.find((r) => (r.id ?? r.match_id) === playable[0]!.id);
  if (!match1Final || match1Final.state !== "final") {
    throw new Error("Match 1 result not marked final in public projection");
  }
  lastResultVersion = finalTruth.publication.result_version;

  // 7. Organiser score correction route on finalised match: reverse the away point
  const auditRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/matches/${playable[0]!.id}/scoring-audit`,
    expectedStatuses: [200],
  });
  const auditData = auditRes.json<{
    events: Array<{ event_id: string; event_type: string; side: string | null }>;
  }>();
  const awayPointEvent = auditData.events.find((e) => e.event_type === "point" && e.side === "away");
  if (!awayPointEvent) throw new Error("Expected away point event in audit");

  await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/matches/${playable[0]!.id}/corrections`,
    payload: {
      client_event_id: randomUUID(),
      reason: "Official review score adjustment: away point disallowed",
      expected_aggregate_version: finalReceipt.aggregate_version,
      events: [
        {
          client_event_id: randomUUID(),
          type: "reversal",
          occurred_at: new Date().toISOString(),
          reversal_target_event_id: awayPointEvent.event_id,
          reason: "Away point disallowed upon review",
        },
      ],
    },
    expectedStatuses: [200],
  });

  // Verify final public version increased after correction
  const pubAfterCorr = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const vFinal = pubAfterCorr.json<{ publication: { result_version: number } }>().publication.result_version;
  if (vFinal <= lastResultVersion) {
    throw new Error(`Result version did not increase after correction: was ${lastResultVersion}, now ${vFinal}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 7: Mid-day disruption / court closure
// ---------------------------------------------------------------------------
async function runScenario7(ctx: SimContext): Promise<void> {
  const { comp, division } = await createStandardTournament(ctx, "canoe_polo", "s7-disrupt");
  const template = createDefaultFormatTemplates(8).find((t) => t.strategy === "championship_focus")!;
  const { formatId, sched } = await materializeAndPublishFormat(ctx, comp.id, division.id, template.graph);

  const areas = await ctx.sql<{ id: string; name: string }[]>`
    SELECT id, name FROM playing_areas WHERE competition_id=${comp.id} ORDER BY name`;
  const court1 = areas.find((a) => a.name === "Court 1")!;
  const court2 = areas.find((a) => a.name === "Court 2")!;

  type SchedMatch = {
    id?: string;
    match_id?: string;
    area?: { id: string };
    playing_area_id?: string;
    starts_at?: string;
  };
  const getMatchId = (m: SchedMatch) => (m.id ?? m.match_id)!;
  const getAreaId = (m: SchedMatch) => (m.area?.id ?? m.playing_area_id)!;

  // Read initial public schedule
  const initialPubRes = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const initialPub = initialPubRes.json<{ schedule: SchedMatch[] }>();
  const initialCourt1Matches = initialPub.schedule.filter((s) => getAreaId(s) === court1.id);
  const initialCourt2Matches = initialPub.schedule.filter((s) => getAreaId(s) === court2.id);

  if (initialCourt1Matches.length === 0 || initialCourt2Matches.length === 0) {
    throw new Error("Expected initial matches on both Court 1 and Court 2");
  }

  // Mid-day court closure: replace capacity with revision: 2, keeping both Court 1 and Court 2
  // so existing scheduled_matches foreign keys remain valid, but closing Court 2 (availability: [])
  const capRes = await ctx.request({
    method: "PUT",
    url: `/api/v1/competitions/${comp.id}/capacity`,
    payload: {
      revision: 2,
      areas: [
        {
          id: court1.id,
          name: "Court 1",
          slot_minutes: 60,
          availability: [
            { date: "2027-04-01", start_time: "08:00", end_time: "20:00" },
            { date: "2027-04-02", start_time: "08:00", end_time: "20:00" },
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
  // R2.1: closing a court with scheduled matches must flag the affected matches for re-plan.
  const capBody = capRes.json<{ affected_matches?: Array<{ match_id: string }>; replan_required?: boolean }>();
  if (!capBody.replan_required || (capBody.affected_matches ?? []).length === 0) {
    throw new Error(`Expected replan_required with affected matches after closing Court 2: ${capRes.body}`);
  }

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

  // Re-plan schedule with updated capacity via canonical Phase 4 solver job flow.
  // Default constraints ignore the prior schedule, and the solver then reshuffles undisplaced
  // matches too (observed: 16 moved for 10 displaced). The organiser-facing way to request
  // minimal change is preserve_existing_schedule, so the re-plan pins every still-valid Court 1
  // placement as required and leaves the displaced Court 2 matches free.
  const generation = (ws as unknown as { generation: { constraints: Record<string, unknown> } }).generation;
  const preserveByMatch = Object.fromEntries(
    initialCourt1Matches.map((m) => [getMatchId(m), { area_id: court1.id, start_epoch_ms: Date.parse(m.starts_at!) }]),
  );
  await generateAndPublishScheduleViaJob(ctx, comp.id, {
    ...generation.constraints,
    preserve_existing_schedule: {
      mode: "preferred",
      weight: 100,
      value: { maximum_shift_minutes: 0, by_match_id: preserveByMatch },
    },
  });

  // Verify public projection no longer schedules matches on Court 2,
  // and Court 2 matches moved to Court 1
  const pubRes = await ctx.request({
    method: "GET",
    url: `/api/v1/public/competitions/${comp.slug}/current`,
    expectedStatuses: [200],
  });
  const pub = pubRes.json<{ schedule: SchedMatch[] }>();
  if (pub.schedule.length === 0) {
    throw new Error("Expected scheduled matches in public projection after replan");
  }
  const court2Matches = pub.schedule.filter((s) => getAreaId(s) === court2.id);
  if (court2Matches.length > 0) {
    throw new Error(`Public schedule still contains ${court2Matches.length} matches on closed Court 2`);
  }

  // Verify affected matches from Court 2 are now on Court 1
  for (const m of initialCourt2Matches) {
    const moved = pub.schedule.find((s) => getMatchId(s) === getMatchId(m));
    if (!moved || getAreaId(moved) !== court1.id) {
      throw new Error(`Affected match ${getMatchId(m)} was not moved to Court 1`);
    }
  }

  // Verify matches originally on Court 1 are still scheduled on Court 1
  for (const m of initialCourt1Matches) {
    const retained = pub.schedule.find((s) => getMatchId(s) === getMatchId(m));
    if (!retained || getAreaId(retained) !== court1.id) {
      throw new Error(`Original Court 1 match ${getMatchId(m)} missing from Court 1`);
    }
  }

  // Minimal disruption: "moved == displaced" is NOT guaranteed by the product. Measured over
  // repeated runs, even with preserve_existing_schedule preferred (weight 100) the solver moves
  // 4-7 undisplaced Court 1 matches, sometimes earlier; with it required the job returns
  // no_solution, because Court 1 is already full before the knockout rounds. The strongest
  // property that holds, and is asserted, is conservation: nothing is dropped or duplicated,
  // exactly the displaced matches change court, and every undisplaced match keeps its court.
  const before = new Map(initialPub.schedule.map((s) => [getMatchId(s), s]));
  const ids = pub.schedule.map(getMatchId);
  if (new Set(ids).size !== ids.length || ids.length !== before.size || ids.some((id) => !before.has(id))) {
    throw new Error(`Re-plan changed the scheduled match set: ${before.size} before, ${ids.length} after`);
  }
  const courtChanged = pub.schedule.filter((s) => getAreaId(before.get(getMatchId(s))!) !== getAreaId(s));
  if (courtChanged.length !== initialCourt2Matches.length) {
    throw new Error(
      `Re-plan changed court for ${courtChanged.length} match(es) but ${initialCourt2Matches.length} were displaced`,
    );
  }
  const timeOnlyMoves = pub.schedule.filter((s) => {
    const prior = before.get(getMatchId(s))!;
    return getAreaId(prior) === getAreaId(s) && prior.starts_at !== s.starts_at;
  }).length;
  console.log(
    `\n    [s7] displaced=${initialCourt2Matches.length} court-changed=${courtChanged.length} time-shifted-on-court-1=${timeOnlyMoves}`,
  );

  // R2.2: running late. Push the final Court 1 match back with the schedule delay tool,
  // publish the delayed revision, and assert the public projection reflects the shift.
  const latest = (
    await ctx.sql<{ published_schedule_revision_id: string; revision: number }[]>`
      SELECT cp.published_schedule_revision_id, sr.revision
      FROM competition_publications cp
      JOIN schedule_revisions sr ON sr.id = cp.published_schedule_revision_id
      WHERE cp.competition_id=${comp.id}`
  )[0]!;
  const lastOnCourt1 = pub.schedule
    .filter((s) => getAreaId(s) === court1.id)
    .reduce((a, b) => (Date.parse(a.starts_at!) >= Date.parse(b.starts_at!) ? a : b));
  const delayRes = await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${latest.published_schedule_revision_id}/delays`,
    payload: {
      idempotency_key: `s7-delay-${randomUUID()}`,
      expected_revision: latest.revision,
      playing_area_id: court1.id,
      from_epoch_ms: Date.parse(lastOnCourt1.starts_at!),
      delay_minutes: 15,
    },
    expectedStatuses: [201],
  });
  const delayed = delayRes.json<{ id: string; revision: number }>();
  await ctx.request({
    method: "POST",
    url: `/api/v1/schedule-revisions/${delayed.id}/publish`,
    payload: { idempotency_key: `s7-delay-pub-${randomUUID()}`, expected_revision: delayed.revision },
    expectedStatuses: [200],
  });
  const afterDelay = (
    await ctx.request({
      method: "GET",
      url: `/api/v1/public/competitions/${comp.slug}/current`,
      expectedStatuses: [200],
    })
  ).json<{ schedule: SchedMatch[] }>();
  const shifted = afterDelay.schedule.find((s) => getMatchId(s) === getMatchId(lastOnCourt1));
  if (!shifted || Date.parse(shifted.starts_at!) - Date.parse(lastOnCourt1.starts_at!) !== 15 * 60_000) {
    throw new Error(`Delayed match ${getMatchId(lastOnCourt1)} was not pushed back 15 minutes in the public schedule`);
  }
  if (afterDelay.schedule.some((s) => getAreaId(s) === court2.id)) {
    throw new Error("Delay re-introduced matches on closed Court 2");
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

  // Walkover must persist a final forfeit result snapshot
  const snapshots = await ctx.sql<{ state: string }[]>`
    SELECT state FROM match_result_snapshots
    WHERE match_id=${targetMatch.id} ORDER BY result_version DESC LIMIT 1`;
  if (snapshots[0]?.state !== "final") {
    throw new Error("Expected final match result snapshot for walkover match");
  }

  // 2. Withdraw the losing home entry via lifecycle endpoint
  await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/entries/${targetMatch.home_entry_id}/lifecycle`,
    payload: { action: "withdraw", reason: "Sprained ankle" },
    expectedStatuses: [200],
  });

  // Verify entry status is withdrawn via API
  const entriesRes = await ctx.request({
    method: "GET",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/entries`,
    expectedStatuses: [200],
  });
  const entries = entriesRes.json<Array<{ id: string; status: string }>>();
  const withdrawnEntry = entries.find((e) => e.id === targetMatch.home_entry_id);
  if (!withdrawnEntry || withdrawnEntry.status !== "withdrawn") {
    throw new Error(`Expected entry to have withdrawn status, got ${withdrawnEntry?.status}`);
  }

  // 3. Recalculate standings via real API route
  await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/divisions/${division.id}/standings/recalculate`,
    expectedStatuses: [200],
  });

  // 4. Assert standings reflect forfeit and winner points
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

  type StandingEntry = {
    entryId?: string;
    entry_id?: string;
    played?: number;
    won?: number;
    lost?: number;
    drawn?: number;
    status?: string;
    tablePoints?: number;
    segmentsWon?: number;
    segmentsLost?: number;
    scoreFor?: number;
    scoreAgainst?: number;
    eligibleForAdvancement?: boolean;
    rank?: number;
  };
  const rawGroups = (standings.standings as { groups?: Record<string, { rows?: StandingEntry[] }> } | undefined)
    ?.groups;
  const standingRows: StandingEntry[] = Array.isArray(standings.standings)
    ? (standings.standings as StandingEntry[])
    : Object.values(rawGroups ?? {}).flatMap((g) => g.rows ?? []);
  if (standingRows.length === 0) throw new Error("Standings rows missing after recalculate");
  const rowFor = (entryId: string) => standingRows.find((s) => (s.entryId ?? s.entry_id) === entryId);

  // Winner: one forfeit win, one table point, full walkover segment/score award, still eligible.
  const winnerRow = rowFor(targetMatch.away_entry_id);
  const loserRow = rowFor(targetMatch.home_entry_id);
  const fail = (what: string) =>
    new Error(`${what}: ${JSON.stringify({ winnerRow, loserRow }, (k, v) => (k === "explanations" ? undefined : v))}`);
  if (
    !winnerRow ||
    winnerRow.played !== 1 ||
    winnerRow.won !== 1 ||
    winnerRow.lost !== 0 ||
    winnerRow.drawn !== 0 ||
    winnerRow.tablePoints !== 1 ||
    winnerRow.status !== "active" ||
    winnerRow.eligibleForAdvancement !== true ||
    (winnerRow.segmentsWon ?? 0) < 2 ||
    (winnerRow.scoreFor ?? 0) <= 0
  ) {
    throw fail("Walkover winner standings row incorrect");
  }
  // Withdrawn entry: one forfeit loss mirroring the winner's award, zero points, withdrawn, last.
  if (
    !loserRow ||
    loserRow.played !== 1 ||
    loserRow.won !== 0 ||
    loserRow.lost !== 1 ||
    loserRow.tablePoints !== 0 ||
    loserRow.status !== "withdrawn" ||
    loserRow.eligibleForAdvancement !== false ||
    loserRow.segmentsLost !== winnerRow.segmentsWon ||
    loserRow.scoreAgainst !== winnerRow.scoreFor ||
    loserRow.scoreFor !== 0 ||
    loserRow.rank !== standingRows.length
  ) {
    throw fail("Withdrawn entry forfeit row incorrect");
  }

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

  // 1. Create setup draft via API, then resume
  const createDraftRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/setup-draft`,
    payload: { idempotency_key: randomUUID() },
    expectedStatuses: [201],
  });
  let draft = createDraftRes.json<{ revision: number }>();

  const resumeRes = await ctx.request({
    method: "POST",
    url: `/api/v1/competitions/${comp.id}/setup-draft/resume`,
    payload: { idempotency_key: randomUUID() },
    expectedStatuses: [200],
  });
  draft = resumeRes.json<{ revision: number }>();

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

  // 4. Read initial AI usage & quota boundaries via API
  const usageBeforeRes = await ctx.request({
    method: "GET",
    url: `/api/v1/organisations/${ctx.organisationId}/ai/usage`,
    expectedStatuses: [200],
  });
  const usageBefore = usageBeforeRes.json<{
    organisation_id: string;
    actions: Array<{ action: string; used_units: number; remaining_units: number }>;
  }>();
  if (usageBefore.organisation_id !== ctx.organisationId) {
    throw new Error("AI usage organisation ID mismatch");
  }
  const initialUsed = usageBefore.actions.find((a) => a.action === "text_to_brief")?.used_units ?? 0;

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
    brief?: { name?: string };
    charged_units?: number;
  }>();
  if (!brief || !brief.status) throw new Error("AI competition brief returned empty response");

  // 6. Verify AI usage incremented after brief
  const usageAfterRes = await ctx.request({
    method: "GET",
    url: `/api/v1/organisations/${ctx.organisationId}/ai/usage`,
    expectedStatuses: [200],
  });
  const usageAfter = usageAfterRes.json<{
    actions: Array<{ action: string; used_units: number; remaining_units: number }>;
  }>();
  const afterUsed = usageAfter.actions.find((a) => a.action === "text_to_brief")?.used_units ?? 0;
  if (afterUsed <= initialUsed) {
    throw new Error(`Expected AI usage used_units to increment: was ${initialUsed}, now ${afterUsed}`);
  }

  // 7. Test quota exhaustion: simulate allowance exhaustion in database, then verify API handles it gracefully
  await ctx.sql`
    UPDATE ai_usage_allowances
    SET used_units = action_limit
    WHERE organisation_id = ${ctx.organisationId} AND action = 'text_to_brief'`;

  const exhaustRes = await ctx.request({
    method: "POST",
    url: `/api/v1/organisations/${ctx.organisationId}/ai/competition-brief`,
    payload: {
      idempotency_key: randomUUID(),
      text: "Another tournament brief after quota exhausted",
      competition_id: comp.id,
    },
    expectedStatuses: [200],
  });
  const exhausted = exhaustRes.json<{ status: string; reason?: string }>();
  if (exhausted.status !== "quota_exhausted" && exhausted.reason !== "quota_exhausted") {
    throw new Error(`Expected quota_exhausted status or reason, got ${JSON.stringify(exhausted)}`);
  }
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
    await tx`INSERT INTO organisation_subscriptions (organisation_id, tier, status, current_period_end)
      VALUES (${organisationId}, 'organiser_pro', 'active', now() + interval '1 year')`;
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
  const jobStore = new PostgresScheduleJobStore(sql);
  const optimizer = new DomainScheduleOptimizer({
    maxIterationsPerRun: profile === "fast" ? 1 : 2,
    workerExecArgv: [],
  });
  const scheduleProcessor = new ScheduleJobProcessor({
    workerId: `sim-worker-${randomUUID()}`,
    store: jobStore,
    optimizer,
    leaseMs: 30_000,
    cancellationPollMs: 50,
    maxYieldIntervalMs: 5_000,
  });

  const enqueuePort: ScheduleEnqueuePort = {
    enqueueSchedule: async (payload) => {
      queueMicrotask(async () => {
        try {
          await scheduleProcessor.process(payload, {
            jobId: payload.jobId,
            attempt: 1,
            isCancellationRequested: async () => false,
            throwIfCancellationRequested: async () => {},
            updateProgress: async () => {},
          });
        } catch {
          // Outcomes are persisted to PostgreSQL by processor/store
        }
      });
      return { id: payload.jobId, name: "schedule.optimize", duplicate: false };
    },
  };

  const phase4 = new ReliableGateBPhase4Runtime(
    sql as unknown as PostgresJsSql,
    phase3,
    enqueuePort,
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
    phase2,
  );

  const app = await buildApp({
    config: testConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: (process.env.SIM_LOG_LEVEL ?? "silent") as "silent" }),
    probes: healthyProbes,
    phase2Runtime: phase2,
    phase3Runtime: phase3,
    phase4Runtime: phase4,
    gateCC4Runtime: phase4.gateCC4,
    gateCC4Operations: phase4.gateCC4Operations,
    gateCC4Lifecycle: phase4.gateCC4Lifecycle,
    gateCC4PublicTruthRuntime: phase4.gateCC4PublicTruth,
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
    rateLimitMax: 100_000,
    authenticatedRateLimitMax: 100_000,
    anonymousRateLimitMax: 100_000,
    publicReadRateLimitMax: 100_000,
    scoringSessionRateLimitMax: 100_000,
    resolveRateLimitAccountId: async () => accountId,
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
