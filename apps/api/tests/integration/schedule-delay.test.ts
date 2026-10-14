import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Phase4FormatBuilderDocument, ScheduleConstraints, ScheduleJobInput } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { DomainScheduleOptimizer, PostgresScheduleJobStore, type ScheduleCandidate } from "@matchday/scheduler";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";

// Track R2.2: the delay tool must run through the same schedule validation as a manual move.
const runInfrastructure = process.env.RUN_INFRA_TESTS === "1";
const describeInfrastructure = runInfrastructure ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const schema = `test_schedule_delay_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const MINUTE = 60_000;
// 08:00–22:00 Asia/Singapore on 2027-08-01.
const OPENS_AT = Date.parse("2027-08-01T00:00:00Z");
const CLOSES_AT = Date.parse("2027-08-01T14:00:00Z");

type Assignment = { match_id: string; area_id: string; start_epoch_ms: number; end_epoch_ms: number };
type Accepted = { id: string; revision: number; assignments: Assignment[] };

let client!: Sql;
let phase3!: Phase3Runtime;
let phase4!: Phase4Runtime;
let ownerId = "";
let competitionId = "";
let courtA = "";
let courtB = "";
let accepted!: Accepted;
let entriesByMatch = new Map<string, string[]>();
let dependenciesByMatch = new Map<string, string[]>();
let codeByMatch = new Map<string, string>();

const actor = () => ({ accountId: ownerId });

function constraints(): ScheduleConstraints {
  const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
  return {
    minimum_rest: ignored({ minutes: 0 }),
    maximum_matches_per_day: ignored({ matches: 8 }),
    preferred_final_time: ignored({ target_start_epoch_ms: CLOSES_AT - 120 * MINUTE, tolerance_minutes: 60 }),
    entry_unavailable: ignored({ by_entry_id: {} }),
    official_availability: ignored({ by_official_id: {} }),
    featured_playing_area: ignored({ area_id: courtA, match_ids: [] }),
    avoid_consecutive_matches: ignored({ minutes: 0 }),
    balance_early_matches: ignored({ before_local_time: "09:00" }),
    balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
    keep_division_together: ignored({ maximum_area_count: 2 }),
    preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
  };
}

async function solveAndAccept(): Promise<Accepted> {
  const [competition] = await client<{ revision: number; capacity_revision: number }[]>`
    SELECT revision::int revision, capacity_revision::int capacity_revision FROM competitions WHERE id=${competitionId}`;
  const generated = await phase4.generateSchedule(
    actor(),
    competitionId,
    {
      idempotency_key: `generate-${randomUUID()}`,
      expected_source_revision: competition!.revision,
      expected_capacity_revision: competition!.capacity_revision,
      objective: "balanced",
      constraints: constraints(),
    },
    randomUUID(),
  );
  const store = new PostgresScheduleJobStore(client);
  const [job] = await client<{ input_hash: string; input_snapshot: ScheduleJobInput }[]>`
    SELECT input_hash,input_snapshot FROM schedule_generation_jobs WHERE id=${generated.job.id}`;
  const claim = await store.claimJob({
    jobId: generated.job.id,
    workerId: "delay-test-worker",
    expectedInputHash: job!.input_hash,
    leaseMs: 30_000,
  });
  if (claim.outcome !== "claimed") throw new Error(`Claim failed: ${claim.outcome}`);
  const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 16, workerExecArgv: [] });
  let best: ScheduleCandidate | null = null;
  for await (const candidate of optimizer.optimize({
    input: claim.job.input,
    seed: null,
    startIteration: 0,
    signal: new AbortController().signal,
    maxYieldIntervalMs: 15_000,
  })) {
    best = candidate;
    break;
  }
  if (!best) throw new Error("No schedule candidate");
  const checkpoint = await store.checkpointBest({
    jobId: generated.job.id,
    workerId: "delay-test-worker",
    fenceToken: claim.job.fenceToken,
    expectedInputHash: claim.job.inputHash,
    candidate: best.result,
    iteration: 0,
    exploredCandidates: 1,
  });
  if (!checkpoint.accepted || !checkpoint.result) throw new Error("Checkpoint failed");
  await store.finishJob({
    jobId: generated.job.id,
    workerId: "delay-test-worker",
    fenceToken: claim.job.fenceToken,
    state: "completed",
    currentBestRevision: checkpoint.result.result_revision,
  });
  const [after] = await client<{ revision: number; current_best_option_id: string }[]>`
    SELECT revision,current_best_option_id FROM schedule_generation_jobs WHERE id=${generated.job.id}`;
  const result = await phase4.acceptScheduleOption(
    actor(),
    generated.job.id,
    after!.current_best_option_id,
    { idempotency_key: `accept-${randomUUID()}`, expected_job_revision: after!.revision },
    randomUUID(),
  );
  expect(result.status).toBe("ready_for_review");
  return result as unknown as Accepted;
}

function delay(input: {
  delay_minutes?: number;
  playing_area_id?: string;
  target_playing_area_id?: string;
  from_epoch_ms?: number;
}) {
  return phase4.delayScheduleMatches(
    actor(),
    accepted.id,
    { idempotency_key: `delay-${randomUUID()}`, expected_revision: accepted.revision, ...input },
    randomUUID(),
  );
}

const overlaps = (left: Assignment, right: Assignment) =>
  left.start_epoch_ms < right.end_epoch_ms && right.start_epoch_ms < left.end_epoch_ms;

beforeAll(async () => {
  if (!runInfrastructure) return;
  if (!databaseUrl) throw new Error("DATABASE_URL is required when RUN_INFRA_TESTS=1");
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });
  ownerId = (
    await client<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES('owner@delay.test','Owner',now()) RETURNING id`
  )[0]!.id;
  let organisationId = "";
  await client.begin(async (tx) => {
    organisationId = (
      await tx<{ id: string }[]>`INSERT INTO organisations(name,slug) VALUES('Delay Org','delay-org') RETURNING id`
    )[0]!.id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${ownerId},'owner','active')`;
  });
  phase3 = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
  const phase2 = new Phase2Runtime(
    client as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    "schedule-delay-fallback-code-hmac-secret",
  );
  phase4 = new Phase4Runtime(
    client as unknown as PostgresJsSql,
    phase3,
    { enqueueSchedule: async () => ({ id: "ignored", name: "schedule.optimize", duplicate: false }) },
    {
      mode: "stub",
      provider: new DeterministicPhase4AiStub(),
      timeoutMs: 2_000,
      maximumAttempts: 1,
      cacheTtlSeconds: 3_600,
    },
    undefined,
    phase2,
  );
  competitionId = (
    await phase3.createCompetition(
      actor(),
      {
        organisationId,
        name: "Delay Cup",
        slug: `delay-cup-${randomUUID()}`,
        sportCode: "canoe_polo",
        venue: "Delay Pool",
        address: "1 Delay Way",
        countryCode: "SG",
        startsOn: "2027-08-01",
        endsOn: "2027-08-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    )
  ).id;
  const window = { date: "2027-08-01", startTime: "08:00", endTime: "22:00" };
  await phase3.replaceCapacity(
    actor(),
    competitionId,
    {
      revision: 1,
      areas: [
        { name: "Court A", slotMinutes: 30, availability: [window] },
        { name: "Court B", slotMinutes: 30, availability: [window] },
      ],
    },
    randomUUID(),
  );
  const areas = await client<{ id: string; name: string }[]>`
    SELECT id,name FROM playing_areas WHERE competition_id=${competitionId} ORDER BY name`;
  courtA = areas.find((area) => area.name === "Court A")!.id;
  courtB = areas.find((area) => area.name === "Court B")!.id;
  const divisionId = (
    await client<{ id: string }[]>`
      INSERT INTO divisions(competition_id,name,team_limit) VALUES(${competitionId},'Open',8) RETURNING id`
  )[0]!.id;
  await client`INSERT INTO division_entries(division_id,name,seed,status,entry_type)
    SELECT ${divisionId},'Team ' || s,s,'active','team' FROM generate_series(1,8) s`;
  const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
  const document: Phase4FormatBuilderDocument = {
    schema_version: 1,
    graph,
    layout: {
      schema_version: 1,
      stage_positions: graph.stages.map((stage, index) => ({ stage_id: stage.id, x: index * 240, y: 80 })),
    },
  };
  const draft = await phase4.saveFormatRevision(
    actor(),
    competitionId,
    divisionId,
    {
      draft_id: null,
      expected_revision: null,
      parent_revision_id: null,
      document,
      idempotency_key: `format-${randomUUID()}`,
    },
    randomUUID(),
  );
  await phase4.materialiseFormat(actor(), draft.draft_id, `materialise-${randomUUID()}`, randomUUID());
  await client`SELECT phase4_publish_format_revision(${draft.draft_id},${ownerId},${`publish-${randomUUID()}`})`;
  accepted = await solveAndAccept();
  // Entries and dependencies come from the accepted solver snapshot, which is what the delay validation
  // checks against (knockout matches carry every entry that could reach them, not just resolved ones).
  const [source] = await client<{ input_snapshot: unknown }[]>`
    SELECT j.input_snapshot FROM schedule_revisions r JOIN schedule_generation_jobs j ON j.id=r.source_job_id
    WHERE r.id=${accepted.id}`;
  const snapshot = (
    typeof source!.input_snapshot === "string" ? JSON.parse(source!.input_snapshot) : source!.input_snapshot
  ) as { matches: Array<{ match_id: string; possible_entry_ids: string[]; dependency_match_ids: string[] }> };
  entriesByMatch = new Map(snapshot.matches.map((match) => [match.match_id, match.possible_entry_ids]));
  dependenciesByMatch = new Map(snapshot.matches.map((match) => [match.match_id, match.dependency_match_ids]));
  const codeRows = await client<{ id: string; code: string }[]>`
    SELECT id,code FROM matches WHERE competition_id=${competitionId}`;
  codeByMatch = new Map(codeRows.map((row) => [row.id, row.code]));
}, 120_000);

afterAll(async () => {
  if (!runInfrastructure) return;
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("schedule delay tool validation (Track R2.2)", () => {
  it("uses both courts in the accepted schedule", () => {
    expect(new Set(accepted.assignments.map((item) => item.area_id))).toEqual(new Set([courtA, courtB]));
  });

  it("applies a valid delay to only the matches from the chosen time onward", async () => {
    const latestStart = Math.max(...accepted.assignments.map((item) => item.start_epoch_ms));
    const latest = accepted.assignments.filter((item) => item.start_epoch_ms === latestStart);
    expect(Math.max(...latest.map((item) => item.end_epoch_ms)) + 30 * MINUTE).toBeLessThanOrEqual(CLOSES_AT);
    const delayed = await delay({ delay_minutes: 30, from_epoch_ms: latestStart });
    expect(delayed).toMatchObject({ status: "ready_for_review", parent_revision_id: accepted.id });
    expect(delayed.delayed_count).toBe(latest.length);
    const before = new Map(accepted.assignments.map((item) => [item.match_id, item]));
    for (const item of delayed.assignments as unknown as Assignment[]) {
      const original = before.get(item.match_id)!;
      const shift = original.start_epoch_ms === latestStart ? 30 * MINUTE : 0;
      expect(item).toMatchObject({
        area_id: original.area_id,
        start_epoch_ms: original.start_epoch_ms + shift,
        end_epoch_ms: original.end_epoch_ms + shift,
      });
    }
  });

  it("rejects a delay that pushes matches past venue close", async () => {
    await expect(delay({ delay_minutes: 720 })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/outside the court's available time/),
    });
    expect(Math.max(...accepted.assignments.map((item) => item.end_epoch_ms)) + 720 * MINUTE).toBeGreaterThan(
      CLOSES_AT,
    );
  });

  it("rejects a court-filtered delay that double-books a team across courts", async () => {
    // Search the accepted schedule exhaustively (every court, start and on-grid delay up to close) for a
    // delay that lands a moved match on top of another-court match sharing a possible entry, using the
    // same solver snapshot data the server validates against. Delays that would also break a dependency
    // are skipped so the entry overlap is the conflict reported.
    type Scenario = { area: string; from: number; minutes: number; moved: string; other: string };
    let scenario: Scenario | null = null;
    const latestEnd = Math.max(...accepted.assignments.map((a) => a.end_epoch_ms));
    search: for (const area of [courtA, courtB]) {
      const starts = [
        ...new Set(accepted.assignments.filter((a) => a.area_id === area).map((a) => a.start_epoch_ms)),
      ].sort((x, y) => x - y);
      for (const from of starts) {
        for (let minutes = 30; from + minutes * MINUTE < latestEnd + 30 * MINUTE; minutes += 30) {
          const shifted = accepted.assignments
            .filter((a) => a.area_id === area && a.start_epoch_ms >= from)
            .map((a) => ({
              ...a,
              start_epoch_ms: a.start_epoch_ms + minutes * MINUTE,
              end_epoch_ms: a.end_epoch_ms + minutes * MINUTE,
            }));
          if (shifted.some((a) => a.end_epoch_ms > CLOSES_AT)) continue;
          const shiftedIds = new Set(shifted.map((a) => a.match_id));
          const others = accepted.assignments.filter((a) => !shiftedIds.has(a.match_id));
          const breaksDependency = shifted.some((moved) =>
            others.some(
              (other) =>
                (dependenciesByMatch.get(other.match_id) ?? []).includes(moved.match_id) &&
                other.start_epoch_ms < moved.end_epoch_ms,
            ),
          );
          if (breaksDependency) continue;
          for (const moved of shifted) {
            const other = others.find(
              (candidate) =>
                candidate.area_id !== area &&
                overlaps(moved, candidate) &&
                (entriesByMatch.get(moved.match_id) ?? []).some((entry) =>
                  (entriesByMatch.get(candidate.match_id) ?? []).includes(entry),
                ),
            );
            if (other) {
              scenario = { area, from, minutes, moved: moved.match_id, other: other.match_id };
              break search;
            }
          }
        }
      }
    }
    if (!scenario) throw new Error("Fixture has no cross-court double-booking scenario");
    const error = await delay({
      delay_minutes: scenario.minutes,
      playing_area_id: scenario.area,
      from_epoch_ms: scenario.from,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 422, message: expect.stringMatching(/possible entry overlap/) });
    const message = (error as Error).message;
    expect(message).toContain(codeByMatch.get(scenario.moved)!);
    expect(message).toContain(codeByMatch.get(scenario.other)!);
  });

  it("rejects relocating matches onto an occupied court", async () => {
    const busyOnB = accepted.assignments.filter((a) => a.area_id === courtB);
    const clash = accepted.assignments
      .filter((a) => a.area_id === courtA && busyOnB.some((b) => overlaps(a, b)))
      .sort((x, y) => x.start_epoch_ms - y.start_epoch_ms)[0];
    if (!clash) throw new Error("Fixture has no concurrent court use");
    await expect(
      delay({ playing_area_id: courtA, target_playing_area_id: courtB, from_epoch_ms: clash.start_epoch_ms }),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/area overlap/) });
    await expect(delay({ playing_area_id: courtA, target_playing_area_id: courtA })).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(delay({ target_playing_area_id: courtB })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("never moves locked or started matches", async () => {
    const starts = [...new Set(accepted.assignments.map((a) => a.start_epoch_ms))].sort((x, y) => x - y);
    const pivot = [...starts]
      .reverse()
      .find(
        (start) =>
          accepted.assignments.some((a) => a.area_id === courtA && a.start_epoch_ms === start) &&
          accepted.assignments.some((a) => a.area_id === courtB && a.start_epoch_ms === start) &&
          accepted.assignments.some((a) => a.start_epoch_ms > start),
      );
    if (pivot === undefined) throw new Error("Fixture has no shared start time on both courts");
    const locked = accepted.assignments.find((a) => a.area_id === courtA && a.start_epoch_ms === pivot)!;
    const started = accepted.assignments.find((a) => a.area_id === courtB && a.start_epoch_ms === pivot)!;
    await phase4.lockScheduleAssignment(
      actor(),
      accepted.id,
      {
        idempotency_key: randomUUID(),
        match_id: locked.match_id,
        playing_area_id: locked.area_id,
        start_epoch_ms: locked.start_epoch_ms,
        end_epoch_ms: locked.end_epoch_ms,
      },
      randomUUID(),
    );
    await client`UPDATE matches SET state='in_progress' WHERE id=${started.match_id}`;
    const later = accepted.assignments.filter((a) => a.start_epoch_ms > pivot);
    expect(Math.max(...later.map((a) => a.end_epoch_ms)) + 30 * MINUTE).toBeLessThanOrEqual(CLOSES_AT);
    const delayed = await delay({ delay_minutes: 30, from_epoch_ms: pivot });
    expect(delayed.delayed_count).toBe(later.length);
    const result = new Map((delayed.assignments as unknown as Assignment[]).map((a) => [a.match_id, a]));
    for (const untouched of [locked, started]) {
      expect(result.get(untouched.match_id)).toMatchObject({
        area_id: untouched.area_id,
        start_epoch_ms: untouched.start_epoch_ms,
        end_epoch_ms: untouched.end_epoch_ms,
      });
    }
    for (const moved of later) {
      expect(result.get(moved.match_id)?.start_epoch_ms).toBe(moved.start_epoch_ms + 30 * MINUTE);
    }
    expect(OPENS_AT).toBeLessThan(pivot);
  });

  // Runs last: changing capacity makes the accepted solver input stale for later delays.
  it("renames courts in place by id and keeps removed courts with scheduled matches visible", async () => {
    const view = await phase3.capacity(actor(), competitionId);
    const window = { date: "2027-08-01", startTime: "08:00", endTime: "22:00" };
    const renamed = await phase3.replaceCapacity(
      actor(),
      competitionId,
      {
        revision: view.revision,
        areas: [
          { id: courtA, name: "Centre Court", slotMinutes: 30, availability: [window] },
          { id: courtB, name: "Court B", slotMinutes: 30, availability: [window] },
        ],
      },
      randomUUID(),
    );
    expect(renamed.areas.map((area) => [area.id, area.name])).toEqual([
      [courtA, "Centre Court"],
      [courtB, "Court B"],
    ]);
    expect(renamed.replan_required).toBe(false);

    const removed = await phase3.replaceCapacity(
      actor(),
      competitionId,
      {
        revision: renamed.revision,
        areas: [{ id: courtA, name: "Centre Court", slotMinutes: 30, availability: [window] }],
      },
      randomUUID(),
    );
    const retained = removed.areas.find((area) => area.id === courtB);
    expect(retained).toMatchObject({ retained: true, availability: [] });
    expect(retained!.scheduled_match_count).toBeGreaterThan(0);
    expect(removed.areas.find((area) => area.id === courtA)).toMatchObject({ retained: false });
    expect(removed.replan_required).toBe(true);
    expect(removed.affected_matches!.length).toBeGreaterThan(0);
    expect(removed.affected_matches!.every((match) => match.reason === "playing_area_removed")).toBe(true);
    const reread = await phase3.capacity(actor(), competitionId);
    expect(reread.areas.map((area) => area.id).sort()).toEqual([courtA, courtB].sort());
  });
});
