import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates, generateConstraintAwareSchedule, type ScheduleProblem } from "@matchday/domain";
import type { Phase4FormatBuilderDocument, ScheduleConstraints, ScheduleJobInput } from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import {
  DomainScheduleOptimizer,
  PostgresScheduleJobStore,
  ScheduleJobQueue,
  SchedulerRuntime,
} from "@matchday/scheduler";
import postgres, { type Sql } from "postgres";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../../src/phase-4-reliable-runtime.js";
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
let phase2!: Phase2Runtime;
let accountId = "";
let viewerId = "";
let officialId = "";
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
  viewerId = required(
    await client<
      { id: string }[]
    >`INSERT INTO accounts(primary_email,display_name,email_verified_at) VALUES('viewer@phase4.test','Viewer',now()) RETURNING id`,
  ).id;
  officialId = required(
    await client<
      { id: string }[]
    >`INSERT INTO accounts(primary_email,display_name,email_verified_at) VALUES('official@phase4.test','Official',now()) RETURNING id`,
  ).id;
  await client.begin(async (tx) => {
    organisationId = required(
      await tx<
        { id: string }[]
      >`INSERT INTO organisations(name,slug) VALUES('Phase 4 Org','phase-4-runtime-org') RETURNING id`,
    ).id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status) VALUES
      (${organisationId},${accountId},'owner','active'),(${organisationId},${viewerId},'viewer','active')`;
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
  await client`INSERT INTO official_grants(account_id,organisation_id,resource_type,resource_id,granted_by)
    VALUES(${officialId},${organisationId},'competition',${competitionId},${accountId})`;
  await client`INSERT INTO ai_usage_allowances(organisation_id,actor_account_id,action,period_start,action_limit)
    VALUES(${organisationId},${accountId},'text_to_brief',current_date,10)`;
  phase2 = new Phase2Runtime(client as unknown as PostgresJsSql, phase2DomainAdapter);
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
    undefined,
    phase2,
  );
});

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 4 PostgreSQL and provider-stub runtime", () => {
  it("loads a schedule workspace ordered across multiple divisions", async () => {
    const scheduleCompetition = await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Schedule workspace ordering",
        slug: `schedule-workspace-ordering-${randomUUID()}`,
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
    );
    await client`INSERT INTO divisions(competition_id,name,team_limit) VALUES
      (${scheduleCompetition.id},'Second division',8)`;

    const workspace = await runtime.scheduleWorkspace({ accountId }, scheduleCompetition.id);

    expect(workspace.competition.id).toBe(scheduleCompetition.id);
    expect(workspace.generation.capacity_revision).toBeTypeOf("number");
    expect(workspace.matches).toEqual([]);
  });

  it("round-trips one canonical format lineage and enforces current template versions", async () => {
    const formatCompetition = await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Format round trip",
        slug: `format-round-trip-${randomUUID()}`,
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
    );
    const formatCompetitionId = formatCompetition.id;
    const sourceDivisionId = randomUUID();
    const sameSportDivisionId = randomUUID();
    const archivedTargetDivisionId = randomUUID();
    await client`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES
      (${sourceDivisionId},${formatCompetitionId},'Format source',8),
      (${sameSportDivisionId},${formatCompetitionId},'Format target',8),
      (${archivedTargetDivisionId},${formatCompetitionId},'Archived target',8)`;
    const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
    const document: Phase4FormatBuilderDocument = {
      schema_version: 1,
      graph,
      layout: {
        schema_version: 1,
        stage_positions: graph.stages.map((stage, index) => ({ stage_id: stage.id, x: index * 240, y: 80 })),
      },
    };

    const validation = await runtime.validateFormat({ accountId }, formatCompetitionId, sourceDivisionId, document);
    expect(validation).toMatchObject({ valid: true, graph_hash: expect.any(String) });
    if (!validation.valid) throw new Error("Expected canonical graph to validate");
    expect(validation.materialisation.matches).toHaveLength(graph.matches.length);

    const root = await runtime.saveFormatRevision(
      { accountId },
      formatCompetitionId,
      sourceDivisionId,
      {
        draft_id: null,
        expected_revision: null,
        parent_revision_id: null,
        document,
        idempotency_key: `format-root-${randomUUID()}`,
      },
      randomUUID(),
    );
    const movedDocument = structuredClone(document);
    const firstPosition = movedDocument.layout.stage_positions[0]!;
    Object.assign(firstPosition, { x: firstPosition.x + 96, y: firstPosition.y + 48 });
    const next = await runtime.saveFormatRevision(
      { accountId },
      formatCompetitionId,
      sourceDivisionId,
      {
        draft_id: root.draft_id,
        expected_revision: root.revision,
        parent_revision_id: root.draft_id,
        document: movedDocument,
        idempotency_key: `format-next-${randomUUID()}`,
      },
      randomUUID(),
    );
    expect(next).toMatchObject({
      parent_revision_id: root.draft_id,
      root_revision_id: root.draft_id,
      document: movedDocument,
    });
    expect(next.document.graph.stages.map((stage) => stage.id)).toEqual(graph.stages.map((stage) => stage.id));
    expect(next.document.graph.matches).toEqual(graph.matches);
    const reloaded = await runtime.readFormatBuilder({ accountId }, formatCompetitionId, sourceDivisionId);
    expect(reloaded.draft).toMatchObject({
      draft_id: next.draft_id,
      parent_revision_id: root.draft_id,
      root_revision_id: root.draft_id,
      document: movedDocument,
    });
    await expect(
      runtime.saveFormatRevision(
        { accountId },
        formatCompetitionId,
        sourceDivisionId,
        {
          draft_id: next.draft_id,
          expected_revision: next.revision,
          parent_revision_id: next.draft_id,
          document: movedDocument,
          idempotency_key: `format-no-op-${randomUUID()}`,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      runtime.saveFormatRevision(
        { accountId },
        formatCompetitionId,
        sourceDivisionId,
        {
          draft_id: root.draft_id,
          expected_revision: root.revision,
          parent_revision_id: root.draft_id,
          document,
          idempotency_key: `format-stale-${randomUUID()}`,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "REVISION_CONFLICT" });

    const materialised = await runtime.materialiseFormat(
      { accountId },
      next.draft_id,
      `materialise-${randomUUID()}`,
      randomUUID(),
    );
    const replayedProjection = await runtime.materialiseFormat(
      { accountId },
      next.draft_id,
      `materialise-${randomUUID()}`,
      randomUUID(),
    );
    expect(replayedProjection).toMatchObject({
      match_count: materialised.match_count,
      materialisation_hash: materialised.materialisation_hash,
    });

    const createdTemplate = await runtime.saveFormatTemplate(
      { accountId },
      organisationId,
      {
        template_id: null,
        parent_version_id: null,
        expected_version: null,
        name: "Canonical format",
        description: null,
        sport_code: "canoe_polo",
        source_format_revision_id: next.draft_id,
        idempotency_key: `template-create-${randomUUID()}`,
      },
      randomUUID(),
    );
    const applied = await runtime.applyFormatTemplate(
      { accountId },
      organisationId,
      {
        competition_id: formatCompetitionId,
        division_id: sameSportDivisionId,
        template_version_id: createdTemplate.template_version_id,
        expected_format_revision: null,
        idempotency_key: `template-apply-${randomUUID()}`,
      },
      randomUUID(),
    );
    expect(applied.document).toEqual(next.document);
    const appliedMaterialisation = await runtime.materialiseFormat(
      { accountId },
      applied.draft_id,
      `materialise-applied-${randomUUID()}`,
      randomUUID(),
    );
    expect(appliedMaterialisation).toMatchObject({
      match_count: materialised.match_count,
      materialisation_hash: materialised.materialisation_hash,
    });
    const [sourceFixtures, appliedFixtures] = await Promise.all([
      client`SELECT graph_match_id,graph_stage_id,graph_pool_id,graph_purpose,round_number,ordinal
        FROM matches WHERE format_revision_id=${next.draft_id} ORDER BY ordinal`,
      client`SELECT graph_match_id,graph_stage_id,graph_pool_id,graph_purpose,round_number,ordinal
        FROM matches WHERE format_revision_id=${applied.draft_id} ORDER BY ordinal`,
    ]);
    expect(appliedFixtures).toEqual(sourceFixtures);

    const updatedTemplate = await runtime.saveFormatTemplate(
      { accountId },
      organisationId,
      {
        template_id: createdTemplate.template_id,
        parent_version_id: createdTemplate.template_version_id,
        expected_version: createdTemplate.revision,
        name: "Canonical format revised",
        description: null,
        sport_code: "canoe_polo",
        source_format_revision_id: next.draft_id,
        idempotency_key: `template-update-${randomUUID()}`,
      },
      randomUUID(),
    );
    expect(updatedTemplate).toMatchObject({ template_id: createdTemplate.template_id, revision: 2 });
    const listedTemplates = await runtime.listFormatTemplates({ accountId }, organisationId, false);
    expect(listedTemplates).toHaveLength(1);
    expect(listedTemplates[0]).toMatchObject({
      template_id: updatedTemplate.template_id,
      template_version_id: updatedTemplate.template_version_id,
      revision: 2,
    });

    const volleyball = await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Cross sport target",
        slug: `cross-sport-${randomUUID()}`,
        sportCode: "volleyball",
        venue: "Test Arena",
        address: "1 Test Road",
        countryCode: "SG",
        startsOn: "2027-08-01",
        endsOn: "2027-08-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const volleyballDivision = randomUUID();
    await client`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${volleyballDivision},${volleyball.id},'Cross sport',8)`;
    await expect(
      runtime.applyFormatTemplate(
        { accountId },
        organisationId,
        {
          competition_id: volleyball.id,
          division_id: volleyballDivision,
          template_version_id: updatedTemplate.template_version_id,
          expected_format_revision: null,
          idempotency_key: `template-cross-sport-${randomUUID()}`,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "DOMAIN_VALIDATION_FAILED" });

    const otherOrganisationId = await client.begin(async (transaction) => {
      const id = required(
        await transaction<{ id: string }[]>`INSERT INTO organisations(name,slug)
          VALUES('Other template org',${`other-template-${randomUUID()}`}) RETURNING id`,
      ).id;
      await transaction`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${id},${accountId},'owner','active')`;
      return id;
    });
    await expect(
      runtime.applyFormatTemplate(
        { accountId },
        otherOrganisationId,
        {
          competition_id: formatCompetitionId,
          division_id: archivedTargetDivisionId,
          template_version_id: updatedTemplate.template_version_id,
          expected_format_revision: null,
          idempotency_key: `template-cross-org-${randomUUID()}`,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_DENIED" });

    await runtime.archiveFormatTemplate(
      { accountId },
      organisationId,
      updatedTemplate.template_id,
      { expected_status: "active", idempotency_key: `template-archive-${randomUUID()}` },
      randomUUID(),
    );
    await expect(
      runtime.applyFormatTemplate(
        { accountId },
        organisationId,
        {
          competition_id: formatCompetitionId,
          division_id: archivedTargetDivisionId,
          template_version_id: updatedTemplate.template_version_id,
          expected_format_revision: null,
          idempotency_key: `template-archived-${randomUUID()}`,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "TEMPLATE_ARCHIVED" });
  });

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

  it("preserves organiser text and does not charge when the AI provider fails", async () => {
    await client`UPDATE ai_usage_allowances SET action_limit=used_units+10
      WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief'`;
    const before = required(
      await client<{ used_units: number }[]>`
        SELECT used_units FROM ai_usage_allowances
        WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief'`,
    ).used_units;
    const failingRuntime = new Phase4Runtime(
      client as unknown as PostgresJsSql,
      phase3,
      { enqueueSchedule: async () => ({ id: "ignored", name: "schedule.optimize", duplicate: false }) },
      {
        mode: "stub",
        provider: {
          generateCompetitionBrief: async () => {
            throw new Error("synthetic provider outage");
          },
        },
        timeoutMs: 2_000,
        maximumAttempts: 1,
        cacheTtlSeconds: 3_600,
      },
      undefined,
      phase2,
    );
    const text = "Keep this exact organiser brief when the provider is unavailable";
    const idempotencyKey = `ai-failure-${randomUUID()}`;

    const result = await failingRuntime.textToBrief(
      { accountId },
      organisationId,
      { idempotency_key: idempotencyKey, competition_id: competitionId, text },
      randomUUID(),
    );

    expect(result).toMatchObject({
      status: "manual_fallback",
      reason: "unknown",
      preserved_text: text,
      charged_units: 0,
    });
    const replay = await failingRuntime.textToBrief(
      { accountId },
      organisationId,
      { idempotency_key: idempotencyKey, competition_id: competitionId, text },
      randomUUID(),
    );
    expect(replay).toMatchObject({
      status: "manual_fallback",
      reason: "unknown",
      preserved_text: text,
      charged_units: 0,
      idempotent_replay: true,
    });
    const after = required(
      await client<{ used_units: number }[]>`
        SELECT used_units FROM ai_usage_allowances
        WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief'`,
    ).used_units;
    expect(after).toBe(before);
    const ledger = required(
      await client<{ id: string; outcome: string; charged_units: number; failure_code: string | null }[]>`
        SELECT id,outcome,charged_units,failure_code FROM ai_action_ledger
        WHERE organisation_id=${organisationId} AND idempotency_key=${idempotencyKey}`,
    );
    expect(ledger).toMatchObject({ outcome: "manual_fallback", charged_units: 0, failure_code: "unknown" });
    expect(await client`SELECT id FROM audit_events WHERE target_id=${ledger.id}`).toHaveLength(1);
    expect(await client`SELECT id FROM outbox_events WHERE aggregate_id=${ledger.id}`).toHaveLength(1);
  });

  it("persists quota exhaustion distinctly and replays it without charging", async () => {
    await client`UPDATE ai_usage_allowances SET action_limit=used_units
      WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief'`;
    const text = "Preserve this brief when quota is exhausted";
    const idempotencyKey = `ai-quota-${randomUUID()}`;
    const request = { idempotency_key: idempotencyKey, competition_id: competitionId, text };

    const first = await runtime.textToBrief({ accountId }, organisationId, request, randomUUID());
    const replay = await runtime.textToBrief({ accountId }, organisationId, request, randomUUID());

    expect(first).toMatchObject({
      status: "quota_exhausted",
      reason: "quota_exhausted",
      preserved_text: text,
      charged_units: 0,
    });
    expect(replay).toMatchObject({
      status: "quota_exhausted",
      reason: "quota_exhausted",
      preserved_text: text,
      charged_units: 0,
      idempotent_replay: true,
    });
    expect(
      required(
        await client<{ outcome: string; charged_units: number; failure_code: string | null }[]>`
          SELECT outcome,charged_units,failure_code FROM ai_action_ledger
          WHERE organisation_id=${organisationId} AND idempotency_key=${idempotencyKey}`,
      ),
    ).toMatchObject({ outcome: "manual_fallback", charged_units: 0, failure_code: "quota_exhausted" });
  });

  it("records a quota race distinctly when concurrent valid provider results compete for one unit", async () => {
    await client`UPDATE ai_usage_allowances SET action_limit=used_units+1
      WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief'`;
    const before = required(
      await client<{ used_units: number }[]>`SELECT used_units FROM ai_usage_allowances
        WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief'`,
    ).used_units;
    const requests = [
      {
        idempotency_key: `ai-race-a-${randomUUID()}`,
        competition_id: competitionId,
        text: "Canoe polo called Race A with 8 teams, 1 division, 1 court at Arena A, 30 minute slots, minimum 2 matches, 2027-08-01 to 2027-08-02",
      },
      {
        idempotency_key: `ai-race-b-${randomUUID()}`,
        competition_id: competitionId,
        text: "Canoe polo called Race B with 8 teams, 1 division, 1 court at Arena B, 30 minute slots, minimum 2 matches, 2027-08-01 to 2027-08-02",
      },
    ] as const;

    const results = await Promise.all(
      requests.map((request) => runtime.textToBrief({ accountId }, organisationId, request, randomUUID())),
    );
    expect(results.map((result) => result.status).sort()).toEqual(["quota_exhausted", "success"]);
    const exhaustedIndex = results.findIndex((result) => result.status === "quota_exhausted");
    expect(exhaustedIndex).toBeGreaterThanOrEqual(0);
    const exhaustedRequest = requests[exhaustedIndex]!;
    expect(results[exhaustedIndex]).toMatchObject({
      status: "quota_exhausted",
      reason: "quota_exhausted",
      preserved_text: exhaustedRequest.text,
      charged_units: 0,
    });
    const replay = await runtime.textToBrief({ accountId }, organisationId, exhaustedRequest, randomUUID());
    expect(replay).toMatchObject({
      status: "quota_exhausted",
      reason: "quota_exhausted",
      preserved_text: exhaustedRequest.text,
      charged_units: 0,
      idempotent_replay: true,
    });
    expect(
      await client<{ outcome: string; charged_units: number; failure_code: string | null }[]>`
        SELECT outcome,charged_units,failure_code FROM ai_action_ledger
        WHERE organisation_id=${organisationId} AND idempotency_key=ANY(${requests.map((request) => request.idempotency_key)})
        ORDER BY charged_units DESC`,
    ).toEqual([
      { outcome: "success", charged_units: 1, failure_code: null },
      { outcome: "manual_fallback", charged_units: 0, failure_code: "quota_exhausted" },
    ]);
    expect(
      required(
        await client<{ used_units: number }[]>`SELECT used_units FROM ai_usage_allowances
          WHERE organisation_id=${organisationId} AND actor_account_id=${accountId} AND action='text_to_brief'`,
      ).used_units,
    ).toBe(before + 1);
  });

  it("carries one setup and format lineage through the real worker, revisions, publication and stale fence", async () => {
    await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Basketball pack seed",
        slug: `basketball-pack-seed-${randomUUID()}`,
        sportCode: "basketball",
        venue: "Seed Arena",
        address: "1 Seed Road",
        countryCode: "SG",
        startsOn: "2027-07-01",
        endsOn: "2027-07-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
    const journeyCompetitionId = (
      await phase3.createCompetition(
        { accountId },
        {
          organisationId,
          name: "Gate B complete journey",
          slug: "gate-b-complete-journey",
          sportCode: "canoe_polo",
          venue: "Journey Arena",
          address: "16 Journey Road",
          countryCode: "SG",
          startsOn: "2027-08-01",
          endsOn: "2027-08-02",
          timezone: "Asia/Singapore",
          locale: "en-SG",
        },
        randomUUID(),
      )
    ).id;
    await client`INSERT INTO official_grants(account_id,organisation_id,resource_type,resource_id,granted_by)
      VALUES(${officialId},${organisationId},'competition',${journeyCompetitionId},${accountId})`;
    const divisionIds = [randomUUID(), randomUUID()] as const;
    await client`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES
      (${divisionIds[0]},${journeyCompetitionId},'Open',8),
      (${divisionIds[1]},${journeyCompetitionId},'Women',8)`;
    for (const [divisionIndex, divisionId] of divisionIds.entries()) {
      for (let seed = 1; seed <= 8; seed += 1) {
        await client`INSERT INTO division_entries(id,division_id,name,seed,status)
          VALUES(${randomUUID()},${divisionId},${`Division ${divisionIndex + 1} entry ${seed}`},${seed},'confirmed')`;
      }
    }
    const canoePack = required(
      await client<{ pack_version: string }[]>`
        SELECT pack_version FROM competition_sport_settings WHERE competition_id=${journeyCompetitionId}`,
    );
    await client`INSERT INTO division_sport_settings(
      division_id,competition_id,sport_code,pack_version,settings_override,updated_by
    ) VALUES
      (${divisionIds[0]},${journeyCompetitionId},'canoe_polo',${canoePack.pack_version},'{}'::jsonb,${accountId}),
      (${divisionIds[1]},${journeyCompetitionId},'canoe_polo',${canoePack.pack_version},'{}'::jsonb,${accountId})`;
    await phase3.replaceCapacity(
      { accountId },
      journeyCompetitionId,
      {
        revision: 1,
        areas: [
          {
            name: "Journey court",
            slotMinutes: 30,
            availability: [
              { date: "2027-08-01", startTime: "00:00", endTime: "23:30" },
              { date: "2027-08-02", startTime: "00:00", endTime: "23:30" },
            ],
          },
        ],
      },
      randomUUID(),
    );
    const areaId = required(
      await client<{ id: string }[]>`SELECT id FROM playing_areas WHERE competition_id=${journeyCompetitionId}`,
    ).id;
    const queueName = `matchday-gate-b-journey-${randomUUID()}`;
    const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
    const apiQueue = new ScheduleJobQueue({ queueName, redisUrl });
    const journeyRuntime = new ReliableGateBPhase4Runtime(
      client as unknown as PostgresJsSql,
      phase3,
      apiQueue,
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
    const createdSetup = await journeyRuntime.createSetupDraft(
      { accountId },
      journeyCompetitionId,
      `journey-create-${randomUUID()}`,
      randomUUID(),
    );
    const resumedSetup = await journeyRuntime.resumeSetupDraft(
      { accountId },
      journeyCompetitionId,
      `journey-resume-${randomUUID()}`,
      randomUUID(),
    );
    expect(resumedSetup).toMatchObject({ id: createdSetup.document.id, competition_id: journeyCompetitionId });
    const basics = resumedSetup.values.basics;
    if (!basics) throw new Error("Expected canonical setup basics");
    const basicsSaved = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: resumedSetup.revision,
        idempotency_key: `journey-basics-${randomUUID()}`,
        transition: { kind: "save_step", step: { step_id: "basics", value: { ...basics, sport_code: "basketball" } } },
      },
      randomUUID(),
    );
    expect(basicsSaved.outcome).toBe("saved");
    if (basicsSaved.outcome !== "saved") throw new Error("Expected Basketball basics to save");
    expect(basicsSaved.document).toMatchObject({ competition_id: journeyCompetitionId, current_step: "capacity" });
    expect(
      required(
        await client<{ sport_code: string; slot_minutes: number; settings_sports: string[] }[]>`
          SELECT competition.sport_code,area.slot_minutes,
            array_agg(DISTINCT division_settings.sport_code ORDER BY division_settings.sport_code) settings_sports
          FROM competitions competition
          JOIN playing_areas area ON area.competition_id=competition.id
          JOIN division_sport_settings division_settings ON division_settings.competition_id=competition.id
          WHERE competition.id=${journeyCompetitionId}
          GROUP BY competition.sport_code,area.slot_minutes`,
      ),
    ).toEqual({ sport_code: "basketball", slot_minutes: 40, settings_sports: ["basketball"] });
    let setupDocument = await journeyRuntime.resumeSetupDraft(
      { accountId },
      journeyCompetitionId,
      `journey-refresh-after-sport-${randomUUID()}`,
      randomUUID(),
    );
    expect(setupDocument).toMatchObject({ id: createdSetup.document.id, current_step: "capacity" });
    const capacity = setupDocument.values.capacity;
    if (!capacity) throw new Error("Expected refreshed capacity reference");
    const capacitySaved = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `journey-capacity-${randomUUID()}`,
        transition: { kind: "save_step", step: { step_id: "capacity", value: capacity } },
      },
      randomUUID(),
    );
    if (capacitySaved.outcome !== "saved") throw new Error("Expected capacity to save");
    setupDocument = capacitySaved.document;
    const settings = setupDocument.values.settings;
    if (!settings) throw new Error("Expected dynamic settings references");
    const settingsSaved = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `journey-settings-${randomUUID()}`,
        transition: { kind: "save_step", step: { step_id: "settings", value: settings } },
      },
      randomUUID(),
    );
    if (settingsSaved.outcome !== "saved") throw new Error("Expected settings to save");
    setupDocument = settingsSaved.document;
    const entries = setupDocument.values.entries;
    if (!entries) throw new Error("Expected division and entry references");
    expect(entries).toMatchObject({ competition_id: journeyCompetitionId, total_entry_count: 16 });
    expect(entries.divisions).toHaveLength(2);
    const entriesSaved = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `journey-entries-${randomUUID()}`,
        transition: { kind: "save_step", step: { step_id: "entries", value: entries } },
      },
      randomUUID(),
    );
    if (entriesSaved.outcome !== "saved") throw new Error("Expected entries to save");
    setupDocument = entriesSaved.document;
    const preferences = setupDocument.values.format_preferences;
    if (!preferences) throw new Error("Expected format preferences");
    const preferencesSaved = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `journey-preferences-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "format_preferences",
            value: {
              ...preferences,
              minimum_matches: { per_entry: 1 },
              ranking: { rank_all_entries: false },
              placement: { required: false },
              priority: { value: "speed" },
            },
          },
        },
      },
      randomUUID(),
    );
    if (preferencesSaved.outcome !== "saved") throw new Error("Expected preferences to save");
    const recommendationSelection = preferencesSaved.document.values.format_recommendations;
    if (!recommendationSelection?.recommendations[0]) throw new Error("Expected a capacity-filtered recommendation");
    expect(recommendationSelection.recommendations.every((item) => item.capacity_status !== "requires_changes")).toBe(
      true,
    );
    const selectedRecommendationId = recommendationSelection.recommendations[0].id;
    const recommendationSaved = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: preferencesSaved.document.revision,
        idempotency_key: `journey-recommendation-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "format_recommendations",
            value: { ...recommendationSelection, selected_recommendation_id: selectedRecommendationId },
          },
        },
      },
      randomUUID(),
    );
    if (recommendationSaved.outcome !== "saved") throw new Error("Expected recommendation selection to save");
    setupDocument = recommendationSaved.document;
    const selectedRecommendation = setupDocument.values.format_recommendations?.recommendations.find(
      (item) => item.id === selectedRecommendationId,
    );
    if (!selectedRecommendation) throw new Error("Expected selected recommendation evidence");
    expect(selectedRecommendation.division_formats).toHaveLength(2);
    for (const divisionFormat of selectedRecommendation.division_formats) {
      if (!divisionFormat.format_revision_id) throw new Error("Expected an applied format revision");
      const builder = await journeyRuntime.readFormatBuilder(
        { accountId },
        journeyCompetitionId,
        divisionFormat.division_id,
      );
      expect(builder.draft).toMatchObject({
        draft_id: divisionFormat.format_revision_id,
        definition_hash: divisionFormat.format_definition_hash,
      });
      if (!builder.draft) throw new Error("Expected persisted canonical format document");
      const validation = await journeyRuntime.validateFormat(
        { accountId },
        journeyCompetitionId,
        divisionFormat.division_id,
        builder.draft.document,
      );
      expect(validation).toMatchObject({ valid: true, graph_hash: divisionFormat.format_definition_hash });
      const materialised = await journeyRuntime.materialiseFormat(
        { accountId },
        divisionFormat.format_revision_id,
        `journey-materialise-${randomUUID()}`,
        randomUUID(),
      );
      expect(materialised.match_count).toBe(divisionFormat.match_count);
      await client`INSERT INTO format_validation_evidence(format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,
        slots_unambiguous,deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by)
        SELECT id,definition_hash,false,false,false,false,0,0,0,false,${accountId}
        FROM format_revisions WHERE id=${divisionFormat.format_revision_id}`;
      await client`SELECT phase4_publish_format_revision(
        ${divisionFormat.format_revision_id},${accountId},${`journey-publish-format-${divisionFormat.format_revision_id}`})`;
    }
    const competition = required(
      await client<{ revision: number; capacity_revision: number }[]>`
      SELECT revision,capacity_revision FROM competitions WHERE id=${journeyCompetitionId}`,
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
    const generated = await journeyRuntime.generateSchedule({ accountId }, journeyCompetitionId, request, randomUUID());
    expect(generated.job).toMatchObject({
      progress_iteration: null,
      explored_candidates: 0,
      progress_updated_at: null,
    });
    await expect(
      journeyRuntime.generateSchedule(
        { accountId },
        journeyCompetitionId,
        { ...request, idempotency_key: randomUUID() },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACTIVE_SCHEDULE_JOB" });
    const scheduler = new SchedulerRuntime({
      queueName,
      redisUrl,
      workerId: `gate-b-worker-${randomUUID()}`,
      store: new PostgresScheduleJobStore(client),
      optimizer: new DomainScheduleOptimizer({ maxIterationsPerRun: 3 }),
      concurrency: 1,
      processor: { leaseMs: 5_000, cancellationPollMs: 20, maxYieldIntervalMs: 1_000 },
    });
    try {
      await scheduler.start();
      await waitForCompletedScheduleJob(journeyRuntime, accountId, generated.job.id);
    } finally {
      await Promise.all([apiQueue.close(), scheduler.stop()]);
    }
    const persisted = required(
      await client<{ input_hash: string; input_snapshot: ScheduleJobInput; revision: number }[]>`
        SELECT input_hash,input_snapshot,revision
        FROM schedule_generation_jobs WHERE id=${generated.job.id}`,
    );
    const checkpointed = await journeyRuntime.readScheduleJob({ accountId }, generated.job.id);
    expect(checkpointed).toMatchObject({
      status: "completed",
      progress_updated_at: expect.any(String),
    });
    expect(checkpointed.explored_candidates).toBeGreaterThanOrEqual(1);
    if (!checkpointed.current_best_option_id || !checkpointed.current_best)
      throw new Error("Expected a current-best option");
    const accepted = await journeyRuntime.acceptScheduleOption(
      { accountId },
      generated.job.id,
      checkpointed.current_best_option_id,
      { idempotency_key: randomUUID(), expected_job_revision: checkpointed.revision },
      randomUUID(),
    );
    expect(accepted.status).toBe("ready_for_review");
    if (!selectedRecommendation.format_revision_id) throw new Error("Expected selected format lineage");
    const settingsReferences = setupDocument.values.settings?.map((reference) => ({
      scope: reference.scope,
      division_id: reference.division_id,
      settings_revision: reference.settings_revision,
      pack_definition_hash: reference.pack_definition_hash,
    }));
    if (!settingsReferences?.length) throw new Error("Expected schedule settings lineage");
    const scheduleSaved = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `journey-schedule-review-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "schedule_review",
            value: {
              schedule_job_id: generated.job.id,
              source_revision: generated.job.source_revision,
              selected_recommendation_id: selectedRecommendationId,
              format_revision_id: selectedRecommendation.format_revision_id,
              format_definition_hash: selectedRecommendation.format_definition_hash,
              capacity_revision: generated.job.capacity_revision,
              settings_references: settingsReferences,
              selected_result_revision: checkpointed.current_best.result_revision,
              selected_result_hash: accepted.assignment_hash!,
              objective: generated.job.objective,
              schedule_revision_id: accepted.id,
              feasibility: "valid",
            },
          },
        },
      },
      randomUUID(),
    );
    if (scheduleSaved.outcome !== "saved") throw new Error("Expected schedule review to save");
    setupDocument = scheduleSaved.document;
    expect(setupDocument).toMatchObject({ current_step: "review_publish" });
    const lockedAssignment = accepted.assignments[0]!;
    await journeyRuntime.lockScheduleAssignment(
      { accountId },
      accepted.id,
      {
        idempotency_key: randomUUID(),
        match_id: lockedAssignment.match_id,
        playing_area_id: lockedAssignment.area_id,
        start_epoch_ms: lockedAssignment.start_epoch_ms,
        end_epoch_ms: lockedAssignment.end_epoch_ms,
      },
      randomUUID(),
    );
    const buildScheduleProblem = journeyRuntime as unknown as {
      buildScheduleProblem(
        tx: PostgresJsSql,
        access: {
          id: string;
          organisation_id: string;
          sport_code: string;
          status: string;
          timezone: string;
          capacity_revision: number;
          revision: number;
        },
        objective: "balanced",
        constraints: ScheduleConstraints,
      ): Promise<{ problem: ScheduleProblem }>;
    };
    const accessRow = required(
      await client<
        {
          id: string;
          organisation_id: string;
          sport_code: string;
          status: string;
          timezone: string;
          capacity_revision: number;
          revision: number;
        }[]
      >`SELECT id,organisation_id,sport_code,status,timezone,capacity_revision,revision FROM competitions WHERE id=${journeyCompetitionId}`,
    );
    const access = { ...accessRow, capacity_revision: Number(accessRow.capacity_revision) };
    const lockedProblem = await buildScheduleProblem.buildScheduleProblem(
      client as unknown as PostgresJsSql,
      access,
      "balanced",
      constraints,
    );
    expect(
      lockedProblem.problem.matches.find((match) => match.id === lockedAssignment.match_id)?.fixedAssignment,
    ).toEqual(expect.objectContaining({ reason: "locked", areaId: lockedAssignment.area_id }));
    expect(
      generateConstraintAwareSchedule(lockedProblem.problem).find(
        (assignment) => assignment.matchId === lockedAssignment.match_id,
      ),
    ).toMatchObject({
      areaId: lockedAssignment.area_id,
      startEpochMs: lockedAssignment.start_epoch_ms,
      endEpochMs: lockedAssignment.end_epoch_ms,
    });

    const occupiedSlots = new Set(accepted.assignments.map((assignment) => assignment.slot_id));
    const movable = accepted.assignments.at(-1)!;
    let validTarget: ScheduleJobInput["slots"][number] | null = null;
    for (const slot of persisted.input_snapshot.slots) {
      if (occupiedSlots.has(slot.slot_id)) continue;
      const preview = await journeyRuntime.validateScheduleMove({ accountId }, accepted.id, {
        match_id: movable.match_id,
        playing_area_id: slot.area_id,
        slot_id: slot.slot_id,
        start_epoch_ms: slot.start_epoch_ms,
        end_epoch_ms: slot.end_epoch_ms,
      });
      if (preview.validation.valid) {
        validTarget = slot;
        break;
      }
    }
    if (!validTarget) throw new Error("Expected a valid local repair target");
    const repaired = await journeyRuntime.moveScheduleMatch(
      { accountId },
      accepted.id,
      {
        idempotency_key: randomUUID(),
        expected_revision: accepted.revision,
        match_id: movable.match_id,
        playing_area_id: validTarget.area_id,
        slot_id: validTarget.slot_id,
        start_epoch_ms: validTarget.start_epoch_ms,
        end_epoch_ms: validTarget.end_epoch_ms,
      },
      randomUUID(),
    );
    expect(repaired.parent_revision_id).toBe(accepted.id);
    if (!repaired.consequences) throw new Error("Expected move consequences for the repaired schedule");
    expect(repaired.consequences.to).toEqual({
      match_id: movable.match_id,
      playing_area_id: validTarget.area_id,
      slot_id: validTarget.slot_id,
      start_epoch_ms: validTarget.start_epoch_ms,
      end_epoch_ms: validTarget.end_epoch_ms,
    });
    const acceptedByMatch = new Map(accepted.assignments.map((assignment) => [assignment.match_id, assignment]));
    for (const assignment of repaired.assignments) {
      if (assignment.match_id === movable.match_id) continue;
      expect(assignment).toEqual(acceptedByMatch.get(assignment.match_id));
    }
    const comparison = await journeyRuntime.compareScheduleRevisions({ accountId }, accepted.id, repaired.id);
    expect(comparison.comparison).toMatchObject({
      moved_match_ids: [movable.match_id],
      moved_match_count: 1,
      scheduled_match_delta: 0,
      conflicts: { before: 0, after: 0, delta: 0 },
    });
    await expect(
      client`UPDATE scheduled_matches SET starts_at=starts_at+interval '5 minutes'
        WHERE schedule_revision_id=${accepted.id} AND match_id=${movable.match_id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      client`DELETE FROM schedule_revision_formats WHERE schedule_revision_id=${accepted.id}`,
    ).rejects.toThrow(/format provenance is immutable/);
    await expect(
      client`UPDATE schedule_revision_formats SET competition_id=competition_id
        WHERE schedule_revision_id=${accepted.id}`,
    ).rejects.toThrow(/format provenance is immutable/);
    await journeyRuntime.unlockScheduleAssignment(
      { accountId },
      accepted.id,
      lockedAssignment.match_id,
      randomUUID(),
      randomUUID(),
    );
    const unlockedProblem = await buildScheduleProblem.buildScheduleProblem(
      client as unknown as PostgresJsSql,
      access,
      "balanced",
      constraints,
    );
    expect(
      unlockedProblem.problem.matches.find((match) => match.id === lockedAssignment.match_id)?.fixedAssignment,
    ).toBeUndefined();
    const assertCurrent = journeyRuntime as unknown as {
      assertScheduleJobCurrent(tx: PostgresJsSql, jobId: string): Promise<void>;
    };
    await expect(
      assertCurrent.assertScheduleJobCurrent(client as unknown as PostgresJsSql, generated.job.id),
    ).resolves.toBeUndefined();

    for (const deniedAccountId of [viewerId, officialId]) {
      await expect(
        journeyRuntime.publishScheduleRevision(
          { accountId: deniedAccountId },
          accepted.id,
          { idempotency_key: randomUUID(), expected_revision: accepted.revision },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED", statusCode: 403 });
    }

    const failingProjectionRuntime = new Phase4Runtime(
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
      { writePublicProjection: async () => Promise.reject(new Error("projection unavailable")) },
    );
    await expect(
      failingProjectionRuntime.publishScheduleRevision(
        { accountId },
        accepted.id,
        { idempotency_key: randomUUID(), expected_revision: accepted.revision },
        randomUUID(),
      ),
    ).rejects.toThrow("projection unavailable");
    expect(
      required(await client<{ status: string }[]>`SELECT status FROM schedule_revisions WHERE id=${accepted.id}`)
        .status,
    ).toBe("ready_for_review");
    expect(
      required(
        await client<
          { schedule_version: number; published_schedule_revision_id: string | null }[]
        >`SELECT schedule_version,published_schedule_revision_id FROM competition_publications WHERE competition_id=${journeyCompetitionId}`,
      ),
    ).toEqual({ schedule_version: 0, published_schedule_revision_id: null });

    await journeyRuntime.publishScheduleRevision(
      { accountId },
      accepted.id,
      { idempotency_key: randomUUID(), expected_revision: accepted.revision },
      randomUUID(),
    );
    const firstPublic = await phase2.publicCompetition("gate-b-complete-journey");
    expect(firstPublic.publication.schedule_version).toBe(1);
    expect(firstPublic.schedule.find((match) => match.id === movable.match_id)?.starts_at).toBe(
      new Date(movable.start_epoch_ms).toISOString(),
    );
    expect((await phase2.publicCompetition("gate-b-complete-journey")).publication.schedule_version).toBe(1);
    expect(
      required(
        await client<{ status: string; assignment_hash: string | null }[]>`
          SELECT status,assignment_hash FROM schedule_revisions WHERE id=${accepted.id}`,
      ),
    ).toEqual({ status: "published", assignment_hash: accepted.assignment_hash });
    expect(setupDocument.values.schedule_review).toMatchObject({
      schedule_revision_id: accepted.id,
      selected_result_hash: accepted.assignment_hash,
      format_revision_id: selectedRecommendation.format_revision_id,
    });
    const completedSetup = await journeyRuntime.autosaveSetupDraft(
      { accountId },
      journeyCompetitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `journey-complete-${randomUUID()}`,
        transition: {
          kind: "complete",
          review: {
            selected_format_revision_id: selectedRecommendation.format_revision_id,
            selected_schedule_result_hash: accepted.assignment_hash!,
            capacity_revision: generated.job.capacity_revision,
            settings_references: settingsReferences,
            acknowledged_warning_codes: [],
            publication_status: "published",
            published_schedule_revision_id: accepted.id,
          },
        },
      },
      randomUUID(),
    );
    if (completedSetup.outcome !== "saved") throw new Error("Expected setup completion to save");
    expect(completedSetup.document).toMatchObject({
      competition_id: journeyCompetitionId,
      status: "completed",
      current_step: "review_publish",
    });

    await journeyRuntime.publishScheduleRevision(
      { accountId },
      repaired.id,
      { idempotency_key: randomUUID(), expected_revision: repaired.revision },
      randomUUID(),
    );
    const secondPublic = await phase2.publicCompetition("gate-b-complete-journey");
    expect(secondPublic.publication.schedule_version).toBe(2);
    expect(secondPublic.schedule.find((match) => match.id === movable.match_id)?.starts_at).toBe(
      new Date(validTarget.start_epoch_ms).toISOString(),
    );
    expect(
      await client<{ id: string; status: string }[]>`
        SELECT id,status FROM schedule_revisions WHERE id IN (${accepted.id},${repaired.id}) ORDER BY revision`,
    ).toEqual([
      { id: accepted.id, status: "superseded" },
      { id: repaired.id, status: "published" },
    ]);
    await expect(
      client`DELETE FROM schedule_revision_formats WHERE schedule_revision_id=${accepted.id}`,
    ).rejects.toThrow(/format provenance is immutable/);
    await expect(
      client`UPDATE scheduled_matches SET starts_at=starts_at+interval '5 minutes' WHERE schedule_revision_id=${repaired.id}`,
    ).rejects.toThrow(/immutable/);

    await client`UPDATE division_entries SET status='withdrawn',withdrawal_reason='Test schedule fence'
      WHERE division_id=${divisionIds[1]} AND seed=8`;
    await expect(
      assertCurrent.assertScheduleJobCurrent(client as unknown as PostgresJsSql, generated.job.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STALE_SCHEDULE_INPUT",
    });
  });
});

async function waitForCompletedScheduleJob(
  target: Phase4Runtime,
  actorAccountId: string,
  jobId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await target.readScheduleJob({ accountId: actorAccountId }, jobId);
    if (job.status === "completed") return;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Schedule worker ended in ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the Redis-backed schedule worker");
}
