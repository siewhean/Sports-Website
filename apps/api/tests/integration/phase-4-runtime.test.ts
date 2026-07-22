import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates } from "@matchday/domain";
import type { ScheduleConstraints } from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_runtime_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let client!: Sql;
let phase3!: Phase3Runtime;
let runtime!: Phase4Runtime;
let accountId = "";
let organisationId = "";
let competitionId = "";

function required<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (!value) throw new Error("Expected database row");
  return value;
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });
  accountId = required(
    await client<
      { id: string }[]
    >`INSERT INTO accounts(primary_email,display_name,email_verified_at) VALUES('owner@phase4.test','Owner',now()) RETURNING id`,
  ).id;
  await client.begin(async (tx) => {
    organisationId = required(
      await tx<
        { id: string }[]
      >`INSERT INTO organisations(name,slug) VALUES('Phase 4 Org','phase-4-runtime-org') RETURNING id`,
    ).id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status) VALUES(${organisationId},${accountId},'owner','active')`;
  });
  phase3 = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
  competitionId = (
    await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Phase 4 Cup",
        slug: "phase-4-cup",
        sportCode: "canoe_polo",
        venue: "Test Arena",
        address: "1 Test Road",
        countryCode: "SG",
        startsOn: "2027-08-01",
        endsOn: "2027-08-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    )
  ).id;
  await client`INSERT INTO ai_usage_allowances(organisation_id,actor_account_id,action,period_start,action_limit)
    VALUES(${organisationId},${accountId},'text_to_brief',current_date,10)`;
  runtime = new Phase4Runtime(
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
  );
});

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 4 PostgreSQL and provider-stub runtime", () => {
  it("creates setup drafts through the transactional command and replays idempotently", async () => {
    const key = `setup-${randomUUID()}`;
    const created = await runtime.createSetupDraft({ accountId }, competitionId, key, randomUUID());
    const replayed = await runtime.createSetupDraft({ accountId }, competitionId, key, randomUUID());
    expect(created.idempotent_replay).toBe(false);
    expect(replayed.idempotent_replay).toBe(true);
    expect(replayed.document.id).toBe(created.document.id);
    expect(
      await client`SELECT 1 FROM audit_events WHERE action='setup.created' AND target_id=${created.document.id}`,
    ).toHaveLength(1);
    expect(
      await client`SELECT 1 FROM outbox_events WHERE event_type='setup.created' AND aggregate_id=${created.document.id}`,
    ).toHaveLength(1);

    const saveKey = `setup-save-${randomUUID()}`;
    const request = {
      expected_revision: created.document.revision,
      idempotency_key: saveKey,
      transition: {
        kind: "save_step" as const,
        step: {
          step_id: "basics" as const,
          value: {
            name: "Phase 4 Cup",
            sport_code: "canoe_polo" as const,
            location: { venue: "Test Arena", address: "1 Test Road", locality: null, country_code: "SG" },
            starts_on: "2027-08-01",
            ends_on: "2027-08-02",
            time_zone: "Asia/Singapore",
            locale: "en-SG",
            entry_count: 12,
            division_count: 2,
            entry_count_status: "confirmed" as const,
          },
        },
      },
    };
    const saved = await runtime.autosaveSetupDraft({ accountId }, competitionId, request, randomUUID());
    const savedReplay = await runtime.autosaveSetupDraft({ accountId }, competitionId, request, randomUUID());
    expect(saved.outcome).toBe("saved");
    expect(savedReplay.outcome).toBe("idempotent_replay");
    const mismatch = await runtime.autosaveSetupDraft(
      { accountId },
      competitionId,
      {
        ...request,
        transition: {
          ...request.transition,
          step: { ...request.transition.step, value: { ...request.transition.step.value, entry_count: 16 } },
        },
      },
      randomUUID(),
    );
    expect(mismatch.outcome).toBe("idempotency_mismatch");
  });

  it("validates, accounts, caches, and replays deterministic AI briefs without storing source text", async () => {
    const text =
      "Canoe polo called Harbour Cup with 12 teams, 2 divisions, 2 courts at Test Arena, 30 minute slots, minimum 3 matches, 2027-08-01 to 2027-08-02";
    const firstKey = `ai-${randomUUID()}`;
    const generated = await runtime.textToBrief(
      { accountId },
      organisationId,
      { idempotency_key: firstKey, competition_id: competitionId, text },
      randomUUID(),
    );
    expect(generated.status).toBe("success");
    if (generated.status !== "success") throw new Error("Expected successful provider result");
    expect(generated.source).toBe("provider");
    expect(generated.brief.entry_count).toBe(12);
    expect(generated.charged_units).toBe(1);

    const cached = await runtime.textToBrief(
      { accountId },
      organisationId,
      { idempotency_key: `ai-${randomUUID()}`, competition_id: competitionId, text },
      randomUUID(),
    );
    expect(cached.status).toBe("success");
    if (cached.status !== "success") throw new Error("Expected successful cached result");
    expect(cached.source).toBe("cache");
    expect(cached.charged_units).toBe(0);
    const ledger = await client<{ source_text_count: number; used_units: number }[]>`
      SELECT count(*) FILTER (WHERE metadata::text ILIKE ${`%${text}%`})::int source_text_count,
        (SELECT used_units FROM ai_usage_allowances WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief')::int used_units
      FROM ai_action_ledger WHERE organisation_id=${organisationId}`;
    expect(ledger[0]).toEqual({ source_text_count: 0, used_units: 1 });
  });

  it("rejects a second active schedule job and fences accepted work when entries change", async () => {
    const divisionId = randomUUID();
    await client`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',8)`;
    for (let seed = 1; seed <= 8; seed += 1) {
      await client`INSERT INTO division_entries(id,division_id,name,seed,status)
        VALUES(${randomUUID()},${divisionId},${`Entry ${seed}`},${seed},'confirmed')`;
    }
    const areaId = randomUUID();
    const intervalId = randomUUID();
    await client`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
      VALUES(${areaId},${competitionId},'Schedule court',30)`;
    await client`INSERT INTO competition_availability_windows(id,competition_id,playing_area_id,starts_at,ends_at)
      VALUES(${intervalId},${competitionId},${areaId},'2027-08-01T00:00:00Z','2027-08-02T00:00:00Z')`;
    const formatId = randomUUID();
    const graph = structuredClone(
      createDefaultFormatTemplates(8).find((template) => template.strategy === "compact_knockout")!.graph,
    );
    await client`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract)
      VALUES(${formatId},${competitionId},${divisionId},1,${client.json(graph)},phase4_sha256_json(${client.json(graph)}::jsonb),
        ${client.json({ schema_version: 1, stage_positions: graph.stages.map((stage, index) => ({ stage_id: stage.id, x: index * 240, y: 80 })) })},${accountId},'phase3')`;
    await client`SELECT phase4_materialize_format_revision(${formatId})`;
    await client`INSERT INTO format_validation_evidence(format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
      slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
      SELECT id,definition_hash,false,false,false,false,0,0,0,false,${accountId} FROM format_revisions WHERE id=${formatId}`;
    await client`SELECT phase4_publish_format_revision(${formatId},${accountId},'phase4-api-publish-format')`;
    const competition = required(
      await client<{ revision: number; capacity_revision: number }[]>`
      SELECT revision,capacity_revision FROM competitions WHERE id=${competitionId}`,
    );
    const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
    const constraints: ScheduleConstraints = {
      minimum_rest: ignored({ minutes: 0 }),
      maximum_matches_per_day: ignored({ matches: 8 }),
      preferred_final_time: ignored({
        target_start_epoch_ms: Date.parse("2027-08-01T12:00:00Z"),
        tolerance_minutes: 60,
      }),
      entry_unavailable: ignored({ by_entry_id: {} }),
      official_availability: ignored({ by_official_id: {} }),
      featured_playing_area: ignored({ area_id: areaId, match_ids: [] }),
      avoid_consecutive_matches: ignored({ minutes: 0 }),
      balance_early_matches: ignored({ before_local_time: "09:00" }),
      balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
      keep_division_together: ignored({ maximum_area_count: 1 }),
      preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
    };
    const request = {
      idempotency_key: randomUUID(),
      expected_source_revision: competition.revision,
      expected_capacity_revision: Number(competition.capacity_revision),
      objective: "balanced" as const,
      constraints,
    };
    const generated = await runtime.generateSchedule({ accountId }, competitionId, request, randomUUID());
    await expect(
      runtime.generateSchedule(
        { accountId },
        competitionId,
        { ...request, idempotency_key: randomUUID() },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACTIVE_SCHEDULE_JOB" });
    const assertCurrent = runtime as unknown as {
      assertScheduleJobCurrent(tx: PostgresJsSql, jobId: string): Promise<void>;
    };
    await expect(
      assertCurrent.assertScheduleJobCurrent(client as unknown as PostgresJsSql, generated.job.id),
    ).resolves.toBeUndefined();
    await client`UPDATE division_entries SET status='withdrawn',withdrawal_reason='Test schedule fence'
      WHERE division_id=${divisionId} AND seed=8`;
    await expect(
      assertCurrent.assertScheduleJobCurrent(client as unknown as PostgresJsSql, generated.job.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STALE_SCHEDULE_INPUT",
    });
  });
});
