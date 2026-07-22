import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ScheduleJobInput } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deterministicJsonHash } from "../../src/canonical.js";
import { PostgresScheduleJobStore } from "../../src/postgres-store.js";
import { candidate, scheduleInput } from "../fixtures.js";

const describeInfra = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_scheduler_store_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let sql!: Sql;

beforeAll(async () => {
  if (process.env.RUN_INFRA_TESTS !== "1") return;
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
});

afterAll(async () => {
  if (process.env.RUN_INFRA_TESTS !== "1") return;
  await sql.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfra("PostgresScheduleJobStore", () => {
  it("fences claims, checkpoints monotonically, resumes retained best and cancels terminally", async () => {
    const accountId = randomUUID();
    const organisationId = randomUUID();
    const competitionId = randomUUID();
    const jobId = randomUUID();
    const authoritative = await seedWorld({ accountId, organisationId, competitionId });
    const baseInput = scheduleInput();
    const input: ScheduleJobInput = {
      ...baseInput,
      job_id: jobId,
      competition_id: competitionId,
      capacity_revision: authoritative.capacityRevision,
      capacity_hash: authoritative.capacityHash,
      matches: [
        {
          match_id: authoritative.matchId,
          division_id: authoritative.divisionId,
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: authoritative.possibleEntryIds,
          official_ids: [],
          is_championship_final: true,
        },
      ],
      slots: [
        {
          slot_id: "store-slot-1",
          interval_id: authoritative.intervalId,
          area_id: authoritative.areaId,
          start_epoch_ms: Date.UTC(2027, 0, 1, 1),
          end_epoch_ms: Date.UTC(2027, 0, 1, 1, 30),
        },
        {
          slot_id: "store-slot-2",
          interval_id: authoritative.intervalId,
          area_id: authoritative.areaId,
          start_epoch_ms: Date.UTC(2027, 0, 1, 1, 30),
          end_epoch_ms: Date.UTC(2027, 0, 1, 2),
        },
      ],
      constraints: {
        ...baseInput.constraints,
        featured_playing_area: {
          ...baseInput.constraints.featured_playing_area,
          value: { area_id: authoritative.areaId, match_ids: [] },
        },
      },
    };
    const inputHash = deterministicJsonHash(input);
    await sql`
      INSERT INTO schedule_generation_jobs(
        id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id
      ) VALUES(
        ${jobId},${organisationId},${competitionId},'balanced',${sql.json(input)},${inputHash},${accountId},
        'request-scheduler-store','correlation-scheduler-store'
      )`;
    const firstStore = new PostgresScheduleJobStore(sql);
    const secondStore = new PostgresScheduleJobStore(sql);

    const beforeWrongHash = await sql<{ status: string; revision: number }[]>`
      SELECT status,revision FROM schedule_generation_jobs WHERE id=${jobId}`;
    await expect(
      firstStore.claimJob({
        jobId,
        workerId: "scheduler-wrong-hash",
        expectedInputHash: "b".repeat(64),
        leaseMs: 5_000,
      }),
    ).rejects.toThrow("queue input hash does not match");
    expect(
      await sql<{ status: string; revision: number }[]>`
      SELECT status,revision FROM schedule_generation_jobs WHERE id=${jobId}`,
    ).toEqual(beforeWrongHash);

    const claimed = await firstStore.claimJob({
      jobId,
      workerId: "scheduler-one",
      expectedInputHash: inputHash,
      leaseMs: 5_000,
    });
    expect(claimed.outcome).toBe("claimed");
    if (claimed.outcome !== "claimed") throw new Error("Expected claim");
    expect(
      await firstStore.renewLease({
        jobId,
        workerId: "scheduler-one",
        fenceToken: claimed.job.fenceToken,
        leaseMs: 5_000,
      }),
    ).toBe(true);
    expect(
      await secondStore.claimJob({ jobId, workerId: "scheduler-two", expectedInputHash: inputHash, leaseMs: 5_000 }),
    ).toEqual({ outcome: "busy" });

    const result = {
      ...candidate(81),
      job_id: jobId,
      source_revision: input.source_revision,
      assignments: [
        {
          match_id: authoritative.matchId,
          division_id: authoritative.divisionId,
          area_id: authoritative.areaId,
          interval_id: authoritative.intervalId,
          slot_id: "store-slot-1",
          start_epoch_ms: Date.UTC(2027, 0, 1, 1),
          end_epoch_ms: Date.UTC(2027, 0, 1, 1, 30),
          fixed: false,
        },
      ],
    };
    const checkpoint = await firstStore.checkpointBest({
      jobId,
      workerId: "scheduler-one",
      fenceToken: claimed.job.fenceToken,
      expectedInputHash: inputHash,
      candidate: result,
      iteration: 7,
    });
    expect(checkpoint).toMatchObject({
      accepted: true,
      result: { result_revision: 1, assignment_hash: expect.any(String) },
    });
    const preferredTieBreak = {
      ...result,
      assignments: [
        {
          ...result.assignments[0]!,
          slot_id: "store-slot-2",
          start_epoch_ms: Date.UTC(2027, 0, 1, 1, 30),
          end_epoch_ms: Date.UTC(2027, 0, 1, 2),
        },
      ],
      quality: { ...result.quality, preferred_penalty: result.quality.preferred_penalty - 1 },
    };
    expect(
      await sql<{ valid: boolean }[]>`
        SELECT phase4_schedule_assignments_valid(${sql.json(input)},${sql.json(preferredTieBreak.assignments)}) AS valid`,
    ).toEqual([{ valid: true }]);
    expect(
      await firstStore.checkpointBest({
        jobId,
        workerId: "scheduler-one",
        fenceToken: claimed.job.fenceToken,
        expectedInputHash: inputHash,
        candidate: preferredTieBreak,
        iteration: 8,
      }),
    ).toMatchObject({ accepted: true, result: { result_revision: 2, quality: { preferred_penalty: 18 } } });

    await sql`UPDATE schedule_generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${jobId}`;
    expect(
      await firstStore.renewLease({
        jobId,
        workerId: "scheduler-one",
        fenceToken: claimed.job.fenceToken,
        leaseMs: 5_000,
      }),
    ).toBe(false);
    const resumed = await secondStore.claimJob({
      jobId,
      workerId: "scheduler-two",
      expectedInputHash: inputHash,
      leaseMs: 5_000,
    });
    expect(resumed).toMatchObject({
      outcome: "claimed",
      job: { continuationIteration: 9, currentBest: { result_revision: 2, quality: { score: 81 } } },
    });
    if (resumed.outcome !== "claimed") throw new Error("Expected resumed claim");

    await sql`SELECT phase4_request_schedule_cancellation(${jobId}::uuid,${accountId}::uuid,'cancel-store-test')`;
    expect(await secondStore.getCancellationStatus(jobId, resumed.job.fenceToken)).toMatchObject({
      requested: true,
      requestedAtEpochMs: expect.any(Number),
    });
    expect(
      await secondStore.checkpointBest({
        jobId,
        workerId: "scheduler-two",
        fenceToken: resumed.job.fenceToken,
        expectedInputHash: inputHash,
        candidate: { ...result, quality: { ...result.quality, score: 90, preferred_penalty: 10 } },
        iteration: 9,
      }),
    ).toEqual({ accepted: false, result: null });
    await secondStore.finishJob({
      jobId,
      workerId: "scheduler-two",
      fenceToken: resumed.job.fenceToken,
      state: "cancelled",
      currentBestRevision: 2,
    });
    expect(
      await firstStore.claimJob({ jobId, workerId: "scheduler-three", expectedInputHash: inputHash, leaseMs: 5_000 }),
    ).toEqual({ outcome: "terminal", state: "cancelled", currentBestRevision: 2 });

    const continuationJobId = randomUUID();
    const continuationInput: ScheduleJobInput = { ...input, job_id: continuationJobId };
    const continuationInputHash = deterministicJsonHash(continuationInput);
    await sql`
      INSERT INTO schedule_generation_jobs(
        id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id,
        continued_from_job_id
      ) VALUES(
        ${continuationJobId},${organisationId},${competitionId},'balanced',${sql.json(continuationInput)},
        ${continuationInputHash},${accountId},'request-scheduler-continue','correlation-scheduler-continue',${jobId}
      )`;
    const continuation = await firstStore.claimJob({
      jobId: continuationJobId,
      workerId: "scheduler-continuation",
      expectedInputHash: continuationInputHash,
      leaseMs: 5_000,
    });
    expect(continuation).toMatchObject({
      outcome: "claimed",
      job: {
        continuedFromJobId: jobId,
        continuationIteration: 9,
        currentBest: { job_id: continuationJobId, result_revision: 1, quality: { score: 81 } },
      },
    });
    if (continuation.outcome !== "claimed") throw new Error("Expected continuation claim");
    const lineage = await sql<{ equal: boolean; current_best_option_id: string | null }[]>`
      SELECT child.problem_hash=parent.problem_hash AS equal,child.current_best_option_id
      FROM schedule_generation_jobs child
      JOIN schedule_generation_jobs parent ON parent.id=child.continued_from_job_id
      WHERE child.id=${continuationJobId}`;
    expect(lineage[0]).toMatchObject({ equal: true, current_best_option_id: expect.any(String) });
    await firstStore.finishJob({
      jobId: continuationJobId,
      workerId: "scheduler-continuation",
      fenceToken: continuation.job.fenceToken,
      state: "completed",
      currentBestRevision: 1,
    });

    const deadLetterJobId = randomUUID();
    const deadLetterInput: ScheduleJobInput = { ...input, job_id: deadLetterJobId };
    const deadLetterInputHash = deterministicJsonHash(deadLetterInput);
    await sql`
      INSERT INTO schedule_generation_jobs(
        id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id
      ) VALUES(
        ${deadLetterJobId},${organisationId},${competitionId},'balanced',${sql.json(deadLetterInput)},
        ${deadLetterInputHash},${accountId},'request-scheduler-dead','correlation-scheduler-dead'
      )`;
    const deadClaim = await firstStore.claimJob({
      jobId: deadLetterJobId,
      workerId: "scheduler-dead-letter",
      expectedInputHash: deadLetterInputHash,
      leaseMs: 5_000,
    });
    if (deadClaim.outcome !== "claimed") throw new Error("Expected dead-letter claim");
    await firstStore.checkpointBest({
      jobId: deadLetterJobId,
      workerId: "scheduler-dead-letter",
      fenceToken: deadClaim.job.fenceToken,
      expectedInputHash: deadLetterInputHash,
      candidate: {
        ...candidate(50),
        job_id: deadLetterJobId,
        source_revision: deadLetterInput.source_revision,
        assignments: result.assignments,
      },
      iteration: 2,
    });
    await firstStore.releaseAfterFailure({
      jobId: deadLetterJobId,
      workerId: "scheduler-dead-letter",
      fenceToken: deadClaim.job.fenceToken,
      failureClass: "Error",
    });
    await firstStore.markDeadLettered(deadLetterJobId, "RetryExhausted");
    expect(
      await firstStore.claimJob({
        jobId: deadLetterJobId,
        workerId: "scheduler-after-dead",
        expectedInputHash: deadLetterInputHash,
        leaseMs: 5_000,
      }),
    ).toEqual({ outcome: "terminal", state: "failed", currentBestRevision: 1 });
  });
});

async function seedWorld(ids: { accountId: string; organisationId: string; competitionId: string }) {
  await sql`INSERT INTO accounts(id,primary_email,display_name)
    VALUES(${ids.accountId},${`${ids.accountId}@example.test`},'Scheduler Test')`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organisations(id,name,slug)
      VALUES(${ids.organisationId},'Scheduler Test',${`scheduler-${ids.organisationId}`})`;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${ids.organisationId},${ids.accountId},'owner','active')`;
  });
  await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on)
    VALUES(${ids.competitionId},${ids.organisationId},${ids.accountId},'Scheduler Cup',
      ${`scheduler-cup-${ids.competitionId}`},'badminton','Asia/Singapore','2027-01-01','2027-01-02')`;
  const divisionId = randomUUID();
  await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
    VALUES(${divisionId},${ids.competitionId},'Open',8)`;
  const entryIds: string[] = [];
  for (let seed = 1; seed <= 8; seed += 1) {
    const entryId = randomUUID();
    entryIds.push(entryId);
    await sql`INSERT INTO division_entries(id,division_id,name,seed,status)
      VALUES(${entryId},${divisionId},${`Entry ${seed}`},${seed},'confirmed')`;
  }
  const areaId = randomUUID();
  const intervalId = randomUUID();
  await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
    VALUES(${areaId},${ids.competitionId},'Scheduler court',30)`;
  await sql`INSERT INTO competition_availability_windows(id,competition_id,playing_area_id,starts_at,ends_at)
    VALUES(${intervalId},${ids.competitionId},${areaId},'2027-01-01T00:00:00Z','2027-01-02T00:00:00Z')`;

  const formatRevisionId = randomUUID();
  const definition = roundRobinGraph();
  await sql`INSERT INTO format_revisions(
      id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract
    ) VALUES(
      ${formatRevisionId},${ids.competitionId},${divisionId},1,${sql.json(definition)},
      ${deterministicJsonHash(definition)},${sql.json({ schema_version: 1, stage_positions: [] })},
      ${ids.accountId},'phase3'
    )`;
  await sql`SELECT phase4_materialize_format_revision(${formatRevisionId})`;
  await sql`INSERT INTO format_validation_evidence(
      format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,slots_unambiguous,
      deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by
    ) VALUES(
      ${formatRevisionId},${deterministicJsonHash(definition)},false,false,false,false,0,0,0,false,${ids.accountId}
    )`;
  await sql`SELECT phase4_publish_format_revision(${formatRevisionId},${ids.accountId},'publish-scheduler-store')`;
  const [match] = await sql<{ id: string; possible_entry_ids: string[] }[]>`
    SELECT match.id,
      ARRAY(SELECT entry_id FROM phase4_match_possible_entries(match.id) ORDER BY entry_id) AS possible_entry_ids
    FROM matches match WHERE match.format_revision_id=${formatRevisionId} ORDER BY match.ordinal LIMIT 1`;
  const [capacity] = await sql<{ capacity_revision: number; capacity_hash: string }[]>`
    SELECT capacity_revision,phase4_capacity_hash(${ids.competitionId}) AS capacity_hash
    FROM competitions WHERE id=${ids.competitionId}`;
  if (match === undefined || capacity === undefined) throw new Error("Failed to seed authoritative schedule input");
  return {
    divisionId,
    areaId,
    intervalId,
    matchId: match.id,
    possibleEntryIds: match.possible_entry_ids,
    capacityRevision: Number(capacity.capacity_revision),
    capacityHash: capacity.capacity_hash,
  };
}

function roundRobinGraph() {
  const matches = [];
  let order = 1;
  for (let home = 1; home <= 8; home += 1) {
    for (let away = home + 1; away <= 8; away += 1) {
      matches.push({
        id: `rr-${home}-${away}`,
        stageId: "round-robin",
        round: home,
        order,
        purpose: "pool",
        home: { type: "entry_seed", seed: home },
        away: { type: "entry_seed", seed: away },
      });
      order += 1;
    }
  }
  return {
    id: "scheduler-round-robin",
    schemaVersion: 1,
    entryCount: 8,
    stages: [
      {
        id: "round-robin",
        label: "Round robin",
        kind: "round_robin",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 8,
        matchIds: matches.map((match) => match.id),
      },
    ],
    matches,
    terminalMatchIds: [],
  };
}
