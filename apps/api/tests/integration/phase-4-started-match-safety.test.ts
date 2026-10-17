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

// Redesign Phase 0: a re-plan can never move a match that has started or finished. Their
// placement in the latest PUBLISHED revision is fixed during regeneration (even when capacity no
// longer offers it), and accept/publish re-check it under match-row locks.
const runInfrastructure = process.env.RUN_INFRA_TESTS === "1";
const describeInfrastructure = runInfrastructure ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const schema = `test_started_safety_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const MINUTE = 60_000;
const CLOSES_AT = Date.parse("2027-08-01T14:00:00Z"); // 22:00 Asia/Singapore

type Assignment = {
  match_id: string;
  area_id: string;
  slot_id: string;
  start_epoch_ms: number;
  end_epoch_ms: number;
  fixed: boolean;
};
type Revision = {
  id: string;
  revision: number;
  status: string;
  source_job_id: string | null;
  assignments: Assignment[];
  placement_warnings?: Array<{ code: string; match_ids: string[] }>;
};

let client!: Sql;
let phase3!: Phase3Runtime;
let phase4!: Phase4Runtime;
let ownerId = "";
let competitionId = "";
let courtA = "";
let courtB = "";

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

/** Generates through the API runtime, runs the real worker optimizer once, and accepts the best option. */
async function solveAndAccept(): Promise<Revision> {
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
  const [job] = await client<{ input_hash: string }[]>`
    SELECT input_hash FROM schedule_generation_jobs WHERE id=${generated.job.id}`;
  const claim = await store.claimJob({
    jobId: generated.job.id,
    workerId: "started-safety-worker",
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
    workerId: "started-safety-worker",
    fenceToken: claim.job.fenceToken,
    expectedInputHash: claim.job.inputHash,
    candidate: best.result,
    iteration: 0,
    exploredCandidates: 1,
  });
  if (!checkpoint.accepted || !checkpoint.result) throw new Error("Checkpoint failed");
  await store.finishJob({
    jobId: generated.job.id,
    workerId: "started-safety-worker",
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
  return result as unknown as Revision;
}

const publish = (revision: Pick<Revision, "id" | "revision">) =>
  phase4.publishScheduleRevision(
    actor(),
    revision.id,
    { idempotency_key: randomUUID(), expected_revision: revision.revision },
    randomUUID(),
  );

async function publishedPlacements(): Promise<Map<string, Assignment>> {
  const rows = await client<{ match_id: string; area_id: string; starts_at: Date; ends_at: Date }[]>`
    SELECT sm.match_id,sm.playing_area_id area_id,sm.starts_at,sm.ends_at
    FROM competition_publications cp
    JOIN scheduled_matches sm ON sm.schedule_revision_id=cp.published_schedule_revision_id
    WHERE cp.competition_id=${competitionId}`;
  return new Map(
    rows.map((row) => [
      row.match_id,
      {
        match_id: row.match_id,
        area_id: row.area_id,
        slot_id: "",
        start_epoch_ms: row.starts_at.getTime(),
        end_epoch_ms: row.ends_at.getTime(),
        fixed: false,
      },
    ]),
  );
}

async function setState(matchId: string, state: string) {
  await client`UPDATE matches SET state=${state} WHERE id=${matchId}`;
}

async function snapshotFixed(jobId: string) {
  const [job] = await client<{ input_snapshot: ScheduleJobInput | string }[]>`
    SELECT input_snapshot FROM schedule_generation_jobs WHERE id=${jobId}`;
  const snapshot = (
    typeof job!.input_snapshot === "string" ? JSON.parse(job!.input_snapshot) : job!.input_snapshot
  ) as ScheduleJobInput;
  return {
    snapshot,
    fixed: new Map(
      snapshot.matches
        .filter((match) => match.fixed_assignment)
        .map((match) => [match.match_id, match.fixed_assignment!] as const),
    ),
  };
}

async function capacityInput(courtBHours: Array<{ date: string; startTime: string; endTime: string }>) {
  const view = await phase3.capacity(actor(), competitionId);
  const window = { date: "2027-08-01", startTime: "08:00", endTime: "22:00" };
  return {
    revision: view.revision,
    areas: [
      { id: courtA, name: "Court A", slotMinutes: 30, fixedReserveSlots: 0, availability: [window] },
      { id: courtB, name: "Court B", slotMinutes: 30, fixedReserveSlots: 0, availability: courtBHours },
    ],
  };
}

beforeAll(async () => {
  if (!runInfrastructure) return;
  if (!databaseUrl) throw new Error("DATABASE_URL is required when RUN_INFRA_TESTS=1");
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });
  ownerId = (
    await client<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES('owner@started.test','Owner',now()) RETURNING id`
  )[0]!.id;
  let organisationId = "";
  await client.begin(async (tx) => {
    organisationId = (
      await tx<{ id: string }[]>`INSERT INTO organisations(name,slug) VALUES('Started Org','started-org') RETURNING id`
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
    "started-safety-fallback-code-hmac-secret",
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
        name: "Started Cup",
        slug: `started-cup-${randomUUID()}`,
        sportCode: "canoe_polo",
        venue: "Started Pool",
        address: "1 Started Way",
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
}, 120_000);

afterAll(async () => {
  if (!runInfrastructure) return;
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("started and finished matches keep their published placement (redesign Phase 0)", () => {
  it("does not block regeneration when a match started before any publication, and warns instead", async () => {
    const first = await solveAndAccept();
    // Nothing is published yet, so this match has no public placement to keep.
    const unplacedMatchId = first.assignments[0]!.match_id;
    await setState(unplacedMatchId, "in_progress");
    try {
      const regenerated = await solveAndAccept();
      const planned = regenerated.assignments.find((assignment) => assignment.match_id === unplacedMatchId);
      expect(planned).toMatchObject({ fixed: false });
      expect(regenerated.assignments).toHaveLength(first.assignments.length);
      const detail = (await phase4.readScheduleRevision(actor(), regenerated.id)) as unknown as Revision;
      expect(detail.placement_warnings).toEqual([
        expect.objectContaining({ code: "STARTED_WITHOUT_PLACEMENT", match_ids: [unplacedMatchId] }),
      ]);
      // Once published, that placement is what the public saw, so the next re-plan fixes it there.
      await publish(regenerated);
      const next = await solveAndAccept();
      expect(next.assignments.find((assignment) => assignment.match_id === unplacedMatchId)).toMatchObject({
        area_id: planned!.area_id,
        start_epoch_ms: planned!.start_epoch_ms,
        fixed: true,
      });
      expect(((await phase4.readScheduleRevision(actor(), next.id)) as unknown as Revision).placement_warnings).toEqual(
        [],
      );
    } finally {
      await setState(unplacedMatchId, "pending");
    }
  });

  it("keeps in_progress and final (walkover) matches on their published court and time when regenerating", async () => {
    const baseline = await solveAndAccept();
    await publish(baseline);
    const published = await publishedPlacements();
    expect(published.size).toBe(baseline.assignments.length);
    const [started, finished] = baseline.assignments;
    await setState(started!.match_id, "in_progress");
    await setState(finished!.match_id, "final");
    const regenerated = await solveAndAccept();
    for (const [matchId, reason] of [
      [started!.match_id, "started"],
      [finished!.match_id, "finished"],
    ] as const) {
      const expected = published.get(matchId)!;
      const actual = regenerated.assignments.find((assignment) => assignment.match_id === matchId)!;
      expect(actual).toMatchObject({
        area_id: expected.area_id,
        start_epoch_ms: expected.start_epoch_ms,
        end_epoch_ms: expected.end_epoch_ms,
        fixed: true,
      });
      const { fixed } = await snapshotFixed(regenerated.source_job_id!);
      expect(fixed.get(matchId)).toMatchObject({ reason, area_id: expected.area_id });
    }
    await publish(regenerated);
  });

  it.each(["in_progress", "final", "corrected"])(
    "rejects validating and committing a move of a %s match with 409 MATCH_NOT_MOVABLE",
    async (state) => {
      const draft = await solveAndAccept();
      const target = draft.assignments.find((assignment) => !assignment.fixed)!;
      const free = draft.assignments.find((assignment) => assignment.match_id !== target.match_id)!;
      const previous = (await client<{ state: string }[]>`SELECT state FROM matches WHERE id=${target.match_id}`)[0]!
        .state;
      await setState(target.match_id, state);
      const move = {
        match_id: target.match_id,
        playing_area_id: free.area_id,
        slot_id: free.slot_id,
        start_epoch_ms: free.start_epoch_ms,
        end_epoch_ms: free.end_epoch_ms,
      };
      try {
        await expect(phase4.validateScheduleMove(actor(), draft.id, move)).rejects.toMatchObject({
          statusCode: 409,
          code: "MATCH_NOT_MOVABLE",
        });
        await expect(
          phase4.moveScheduleMatch(
            actor(),
            draft.id,
            { ...move, idempotency_key: randomUUID(), expected_revision: draft.revision },
            randomUUID(),
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: "MATCH_NOT_MOVABLE" });
      } finally {
        await setState(target.match_id, previous);
      }
    },
  );

  it("refuses to publish a draft that moved a match which started after the draft was made", async () => {
    const draft = await solveAndAccept();
    const before = await publishedPlacements();
    const { snapshot } = await snapshotFixed(draft.source_job_id!);
    let moved: Revision | undefined;
    let movedMatchId = "";
    for (const candidate of draft.assignments.filter((assignment) => !assignment.fixed)) {
      for (const slot of snapshot.slots) {
        if (slot.area_id === candidate.area_id && slot.start_epoch_ms === candidate.start_epoch_ms) continue;
        const move = {
          match_id: candidate.match_id,
          playing_area_id: slot.area_id,
          slot_id: slot.slot_id,
          start_epoch_ms: slot.start_epoch_ms,
          end_epoch_ms: slot.end_epoch_ms,
        };
        const preview = await phase4.validateScheduleMove(actor(), draft.id, move);
        if (!preview.validation.valid) continue;
        moved = (await phase4.moveScheduleMatch(
          actor(),
          draft.id,
          { ...move, idempotency_key: randomUUID(), expected_revision: draft.revision },
          randomUUID(),
        )) as unknown as Revision;
        movedMatchId = candidate.match_id;
        break;
      }
      if (moved) break;
    }
    if (!moved) throw new Error("No valid move found for the race fixture");
    const ready = (await phase4.markScheduleReady(
      actor(),
      moved.id,
      { idempotency_key: randomUUID(), expected_revision: moved.revision },
      randomUUID(),
    )) as unknown as Revision;
    await setState(movedMatchId, "in_progress");
    try {
      await expect(publish(ready)).rejects.toMatchObject({ statusCode: 409, code: "MATCH_NOT_MOVABLE" });
      expect(await publishedPlacements()).toEqual(before);
    } finally {
      await setState(movedMatchId, "pending");
    }
  });

  it("regenerates when a slot spans two touching availability windows on one court", async () => {
    // Court B 08:00-10:15 and 10:15-22:00 merge into one interval, so the 10:00-10:30 slot spans
    // both windows. The job-input guard used to require a single window and rejected the snapshot.
    const full = { date: "2027-08-01", startTime: "08:00", endTime: "22:00" };
    await phase3.replaceCapacity(
      actor(),
      competitionId,
      await capacityInput([
        { date: "2027-08-01", startTime: "08:00", endTime: "10:15" },
        { date: "2027-08-01", startTime: "10:15", endTime: "22:00" },
      ]),
      randomUUID(),
    );
    try {
      const regenerated = await solveAndAccept();
      const { snapshot } = await snapshotFixed(regenerated.source_job_id!);
      const spanStart = Date.parse("2027-08-01T02:00:00Z"); // 10:00 Asia/Singapore
      expect(snapshot.slots).toContainEqual(
        expect.objectContaining({ area_id: courtB, start_epoch_ms: spanStart, end_epoch_ms: spanStart + 30 * MINUTE }),
      );
    } finally {
      await phase3.replaceCapacity(actor(), competitionId, await capacityInput([full]), randomUUID());
    }
  });

  // Runs last: it changes capacity.
  it("keeps a started match whose court closed as a fixed placement outside capacity (FIXED_OUTSIDE_CAPACITY)", async () => {
    const published = await publishedPlacements();
    const states = new Map(
      (
        await client<
          { id: string; state: string }[]
        >`SELECT id,state FROM matches WHERE competition_id=${competitionId}`
      ).map((row) => [row.id, row.state]),
    );
    // A match can only start once its feeders are played, so pick a dependency-free one: starting a
    // knockout match while its feeders are still pending can leave too few earlier slots on the one
    // open court, and the solver then (correctly) finds no schedule.
    const notStarted = new Set(["pending", "ready"]);
    const independent = new Set(
      (
        await client<{ id: string }[]>`
          SELECT m.id FROM matches m WHERE m.competition_id=${competitionId}
            AND NOT EXISTS (SELECT 1 FROM phase4_match_schedule_dependencies(m.id))`
      ).map((row) => row.id),
    );
    const live = [...published.values()]
      .filter(
        (placement) =>
          placement.area_id === courtB &&
          notStarted.has(states.get(placement.match_id) ?? "") &&
          independent.has(placement.match_id),
      )
      .sort((left, right) => left.start_epoch_ms - right.start_epoch_ms)[0];
    if (!live) throw new Error("Fixture needs a not-started, dependency-free published match on Court B");
    await setState(live.match_id, "in_progress");
    // Close Court B for the whole day.
    await phase3.replaceCapacity(actor(), competitionId, await capacityInput([]), randomUUID());
    const regenerated = await solveAndAccept();
    const kept = regenerated.assignments.find((assignment) => assignment.match_id === live.match_id)!;
    expect(kept).toMatchObject({
      area_id: courtB,
      start_epoch_ms: live.start_epoch_ms,
      end_epoch_ms: live.end_epoch_ms,
      fixed: true,
    });
    expect(kept.slot_id).toBe(`historical:${live.match_id}`);
    // Every match that has not started left the closed court; started/finished ones all stayed.
    states.set(live.match_id, "in_progress");
    const onClosedCourt = regenerated.assignments.filter((assignment) => assignment.area_id === courtB);
    expect(onClosedCourt.filter((assignment) => notStarted.has(states.get(assignment.match_id) ?? ""))).toEqual([]);
    expect(onClosedCourt.every((assignment) => assignment.fixed && assignment.slot_id.startsWith("historical:"))).toBe(
      true,
    );
    const detail = (await phase4.readScheduleRevision(actor(), regenerated.id)) as unknown as Revision;
    expect(detail.placement_warnings).toContainEqual(
      expect.objectContaining({
        code: "FIXED_OUTSIDE_CAPACITY",
        match_ids: expect.arrayContaining(onClosedCourt.map((assignment) => assignment.match_id)),
      }),
    );
    await publish(regenerated);
    expect((await publishedPlacements()).get(live.match_id)).toMatchObject({
      area_id: courtB,
      start_epoch_ms: live.start_epoch_ms,
    });
  });
});
