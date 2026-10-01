import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "@matchday/config";
import type { Phase4FormatBuilderDocument, ScheduleConstraints, ScheduleJobInput } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { DomainScheduleOptimizer, PostgresScheduleJobStore, type ScheduleCandidate } from "@matchday/scheduler";
import { buildApp } from "../../src/app.js";
import { ErrorCode } from "../../src/errors.js";
import { GateCC4PublicTruthRuntime } from "../../src/gate-c-c4-public-truth.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const config = parseConfig(process.env);
const schema = `test_phase4_integrity_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let phase3!: Phase3Runtime;
let phase2!: Phase2Runtime;
let phase4!: Phase4Runtime;
let app!: Awaited<ReturnType<typeof buildApp>>;

let ownerId = "";
let org1Id = "";
let compId = "";
let compSlug = "";
let divisionId = "";
let match1Id = "";
let match2Id = "";
let areaId = "";

function ownerHeaders(origin = "http://localhost:3000") {
  return {
    origin,
    "x-csrf-token": "csrf-owner",
    cookie: "matchday_session=owner-token",
  };
}

function mockIdentityRuntime(): IdentityApiRuntime {
  return {
    authenticate: vi.fn(async (token: string) => {
      if (token === "owner-token") {
        return {
          account: {
            id: ownerId,
            primaryEmail: "owner@matchday.test",
            displayName: "Owner",
            status: "active",
            emailVerifiedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          sessionId: randomUUID(),
          sessionToken: token,
          csrfToken: "csrf-owner",
          idleExpiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        };
      }
      throw new Error("Invalid session token");
    }),
    verifyCsrfToken: vi.fn((token: string, csrf: string) => {
      return token === "owner-token" && csrf === "csrf-owner";
    }),
  } as unknown as IdentityApiRuntime;
}

beforeAll(async () => {
  await dropTestSchema(config.databaseUrl, schema);
  await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
  client = postgres(config.databaseUrl, { max: 10, onnotice: () => undefined, connection: { search_path: schema } });

  const [owner] = await client<{ id: string }[]>`
    INSERT INTO accounts(primary_email, display_name, email_verified_at)
    VALUES('owner@matchday.test', 'Owner', now()) RETURNING id`;
  ownerId = owner!.id;

  await client.begin(async (tx) => {
    const [org] = await tx<{ id: string }[]>`
      INSERT INTO organisations(name, slug) VALUES('Integrity Org', 'integrity-org') RETURNING id`;
    org1Id = org!.id;
    await tx`
      INSERT INTO organisation_memberships(organisation_id, account_id, role, status)
      VALUES (${org1Id}, ${ownerId}, 'owner', 'active')`;
  });

  phase3 = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
  phase2 = new Phase2Runtime(
    client as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    "phase-4-runtime-fallback-code-hmac-secret",
  );
  phase4 = new Phase4Runtime(
    client as unknown as PostgresJsSql,
    phase3,
    { enqueueSchedule: async () => ({ id: "sched-job", name: "schedule.optimize", duplicate: false }) },
    {
      mode: "stub",
      provider: new DeterministicPhase4AiStub(),
      timeoutMs: 2000,
      maximumAttempts: 1,
      cacheTtlSeconds: 3600,
    },
    undefined,
    phase2,
  );

  const generatedSlug = `integrity-cup-${randomUUID()}`;
  const comp = await phase3.createCompetition(
    { accountId: ownerId },
    {
      organisationId: org1Id,
      name: "Integrity Cup",
      slug: generatedSlug,
      sportCode: "canoe_polo",
      venue: "Pool 1",
      address: "1 Pool Way",
      countryCode: "SG",
      startsOn: "2027-08-01",
      endsOn: "2027-08-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
  );
  compId = comp.id;
  compSlug = generatedSlug;

  const [area] = await client<{ id: string }[]>`
    INSERT INTO playing_areas(competition_id, name, slot_minutes, sort_order)
    VALUES(${compId}, 'Pitch A', 30, 1) RETURNING id`;
  areaId = area!.id;

  await client`
    INSERT INTO competition_availability_windows(competition_id, playing_area_id, starts_at, ends_at)
    VALUES(${compId}, ${areaId}, '2027-08-01 08:00:00+08', '2027-08-01 18:00:00+08')`;

  const [div] = await client<{ id: string }[]>`
    INSERT INTO divisions(competition_id, name, team_limit)
    VALUES(${compId}, 'Open Division', 8) RETURNING id`;
  divisionId = div!.id;

  await client`
    INSERT INTO division_entries(division_id, name, seed, status, entry_type)
    SELECT ${divisionId}, 'Team ' || s, s, 'active', 'team'
    FROM generate_series(1, 8) s`;

  const templateGraph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
  const formatDoc: Phase4FormatBuilderDocument = {
    schema_version: 1,
    graph: templateGraph,
    layout: {
      schema_version: 1,
      stage_positions: templateGraph.stages.map((stage, index) => ({
        stage_id: stage.id,
        x: index * 240,
        y: 80,
      })),
    },
  };

  const draft = await phase4.saveFormatRevision(
    { accountId: ownerId },
    compId,
    divisionId,
    {
      draft_id: null,
      expected_revision: null,
      parent_revision_id: null,
      document: formatDoc,
      idempotency_key: `format-${randomUUID()}`,
    },
    randomUUID(),
  );

  await phase4.materialiseFormat({ accountId: ownerId }, draft.draft_id, `mat-${randomUUID()}`, randomUUID());
  await client`SELECT phase4_publish_format_revision(${draft.draft_id}, ${ownerId}, ${`pub-${randomUUID()}`})`;

  const matches = await client<{ id: string }[]>`
    SELECT id FROM matches WHERE competition_id = ${compId} ORDER BY ordinal ASC LIMIT 2`;
  match1Id = matches[0]!.id;
  match2Id = matches[1]!.id;

  app = await buildApp({
    config: testConfig(),
    probes: healthyProbes,
    identityRuntime: mockIdentityRuntime(),
    phase3Runtime: phase3,
    phase4Runtime: phase4,
    phase2Runtime: phase2,
    gateCC4PublicTruthRuntime: new GateCC4PublicTruthRuntime(client as unknown as PostgresJsSql),
  });
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (client) {
    await client.end();
    await dropTestSchema(config.databaseUrl, schema);
  }
});

function getConstraints(): ScheduleConstraints {
  return {
    minimum_rest: { mode: "ignored", value: { minutes: 0 } },
    maximum_matches_per_day: { mode: "ignored", value: { matches: 8 } },
    preferred_final_time: {
      mode: "ignored",
      value: { target_start_epoch_ms: Date.parse("2027-08-01T12:00:00Z"), tolerance_minutes: 60 },
    },
    entry_unavailable: { mode: "ignored", value: { by_entry_id: {} } },
    official_availability: {
      mode: "ignored",
      value: { by_official_id: {} },
    },
    featured_playing_area: { mode: "ignored", value: { area_id: areaId, match_ids: [] } },
    avoid_consecutive_matches: { mode: "ignored", value: { minutes: 0 } },
    balance_early_matches: { mode: "ignored", value: { before_local_time: "09:00" } },
    balance_late_matches: { mode: "ignored", value: { at_or_after_local_time: "18:00" } },
    keep_division_together: { mode: "ignored", value: { maximum_area_count: 1 } },
    preserve_existing_schedule: { mode: "ignored", value: { maximum_shift_minutes: 0, by_match_id: {} } },
  };
}

async function solveAndAcceptSchedule(currentCompId: string) {
  await client`DELETE FROM schedule_generation_jobs WHERE competition_id=${currentCompId} AND status IN ('queued','running','valid_best_found','cancelling')`;

  const comp = (
    await client<{ revision: number; capacity_revision: number }[]>`
    SELECT revision::int revision, capacity_revision::int capacity_revision FROM competitions WHERE id=${currentCompId}`
  )[0]!;

  const gen = await phase4.generateSchedule(
    { accountId: ownerId },
    currentCompId,
    {
      idempotency_key: `gen-${randomUUID()}`,
      expected_source_revision: Number(comp.revision),
      expected_capacity_revision: Number(comp.capacity_revision),
      objective: "balanced",
      constraints: getConstraints(),
    },
    randomUUID(),
  );

  const store = new PostgresScheduleJobStore(client);
  const [jobRow] = await client<{ input_hash: string; input_snapshot: ScheduleJobInput }[]>`
    SELECT input_hash, input_snapshot FROM schedule_generation_jobs WHERE id=${gen.job.id}`;

  const claim = await store.claimJob({
    jobId: gen.job.id,
    workerId: "test-worker",
    expectedInputHash: jobRow!.input_hash,
    leaseMs: 30_000,
  });
  if (claim.outcome !== "claimed") throw new Error(`Claim failed: ${claim.outcome}`);

  const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 16, workerExecArgv: [] });
  let bestCandidate: ScheduleCandidate | null = null;
  for await (const candidate of optimizer.optimize({
    input: claim.job.input,
    seed: null,
    startIteration: 0,
    signal: new AbortController().signal,
    maxYieldIntervalMs: 15_000,
  })) {
    bestCandidate = candidate;
    break;
  }
  if (!bestCandidate) throw new Error("No candidate generated");

  const checkpoint = await store.checkpointBest({
    jobId: gen.job.id,
    workerId: "test-worker",
    fenceToken: claim.job.fenceToken,
    expectedInputHash: claim.job.inputHash,
    candidate: bestCandidate.result,
    iteration: 0,
    exploredCandidates: 1,
  });
  if (!checkpoint.accepted || !checkpoint.result) throw new Error("Checkpoint failed");

  await store.finishJob({
    jobId: gen.job.id,
    workerId: "test-worker",
    fenceToken: claim.job.fenceToken,
    state: "completed",
    currentBestRevision: checkpoint.result.result_revision,
  });

  const [jobAfter] = await client<{ revision: number; current_best_option_id: string }[]>`
    SELECT revision, current_best_option_id FROM schedule_generation_jobs WHERE id=${gen.job.id}`;

  const accepted = await phase4.acceptScheduleOption(
    { accountId: ownerId },
    gen.job.id,
    jobAfter!.current_best_option_id,
    { idempotency_key: `accept-${randomUUID()}`, expected_job_revision: jobAfter!.revision },
    randomUUID(),
  );

  return {
    jobId: gen.job.id,
    scheduleRevisionId: accepted.id,
    revision: accepted.revision,
    assignmentHash: accepted.assignment_hash,
    sourceRevision: Number(comp.revision),
  };
}

describe("SCH-006 Checkpoint 6 — Revision, Move & Publication Integrity", () => {
  it("CP 6.0 & CP 6.1: Authoritative currentness predicate and SCH-006 staleness integration", async () => {
    // 1. Setup official A and B
    const offARes = await app.inject({
      method: "POST",
      url: `/api/v1/phase4/competitions/${compId}/officials`,
      headers: ownerHeaders(),
      payload: { name: "Referee Alpha", default_role: "referee" },
    });
    const offA = JSON.parse(offARes.body);

    const offBRes = await app.inject({
      method: "POST",
      url: `/api/v1/phase4/competitions/${compId}/officials`,
      headers: ownerHeaders(),
      payload: { name: "Referee Bravo", default_role: "referee" },
    });
    const offB = JSON.parse(offBRes.body);

    // Initial match assignment: only offA
    await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/matches/${match1Id}/officials`,
      headers: ownerHeaders(),
      payload: { assignments: [{ official_id: offA.id, assigned_role: "referee" }] },
    });

    // Generate, solve and accept schedule at revision R
    const initialSchedule = await solveAndAcceptSchedule(compId);

    // Verify workspace reports 'current'
    const wsBefore = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsBefore.current_revision_input_state).toBe("current");

    // CP 6.1 #2: Schedule-relevant assignment change: A -> A + B
    const assignRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/matches/${match1Id}/officials`,
      headers: ownerHeaders(),
      payload: {
        assignments: [
          { official_id: offA.id, assigned_role: "referee" },
          { official_id: offB.id, assigned_role: "assistant_referee" },
        ],
      },
    });
    expect(assignRes.statusCode).toBe(200);
    const assignBody = JSON.parse(assignRes.body);
    expect(assignBody.bumped_revision).toBe(true);

    // Verify predicate and workspace state
    const wsAfter = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsAfter.current_revision_input_state).toBe("stale");

    // CP 6.2: Stale Move Integrity (validate and move both fail with 409 STALE_SCHEDULE_INPUT)
    const [slotRow] = await client<{ start_epoch_ms: number; end_epoch_ms: number }[]>`
      SELECT extract(epoch from starts_at)*1000 start_epoch_ms, extract(epoch from ends_at)*1000 end_epoch_ms
      FROM competition_availability_windows WHERE competition_id=${compId} LIMIT 1`;

    await expect(
      phase4.validateScheduleMove({ accountId: ownerId }, initialSchedule.scheduleRevisionId, {
        match_id: match1Id,
        playing_area_id: areaId,
        slot_id: "pitch-a:1",
        start_epoch_ms: Number(slotRow!.start_epoch_ms),
        end_epoch_ms: Number(slotRow!.end_epoch_ms),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    await expect(
      phase4.moveScheduleMatch(
        { accountId: ownerId },
        initialSchedule.scheduleRevisionId,
        {
          idempotency_key: `move-${randomUUID()}`,
          expected_revision: initialSchedule.revision,
          match_id: match1Id,
          playing_area_id: areaId,
          slot_id: "pitch-a:1",
          start_epoch_ms: Number(slotRow!.start_epoch_ms),
          end_epoch_ms: Number(slotRow!.end_epoch_ms),
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // CP 6.3: Stale Mark-Ready Integrity
    await expect(
      phase4.markScheduleReady(
        { accountId: ownerId },
        initialSchedule.scheduleRevisionId,
        { idempotency_key: `ready-${randomUUID()}`, expected_revision: initialSchedule.revision },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // CP 6.4: Stale Publish Integrity
    await expect(
      phase4.publishScheduleRevision(
        { accountId: ownerId },
        initialSchedule.scheduleRevisionId,
        { idempotency_key: `pub-${randomUUID()}`, expected_revision: initialSchedule.revision },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // CP 6.7: Stale Schedule Inspection Preserved
    const staleDoc = await phase4.readScheduleRevision({ accountId: ownerId }, initialSchedule.scheduleRevisionId);
    expect(staleDoc.id).toBe(initialSchedule.scheduleRevisionId);
    expect(staleDoc.assignments.length).toBeGreaterThan(0);
  });

  it("CP 6.1 #3 & #4: Assigned official availability change and assigned archive stale the schedule", async () => {
    // Regenerate and accept a fresh schedule
    await solveAndAcceptSchedule(compId);
    const wsFresh = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsFresh.current_revision_input_state).toBe("current");

    // Get an assigned official
    const assignedRow = (
      await client<{ official_id: string }[]>`
      SELECT official_id FROM match_official_assignments LIMIT 1`
    )[0]!;

    // Assigned official availability change -> bumped_revision=true
    const availRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow.official_id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T09:00:00.000Z", ends_at: "2027-08-01T12:00:00.000Z" }],
      },
    });
    expect(availRes.statusCode).toBe(200);
    expect(JSON.parse(availRes.body).bumped_revision).toBe(true);

    const wsAfterAvail = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsAfterAvail.current_revision_input_state).toBe("stale");

    // Now regenerate fresh schedule
    await solveAndAcceptSchedule(compId);
    const wsFresh2 = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsFresh2.current_revision_input_state).toBe("current");

    // Archive assigned official -> bumped_revision=true
    const archiveRes = await app.inject({
      method: "POST",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow.official_id}/archive`,
      headers: ownerHeaders(),
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(JSON.parse(archiveRes.body).bumped_revision).toBe(true);

    const wsAfterArchive = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsAfterArchive.current_revision_input_state).toBe("stale");
  });

  it("CP 6.1 #5: Scheduling-Neutral Controls do NOT stale the schedule", async () => {
    // 1. Create an official to be assigned
    const assignedOffRes = await app.inject({
      method: "POST",
      url: `/api/v1/phase4/competitions/${compId}/officials`,
      headers: ownerHeaders(),
      payload: { name: "Assigned For Neutral Test", default_role: "referee" },
    });
    const assignedOff = JSON.parse(assignedOffRes.body);

    await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/matches/${match2Id}/officials`,
      headers: ownerHeaders(),
      payload: {
        assignments: [{ official_id: assignedOff.id, assigned_role: "referee" }],
      },
    });

    // 2. Generate and accept fresh schedule with this assignment in place
    const freshSchedule = await solveAndAcceptSchedule(compId);
    const wsFresh = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsFresh.current_revision_input_state).toBe("current");

    // 3. Create unassigned official
    const unassignedRes = await app.inject({
      method: "POST",
      url: `/api/v1/phase4/competitions/${compId}/officials`,
      headers: ownerHeaders(),
      payload: { name: "Unassigned Official", default_role: "referee" },
    });
    const unassignedOff = JSON.parse(unassignedRes.body);

    // 4. Official rename
    const renameRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/phase4/competitions/${compId}/officials/${unassignedOff.id}`,
      headers: ownerHeaders(),
      payload: { name: "Renamed Official" },
    });
    expect(renameRes.statusCode).toBe(200);

    // 5. Default role edit
    const roleRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/phase4/competitions/${compId}/officials/${unassignedOff.id}`,
      headers: ownerHeaders(),
      payload: { default_role: "table_official" },
    });
    expect(roleRes.statusCode).toBe(200);

    // 6. Unassigned official availability change
    const unavailRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${unassignedOff.id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T10:00:00.000Z", ends_at: "2027-08-01T14:00:00.000Z" }],
      },
    });
    expect(unavailRes.statusCode).toBe(200);
    expect(JSON.parse(unavailRes.body).bumped_revision).toBe(false);

    // 7. Canonical availability no-op
    const noopRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${unassignedOff.id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T10:00:00.000Z", ends_at: "2027-08-01T14:00:00.000Z" }],
      },
    });
    expect(noopRes.statusCode).toBe(200);
    expect(JSON.parse(noopRes.body).bumped_revision).toBe(false);

    // 8. Archive unassigned official
    const archiveUnassignedRes = await app.inject({
      method: "POST",
      url: `/api/v1/phase4/competitions/${compId}/officials/${unassignedOff.id}/archive`,
      headers: ownerHeaders(),
    });
    expect(archiveUnassignedRes.statusCode).toBe(200);
    expect(JSON.parse(archiveUnassignedRes.body).bumped_revision).toBe(false);

    // 9. Assigned role-only change
    const roleOnlyRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/matches/${match2Id}/officials`,
      headers: ownerHeaders(),
      payload: {
        assignments: [{ official_id: assignedOff.id, assigned_role: "table_official" }],
      },
    });
    expect(roleOnlyRes.statusCode).toBe(200);
    expect(JSON.parse(roleOnlyRes.body).bumped_revision).toBe(false);

    // 10. Same assignment membership replay
    const replayRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/matches/${match2Id}/officials`,
      headers: ownerHeaders(),
      payload: {
        assignments: [{ official_id: assignedOff.id, assigned_role: "table_official" }],
      },
    });
    expect(replayRes.statusCode).toBe(200);
    expect(JSON.parse(replayRes.body).bumped_revision).toBe(false);

    // Verify workspace still reports 'current'
    const wsStillCurrent = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsStillCurrent.current_revision_input_state).toBe("current");

    // Publishing remains permitted for current revision
    const published = await phase4.publishScheduleRevision(
      { accountId: ownerId },
      freshSchedule.scheduleRevisionId,
      { idempotency_key: `pub-current-${randomUUID()}`, expected_revision: freshSchedule.revision },
      randomUUID(),
    );
    expect(published.status).toBe("published");
  });

  it("CP 6.5 & CP 6.6: Complete Published-History and Public Truth Proof under official mutation", async () => {
    // 1. Before mutation capture
    const [pubBefore] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    const s1RevisionId = pubBefore!.published_schedule_revision_id;
    const initialVersion = pubBefore!.schedule_version;

    // Capture S1 revision row and assignment_hash
    const [s1RowBefore] = await client<{ id: string; status: string; published_at: Date; assignment_hash: string }[]>`
      SELECT id, status, published_at, assignment_hash FROM schedule_revisions WHERE id=${s1RevisionId}`;
    expect(s1RowBefore).toBeDefined();
    expect(s1RowBefore!.status).toBe("published");
    expect(s1RowBefore!.published_at).not.toBeNull();
    const originalPublishedAt = s1RowBefore!.published_at;
    const originalHash = s1RowBefore!.assignment_hash;

    // Capture all scheduled_matches for S1 deterministically ordered by match_id
    const s1MatchesBefore = await client<
      { match_id: string; playing_area_id: string; starts_at: Date; ends_at: Date }[]
    >`
      SELECT match_id, playing_area_id, starts_at, ends_at
      FROM scheduled_matches
      WHERE schedule_revision_id=${s1RevisionId}
      ORDER BY match_id`;
    expect(s1MatchesBefore.length).toBeGreaterThan(0);

    // Capture public truth response and ETag
    const publicBefore = await app.inject({
      method: "GET",
      url: `/api/v1/public/competitions/${compSlug}/current`,
    });
    expect(publicBefore.statusCode).toBe(200);
    const s1Etag = publicBefore.headers["etag"];
    expect(s1Etag).toBeDefined();
    const s1PublicBody = publicBefore.body;

    // 2. Perform official scheduling-input mutation
    const [assignedRow] = await client<{ official_id: string }[]>`
      SELECT official_id FROM match_official_assignments WHERE competition_id=${compId} LIMIT 1`;

    const availMutRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow!.official_id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T08:00:00.000Z", ends_at: "2027-08-01T09:00:00.000Z" }],
      },
    });
    expect(availMutRes.statusCode).toBe(200);
    expect(JSON.parse(availMutRes.body).bumped_revision).toBe(true);

    // 3. Assert all unchanged after official mutation:
    // S1.id, S1.status, S1.published_at, S1.assignment_hash
    const [s1RowAfter] = await client<{ id: string; status: string; published_at: Date; assignment_hash: string }[]>`
      SELECT id, status, published_at, assignment_hash FROM schedule_revisions WHERE id=${s1RevisionId}`;
    expect(s1RowAfter!.id).toBe(s1RevisionId);
    expect(s1RowAfter!.status).toBe("published");
    expect(s1RowAfter!.published_at.toISOString()).toBe(originalPublishedAt.toISOString());
    expect(s1RowAfter!.assignment_hash).toBe(originalHash);

    // Immutable scheduled_matches: exact semantic equality
    const s1MatchesAfter = await client<
      { match_id: string; playing_area_id: string; starts_at: Date; ends_at: Date }[]
    >`
      SELECT match_id, playing_area_id, starts_at, ends_at
      FROM scheduled_matches
      WHERE schedule_revision_id=${s1RevisionId}
      ORDER BY match_id`;
    expect(s1MatchesAfter).toEqual(s1MatchesBefore);

    // competition_publications.schedule_version and published_schedule_revision_id
    const [pubAfter] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    expect(pubAfter!.schedule_version).toBe(initialVersion);
    expect(pubAfter!.published_schedule_revision_id).toBe(s1RevisionId);

    // Public schedule body and ETag
    const publicAfter = await app.inject({
      method: "GET",
      url: `/api/v1/public/competitions/${compSlug}/current`,
    });
    expect(publicAfter.statusCode).toBe(200);
    expect(publicAfter.headers["etag"]).toBe(s1Etag);
    expect(publicAfter.body).toBe(s1PublicBody);

    // Conditional request with S1 ETag yields 304 Not Modified
    const condRes = await app.inject({
      method: "GET",
      url: `/api/v1/public/competitions/${compSlug}/current`,
      headers: { "if-none-match": s1Etag },
    });
    expect(condRes.statusCode).toBe(304);

    // 4. CP 6.6: Explicit S2 publication changes public truth and ETag
    const regenerated = await solveAndAcceptSchedule(compId);
    const wsRegen = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsRegen.current_revision_input_state).toBe("current");

    const newPublish = await phase4.publishScheduleRevision(
      { accountId: ownerId },
      regenerated.scheduleRevisionId,
      { idempotency_key: `pub-regen-${randomUUID()}`, expected_revision: regenerated.revision },
      randomUUID(),
    );
    expect(newPublish.status).toBe("published");
    expect(newPublish.schedule_version).toBe(initialVersion + 1);

    // Pointer points to S2
    const [pubFinal] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    expect(pubFinal!.published_schedule_revision_id).toBe(regenerated.scheduleRevisionId);
    expect(pubFinal!.schedule_version).toBe(initialVersion + 1);

    // S1 remains immutable in history (superseded by S2)
    const [s1Final] = await client<{ id: string; status: string; published_at: Date; assignment_hash: string }[]>`
      SELECT id, status, published_at, assignment_hash FROM schedule_revisions WHERE id=${s1RevisionId}`;
    expect(s1Final!.status).toBe("superseded");
    expect(s1Final!.published_at.toISOString()).toBe(originalPublishedAt.toISOString());

    // Public truth now reflects S2 with new ETag
    const publicS2 = await app.inject({
      method: "GET",
      url: `/api/v1/public/competitions/${compSlug}/current`,
    });
    expect(publicS2.statusCode).toBe(200);
    const s2Etag = publicS2.headers["etag"];
    expect(s2Etag).toBeDefined();
    expect(s2Etag).not.toBe(s1Etag);

    // Conditional request with old S1 ETag returns 200 with new representation
    const condOldRes = await app.inject({
      method: "GET",
      url: `/api/v1/public/competitions/${compSlug}/current`,
      headers: { "if-none-match": s1Etag },
    });
    expect(condOldRes.statusCode).toBe(200);
    expect(condOldRes.headers["etag"]).toBe(s2Etag);
  });

  it("CP 6.13, 6.16, 6.17, 6.18: Idempotent publish replay after later official mutation, failed stale receipt safety, and fresh retry", async () => {
    // 1. Generate and accept S3
    const s3 = await solveAndAcceptSchedule(compId);
    const idemKey = `idem-pub-${randomUUID()}`;

    // Publish once
    const pubReceipt = await phase4.publishScheduleRevision(
      { accountId: ownerId },
      s3.scheduleRevisionId,
      { idempotency_key: idemKey, expected_revision: s3.revision },
      randomUUID(),
    );
    expect(pubReceipt.idempotent_replay).toBe(false);
    const publishedVersion = pubReceipt.schedule_version;

    // Capture audit count before replay
    const [auditBefore] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM audit_events WHERE action = 'schedule.publish' AND organisation_id = ${org1Id}`;

    // 2. Perform official scheduling-input mutation -> bumps competition revision
    const [assignedRow] = await client<{ official_id: string }[]>`
      SELECT official_id FROM match_official_assignments WHERE competition_id=${compId} LIMIT 1`;
    const mutRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow!.official_id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T06:00:00.000Z", ends_at: "2027-08-01T07:00:00.000Z" }],
      },
    });
    expect(mutRes.statusCode).toBe(200);
    expect(JSON.parse(mutRes.body).bumped_revision).toBe(true);

    // 3. Replay exact publish request with key K
    const replay = await phase4.publishScheduleRevision(
      { accountId: ownerId },
      s3.scheduleRevisionId,
      { idempotency_key: idemKey, expected_revision: s3.revision },
      randomUUID(),
    );
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.id).toBe(pubReceipt.id);
    expect(replay.schedule_version).toBe(publishedVersion);

    // Assert: schedule_version and published_schedule_revision_id unchanged
    const [pubCheck] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    expect(pubCheck!.schedule_version).toBe(publishedVersion);
    expect(pubCheck!.published_schedule_revision_id).toBe(s3.scheduleRevisionId);

    // Assert: no second audit/outbox success mutation
    const [auditAfter] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM audit_events WHERE action = 'schedule.publish' AND organisation_id = ${org1Id}`;
    expect(auditAfter!.count).toBe(auditBefore!.count);

    // 4. Failed Stale Publication Receipt (CP 6A #17)
    const sStale = await solveAndAcceptSchedule(compId);
    const staleMut = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow!.official_id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T05:00:00.000Z", ends_at: "2027-08-01T06:00:00.000Z" }],
      },
    });
    expect(JSON.parse(staleMut.body).bumped_revision).toBe(true);

    const staleKey = `stale-attempt-${randomUUID()}`;
    await expect(
      phase4.publishScheduleRevision(
        { accountId: ownerId },
        sStale.scheduleRevisionId,
        { idempotency_key: staleKey, expected_revision: sStale.revision },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // Failed attempt creates NO successful receipt
    const [staleReceipt] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM phase4_mutation_receipts
      WHERE idempotency_key = ${staleKey}`;
    expect(staleReceipt!.count).toBe(0);

    // 5. Fresh Retry (CP 6A #18)
    const s4 = await solveAndAcceptSchedule(compId);
    const ws4 = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(ws4.current_revision_input_state).toBe("current");

    const freshKey = `fresh-retry-${randomUUID()}`;
    const freshPub = await phase4.publishScheduleRevision(
      { accountId: ownerId },
      s4.scheduleRevisionId,
      { idempotency_key: freshKey, expected_revision: s4.revision },
      randomUUID(),
    );
    expect(freshPub.status).toBe("published");
    expect(freshPub.idempotent_replay).toBe(false);
    expect(freshPub.schedule_version).toBe(publishedVersion + 1);

    const [finalPub] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    expect(finalPub!.published_schedule_revision_id).toBe(s4.scheduleRevisionId);
    expect(finalPub!.schedule_version).toBe(publishedVersion + 1);
  });

  it("Preserves stale input state when a subsequent neutral official mutation occurs", async () => {
    // 1. Generate and accept a fresh schedule
    await solveAndAcceptSchedule(compId);
    const wsFresh = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsFresh.current_revision_input_state).toBe("current");

    // 2. Introduce a schedule-relevant change to make it stale
    const [assignedRow] = await client<{ official_id: string }[]>`
      SELECT official_id FROM match_official_assignments WHERE competition_id=${compId} LIMIT 1`;

    const staleRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow!.official_id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T07:00:00.000Z", ends_at: "2027-08-01T08:00:00.000Z" }],
      },
    });
    expect(staleRes.statusCode).toBe(200);
    expect(JSON.parse(staleRes.body).bumped_revision).toBe(true);

    const wsStale = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsStale.current_revision_input_state).toBe("stale");

    // 3. Perform a neutral change (e.g. rename official, bumped_revision=false)
    const renameRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow!.official_id}`,
      headers: ownerHeaders(),
      payload: { name: "Renamed Stale Preserved" },
    });
    expect(renameRes.statusCode).toBe(200);

    // 4. Verify schedule workspace REMAINS stale (never clears invalidation)
    const wsStillStale = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsStillStale.current_revision_input_state).toBe("stale");
  });

  it("CP 6.12 Case 1: Official-First → Publish (Concurrent Mutex / Serialization)", async () => {
    // 1. Generate and accept a fresh schedule
    const fresh = await solveAndAcceptSchedule(compId);
    const ws = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(ws.current_revision_input_state).toBe("current");

    const [pubBefore] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    const pubBeforeVersion = pubBefore!.schedule_version;
    const pubBeforeRevisionId = pubBefore!.published_schedule_revision_id;

    const publicBefore = await app.inject({ method: "GET", url: `/api/v1/public/competitions/${compSlug}/current` });
    const publicBeforeEtag = publicBefore.headers["etag"];

    // 2. Simulate concurrent execution where an official mutation starts and holds the advisory lock
    // while a publishScheduleRevision request is dispatched.
    let unblockTx1: () => void = () => {};
    const tx1Blocked = new Promise<void>((resolve) => {
      unblockTx1 = resolve;
    });

    let tx1Ready: () => void = () => {};
    const tx1Acquired = new Promise<void>((resolve) => {
      tx1Ready = resolve;
    });

    // Start tx1: acquires lock, signals ready, waits for trigger, then bumps revision and commits
    const tx1Promise = client.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2, 0))`, ["phase4-schedule", compId]);
      tx1Ready();
      await tx1Blocked;
      await tx.unsafe(`UPDATE competitions SET revision = revision + 1 WHERE id = $1`, [compId]);
    });

    // Wait until tx1 has acquired the lock
    await tx1Acquired;

    // Tx2: Attempt to publish schedule revision. It starts, but will block trying to acquire the same advisory lock.
    const pubIdemKey = `pub-concurrent-${randomUUID()}`;
    const publishPromise = phase4.publishScheduleRevision(
      { accountId: ownerId },
      fresh.scheduleRevisionId,
      { idempotency_key: pubIdemKey, expected_revision: fresh.revision },
      randomUUID(),
    );

    // Give tx2 a moment to enter and queue on the advisory lock
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Release tx1 so tx1 bumps revision and commits
    unblockTx1();
    await tx1Promise;

    // Now tx2 unblocks, checks currentness, and must fail with 409 STALE_SCHEDULE_INPUT
    await expect(publishPromise).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // Postconditions:
    // schedule_version unchanged
    const [pubAfter] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    expect(pubAfter!.schedule_version).toBe(pubBeforeVersion);
    expect(pubAfter!.published_schedule_revision_id).toBe(pubBeforeRevisionId);

    // no schedule.publish success receipt
    const [receiptRow] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM phase4_mutation_receipts
      WHERE operation = 'schedule.publish' AND idempotency_key = ${pubIdemKey}`;
    expect(receiptRow!.count).toBe(0);

    // no public projection change
    const publicAfter = await app.inject({ method: "GET", url: `/api/v1/public/competitions/${compSlug}/current` });
    expect(publicAfter.headers["etag"]).toBe(publicBeforeEtag);
  });

  it("CP 6.12 Case 2: Official-First → Move (Concurrent Mutex / Serialization)", async () => {
    // 1. Fresh accepted revision S
    const fresh = await solveAndAcceptSchedule(compId);
    const ws = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(ws.current_revision_input_state).toBe("current");

    const occupiedSlots = new Set(ws.current_revision!.assignments.map((assignment) => assignment.slot_id));
    const movable = ws.current_revision!.assignments.at(-1)!;
    let validTarget: { area_id: string; slot_id: string; start_epoch_ms: number; end_epoch_ms: number } | null = null;
    for (const area of ws.areas) {
      for (const slot of area.slots) {
        if (occupiedSlots.has(slot.id)) continue;
        const preview = await phase4.validateScheduleMove({ accountId: ownerId }, fresh.scheduleRevisionId, {
          match_id: movable.match_id,
          playing_area_id: area.id,
          slot_id: slot.id,
          start_epoch_ms: slot.start_epoch_ms,
          end_epoch_ms: slot.end_epoch_ms,
        });
        if (preview.validation.valid) {
          validTarget = {
            area_id: area.id,
            slot_id: slot.id,
            start_epoch_ms: slot.start_epoch_ms,
            end_epoch_ms: slot.end_epoch_ms,
          };
          break;
        }
      }
      if (validTarget) break;
    }
    expect(validTarget).not.toBeNull();

    // 2. Transaction A acquires lock, waits, bumps revision, commits
    let unblockTx1: () => void = () => {};
    const tx1Blocked = new Promise<void>((resolve) => {
      unblockTx1 = resolve;
    });

    let tx1Ready: () => void = () => {};
    const tx1Acquired = new Promise<void>((resolve) => {
      tx1Ready = resolve;
    });

    const tx1Promise = client.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2, 0))`, ["phase4-schedule", compId]);
      tx1Ready();
      await tx1Blocked;
      await tx.unsafe(`UPDATE competitions SET revision = revision + 1 WHERE id = $1`, [compId]);
    });

    await tx1Acquired;

    // Concurrent move queued behind advisory lock
    const moveKey = `move-concurrent-${randomUUID()}`;
    const movePromise = phase4.moveScheduleMatch(
      { accountId: ownerId },
      fresh.scheduleRevisionId,
      {
        idempotency_key: moveKey,
        expected_revision: fresh.revision,
        match_id: movable.match_id,
        playing_area_id: validTarget!.area_id,
        slot_id: validTarget!.slot_id,
        start_epoch_ms: validTarget!.start_epoch_ms,
        end_epoch_ms: validTarget!.end_epoch_ms,
      },
      randomUUID(),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    unblockTx1();
    await tx1Promise;

    // Expected: move rejects 409 STALE_SCHEDULE_INPUT
    await expect(movePromise).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // Assert: no child revision created
    const [childCount] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM schedule_revisions WHERE parent_revision_id = ${fresh.scheduleRevisionId}`;
    expect(childCount!.count).toBe(0);

    // Assert: no scheduled_matches for a child revision
    const [childMatches] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM scheduled_matches
      WHERE schedule_revision_id IN (SELECT id FROM schedule_revisions WHERE parent_revision_id = ${fresh.scheduleRevisionId})`;
    expect(childMatches!.count).toBe(0);

    // Assert: no schedule.move success receipt
    const [receiptRow] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM phase4_mutation_receipts
      WHERE operation = 'schedule.move' AND idempotency_key = ${moveKey}`;
    expect(receiptRow!.count).toBe(0);

    // Assert: no schedule.match.moved success audit event
    const [auditCount] = await client<{ count: number }[]>`
      SELECT count(*)::int as count FROM audit_events
      WHERE action = 'schedule.match.moved' AND organisation_id = ${org1Id} AND target_id = ${movable.match_id}`;
    expect(auditCount!.count).toBe(0);
  });

  it("CP 6.12 Case 3: Move-First → Official Mutation (Sequential / Serialization)", async () => {
    // 1. Fresh accepted revision S1
    const s1 = await solveAndAcceptSchedule(compId);
    const ws1 = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(ws1.current_revision_input_state).toBe("current");

    const occupiedSlots = new Set(ws1.current_revision!.assignments.map((assignment) => assignment.slot_id));
    const movable = ws1.current_revision!.assignments.at(-1)!;
    let validTarget: { area_id: string; slot_id: string; start_epoch_ms: number; end_epoch_ms: number } | null = null;
    for (const area of ws1.areas) {
      for (const slot of area.slots) {
        if (occupiedSlots.has(slot.id)) continue;
        const preview = await phase4.validateScheduleMove({ accountId: ownerId }, s1.scheduleRevisionId, {
          match_id: movable.match_id,
          playing_area_id: area.id,
          slot_id: slot.id,
          start_epoch_ms: slot.start_epoch_ms,
          end_epoch_ms: slot.end_epoch_ms,
        });
        if (preview.validation.valid) {
          validTarget = {
            area_id: area.id,
            slot_id: slot.id,
            start_epoch_ms: slot.start_epoch_ms,
            end_epoch_ms: slot.end_epoch_ms,
          };
          break;
        }
      }
      if (validTarget) break;
    }
    expect(validTarget).not.toBeNull();

    // 2. Move transaction executes first and commits successfully -> produces S2
    const moveKey = `move-first-${randomUUID()}`;
    const s2 = await phase4.moveScheduleMatch(
      { accountId: ownerId },
      s1.scheduleRevisionId,
      {
        idempotency_key: moveKey,
        expected_revision: s1.revision,
        match_id: movable.match_id,
        playing_area_id: validTarget!.area_id,
        slot_id: validTarget!.slot_id,
        start_epoch_ms: validTarget!.start_epoch_ms,
        end_epoch_ms: validTarget!.end_epoch_ms,
      },
      randomUUID(),
    );
    expect(s2.revision).toBe(s1.revision + 1);

    // 3. Scheduling-relevant official mutation acquires lock and commits
    const [assignedRow] = await client<{ official_id: string }[]>`
      SELECT official_id FROM match_official_assignments WHERE competition_id=${compId} LIMIT 1`;
    const mutRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow!.official_id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T08:30:00.000Z", ends_at: "2027-08-01T11:30:00.000Z" }],
      },
    });
    expect(mutRes.statusCode).toBe(200);
    expect(JSON.parse(mutRes.body).bumped_revision).toBe(true);

    // 4. S2 exists
    const s2Detail = await phase4.readScheduleRevision({ accountId: ownerId }, s2.id);
    expect(s2Detail.id).toBe(s2.id);

    // S2 current_revision_input_state becomes stale
    const wsAfter = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsAfter.current_revision?.id).toBe(s2.id);
    expect(wsAfter.current_revision_input_state).toBe("stale");

    // S2 cannot subsequently be moved
    await expect(
      phase4.moveScheduleMatch(
        { accountId: ownerId },
        s2.id,
        {
          idempotency_key: `move-after-stale-${randomUUID()}`,
          expected_revision: s2.revision,
          match_id: movable.match_id,
          playing_area_id: validTarget!.area_id,
          slot_id: validTarget!.slot_id,
          start_epoch_ms: validTarget!.start_epoch_ms,
          end_epoch_ms: validTarget!.end_epoch_ms,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // S2 cannot subsequently be marked ready
    await expect(
      phase4.markScheduleReady(
        { accountId: ownerId },
        s2.id,
        { idempotency_key: `ready-after-stale-${randomUUID()}`, expected_revision: s2.revision },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });

    // S2 cannot subsequently be published
    await expect(
      phase4.publishScheduleRevision(
        { accountId: ownerId },
        s2.id,
        { idempotency_key: `pub-after-stale-${randomUUID()}`, expected_revision: s2.revision },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.STALE_SCHEDULE_INPUT,
    });
  });

  it("CP 6.12 Case 4: Publish-First → Official Mutation (Sequential / Serialization)", async () => {
    // 1. Fresh review-ready S1
    const s1 = await solveAndAcceptSchedule(compId);
    const pubRes = await phase4.publishScheduleRevision(
      { accountId: ownerId },
      s1.scheduleRevisionId,
      { idempotency_key: `pub-first-${randomUUID()}`, expected_revision: s1.revision },
      randomUUID(),
    );
    expect(pubRes.status).toBe("published");
    const publishedVersion = pubRes.schedule_version;

    // 2. Official scheduling-input mutation commits
    const [assignedRow] = await client<{ official_id: string }[]>`
      SELECT official_id FROM match_official_assignments WHERE competition_id=${compId} LIMIT 1`;
    const mutRes = await app.inject({
      method: "PUT",
      url: `/api/v1/phase4/competitions/${compId}/officials/${assignedRow!.official_id}/availability`,
      headers: ownerHeaders(),
      payload: {
        windows: [{ starts_at: "2027-08-01T07:30:00.000Z", ends_at: "2027-08-01T10:30:00.000Z" }],
      },
    });
    expect(mutRes.statusCode).toBe(200);
    expect(JSON.parse(mutRes.body).bumped_revision).toBe(true);

    // 3. Postconditions:
    // S1 remains published
    const [s1Row] = await client<{ status: string }[]>`
      SELECT status FROM schedule_revisions WHERE id=${s1.scheduleRevisionId}`;
    expect(s1Row!.status).toBe("published");

    // public remains S1
    const [pubRow] = await client<{ schedule_version: number; published_schedule_revision_id: string }[]>`
      SELECT schedule_version, published_schedule_revision_id FROM competition_publications WHERE competition_id=${compId}`;
    expect(pubRow!.published_schedule_revision_id).toBe(s1.scheduleRevisionId);
    expect(pubRow!.schedule_version).toBe(publishedVersion);

    // schedule_version does not increment again
    expect(pubRow!.schedule_version).toBe(publishedVersion);

    // private freshness becomes stale
    const wsAfter = await phase4.scheduleWorkspace({ accountId: ownerId }, compId);
    expect(wsAfter.current_revision_input_state).toBe("stale");
  });
});
