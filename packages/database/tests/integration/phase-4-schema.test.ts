import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultFormatTemplates, type FormatGraph } from "../../../domain/src/index.js";
import { dropTestSchema, migrateDatabase, migrationAdvisoryLockId } from "../../src/migrations.js";
import { contendedMigrationTestTimeoutMs } from "./migration-test-settings.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_schema_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
let sql!: Sql;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function roundRobinGraph(id = "phase4-eight", extended = false) {
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
    id,
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
        ...(extended
          ? {
              repetitions: 1,
              seeding: "snake",
              placementRule: { coverage: "full", positions: [1, 2, 3, 4, 5, 6, 7, 8] },
              carriedResults: "head_to_head",
            }
          : {}),
      },
    ],
    matches,
    terminalMatchIds: [],
  };
}

const layout = {
  schema_version: 1,
  stage_positions: [{ stage_id: "round-robin", x: 120, y: 80 }],
};

function authoredQualifierGraph(): FormatGraph {
  const definition = structuredClone(createDefaultFormatTemplates(8)[0]!.graph) as FormatGraph;
  const groups = definition.stages.find((stage) => stage.id === "groups")!;
  const placement = definition.matches.find((match) => match.stageId === "placement")!;
  Object.assign(groups, {
    repetitions: 1,
    qualificationPositions: [1, 2],
    additionalQualifiers: [
      { method: "best_across_groups", count: 1, destinationStageId: "placement" },
      { method: "manual", count: 1, destinationStageId: "placement" },
      { method: "bottom_from_each_group", count: 2, destinationStageId: "consolation" },
    ],
    destinationStageIds: ["championship", "placement", "consolation"],
    seeding: "snake",
    carriedResults: "none",
  });
  Object.assign(placement, {
    home: { type: "manual_qualifier", qualifierId: "wildcard-1", stageId: "groups" },
    away: { type: "stage_rank", stageId: "groups", rank: 3 },
  });
  return definition;
}

async function world(label = "Phase 4") {
  const account = randomUUID();
  const organisation = randomUUID();
  const competition = randomUUID();
  const divisionA = randomUUID();
  const divisionB = randomUUID();
  await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${account},${`${account}@example.test`},${label})`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisation},${label},${`phase4-${organisation}`})`;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisation},${account},'owner','active')`;
  });
  await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
    VALUES(${competition},${organisation},${account},${`${label} Cup`},${`phase4-cup-${competition}`},'badminton','Asia/Singapore','2027-01-01','2027-01-02','organiser_pro')`;
  await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES
    (${divisionA},${competition},'Open',48),(${divisionB},${competition},'Women',48)`;
  return { account, organisation, competition, divisionA, divisionB };
}

async function prepareScheduleInput(jobId: string, value: Awaited<ReturnType<typeof world>>) {
  const entries: string[] = [];
  for (let seed = 1; seed <= 8; seed += 1) {
    const id = randomUUID();
    entries.push(id);
    await sql`INSERT INTO division_entries(id,division_id,name,seed,status)
      VALUES(${id},${value.divisionA},${`Entry ${seed}`},${seed},'confirmed')`;
  }
  const areaId = randomUUID();
  const intervalId = randomUUID();
  await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
    VALUES(${areaId},${value.competition},'Job court',30)`;
  await sql`INSERT INTO competition_availability_windows(id,competition_id,playing_area_id,starts_at,ends_at)
    VALUES(${intervalId},${value.competition},${areaId},'2027-01-01T00:00:00Z','2027-01-02T00:00:00Z')`;
  const formatRevisionId = randomUUID();
  const definition = roundRobinGraph("schedule-input");
  await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract)
    VALUES(${formatRevisionId},${value.competition},${value.divisionA},1,${sql.json(definition)},${hash(definition)},${sql.json(layout)},${value.account},'phase3')`;
  await sql`SELECT phase4_materialize_format_revision(${formatRevisionId})`;
  await sql`INSERT INTO format_validation_evidence(format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
    slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
    VALUES(${formatRevisionId},${hash(definition)},false,false,false,false,0,0,0,false,${value.account})`;
  await sql`SELECT phase4_publish_format_revision(${formatRevisionId},${value.account},'publish-schedule-input')`;
  const [storedMatch] = await sql<
    { id: string }[]
  >`SELECT id FROM matches WHERE format_revision_id=${formatRevisionId} ORDER BY ordinal LIMIT 1`;
  const [capacity] = await sql<{ revision: number; capacity_hash: string }[]>`SELECT capacity_revision AS revision,
    phase4_capacity_hash(${value.competition}) AS capacity_hash FROM competitions WHERE id=${value.competition}`;
  const matchId = storedMatch!.id;
  const startEpochMs = Date.parse("2027-01-01T00:00:00Z");
  return {
    schema_version: 1,
    job_id: jobId,
    competition_id: value.competition,
    source_revision: 1,
    time_zone: "Asia/Singapore",
    objective: "balanced",
    capacity_revision: Number(capacity!.revision),
    capacity_hash: capacity!.capacity_hash,
    matches: [
      {
        match_id: matchId,
        division_id: value.divisionA,
        duration_minutes: 30,
        dependency_match_ids: [] as string[],
        possible_entry_ids: entries.slice(0, 2),
        official_ids: [] as string[],
        is_championship_final: false,
      },
    ],
    slots: [
      {
        slot_id: "slot-1",
        interval_id: intervalId,
        area_id: areaId,
        start_epoch_ms: startEpochMs,
        end_epoch_ms: startEpochMs + 1_800_000,
      },
    ],
    constraints: {
      minimum_rest: { mode: "ignored", value: { minutes: 30 } },
      maximum_matches_per_day: { mode: "ignored", value: { matches: 5 } },
      preferred_final_time: { mode: "ignored", value: { target_start_epoch_ms: startEpochMs, tolerance_minutes: 30 } },
      entry_unavailable: { mode: "ignored", value: { by_entry_id: {} } },
      official_availability: { mode: "ignored", value: { by_official_id: {} } },
      featured_playing_area: { mode: "ignored", value: { area_id: areaId, match_ids: [matchId] } },
      avoid_consecutive_matches: { mode: "ignored", value: { minutes: 30 } },
      balance_early_matches: { mode: "ignored", value: { before_local_time: "10:00" } },
      balance_late_matches: { mode: "ignored", value: { at_or_after_local_time: "18:00" } },
      keep_division_together: { mode: "ignored", value: { maximum_area_count: 1 } },
      preserve_existing_schedule: { mode: "ignored", value: { maximum_shift_minutes: 0, by_match_id: {} } },
    },
  };
}

function validBrief() {
  return {
    schema_version: "1.0",
    name: "AI Cup",
    sport: "badminton",
    entry_count: 8,
    division_count: 1,
    divisions: [{ name: "Open", entry_count: 8 }],
    location: { venue: "Hall", address: "1 Test St", locality: "Singapore", country_code: "SG" },
    dates: { start: "2027-01-01", end: "2027-01-02" },
    playing_areas: 2,
    daily_availability: [{ date: "2027-01-01", start_time: "09:00", end_time: "18:00" }],
    time_slot_minutes: 30,
    minimum_matches_per_entry: 3,
    knockout_required: false,
    rank_all_entries: true,
    placement_required: true,
    cross_group_qualification_allowed: false,
    organiser_priority: "participation",
    missing_fields: [],
  };
}

function scheduleQuality(
  overrides: Partial<{
    score: number;
    preferred_penalty: number;
    makespan_minutes: number;
    minimum_rest_minutes: number | null;
    maximum_matches_per_entry_day: number;
    preferred_final_delta_minutes: number | null;
  }> = {},
) {
  const keys = [
    "completion",
    "rest",
    "daily_balance",
    "preferred_final",
    "featured_area",
    "consecutive",
    "time_balance",
    "division_cohesion",
    "schedule_preservation",
    "entry_availability",
    "official_availability",
  ];
  return {
    score: 10,
    objective: "balanced",
    valid: true,
    makespan_minutes: 60,
    minimum_rest_minutes: 30,
    maximum_matches_per_entry_day: 5,
    preferred_final_delta_minutes: null,
    required_violation_count: 0,
    preferred_penalty: 2,
    components: keys.map((key) => ({
      key,
      score: 100,
      weight: 1,
      measured: 0,
      unit: "percent",
      explanation: `${key} score`,
    })),
    ...overrides,
  };
}

async function completeScheduleJob(
  value: Awaited<ReturnType<typeof world>>,
  baseInput: Awaited<ReturnType<typeof prepareScheduleInput>>,
  suffix: string,
) {
  const jobId = randomUUID();
  const input = structuredClone(baseInput);
  input.job_id = jobId;
  await sql`INSERT INTO schedule_generation_jobs(id,organisation_id,competition_id,objective,input_snapshot,input_hash,
    requested_by,request_id,correlation_id)
    VALUES(${jobId},${value.organisation},${value.competition},'balanced',${sql.json(input)},${hash(input)},
      ${value.account},${`accept-${suffix}`},${`accept-${suffix}`})`;
  const [claim] = await sql<{ revision: number; fence_token: string; worker_id: string }[]>`
    SELECT revision,fence_token,worker_id FROM phase4_claim_schedule_job(
      ${jobId},${`worker-${suffix}`},${hash(input)},30)`;
  const assignment = {
    match_id: input.matches[0]!.match_id,
    division_id: input.matches[0]!.division_id,
    area_id: input.slots[0]!.area_id,
    interval_id: input.slots[0]!.interval_id,
    slot_id: input.slots[0]!.slot_id,
    start_epoch_ms: input.slots[0]!.start_epoch_ms,
    end_epoch_ms: input.slots[0]!.end_epoch_ms,
    fixed: false,
  };
  const [option] = await sql<{ id: string }[]>`SELECT id FROM phase4_checkpoint_schedule_option(
    ${jobId},${claim!.worker_id},${claim!.fence_token},${claim!.revision},${hash(input)},0,
    ${sql.json(scheduleQuality())},${sql.json([assignment])},'[]'::jsonb)`;
  await sql`SELECT phase4_finish_schedule_job(
    ${jobId},${claim!.worker_id},${claim!.fence_token},'completed',NULL)`;
  return { jobId, optionId: option!.id, assignment };
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, {
    max: 8,
    onnotice: () => undefined,
    connection: { search_path: schema, timezone: "UTC" },
  });
  const definition = { recommendedSlotMinutes: 20, recommendedSettings: { slotMinutes: 20 } };
  await sql`INSERT INTO sport_pack_versions(
    sport_code,version,schema_version,definition,definition_hash,status,activated_at
  ) VALUES('badminton','phase4-test-1',1,${sql.json(definition)},${hash(definition)},'active',now())`;
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 4 organiser-alpha PostgreSQL guardrails", () => {
  it(
    "upgrades a populated 0012 schema without rewriting legacy rows",
    async () => {
      const upgradeSchema = `test_phase4_upgrade_${randomUUID().replaceAll("-", "")}`;
      const upgradeSql = postgres(databaseUrl, {
        max: 1,
        onnotice: () => undefined,
        connection: { search_path: upgradeSchema },
      });
      try {
        await upgradeSql.unsafe(`CREATE SCHEMA "${upgradeSchema}"`);
        await upgradeSql`SELECT pg_advisory_lock(${migrationAdvisoryLockId})`;
        try {
          for (const name of (await readdir(migrationsDirectory))
            .filter((item) => /^00(0[1-9]|1[0-2])_/.test(item))
            .sort()) {
            await upgradeSql.begin((tx) =>
              readFile(path.join(migrationsDirectory, name), "utf8").then((body) => tx.unsafe(body)),
            );
          }
        } finally {
          await upgradeSql`SELECT pg_advisory_unlock(${migrationAdvisoryLockId})`;
        }
        const account = randomUUID();
        const organisation = randomUUID();
        const competition = randomUUID();
        await upgradeSql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${account},${`${account}@test`},'Upgrade')`;
        await upgradeSql.begin(async (tx) => {
          await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisation},'Upgrade',${`upgrade-${organisation}`})`;
          await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status) VALUES(${organisation},${account},'owner','active')`;
        });
        await upgradeSql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on)
        VALUES(${competition},${organisation},${account},'Upgrade Cup',${`upgrade-${competition}`},'badminton','UTC','2027-01-01','2027-01-02')`;
        const migration = await readFile(path.join(migrationsDirectory, "0013_phase4_organiser_alpha.sql"), "utf8");
        await upgradeSql.begin((tx) => tx.unsafe(migration));
        const row = await upgradeSql`SELECT id,name,status FROM competitions WHERE id=${competition}`;
        expect(row).toMatchObject([{ id: competition, name: "Upgrade Cup", status: "draft" }]);
      } finally {
        await upgradeSql.end({ timeout: 2 });
        await dropTestSchema(databaseUrl, upgradeSchema);
      }
    },
    contendedMigrationTestTimeoutMs,
  );

  it("persists setup autosaves with optimistic concurrency and exact idempotent replay", async () => {
    const value = await world("Setup");
    const createResults = await Promise.all([
      sql<{ result: { id: string } }[]>`SELECT phase4_create_setup_draft(
        ${value.organisation},${value.competition},${value.account},'setup-create','setup-create') AS result`,
      sql<{ result: { id: string } }[]>`SELECT phase4_create_setup_draft(
        ${value.organisation},${value.competition},${value.account},'setup-create','setup-create-replay') AS result`,
    ]);
    const draftId = createResults[0]![0]!.result.id;
    expect(createResults[1]![0]!.result.id).toBe(draftId);
    const args = [
      value.organisation,
      value.competition,
      value.account,
      1,
      "capacity",
      ["basics"],
      { basics: { name: "Setup Cup" } },
      { valid: true, pending: false, issues: [] },
      "active",
      "setup-save-1",
      "request-setup-1",
    ] as const;
    const saveResults = await Promise.all([
      sql<{ result: { revision: number } }[]>`SELECT phase4_save_setup_draft(
        ${args[0]},${args[1]},${args[2]},${args[3]},${args[4]},${sql.json(args[5])},${sql.json(args[6])},${sql.json(args[7])},${args[8]},${args[9]},${args[10]}) AS result`,
      sql<{ result: { revision: number } }[]>`SELECT phase4_save_setup_draft(
        ${args[0]},${args[1]},${args[2]},${args[3]},${args[4]},${sql.json(args[5])},${sql.json(args[6])},${sql.json(args[7])},${args[8]},${args[9]},${args[10]}) AS result`,
    ]);
    const [saved] = saveResults[0]!;
    const [replayed] = saveResults[1]!;
    expect(saved?.result).toEqual(replayed?.result);
    expect(saved?.result.revision).toBe(2);
    await expect(sql`SELECT phase4_save_setup_draft(${value.organisation},${value.competition},${value.account},1,'entries',
      '[]'::jsonb,'{"different":true}'::jsonb,'{}'::jsonb,'active','setup-save-1','request-mismatch')`).rejects.toThrow(
      /idempotency key was reused/,
    );
    await expect(sql`SELECT phase4_save_setup_draft(${value.organisation},${value.competition},${value.account},1,'entries',
      '[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'active','setup-stale','request-stale')`).rejects.toThrow(
      /revision conflict/,
    );
    const evidence = await sql<{ audits: number; outbox: number; receipts: number }[]>`SELECT
      (SELECT count(*)::int FROM audit_events WHERE target_id=${draftId}) AS audits,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=${draftId}) AS outbox,
      (SELECT count(*)::int FROM phase4_mutation_receipts WHERE organisation_id=${value.organisation}) AS receipts`;
    expect(evidence[0]).toEqual({ audits: 2, outbox: 2, receipts: 2 });
  });

  it("enforces organisation-owned immutable template versions and definition-only hashes", async () => {
    const value = await world("Templates");
    const other = await world("Other templates");
    const templateId = randomUUID();
    const versionId = randomUUID();
    const sourceRevision = randomUUID();
    const definition = roundRobinGraph("template-graph", true);
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract)
      VALUES(${sourceRevision},${value.competition},${value.divisionA},1,${sql.json(definition)},${hash(definition)},${sql.json(layout)},${value.account},'phase3')`;
    await sql`INSERT INTO format_templates(id,organisation_id,sport_code,name,created_by)
      VALUES(${templateId},${value.organisation},'badminton','Eight team round robin',${value.account})`;
    await expect(sql`INSERT INTO format_template_versions(id,template_id,organisation_id,version,source_format_revision_id,definition,definition_hash,layout,created_by)
      VALUES(${versionId},${templateId},${value.organisation},1,${sourceRevision},${sql.json(definition)},${"0".repeat(64)},${sql.json(layout)},${value.account})`).rejects.toThrow(
      /definition, hash, or layout/,
    );
    await expect(sql`INSERT INTO format_template_versions(id,template_id,organisation_id,version,source_format_revision_id,definition,definition_hash,layout,created_by)
      VALUES(${versionId},${templateId},${other.organisation},1,${sourceRevision},${sql.json(definition)},${hash(definition)},${sql.json(layout)},${other.account})`).rejects.toThrow();
    await sql`INSERT INTO format_template_versions(id,template_id,organisation_id,version,source_format_revision_id,definition,definition_hash,layout,created_by)
      VALUES(${versionId},${templateId},${value.organisation},1,${sourceRevision},${sql.json(definition)},${hash(definition)},${sql.json(layout)},${value.account})`;
    await expect(
      sql`UPDATE format_template_versions SET layout='{"schema_version":1,"stage_positions":[]}' WHERE id=${versionId}`,
    ).rejects.toThrow(/immutable/);
    const [managedVersion] = await sql<{ id: string; template_id: string }[]>`SELECT id,template_id
      FROM phase4_create_format_template(${value.organisation},${sourceRevision},${value.account},
        'Managed template','Created atomically','managed-template')`;
    expect(managedVersion?.id).toBeTruthy();
    expect(
      (
        await sql<{ status: string }[]>`SELECT status FROM phase4_archive_format_template(
          ${managedVersion!.template_id},${value.account},'archive-managed-template')`
      )[0]?.status,
    ).toBe("archived");
  });

  it("materialises stable graph IDs and exact participant sources into the existing match pipeline", async () => {
    const value = await world("Materialise");
    const revisionId = randomUUID();
    const definition = roundRobinGraph("materialise", true);
    await expect(sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,layout,source_kind,created_by,validation_contract)
      VALUES(${randomUUID()},${value.competition},${value.divisionB},99,${sql.json(definition)},${hash(definition)},${sql.json(layout)},'manual',${value.account},'phase3')`).rejects.toThrow(
      /root format revision must be revision one/,
    );
    await expect(sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,layout,source_kind,created_by,validation_contract)
      VALUES(${randomUUID()},${value.competition},${value.divisionB},1,${sql.json(definition)},${hash(definition)},
        '{"schema_version":1,"stage_positions":[]}'::jsonb,'visual',${value.account},'phase3')`).rejects.toThrow(
      /complete stage layout/,
    );
    const managedResults = await Promise.all([
      sql<{ result: { id: string } }[]>`SELECT phase4_save_format_revision(${value.competition},
        ${value.divisionB},${value.account},null,${sql.json(definition)},${sql.json(layout)},'manual',null,
        'managed-format','managed-format') AS result`,
      sql<{ result: { id: string } }[]>`SELECT phase4_save_format_revision(${value.competition},
        ${value.divisionB},${value.account},null,${sql.json(definition)},${sql.json(layout)},'manual',null,
        'managed-format','managed-format-replay') AS result`,
    ]);
    const [managed] = managedResults[0]!;
    expect(managedResults[1]![0]!.result.id).toBe(managed!.result.id);
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract)
      VALUES(${revisionId},${value.competition},${value.divisionA},1,${sql.json(definition)},${hash(definition)},${sql.json(layout)},${value.account},'phase3')`;
    const result = await sql<{ count: number }[]>`SELECT phase4_materialize_format_revision(${revisionId}) AS count`;
    expect(result[0]?.count).toBe(28);
    const stored = await sql<{ matches: number; sources: number; distinct_graph_ids: number }[]>`SELECT
      (SELECT count(*)::int FROM matches WHERE format_revision_id=${revisionId}) AS matches,
      (SELECT count(*)::int FROM format_match_sources WHERE format_revision_id=${revisionId}) AS sources,
      (SELECT count(DISTINCT graph_match_id)::int FROM matches WHERE format_revision_id=${revisionId}) AS distinct_graph_ids`;
    expect(stored[0]).toEqual({ matches: 28, sources: 56, distinct_graph_ids: 28 });
    const stable = await sql<
      { stable: boolean }[]
    >`SELECT id=phase4_deterministic_uuid(${revisionId},graph_match_id) AS stable
      FROM matches WHERE format_revision_id=${revisionId}`;
    expect(stable.every((row) => row.stable)).toBe(true);
    await expect(sql`SELECT phase4_materialize_format_revision(${revisionId})`).rejects.toThrow(
      /already been materialised/,
    );
    await expect(sql`UPDATE matches SET graph_purpose='forged' WHERE format_revision_id=${revisionId}`).rejects.toThrow(
      /projection is immutable/,
    );
    await expect(sql`DELETE FROM format_match_sources WHERE format_revision_id=${revisionId}`).rejects.toThrow(
      /projection is immutable/,
    );
    await expect(
      sql`UPDATE format_revisions SET definition_hash=${"f".repeat(64)} WHERE id=${revisionId}`,
    ).rejects.toThrow(/content and lineage are immutable|hash/);
    await expect(sql`INSERT INTO format_match_sources(match_id,format_revision_id,competition_id,division_id,slot,source_kind,entry_seed)
      SELECT id,format_revision_id,competition_id,division_id,'home','entry_seed',99 FROM matches WHERE format_revision_id=${revisionId} LIMIT 1`).rejects.toThrow();
  });

  it("matches authored qualifier semantics and persists unresolved manual provenance", async () => {
    const value = await world("Authored qualifiers");
    const definition = authoredQualifierGraph();
    expect(
      (await sql<{ valid: boolean }[]>`SELECT phase3_format_definition_db_valid(${sql.json(definition)}) AS valid`)[0]
        ?.valid,
    ).toBe(true);
    const revisionId = randomUUID();
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES(${revisionId},${value.competition},${value.divisionA},1,${sql.json(definition)},${hash(definition)},${value.account},'phase3')`;
    await sql`SELECT phase4_materialize_format_revision(${revisionId})`;
    expect(
      await sql`SELECT source_kind,source_stage_id,source_group_id,source_rank,source_manual_qualifier_id
        FROM format_match_sources WHERE format_revision_id=${revisionId} AND source_kind IN ('manual_qualifier','stage_rank')
          AND match_id=phase4_deterministic_uuid(${revisionId},'placement-r1-m1') ORDER BY slot`,
    ).toMatchObject([
      {
        source_kind: "stage_rank",
        source_stage_id: "groups",
        source_group_id: null,
        source_rank: 3,
        source_manual_qualifier_id: null,
      },
      {
        source_kind: "manual_qualifier",
        source_stage_id: "groups",
        source_group_id: null,
        source_rank: null,
        source_manual_qualifier_id: "wildcard-1",
      },
    ]);
    const placementDependencies = await sql<{ graph_match_id: string }[]>`
      SELECT producer.graph_match_id
      FROM phase4_match_schedule_dependencies(
        phase4_deterministic_uuid(${revisionId},'placement-r1-m1')
      ) dependency
      JOIN matches producer ON producer.id=dependency.source_match_id
      ORDER BY producer.graph_match_id`;
    expect(placementDependencies.map((row) => row.graph_match_id)).toEqual(
      definition.stages
        .find((stage) => stage.id === "groups")!
        .matchIds.slice()
        .sort(),
    );

    const corruptions = [
      (graph: FormatGraph) => Object.assign(graph.stages[0]!, { destinationStageIds: ["championship", "placement"] }),
      (graph: FormatGraph) =>
        Object.assign(graph.stages[0]!, {
          additionalQualifiers: [
            { method: "best_across_groups", count: 2, destinationStageId: "placement" },
            { method: "manual", count: 1, destinationStageId: "placement" },
            { method: "bottom_from_each_group", count: 2, destinationStageId: "consolation" },
          ],
        }),
      (graph: FormatGraph) =>
        Object.assign(
          graph.matches.find((match) => match.stageId === "placement")!,
          {
            away: { type: "manual_qualifier", qualifierId: "wildcard-1", stageId: "groups" },
          },
        ),
      (graph: FormatGraph) =>
        Object.assign(graph.stages[0]!, {
          placementRule: { coverage: "podium", positions: [1, 2, 3], clientHash: "forged" },
        }),
      (graph: FormatGraph) =>
        Object.assign(
          graph.matches.find((match) => match.stageId === "placement")!,
          {
            home: { type: "manual_qualifier", qualifierId: "wildcard-1", stageId: "placement" },
          },
        ),
    ];
    for (const corrupt of corruptions) {
      const invalid = authoredQualifierGraph();
      corrupt(invalid);
      expect(
        (await sql<{ valid: boolean }[]>`SELECT phase3_format_definition_db_valid(${sql.json(invalid)}) AS valid`)[0]
          ?.valid,
      ).toBe(false);
    }
  });

  it("accepts only the exact authoritative qualifier dependency set in schedule jobs", async () => {
    const value = await world("Qualifier schedule guard");
    const baseJobId = randomUUID();
    const baseInput = await prepareScheduleInput(baseJobId, value);
    const definition = authoredQualifierGraph();
    const revisionId = randomUUID();
    const entryIds: string[] = [];
    for (let seed = 1; seed <= 8; seed += 1) {
      const id = randomUUID();
      entryIds.push(id);
      await sql`INSERT INTO division_entries(id,division_id,name,seed,status)
        VALUES(${id},${value.divisionB},${`Qualifier entry ${seed}`},${seed},'confirmed')`;
    }
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES(${revisionId},${value.competition},${value.divisionB},1,${sql.json(definition)},${hash(definition)},${value.account},'phase3')`;
    await sql`SELECT phase4_materialize_format_revision(${revisionId})`;
    await sql`INSERT INTO format_validation_evidence(format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
      slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
      VALUES(${revisionId},${hash(definition)},false,false,false,false,0,0,0,false,${value.account})`;
    await sql`SELECT phase4_publish_format_revision(${revisionId},${value.account},'publish-qualifier-schedule-guard')`;
    const [target] = await sql<{ id: string }[]>`
      SELECT id FROM matches
      WHERE format_revision_id=${revisionId} AND graph_match_id='placement-r1-m1'`;
    const dependencies = await sql<{ source_match_id: string }[]>`
      SELECT source_match_id FROM phase4_match_schedule_dependencies(${target!.id})`;
    const authoritative = structuredClone(baseInput);
    authoritative.matches = [
      {
        ...baseInput.matches[0]!,
        match_id: target!.id,
        division_id: value.divisionB,
        dependency_match_ids: dependencies.map((row) => row.source_match_id),
        possible_entry_ids: entryIds,
      },
    ];
    for (const dependencyMutation of [(ids: string[]) => ids.slice(1), (ids: string[]) => [...ids, target!.id]]) {
      const forgedJobId = randomUUID();
      const forged = structuredClone(authoritative);
      forged.job_id = forgedJobId;
      forged.matches[0]!.dependency_match_ids = dependencyMutation(forged.matches[0]!.dependency_match_ids);
      await expect(sql`INSERT INTO schedule_generation_jobs(
          id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id
        ) VALUES(
          ${forgedJobId},${value.organisation},${value.competition},'balanced',
          ${sql.json(forged)},${hash(forged)},${value.account},${`forged-${forgedJobId}`},${`forged-${forgedJobId}`}
        )`).rejects.toThrow(/dependencies are not authoritative/);
    }
    authoritative.job_id = baseJobId;
    await sql`INSERT INTO schedule_generation_jobs(
      id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id
    ) VALUES(
      ${baseJobId},${value.organisation},${value.competition},'balanced',
      ${sql.json(authoritative)},${hash(authoritative)},${value.account},'qualifier-authoritative','qualifier-authoritative'
    )`;
  });

  it("serialises format publication and leaves one current published revision per division", async () => {
    const value = await world("Publish format");
    const area = randomUUID();
    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes) VALUES(${area},${value.competition},'Court',30)`;
    await sql`INSERT INTO competition_availability_windows(competition_id,playing_area_id,starts_at,ends_at)
      VALUES(${value.competition},${area},'2027-01-01T00:00:00Z','2027-01-02T00:00:00Z')`;
    const ids: string[] = [];
    for (const revision of [1, 2]) {
      const id = randomUUID();
      ids.push(id);
      const definition = roundRobinGraph(`publish-${revision}`);
      await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,parent_revision_id,definition,definition_hash,layout,created_by,validation_contract)
      VALUES(${id},${value.competition},${value.divisionA},${revision},${revision === 1 ? null : ids.at(0)!},${sql.json(definition)},${hash(definition)},${sql.json(layout)},${value.account},'phase3')`;
      await sql`SELECT phase4_materialize_format_revision(${id})`;
      await sql`INSERT INTO format_validation_evidence(format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
        slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
        VALUES(${id},${hash(definition)},false,false,false,false,0,0,0,false,${value.account})`;
      await sql`SELECT phase4_publish_format_revision(${id},${value.account},${`publish-${revision}`})`;
    }
    const statuses = await sql<
      { id: string; status: string }[]
    >`SELECT id,status FROM format_revisions WHERE id=ANY(${ids}) ORDER BY revision`;
    expect(statuses).toEqual([
      { id: ids[0], status: "superseded" },
      { id: ids[1], status: "published" },
    ]);
    await expect(sql`UPDATE format_revisions SET status='published' WHERE id=${ids.at(0)!}`).rejects.toThrow();
    expect(
      await sql`SELECT id FROM audit_events WHERE action='format.published' AND target_id=ANY(${ids})`,
    ).toHaveLength(2);
  });

  it("fences worker claims, renewals, monotonic checkpoints, retries, and cancellation", async () => {
    const value = await world("Jobs");
    const jobId = randomUUID();
    const input = await prepareScheduleInput(jobId, value);
    const invalidConstraintJob = randomUUID();
    const invalidConstraintInput = structuredClone(input);
    invalidConstraintInput.job_id = invalidConstraintJob;
    Object.assign(invalidConstraintInput.constraints.minimum_rest.value, { clientHash: "forged" });
    await expect(sql`INSERT INTO schedule_generation_jobs(id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id)
      VALUES(${invalidConstraintJob},${value.organisation},${value.competition},'balanced',${sql.json(invalidConstraintInput)},${hash(invalidConstraintInput)},${value.account},'invalid-constraint','invalid-constraint')`).rejects.toThrow(
      /input_snapshot_check/,
    );
    const forgedParticipantsJob = randomUUID();
    const forgedParticipantsInput = structuredClone(input);
    forgedParticipantsInput.job_id = forgedParticipantsJob;
    const [extraEntry] = await sql<{ id: string }[]>`SELECT id FROM division_entries
      WHERE division_id=${value.divisionA} AND NOT (id=ANY(${forgedParticipantsInput.matches[0]!.possible_entry_ids})) LIMIT 1`;
    forgedParticipantsInput.matches[0]!.possible_entry_ids.push(extraEntry!.id);
    await expect(sql`INSERT INTO schedule_generation_jobs(id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id)
      VALUES(${forgedParticipantsJob},${value.organisation},${value.competition},'balanced',${sql.json(forgedParticipantsInput)},${hash(forgedParticipantsInput)},${value.account},'forged-participants','forged-participants')`).rejects.toThrow(
      /participants.*authoritative/,
    );
    await sql`INSERT INTO schedule_generation_jobs(id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id)
      VALUES(${jobId},${value.organisation},${value.competition},'balanced',${sql.json(input)},${hash(input)},${value.account},'job-request','job-correlation')`;
    expect(await sql`SELECT id FROM phase4_claim_schedule_job(${jobId},'wrong-hash',${"0".repeat(64)},30)`).toEqual([
      { id: null },
    ]);
    expect(await sql`SELECT revision FROM schedule_generation_jobs WHERE id=${jobId}`).toMatchObject([{ revision: 1 }]);
    const claims = await Promise.all([
      sql<
        { id: string | null; revision: number | null; fence_token: string | null; worker_id: string | null }[]
      >`SELECT * FROM phase4_claim_schedule_job(${jobId},'worker-a',${hash(input)},30)`,
      sql<
        { id: string | null; revision: number | null; fence_token: string | null; worker_id: string | null }[]
      >`SELECT * FROM phase4_claim_schedule_job(${jobId},'worker-b',${hash(input)},30)`,
    ]);
    const claimed = claims.flat().find((row) => row.id === jobId)!;
    expect(claims.flat().filter((row) => row.id === jobId)).toHaveLength(1);
    const worker = claimed.worker_id!;
    const renewed = await sql<
      { revision: number }[]
    >`SELECT revision FROM phase4_renew_schedule_job_lease(${jobId},${worker},${claimed.fence_token},30)`;
    expect(renewed[0]?.revision).toBe(claimed.revision);
    const assignment = {
      match_id: input.matches[0]!.match_id,
      division_id: input.matches[0]!.division_id,
      area_id: input.slots[0]!.area_id,
      interval_id: input.slots[0]!.interval_id,
      slot_id: input.slots[0]!.slot_id,
      start_epoch_ms: input.slots[0]!.start_epoch_ms,
      end_epoch_ms: input.slots[0]!.end_epoch_ms,
      fixed: false,
    };
    const durationMismatch = structuredClone(input);
    durationMismatch.matches[0]!.duration_minutes = 60;
    expect(
      (
        await sql<{ valid: boolean }[]>`SELECT phase4_schedule_assignments_valid(
          ${sql.json(durationMismatch)},${sql.json([assignment])}) AS valid`
      )[0]?.valid,
    ).toBe(false);
    const preferredViolation = {
      code: "minimum_rest",
      severity: "preferred",
      match_ids: [assignment.match_id],
      message: "Preferred rest target was not reached",
      amount: 5,
    };
    expect(
      (
        await sql<{ valid: boolean }[]>`SELECT phase4_schedule_preferred_violations_valid(
          ${sql.json([preferredViolation])}) AS valid`
      )[0]?.valid,
    ).toBe(true);
    expect(
      (
        await sql<{ valid: boolean }[]>`SELECT phase4_schedule_preferred_violations_valid(
          ${sql.json([{ ...preferredViolation, severity: "required" }])}) AS valid`
      )[0]?.valid,
    ).toBe(false);
    const extraEntries = await sql<
      { id: string }[]
    >`SELECT id FROM division_entries WHERE division_id=${value.divisionA}
      AND NOT (id=ANY(${input.matches[0]!.possible_entry_ids})) ORDER BY seed LIMIT 2`;
    const officialId = randomUUID();
    const overlappingSnapshot = {
      ...structuredClone(input),
      matches: input.matches.map((item) => ({ ...structuredClone(item), official_ids: [officialId] })),
    };
    overlappingSnapshot.matches.push({
      ...structuredClone(overlappingSnapshot.matches[0]!),
      match_id: randomUUID(),
      possible_entry_ids: extraEntries.map((entry) => entry.id),
    });
    overlappingSnapshot.slots.push({
      ...structuredClone(overlappingSnapshot.slots[0]!),
      slot_id: "slot-overlap",
      interval_id: randomUUID(),
      area_id: randomUUID(),
    });
    const overlappingAssignments = [
      assignment,
      {
        ...assignment,
        match_id: overlappingSnapshot.matches[1]!.match_id,
        slot_id: overlappingSnapshot.slots[1]!.slot_id,
        interval_id: overlappingSnapshot.slots[1]!.interval_id,
        area_id: overlappingSnapshot.slots[1]!.area_id,
      },
    ];
    expect(
      (
        await sql<{ valid: boolean }[]>`SELECT phase4_schedule_assignments_valid(
          ${sql.json(overlappingSnapshot)},${sql.json(overlappingAssignments)}) AS valid`
      )[0]?.valid,
    ).toBe(false);
    const balanceSnapshot = structuredClone(overlappingSnapshot);
    balanceSnapshot.matches[0]!.official_ids = [];
    balanceSnapshot.matches[1]!.official_ids = [];
    balanceSnapshot.matches[1]!.possible_entry_ids = [...balanceSnapshot.matches[0]!.possible_entry_ids];
    balanceSnapshot.constraints.balance_early_matches.mode = "required";
    balanceSnapshot.matches.push({
      ...structuredClone(balanceSnapshot.matches[0]!),
      match_id: randomUUID(),
      possible_entry_ids: extraEntries.map((entry) => entry.id),
    });
    balanceSnapshot.slots[1]!.start_epoch_ms += 1_800_000;
    balanceSnapshot.slots[1]!.end_epoch_ms += 1_800_000;
    balanceSnapshot.slots.push({
      ...structuredClone(balanceSnapshot.slots[0]!),
      slot_id: "slot-late",
      interval_id: randomUUID(),
      start_epoch_ms: balanceSnapshot.slots[0]!.start_epoch_ms + 14_400_000,
      end_epoch_ms: balanceSnapshot.slots[0]!.end_epoch_ms + 14_400_000,
    });
    const balanceAssignments = [
      assignment,
      {
        ...overlappingAssignments[1]!,
        start_epoch_ms: balanceSnapshot.slots[1]!.start_epoch_ms,
        end_epoch_ms: balanceSnapshot.slots[1]!.end_epoch_ms,
      },
      {
        ...assignment,
        match_id: balanceSnapshot.matches[2]!.match_id,
        slot_id: balanceSnapshot.slots[2]!.slot_id,
        interval_id: balanceSnapshot.slots[2]!.interval_id,
        start_epoch_ms: balanceSnapshot.slots[2]!.start_epoch_ms,
        end_epoch_ms: balanceSnapshot.slots[2]!.end_epoch_ms,
      },
    ];
    expect(
      (
        await sql<{ valid: boolean }[]>`SELECT phase4_schedule_assignments_valid(
          ${sql.json(balanceSnapshot)},${sql.json(balanceAssignments)}) AS valid`
      )[0]?.valid,
    ).toBe(false);
    const lateBalanceSnapshot = structuredClone(balanceSnapshot);
    lateBalanceSnapshot.constraints.balance_early_matches.mode = "ignored";
    lateBalanceSnapshot.constraints.balance_late_matches = {
      mode: "required",
      value: { at_or_after_local_time: "10:00" },
    };
    lateBalanceSnapshot.slots[0]!.start_epoch_ms += 14_400_000;
    lateBalanceSnapshot.slots[0]!.end_epoch_ms += 14_400_000;
    lateBalanceSnapshot.slots[1]!.start_epoch_ms += 14_400_000;
    lateBalanceSnapshot.slots[1]!.end_epoch_ms += 14_400_000;
    lateBalanceSnapshot.slots[2]!.start_epoch_ms = input.slots[0]!.start_epoch_ms;
    lateBalanceSnapshot.slots[2]!.end_epoch_ms = input.slots[0]!.end_epoch_ms;
    const lateBalanceAssignments = balanceAssignments.map((item, index) => ({
      ...item,
      start_epoch_ms: lateBalanceSnapshot.slots[index]!.start_epoch_ms,
      end_epoch_ms: lateBalanceSnapshot.slots[index]!.end_epoch_ms,
    }));
    expect(
      (
        await sql<{ valid: boolean }[]>`SELECT phase4_schedule_assignments_valid(
          ${sql.json(lateBalanceSnapshot)},${sql.json(lateBalanceAssignments)}) AS valid`
      )[0]?.valid,
    ).toBe(false);
    const option = await sql<
      { result_revision: number }[]
    >`SELECT result_revision FROM phase4_checkpoint_schedule_option(${jobId},${worker},${claimed.fence_token},
      ${claimed.revision},${hash(input)},10,${sql.json(scheduleQuality({ preferred_penalty: 5 }))},
      ${sql.json([assignment])},${sql.json([preferredViolation])})`;
    expect(option[0]?.result_revision).toBe(1);
    await expect(sql`SELECT phase4_checkpoint_schedule_option(${jobId},${worker},${claimed.fence_token},${claimed.revision! + 1},
      ${hash(input)},11,${sql.json(scheduleQuality({ score: 99 }))},'[]'::jsonb,'[]'::jsonb)`).rejects.toThrow(
      /invalid schedule checkpoint/,
    );
    const [accepted] = await sql<{ id: string; status: string }[]>`SELECT id,status FROM phase4_accept_schedule_option(
      (SELECT current_best_option_id FROM schedule_generation_jobs WHERE id=${jobId}),${value.account},'accept-option')`;
    expect(accepted?.status).toBe("ready_for_review");
    await expect(sql`UPDATE schedule_revisions SET status='published',published_at=now()
      WHERE id=${accepted!.id}`).rejects.toThrow(/server-owned publication routine/);
    const [lock] = await sql<{ id: string }[]>`SELECT id FROM phase4_set_schedule_assignment_lock(${value.competition},
      ${assignment.match_id},${accepted!.id},${assignment.area_id},${new Date(assignment.start_epoch_ms).toISOString()},
      ${new Date(assignment.end_epoch_ms).toISOString()},${value.account},'lock-assignment')`;
    await expect(
      sql`UPDATE schedule_assignment_locks SET starts_at=starts_at+interval '5 minutes' WHERE id=${lock!.id}`,
    ).rejects.toThrow(/server-owned lock routine/);
    expect(
      (
        await sql<{ status: string }[]>`SELECT status FROM phase4_publish_schedule_revision(
          ${accepted!.id},${value.account},'publish-schedule')`
      )[0]?.status,
    ).toBe("published");
    await expect(sql`DELETE FROM schedule_revision_formats WHERE schedule_revision_id=${accepted!.id}`).rejects.toThrow(
      /format provenance is immutable/,
    );
    await expect(sql`UPDATE schedule_revisions SET status='superseded',warnings='[{"forged":true}]'::jsonb
      WHERE id=${accepted!.id}`).rejects.toThrow(/immutable/);
    await expect(sql`INSERT INTO schedule_generation_options(job_id,organisation_id,competition_id,result_revision,solver_iteration,result_status,
      input_hash,problem_hash,quality,assignments,violations,assignment_hash,result_hash)
      SELECT id,organisation_id,competition_id,99,99,'valid',input_hash,problem_hash,${sql.json(scheduleQuality())},'[{"direct":true}]','[]',${hash([{ direct: true }])},
        phase4_sha256_json(jsonb_build_object('input_hash',input_hash,'problem_hash',problem_hash,'quality',${sql.json(scheduleQuality())},
          'assignments','[{"direct":true}]'::jsonb,'violations','[]'::jsonb))
      FROM schedule_generation_jobs WHERE id=${jobId}`).rejects.toThrow(/checkpoint routine/);
    await expect(sql`SELECT phase4_checkpoint_schedule_option(${jobId},${worker},${claimed.fence_token},${claimed.revision! + 1},
      ${hash(input)},11,${sql.json(scheduleQuality({ score: 9, preferred_penalty: 1 }))},'[{"candidate":"worse-score"}]'::jsonb,'[]'::jsonb)`).rejects.toThrow(
      /improve/,
    );
    await expect(sql`SELECT phase4_checkpoint_schedule_option(${jobId},${worker},${claimed.fence_token},${claimed.revision! + 1},
      ${hash(input)},12,${sql.json(scheduleQuality({ maximum_matches_per_entry_day: 6, preferred_penalty: 5 }))},'[{"candidate":"worse-balanced"}]'::jsonb,'[]'::jsonb)`).rejects.toThrow(
      /improve/,
    );
    await sql`UPDATE schedule_generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${jobId}`;
    const [reclaimed] = await sql<
      { revision: number; fence_token: string; worker_id: string; current_best_option_id: string }[]
    >`SELECT revision,fence_token,worker_id,current_best_option_id
      FROM phase4_claim_schedule_job(${jobId},'worker-recovery',${hash(input)},30)`;
    expect(reclaimed?.current_best_option_id).toBeTruthy();
    await sql`SELECT phase4_request_schedule_cancellation(${jobId},${value.account},'cancel-job')`;
    const cancelState = await sql<
      { requested: boolean }[]
    >`SELECT phase4_is_schedule_job_cancel_requested(${jobId},${reclaimed!.fence_token}) AS requested`;
    expect(cancelState[0]?.requested).toBe(true);
    await expect(sql`SELECT phase4_checkpoint_schedule_option(${jobId},'worker-recovery',${reclaimed!.fence_token},${reclaimed!.revision},
      ${hash(input)},13,${sql.json(scheduleQuality({ maximum_matches_per_entry_day: 4 }))},'[{"candidate":"cancel-race"}]'::jsonb,'[]'::jsonb)`).rejects.toThrow(
      /checkpoint cancelled/,
    );
    await sql`SELECT phase4_release_schedule_job_after_failure(${jobId},'worker-recovery',${reclaimed!.fence_token},'transient')`;
    const final = await sql<
      { status: string; current_best_option_id: string }[]
    >`SELECT status,current_best_option_id FROM schedule_generation_jobs WHERE id=${jobId}`;
    expect(final[0]).toMatchObject({ status: "cancelled" });
    expect(final[0]?.current_best_option_id).toBeTruthy();
    expect(
      await sql`SELECT id,status,source_job_id,source_option_id
        FROM schedule_revisions WHERE id=${accepted!.id}`,
    ).toEqual([
      {
        id: accepted!.id,
        status: "published",
        source_job_id: jobId,
        source_option_id: expect.any(String),
      },
    ]);
  });

  it("serialises concurrent option acceptance and rejects cross-revision lock collisions", async () => {
    const value = await world("Schedule concurrency");
    const seedJobId = randomUUID();
    const input = await prepareScheduleInput(seedJobId, value);
    const firstJob = await completeScheduleJob(value, input, "first");
    const secondJob = await completeScheduleJob(value, input, "second");

    const accepted = await Promise.all([
      sql<{ id: string; revision: number; status: string }[]>`SELECT id,revision,status
        FROM phase4_accept_schedule_option(${firstJob.optionId},${value.account},'accept-concurrent-first')`,
      sql<{ id: string; revision: number; status: string }[]>`SELECT id,revision,status
        FROM phase4_accept_schedule_option(${secondJob.optionId},${value.account},'accept-concurrent-second')`,
    ]);
    const acceptedRows = accepted.flat().sort((left, right) => left.revision - right.revision);
    expect(acceptedRows.map(({ revision, status }) => ({ revision, status }))).toEqual([
      { revision: 1, status: "ready_for_review" },
      { revision: 2, status: "ready_for_review" },
    ]);
    const [replayedAcceptance] = await sql<{ id: string; revision: number }[]>`SELECT id,revision
      FROM phase4_accept_schedule_option(${firstJob.optionId},${value.account},'accept-concurrent-first-replay')`;
    expect(replayedAcceptance).toMatchObject({ id: accepted[0]![0]!.id, revision: accepted[0]![0]!.revision });
    expect(await sql`SELECT id FROM schedule_revisions WHERE competition_id=${value.competition}`).toHaveLength(2);

    const secondArea = randomUUID();
    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
      VALUES(${secondArea},${value.competition},'Second job court',30)`;
    const [secondMatch] = await sql<{ id: string; format_revision_id: string }[]>`
      SELECT id,format_revision_id FROM matches
      WHERE competition_id=${value.competition} AND id<>${firstJob.assignment.match_id}
      ORDER BY ordinal LIMIT 1`;
    const createDerivedRevision = async (matchId: string, areaId: string, parentId: string, revision: number) => {
      const revisionId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO schedule_revisions(
            id,competition_id,format_revision_id,revision,input_hash,status,created_by,parent_revision_id,source_job_id,quality
          ) VALUES(
            ${revisionId},${value.competition},${secondMatch!.format_revision_id},${revision},
            ${hash({ revisionId })},'draft',${value.account},${parentId},${secondJob.jobId},${tx.json(scheduleQuality())}
          )`;
        await tx`INSERT INTO schedule_revision_formats(schedule_revision_id,competition_id,division_id,format_revision_id)
          SELECT ${revisionId},competition_id,division_id,format_revision_id
          FROM schedule_revision_formats WHERE schedule_revision_id=${parentId}`;
        await tx`INSERT INTO scheduled_matches(
            schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
          ) VALUES(
            ${revisionId},${matchId},${value.competition},${areaId},
            ${new Date(firstJob.assignment.start_epoch_ms).toISOString()},
            ${new Date(firstJob.assignment.end_epoch_ms).toISOString()}
          )`;
        await tx`SELECT set_config('matchday.phase4_accept_schedule','on',true)`;
        await tx`UPDATE schedule_revisions
          SET assignment_hash=phase4_schedule_assignment_hash(id),status='ready_for_review',updated_at=now()
          WHERE id=${revisionId}`;
      });
      return revisionId;
    };
    const relocatedRevision = await createDerivedRevision(
      firstJob.assignment.match_id,
      secondArea,
      acceptedRows[1]!.id,
      3,
    );
    const conflictingRevision = await createDerivedRevision(secondMatch!.id, secondArea, relocatedRevision, 4);
    const startsAt = new Date(firstJob.assignment.start_epoch_ms).toISOString();
    const endsAt = new Date(firstJob.assignment.end_epoch_ms).toISOString();

    const utcSql = postgres(databaseUrl, {
      max: 1,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });
    const singaporeSql = postgres(databaseUrl, {
      max: 1,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });
    try {
      await utcSql`SET TIME ZONE 'UTC'`;
      await singaporeSql`SET TIME ZONE 'Asia/Singapore'`;
      await utcSql`SELECT phase4_set_schedule_assignment_lock(
        ${value.competition},${firstJob.assignment.match_id},${acceptedRows[0]!.id},${firstJob.assignment.area_id},
        ${startsAt},${endsAt},${value.account},'lock-outbox-first')`;
      await utcSql`SELECT phase4_set_schedule_assignment_lock(
        ${value.competition},${firstJob.assignment.match_id},${relocatedRevision},${secondArea},
        ${startsAt},${endsAt},${value.account},'lock-outbox-relocated')`;
      await singaporeSql`SELECT phase4_set_schedule_assignment_lock(
        ${value.competition},${firstJob.assignment.match_id},${relocatedRevision},${secondArea},
        ${startsAt},${endsAt},${value.account},'lock-outbox-relocated-replay')`;
    } finally {
      await Promise.all([utcSql.end(), singaporeSql.end()]);
    }
    expect(
      await sql`SELECT payload FROM outbox_events
        WHERE event_type='schedule.assignment.locked' AND aggregate_id=${firstJob.assignment.match_id}
        ORDER BY created_at,id`,
    ).toMatchObject([
      { payload: { area_id: firstJob.assignment.area_id, source_schedule_revision_id: acceptedRows[0]!.id } },
      { payload: { area_id: secondArea, source_schedule_revision_id: relocatedRevision } },
    ]);
    await expect(
      sql`SELECT phase4_set_schedule_assignment_lock(
        ${value.competition},${secondMatch!.id},${conflictingRevision},${secondArea},
        ${startsAt},${endsAt},${value.account},'lock-cross-revision-conflict')`,
    ).rejects.toThrow(/conflicts with an existing locked interval/);
    expect(
      await sql`SELECT match_id,source_schedule_revision_id,playing_area_id
        FROM schedule_assignment_locks WHERE competition_id=${value.competition}`,
    ).toEqual([
      {
        match_id: firstJob.assignment.match_id,
        source_schedule_revision_id: relocatedRevision,
        playing_area_id: secondArea,
      },
    ]);
  });

  it("retains immutable multi-division revisions and emits 7/1-day expiry evidence once", async () => {
    const value = await world("Expiry");
    const definition = roundRobinGraph("expiry-format");
    const formatA = randomUUID();
    const formatB = randomUUID();
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract) VALUES
      (${formatA},${value.competition},${value.divisionA},1,${sql.json(definition)},${hash(definition)},${value.account},'phase3'),
      (${formatB},${value.competition},${value.divisionB},1,${sql.json(definition)},${hash(definition)},${value.account},'phase3')`;
    const warningRevision = randomUUID();
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,status,created_by,updated_at)
      VALUES(${warningRevision},${value.competition},${formatA},1,${"1".repeat(64)},'draft',${value.account},
        timezone('UTC', current_date)+interval '7 days'-interval '1 month')`;
    await sql`INSERT INTO schedule_revision_formats(schedule_revision_id,competition_id,division_id,format_revision_id) VALUES
      (${warningRevision},${value.competition},${value.divisionA},${formatA}),
      (${warningRevision},${value.competition},${value.divisionB},${formatB})`;
    const warningExpiry = (
      await sql<{ editable_until: Date }[]>`SELECT editable_until FROM schedule_revisions WHERE id=${warningRevision}`
    )[0]!.editable_until;
    await sql`INSERT INTO schedule_revision_warnings(schedule_revision_id,competition_id,warning_days,expires_at,
      notified_account_id,idempotency_key)
      VALUES(${warningRevision},${value.competition},7,${new Date(warningExpiry.getTime() - 86_400_000)},${value.account},
        ${`phase4:legacy-30-day-warning:${warningRevision}`})`;
    const [first, replay] = await Promise.all([
      sql`SELECT phase4_emit_schedule_expiry_warning(${warningRevision},7,${value.account},'warning-7-a')`,
      sql`SELECT phase4_emit_schedule_expiry_warning(${warningRevision},7,${value.account},'warning-7-b')`,
    ]);
    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(1);
    expect(
      await sql`SELECT id FROM schedule_revision_warnings WHERE schedule_revision_id=${warningRevision}`,
    ).toHaveLength(2);
    expect(
      await sql`SELECT id FROM notifications WHERE idempotency_key LIKE ${`phase4:schedule-expiry-warning:${warningRevision}%`}`,
    ).toHaveLength(1);
    const urgentWarningRevision = randomUUID();
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,status,created_by,updated_at)
      VALUES(${urgentWarningRevision},${value.competition},${formatA},2,${"3".repeat(64)},'draft',${value.account},
        timezone('UTC', current_date)+interval '1 day'-interval '1 month')`;
    await sql`SELECT phase4_emit_schedule_expiry_warning(${urgentWarningRevision},1,${value.account},'warning-1')`;
    expect(
      await sql`SELECT id FROM schedule_revision_warnings WHERE schedule_revision_id=${urgentWarningRevision} AND warning_days=1`,
    ).toHaveLength(1);
    const expiredRevision = randomUUID();
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,status,created_by,updated_at)
      VALUES(${expiredRevision},${value.competition},${formatA},3,${"2".repeat(64)},'draft',${value.account},
        now()-interval '1 month'-interval '1 second')`;
    await sql`INSERT INTO schedule_revision_formats(schedule_revision_id,competition_id,division_id,format_revision_id)
      VALUES(${expiredRevision},${value.competition},${value.divisionA},${formatA})`;
    await sql`SELECT phase4_expire_schedule_revision(${expiredRevision},'expire-now')`;
    await expect(sql`UPDATE schedule_revisions SET warnings='["forged"]' WHERE id=${expiredRevision}`).rejects.toThrow(
      /terminal/,
    );
    await expect(
      sql`UPDATE schedule_revision_formats SET format_revision_id=${formatA} WHERE schedule_revision_id=${expiredRevision}`,
    ).rejects.toThrow(/format provenance is immutable/);
    await expect(
      sql`DELETE FROM schedule_revision_formats WHERE schedule_revision_id=${expiredRevision}`,
    ).rejects.toThrow(/format provenance is immutable/);
    expect(
      await sql`SELECT action FROM audit_events WHERE target_id=${expiredRevision}::text AND action='schedule.expired'`,
    ).toHaveLength(1);
    expect(
      await sql`SELECT event_type FROM outbox_events WHERE aggregate_id=${expiredRevision}::text AND event_type='schedule.expired'`,
    ).toHaveLength(1);

    const monthEndRevision = randomUUID();
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,status,created_by,updated_at)
      VALUES(${monthEndRevision},${value.competition},${formatA},4,${"4".repeat(64)},'draft',${value.account},
        '2027-01-31T10:15:00Z')`;
    expect(
      (
        await sql<
          { editable_until: string }[]
        >`SELECT editable_until::text FROM schedule_revisions WHERE id=${monthEndRevision}`
      )[0]?.editable_until,
    ).toContain("2027-02-28 10:15:00");

    const leapRevision = randomUUID();
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,status,created_by,updated_at)
      VALUES(${leapRevision},${value.competition},${formatA},5,${"5".repeat(64)},'draft',${value.account},
        '2028-01-31T10:15:00Z')`;
    expect(
      (
        await sql<
          { editable_until: string }[]
        >`SELECT editable_until::text FROM schedule_revisions WHERE id=${leapRevision}`
      )[0]?.editable_until,
    ).toContain("2028-02-29 10:15:00");

    const yearBoundaryRevision = randomUUID();
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,status,created_by,updated_at)
      VALUES(${yearBoundaryRevision},${value.competition},${formatA},6,${"6".repeat(64)},'draft',${value.account},
        '2027-12-31T10:15:00Z')`;
    expect(
      (
        await sql<
          { editable_until: string }[]
        >`SELECT editable_until::text FROM schedule_revisions WHERE id=${yearBoundaryRevision}`
      )[0]?.editable_until,
    ).toContain("2028-01-31 10:15:00");

    const latestEditRevision = randomUUID();
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,status,created_by,updated_at)
      VALUES(${latestEditRevision},${value.competition},${formatA},7,${"7".repeat(64)},'draft',${value.account},
        '2027-03-15T08:00:00Z')`;
    await sql`UPDATE schedule_revisions SET updated_at='2027-03-20T09:30:00Z' WHERE id=${latestEditRevision}`;
    expect(
      (
        await sql<
          { editable_until: string }[]
        >`SELECT editable_until::text FROM schedule_revisions WHERE id=${latestEditRevision}`
      )[0]?.editable_until,
    ).toContain("2027-04-20 09:30:00");
  });

  it("charges AI successes once, isolates cache tenants, and rejects raw prompt metadata", async () => {
    const value = await world("AI");
    const other = await world("AI Other");
    await sql`INSERT INTO ai_usage_allowances(organisation_id,actor_account_id,action,period_start,action_limit)
      VALUES(${value.organisation},${value.account},'text_to_brief',current_date,2)`;
    const ledgerId = randomUUID();
    await expect(sql`INSERT INTO ai_action_ledger(id,organisation_id,actor_account_id,action,request_id,correlation_id,idempotency_key,
      request_fingerprint,schema_version,input_character_count,metadata)
      VALUES(${randomUUID()},${value.organisation},${value.account},'text_to_brief','raw','raw','raw',${"a".repeat(64)},'1.0',10,
        '{"raw_prompt":"secret"}'::jsonb)`).rejects.toThrow();
    await expect(sql`INSERT INTO ai_action_ledger(id,organisation_id,actor_account_id,action,request_id,correlation_id,idempotency_key,
      request_fingerprint,schema_version,input_character_count,metadata)
      VALUES(${randomUUID()},${value.organisation},${value.account},'text_to_brief','nested','nested','nested',${"c".repeat(64)},'1.0',10,
        '{"safe":{"provider_output":"secret"}}'::jsonb)`).rejects.toThrow();
    await sql`SELECT phase4_begin_ai_action(${ledgerId},${value.organisation},${value.account},${value.competition},'text_to_brief',
      'ai-request','ai-correlation','ai-once',${"b".repeat(64)},'1.0',42)`;
    const completions = await Promise.all([
      sql`SELECT phase4_finalize_ai_action(${ledgerId},'success','miss',${sql.json(validBrief())},now()+interval '1 day',1,20,null)`,
      sql`SELECT phase4_finalize_ai_action(${ledgerId},'success','miss',${sql.json(validBrief())},now()+interval '1 day',1,20,null)`,
    ]);
    expect(completions).toHaveLength(2);
    const usage = await sql<
      { used_units: number }[]
    >`SELECT used_units FROM ai_usage_allowances WHERE organisation_id=${value.organisation}`;
    expect(usage[0]?.used_units).toBe(1);
    expect(await sql`SELECT id FROM ai_response_cache WHERE organisation_id=${value.organisation}`).toHaveLength(1);
    expect(await sql`SELECT id FROM ai_response_cache WHERE organisation_id=${other.organisation}`).toHaveLength(0);
    const cacheHitLedger = randomUUID();
    const [cacheHit] = await sql<
      { result: { ledger: { outcome: string; cache_status: string }; cache_result: unknown } }[]
    >`
      SELECT phase4_begin_ai_action(${cacheHitLedger},${value.organisation},${value.account},${value.competition},'text_to_brief',
        'ai-cache-hit','ai-cache-hit','ai-cache-hit',${"b".repeat(64)},'1.0',42) AS result`;
    expect(cacheHit?.result.ledger).toMatchObject({ outcome: "success", cache_status: "hit" });
    expect(cacheHit?.result.cache_result).toEqual(validBrief());
    await expect(sql`UPDATE ai_action_ledger SET charged_units=0 WHERE id=${ledgerId}`).rejects.toThrow(/server-owned/);
    expect(await sql`SELECT id FROM audit_events WHERE target_id=${ledgerId}`).toHaveLength(1);
    expect(await sql`SELECT id FROM outbox_events WHERE aggregate_id=${ledgerId}`).toHaveLength(1);
    expect(await sql`SELECT id FROM audit_events WHERE target_id=${cacheHitLedger}`).toHaveLength(1);
    expect(await sql`SELECT id FROM outbox_events WHERE aggregate_id=${cacheHitLedger}`).toHaveLength(1);

    const invalidLedger = randomUUID();
    await sql`INSERT INTO ai_action_ledger(id,organisation_id,actor_account_id,action,request_id,correlation_id,idempotency_key,
      request_fingerprint,schema_version,input_character_count) VALUES(${invalidLedger},${value.organisation},${value.account},'text_to_brief',
      'invalid-result','invalid-result','invalid-result',${"d".repeat(64)},'1.0',5)`;
    await expect(sql`SELECT phase4_finalize_ai_action(${invalidLedger},'success','miss','{"schema_version":"1.0"}'::jsonb,
      now()+interval '1 day',1,1,null)`).rejects.toThrow(/validated structured result/);
    await expect(sql`INSERT INTO ai_response_cache(organisation_id,action,request_fingerprint,schema_version,result,result_hash,validated,
      created_from_ledger_id,expires_at) VALUES(${value.organisation},'text_to_brief',${"d".repeat(64)},'1.0',${sql.json(validBrief())},
      ${hash(validBrief())},true,${invalidLedger},now()+interval '1 day')`).rejects.toThrow(
      /server-owned finalisation/,
    );
    expect(
      (
        await sql<
          { used_units: number }[]
        >`SELECT used_units FROM ai_usage_allowances WHERE organisation_id=${value.organisation}`
      )[0]?.used_units,
    ).toBe(1);

    const concurrentIds = [randomUUID(), randomUUID()];
    for (const [index, id] of concurrentIds.entries()) {
      await sql`INSERT INTO ai_action_ledger(id,organisation_id,actor_account_id,action,request_id,correlation_id,idempotency_key,
        request_fingerprint,schema_version,input_character_count) VALUES(${id},${value.organisation},${value.account},'text_to_brief',
        ${`concurrent-${index}`},${`concurrent-${index}`},${`concurrent-${index}`},${"e".repeat(64)},'1.0',20)`;
    }
    await Promise.all(
      concurrentIds.map(
        (id) => sql`SELECT phase4_finalize_ai_action(${id},'success','miss',${sql.json(validBrief())},
      now()+interval '1 day',1,10,null)`,
      ),
    );
    const concurrentRows = await sql<
      { cache_status: string; charged_units: number }[]
    >`SELECT cache_status,charged_units FROM ai_action_ledger
      WHERE id=ANY(${concurrentIds}) ORDER BY charged_units DESC`;
    expect(concurrentRows).toEqual([
      { cache_status: "miss", charged_units: 1 },
      { cache_status: "hit", charged_units: 0 },
    ]);
    expect(
      (
        await sql<
          { used_units: number }[]
        >`SELECT used_units FROM ai_usage_allowances WHERE organisation_id=${value.organisation}`
      )[0]?.used_units,
    ).toBe(2);
  });

  it("rejects every Phase 4 child write after aggregate archival", async () => {
    const value = await world("Archive");
    const jobId = randomUUID();
    const input = await prepareScheduleInput(jobId, value);
    await sql`UPDATE competitions SET status='archived',archived_from_status='draft' WHERE id=${value.competition}`;
    await expect(sql`INSERT INTO setup_drafts(organisation_id,competition_id,created_by,updated_by)
      VALUES(${value.organisation},${value.competition},${value.account},${value.account})`).rejects.toThrow(
      /archived competitions/,
    );
    await expect(sql`INSERT INTO schedule_generation_jobs(id,organisation_id,competition_id,objective,input_snapshot,input_hash,requested_by,request_id,correlation_id)
      VALUES(${jobId},${value.organisation},${value.competition},'balanced',${sql.json(input)},${hash(input)},${value.account},'archived','archived')`).rejects.toThrow(
      /archived competitions/,
    );
  });
});
