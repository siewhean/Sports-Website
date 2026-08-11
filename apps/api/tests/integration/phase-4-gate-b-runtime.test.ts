import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates, SPORT_PACKS } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../../src/phase-4-reliable-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase4_gate_b_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
let client!: Sql;
let phase3!: Phase3Runtime;
let runtime!: ReliableGateBPhase4Runtime;
let accountId = "";
let viewerId = "";
let organisationId = "";
let competitionId = "";
let divisionId = "";
const sports = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const;
type SportCode = (typeof sports)[number];

function required<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (!value) throw new Error("Expected database row");
  return value;
}

async function createCompetitionFixture(sportCode: SportCode, label: string) {
  const competition = await phase3.createCompetition(
    { accountId },
    {
      organisationId,
      name: `${label} ${sportCode}`,
      slug: `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${sportCode.replaceAll("_", "-")}-${randomUUID()}`,
      sportCode,
      venue: "Fixture venue",
      address: "10 Fixture Road",
      countryCode: "SG",
      startsOn: "2027-09-01",
      endsOn: "2027-09-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
  );
  const fixtureDivisionId = randomUUID();
  await client`INSERT INTO divisions(id,competition_id,name,team_limit)
    VALUES(${fixtureDivisionId},${competition.id},'Open',16)`;
  for (let seed = 1; seed <= 8; seed += 1) {
    await client`INSERT INTO division_entries(id,division_id,name,seed,status)
      VALUES(${randomUUID()},${fixtureDivisionId},${`Fixture entry ${seed}`},${seed},'confirmed')`;
  }
  const settings = required(
    await client<{ pack_version: string }[]>`
      SELECT pack_version FROM competition_sport_settings WHERE competition_id=${competition.id}`,
  );
  await client`INSERT INTO division_sport_settings(
      division_id,competition_id,sport_code,pack_version,settings_override,updated_by
    ) VALUES(${fixtureDivisionId},${competition.id},${sportCode},${settings.pack_version},'{}'::jsonb,${accountId})`;
  await client`INSERT INTO playing_areas(competition_id,name,slot_minutes)
    VALUES(${competition.id},'Default area',${SPORT_PACKS[sportCode].recommendedSlotMinutes})`;
  return { competitionId: competition.id, divisionId: fixtureDivisionId, packVersion: settings.pack_version };
}

function basicsFor(document: Awaited<ReturnType<ReliableGateBPhase4Runtime["readSetupDraft"]>>, sportCode: SportCode) {
  const basics = document.values.basics;
  if (!basics) throw new Error("Expected seeded basics");
  return { ...basics, sport_code: sportCode };
}

async function evidenceCounts() {
  return required(
    await client<{ receipts: number; audits: number; outbox: number }[]>`
      SELECT
        (SELECT count(*)::int FROM phase4_mutation_receipts) receipts,
        (SELECT count(*)::int FROM audit_events) audits,
        (SELECT count(*)::int FROM outbox_events) outbox`,
  );
}

async function createBootstrapAccount(label: string) {
  return required(
    await client<{ id: string }[]>`INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES(${`${label}-${randomUUID()}@gate-b.test`},${label},now()) RETURNING id`,
  ).id;
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 6, onnotice: () => undefined, connection: { search_path: schema } });
  accountId = required(
    await client<{ id: string }[]>`INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES('owner@gate-b.test','Gate B Owner',now()) RETURNING id`,
  ).id;
  viewerId = required(
    await client<{ id: string }[]>`INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES('viewer@gate-b.test','Gate B Viewer',now()) RETURNING id`,
  ).id;
  await client.begin(async (tx) => {
    organisationId = required(
      await tx<{ id: string }[]>`INSERT INTO organisations(name,slug)
        VALUES('Gate B Org','gate-b-runtime-org') RETURNING id`,
    ).id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status) VALUES
      (${organisationId},${accountId},'owner','active'),
      (${organisationId},${viewerId},'viewer','active')`;
  });
  phase3 = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);

  // Install and validate all five immutable launch-sport packs before the
  // complete switch matrix runs.
  for (const sportCode of sports) {
    await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: `${sportCode.replaceAll("_", " ")} Pack Seed`,
        slug: `${sportCode.replaceAll("_", "-")}-pack-seed`,
        sportCode,
        venue: "Seed Hall",
        address: "1 Seed Street",
        countryCode: "SG",
        startsOn: "2027-01-01",
        endsOn: "2027-01-01",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    );
  }
  competitionId = (
    await phase3.createCompetition(
      { accountId },
      {
        organisationId,
        name: "Dynamic Sport Cup",
        slug: "dynamic-sport-cup",
        sportCode: "canoe_polo",
        venue: "Water Arena",
        address: "2 Test Road",
        countryCode: "SG",
        startsOn: "2027-08-01",
        endsOn: "2027-08-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
    )
  ).id;
  divisionId = randomUUID();
  await client`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',16)`;
  const [canoeSettings] = await client<{ pack_version: string }[]>`
    SELECT pack_version FROM competition_sport_settings WHERE competition_id=${competitionId}`;
  await client`INSERT INTO division_sport_settings(
      division_id,competition_id,sport_code,pack_version,settings_override,updated_by
    ) VALUES(${divisionId},${competitionId},'canoe_polo',${canoeSettings!.pack_version},'{}'::jsonb,${accountId})`;
  await client`INSERT INTO playing_areas(competition_id,name,slot_minutes) VALUES(${competitionId},'Primary area',30)`;

  runtime = new ReliableGateBPhase4Runtime(
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

describeInfrastructure("Gate B dynamic sport setup runtime", () => {
  it("creates exactly one durable workspace and recovers from a non-writable legacy membership", async () => {
    const firstAccountId = await createBootstrapAccount("First workspace");
    const receipts = await Promise.all([
      runtime.ensureWritableOrganisation({ accountId: firstAccountId }, randomUUID()),
      runtime.ensureWritableOrganisation({ accountId: firstAccountId }, randomUUID()),
    ]);
    expect(receipts.map((receipt) => receipt.id)).toEqual([receipts[0]!.id, receipts[0]!.id]);
    expect(receipts.filter((receipt) => receipt.created)).toHaveLength(1);
    const firstCounts = required(
      await client<{ organisations: number; memberships: number; audits: number; outbox: number }[]>`
        SELECT
          (SELECT count(*)::int FROM organisations WHERE id=${receipts[0]!.id}) organisations,
          (SELECT count(*)::int FROM organisation_memberships
           WHERE organisation_id=${receipts[0]!.id} AND account_id=${firstAccountId} AND role='owner' AND status='active') memberships,
          (SELECT count(*)::int FROM audit_events
           WHERE target_id=${receipts[0]!.id} AND action='organisation.created') audits,
          (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=${receipts[0]!.id} AND event_type='organisation.created') outbox`,
    );
    expect(firstCounts).toEqual({ organisations: 1, memberships: 1, audits: 1, outbox: 1 });

    const legacyAccountId = await createBootstrapAccount("Legacy viewer");
    const legacyOwnerId = await createBootstrapAccount("Legacy owner");
    const legacyOrganisationId = await client.begin(async (tx) => {
      const legacyOrganisation = required(
        await tx<{ id: string }[]>`INSERT INTO organisations(name,slug)
          VALUES('Legacy workspace',${`workspace-${legacyAccountId}`}) RETURNING id`,
      );
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES
          (${legacyOrganisation.id},${legacyOwnerId},'owner','active'),
          (${legacyOrganisation.id},${legacyAccountId},'viewer','active')`;
      return legacyOrganisation.id;
    });
    const recovered = await runtime.ensureWritableOrganisation({ accountId: legacyAccountId }, randomUUID());
    expect(recovered).toMatchObject({ role: "owner", created: true });
    expect(recovered.id).not.toBe(legacyOrganisationId);
  });

  it("rolls back workspace creation when its audit or outbox evidence fails", async () => {
    for (const failure of [
      { table: "audit_events", trigger: "bootstrap_audit_failure", field: "action", value: "organisation.created" },
      {
        table: "outbox_events",
        trigger: "bootstrap_outbox_failure",
        field: "event_type",
        value: "organisation.created",
      },
    ] as const) {
      const bootstrapAccountId = await createBootstrapAccount(failure.trigger);
      const functionName = `${failure.trigger}_fn`;
      await client.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION '${failure.trigger}'; END;
      $$`);
      await client.unsafe(
        `CREATE TRIGGER ${failure.trigger} BEFORE INSERT ON ${failure.table}
         FOR EACH ROW WHEN (NEW.${failure.field} = '${failure.value}') EXECUTE FUNCTION ${functionName}()`,
      );
      try {
        await expect(
          runtime.ensureWritableOrganisation({ accountId: bootstrapAccountId }, randomUUID()),
        ).rejects.toThrow(failure.trigger);
      } finally {
        await client.unsafe(`DROP TRIGGER ${failure.trigger} ON ${failure.table}`);
        await client.unsafe(`DROP FUNCTION ${functionName}()`);
      }
      const rollbackCounts = required(
        await client<{ organisations: number; memberships: number; audits: number; outbox: number }[]>`
          SELECT
            (SELECT count(*)::int FROM organisations WHERE slug=${`workspace-${bootstrapAccountId}`}) organisations,
            (SELECT count(*)::int FROM organisation_memberships WHERE account_id=${bootstrapAccountId}) memberships,
            (SELECT count(*)::int FROM audit_events WHERE actor_account_id=${bootstrapAccountId} AND action='organisation.created') audits,
            (SELECT count(*)::int FROM outbox_events WHERE idempotency_key LIKE ${`organisation.bootstrap:${bootstrapAccountId}:%`}) outbox`,
      );
      expect(rollbackCounts).toEqual({ organisations: 0, memberships: 0, audits: 0, outbox: 0 });
    }
  });

  it("generates immutable multi-metric evidence without changing formats and applies a selection once", async () => {
    const fixture = await createCompetitionFixture("basketball", "Recommendations");
    await client`UPDATE competitions SET plan_tier='organiser_pro' WHERE id=${fixture.competitionId}`;
    const secondDivisionId = randomUUID();
    await client`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${secondDivisionId},${fixture.competitionId},'Women',16)`;
    for (let seed = 1; seed <= 12; seed += 1) {
      await client`INSERT INTO division_entries(id,division_id,name,seed,status)
        VALUES(${randomUUID()},${secondDivisionId},${`Women entry ${seed}`},${seed},'confirmed')`;
    }
    await client`INSERT INTO division_sport_settings(
      division_id,competition_id,sport_code,pack_version,settings_override,updated_by
    ) VALUES(${secondDivisionId},${fixture.competitionId},'basketball',${fixture.packVersion},'{}'::jsonb,${accountId})`;
    await phase3.replaceCapacity(
      { accountId },
      fixture.competitionId,
      {
        revision: 1,
        areas: [
          {
            name: "Main court",
            slotMinutes: SPORT_PACKS.basketball.recommendedSlotMinutes,
            availability: [
              { date: "2027-09-01", startTime: "00:00", endTime: "23:30" },
              { date: "2027-09-02", startTime: "00:00", endTime: "23:30" },
            ],
          },
        ],
      },
      randomUUID(),
    );
    await runtime.createSetupDraft(
      { accountId },
      fixture.competitionId,
      `recommend-create-${randomUUID()}`,
      randomUUID(),
    );
    const created = await runtime.resumeSetupDraft(
      { accountId },
      fixture.competitionId,
      `recommend-resume-${randomUUID()}`,
      randomUUID(),
    );
    const canonicalCapacity = required(
      await client<{ revision: number; source_hash: string }[]>`
        SELECT capacity_revision revision,phase4_capacity_hash(id) source_hash
        FROM competitions WHERE id=${fixture.competitionId}`,
    );
    expect(created.values.capacity).toMatchObject({
      ...canonicalCapacity,
      revision: Number(canonicalCapacity.revision),
    });
    const before = required(
      await client<
        { count: number }[]
      >`SELECT count(*)::int count FROM format_revisions WHERE competition_id=${fixture.competitionId}`,
    ).count;
    const preferences = created.values.format_preferences!;
    const generated = await runtime.autosaveSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: created.revision,
        idempotency_key: `recommend-generate-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "format_preferences",
            value: {
              ...preferences,
              minimum_matches: { per_entry: 1 },
              ranking: { rank_all_entries: false },
              placement: { required: false },
              qualification: { cross_group_allowed: true },
            },
          },
        },
      },
      randomUUID(),
    );
    expect(generated.outcome).toBe("saved");
    if (generated.outcome !== "saved") throw new Error("Expected generated recommendation set");
    let selection = generated.document.values.format_recommendations!;
    expect(selection.recommendations.length).toBeGreaterThan(0);
    expect(selection.recommendations.length).toBeGreaterThanOrEqual(1);
    expect(selection.recommendations.length).toBeLessThanOrEqual(3);
    expect(new Set(selection.recommendations.map((item) => item.id)).size).toBe(selection.recommendations.length);
    expect(new Set(selection.recommendations.map((item) => item.format_definition_hash)).size).toBe(
      selection.recommendations.length,
    );
    expect(selection.recommendations.every((item) => item.available_match_slots >= item.match_count)).toBe(true);
    expect(selection.recommendations.every((item) => item.division_formats.length === 2)).toBe(true);
    expect(
      selection.recommendations.every(
        (item) => item.match_count === item.division_formats.reduce((sum, format) => sum + format.match_count, 0),
      ),
    ).toBe(true);
    expect(selection.recommendations.every((item) => item.format_revision_id === null)).toBe(true);
    const evidence = required(
      await client<
        {
          set_id: string;
          candidate_id: string;
          candidate_division_id: string;
          definition: unknown;
          layout: unknown;
          metrics: unknown;
        }[]
      >`SELECT s.id set_id,c.id candidate_id,d.id candidate_division_id,d.definition,d.layout,d.metrics
        FROM phase4_format_recommendation_sets s
        JOIN phase4_format_recommendation_candidates c ON c.recommendation_set_id=s.id
        JOIN phase4_format_recommendation_candidate_divisions d ON d.candidate_id=c.id
        WHERE s.competition_id=${fixture.competitionId} LIMIT 1`,
    );
    await expect(
      client`UPDATE phase4_format_recommendation_sets SET source_evidence='{}'::jsonb WHERE id=${evidence.set_id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      client`INSERT INTO phase4_format_recommendation_candidate_divisions(
        id,candidate_id,division_id,definition,definition_hash,layout,metrics
      ) VALUES(
        ${randomUUID()},${evidence.candidate_id},${fixture.divisionId},${client.json(evidence.definition as never)},
        ${"0".repeat(64)},${client.json(evidence.layout as never)},${client.json(evidence.metrics as never)}
      )`,
    ).rejects.toThrow(/evidence is invalid/);

    const alternate = await runtime.autosaveSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: generated.document.revision,
        idempotency_key: `recommend-alternate-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "format_preferences",
            value: { ...generated.document.values.format_preferences!, priority: { value: "speed" } },
          },
        },
      },
      randomUUID(),
    );
    expect(alternate.outcome).toBe("saved");
    if (alternate.outcome !== "saved") throw new Error("Expected alternate recommendation set");
    const reused = await runtime.autosaveSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: alternate.document.revision,
        idempotency_key: `recommend-reuse-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: { step_id: "format_preferences", value: generated.document.values.format_preferences! },
        },
      },
      randomUUID(),
    );
    expect(reused.outcome).toBe("saved");
    if (reused.outcome !== "saved") throw new Error("Expected reused recommendation set");
    expect(reused.document.values.format_recommendations?.recommendation_set_hash).toBe(
      selection.recommendation_set_hash,
    );
    expect(reused.document.values.format_recommendations?.recommendations.map((item) => item.id)).toEqual(
      selection.recommendations.map((item) => item.id),
    );
    selection = reused.document.values.format_recommendations!;
    const canonicalRecommendations = structuredClone(selection.recommendations);
    expect(
      required(
        await client<
          { count: number }[]
        >`SELECT count(*)::int count FROM format_revisions WHERE competition_id=${fixture.competitionId}`,
      ).count,
    ).toBe(before);

    const selectedId = selection.recommendations[0]!.id;
    const selectedCandidate = selection.recommendations[0]!;
    const partialAndForgedSelection = {
      ...selection,
      recommendations: selection.recommendations.slice(0, 2).map((candidate) => {
        if (candidate.id === selectedId)
          return {
            ...candidate,
            division_formats: [
              ...candidate.division_formats.slice(1).reverse(),
              candidate.division_formats[1]!,
              {
                ...candidate.division_formats[0]!,
                candidate_division_id: randomUUID(),
                division_id: randomUUID(),
              },
            ],
            match_count: selectedCandidate.division_formats[1]!.match_count,
          };
        return {
          ...candidate,
          name: "Forged unselected option",
          advantage: "Forged advantage",
          guaranteed_matches: 99,
          ranking_coverage: "champion" as const,
          capacity_status: "requires_changes" as const,
          scheduling_status: "infeasible" as const,
          warning_codes: ["forged_warning"],
        };
      }),
      selected_recommendation_id: selectedId,
    };
    const applied = await runtime.autosaveSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: reused.document.revision,
        idempotency_key: `recommend-select-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "format_recommendations",
            value: partialAndForgedSelection,
          },
        },
      },
      randomUUID(),
    );
    expect(applied.outcome).toBe("saved");
    if (applied.outcome !== "saved") throw new Error("Expected applied recommendation");
    const selected = applied.document.values.format_recommendations!.recommendations.find(
      (item) => item.id === selectedId,
    )!;
    const appliedRecommendations = applied.document.values.format_recommendations!.recommendations;
    expect(appliedRecommendations.map((item) => item.id)).toEqual(canonicalRecommendations.map((item) => item.id));
    expect(appliedRecommendations.filter((item) => item.id !== selectedId)).toEqual(
      canonicalRecommendations.filter((item) => item.id !== selectedId),
    );
    expect(selected.division_formats.every((item) => item.format_revision_id !== null)).toBe(true);
    const after = required(
      await client<
        { count: number }[]
      >`SELECT count(*)::int count FROM format_revisions WHERE competition_id=${fixture.competitionId}`,
    ).count;
    expect(after).toBe(before + 2);

    const replay = await runtime.autosaveSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: applied.document.revision,
        idempotency_key: `recommend-reselect-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: { step_id: "format_recommendations", value: applied.document.values.format_recommendations! },
        },
      },
      randomUUID(),
    );
    expect(replay.outcome).toBe("saved");
    expect(
      required(
        await client<
          { count: number }[]
        >`SELECT count(*)::int count FROM format_revisions WHERE competition_id=${fixture.competitionId}`,
      ).count,
    ).toBe(after);
  });

  it("counts a confirmed placeholder once from setup seed through recommendation evidence", async () => {
    const fixture = await createCompetitionFixture("basketball", "Placeholder recommendations");
    await client`UPDATE competitions SET plan_tier='organiser_pro' WHERE id=${fixture.competitionId}`;
    const placeholderId = required(
      await client<{ id: string }[]>`UPDATE division_entries SET entry_type='placeholder',name='Placeholder entry'
        WHERE id=(SELECT id FROM division_entries WHERE division_id=${fixture.divisionId} ORDER BY seed DESC LIMIT 1)
        RETURNING id`,
    ).id;
    await phase3.replaceCapacity(
      { accountId },
      fixture.competitionId,
      {
        revision: 1,
        areas: [
          {
            name: "Main court",
            slotMinutes: SPORT_PACKS.basketball.recommendedSlotMinutes,
            availability: [{ date: "2027-09-01", startTime: "00:00", endTime: "23:30" }],
          },
        ],
      },
      randomUUID(),
    );
    const created = await runtime.createSetupDraft(
      { accountId },
      fixture.competitionId,
      `placeholder-create-${randomUUID()}`,
      randomUUID(),
    );
    const entries = created.document.values.entries!.divisions[0]!;
    expect(entries.entry_ids).toHaveLength(8);
    expect(entries.entry_ids).toContain(placeholderId);
    expect(entries).toMatchObject({ confirmed_count: 7, placeholder_count: 1 });

    const generated = await runtime.autosaveSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: created.document.revision,
        idempotency_key: `placeholder-generate-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "format_preferences",
            value: created.document.values.format_preferences!,
          },
        },
      },
      randomUUID(),
    );
    expect(generated.outcome).toBe("saved");
    const evidence = required(
      await client<{ source_entry_count: number; definition_entry_count: number }[]>`
        SELECT
          (recommendation_set.source_evidence->'entries'->0->>'entry_count')::int source_entry_count,
          (candidate_division.definition->>'entryCount')::int definition_entry_count
        FROM phase4_format_recommendation_sets recommendation_set
        JOIN phase4_format_recommendation_candidates candidate
          ON candidate.recommendation_set_id=recommendation_set.id
        JOIN phase4_format_recommendation_candidate_divisions candidate_division
          ON candidate_division.candidate_id=candidate.id
        WHERE recommendation_set.competition_id=${fixture.competitionId}
        LIMIT 1`,
    );
    expect(evidence).toEqual({ source_entry_count: 8, definition_entry_count: 8 });
  });

  it("patches Basics in place and atomically switches every pinned rule scope", async () => {
    await client`UPDATE playing_areas SET slot_minutes=37 WHERE competition_id=${competitionId}`;
    const created = await runtime.createSetupDraft(
      { accountId },
      competitionId,
      `gate-b-create-${randomUUID()}`,
      randomUUID(),
    );
    expect(created.document.values.basics).toMatchObject({ sport_code: "canoe_polo" });
    expect(created.document.values.format_preferences).toMatchObject({
      minimum_matches: { per_entry: 3 },
    });

    const outcome = await runtime.patchSetupDraft(
      { accountId },
      competitionId,
      {
        expected_revision: created.document.revision,
        idempotency_key: `gate-b-patch-${randomUUID()}`,
        step: {
          step_id: "basics",
          value: {
            name: "Dynamic Badminton Cup",
            sport_code: "badminton",
            location: { venue: "Sports Hall", address: "3 Test Road", locality: "Singapore", country_code: "SG" },
            starts_on: "2027-08-01",
            ends_on: "2027-08-02",
            time_zone: "Asia/Singapore",
            locale: "en-SG",
            entry_count: 16,
            division_count: 1,
            entry_count_status: "estimated",
          },
        },
      },
      randomUUID(),
    );

    expect(outcome.outcome).toBe("saved");
    if (outcome.outcome !== "saved") throw new Error("Expected saved patch");
    expect(outcome.document).toMatchObject({
      revision: created.document.revision + 1,
      current_step: "basics",
      values: {
        basics: { sport_code: "badminton" },
        capacity: null,
        format_recommendations: null,
        schedule_review: null,
        review_publish: null,
      },
    });
    const [state] = await client<
      {
        competition_sport: string;
        competition_settings_sport: string;
        division_settings_sport: string;
        slot_minutes: number;
        pack_version: string;
      }[]
    >`SELECT competition.sport_code competition_sport,
      competition_settings.sport_code competition_settings_sport,
      division_settings.sport_code division_settings_sport,
      area.slot_minutes,competition_settings.pack_version
      FROM competitions competition
      JOIN competition_sport_settings competition_settings ON competition_settings.competition_id=competition.id
      JOIN division_sport_settings division_settings ON division_settings.competition_id=competition.id
      JOIN playing_areas area ON area.competition_id=competition.id
      WHERE competition.id=${competitionId} AND area.name='Primary area'`;
    expect(state).toMatchObject({
      competition_sport: "badminton",
      competition_settings_sport: "badminton",
      division_settings_sport: "badminton",
      slot_minutes: 37,
    });
    expect(outcome.document.values.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "competition", pack_version: state!.pack_version }),
        expect.objectContaining({ scope: "division", pack_version: state!.pack_version }),
      ]),
    );
    expect(await client`SELECT 1 FROM audit_events WHERE action='competition.setup_basics.updated'`).toHaveLength(1);
    expect(await client`SELECT 1 FROM outbox_events WHERE event_type='competition.setup_basics.updated'`).toHaveLength(
      1,
    );
  });

  it("binds create, PATCH, Gate-B PUT, and base PUT receipts to one competition aggregate", async () => {
    const first = await createCompetitionFixture("canoe_polo", "Receipt first");
    const second = await createCompetitionFixture("canoe_polo", "Receipt second");
    const createKey = `aggregate-create-${randomUUID()}`;
    const firstDraft = await runtime.createSetupDraft({ accountId }, first.competitionId, createKey, randomUUID());
    await expect(
      runtime.createSetupDraft({ accountId }, second.competitionId, createKey, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_MISMATCH" });
    const secondDraft = await runtime.createSetupDraft(
      { accountId },
      second.competitionId,
      `aggregate-create-${randomUUID()}`,
      randomUUID(),
    );

    const patchKey = `aggregate-patch-${randomUUID()}`;
    const firstPatch = await runtime.patchSetupDraft(
      { accountId },
      first.competitionId,
      {
        expected_revision: firstDraft.document.revision,
        idempotency_key: patchKey,
        step: { step_id: "basics", value: basicsFor(firstDraft.document, "badminton") },
      },
      randomUUID(),
    );
    expect(firstPatch.outcome).toBe("saved");
    const crossPatch = await runtime.patchSetupDraft(
      { accountId },
      second.competitionId,
      {
        expected_revision: secondDraft.document.revision,
        idempotency_key: patchKey,
        step: { step_id: "basics", value: basicsFor(secondDraft.document, "badminton") },
      },
      randomUUID(),
    );
    expect(crossPatch).toMatchObject({
      outcome: "idempotency_mismatch",
      document: { competition_id: second.competitionId, revision: secondDraft.document.revision },
    });

    const putKey = `aggregate-put-${randomUUID()}`;
    const firstAfterPatch = firstPatch.outcome === "saved" ? firstPatch.document : firstDraft.document;
    const firstPut = await runtime.autosaveSetupDraft(
      { accountId },
      first.competitionId,
      {
        expected_revision: firstAfterPatch.revision,
        idempotency_key: putKey,
        transition: { kind: "save_step", step: { step_id: "basics", value: firstAfterPatch.values.basics! } },
      },
      randomUUID(),
    );
    expect(firstPut.outcome).toBe("saved");
    const crossPut = await runtime.autosaveSetupDraft(
      { accountId },
      second.competitionId,
      {
        expected_revision: secondDraft.document.revision,
        idempotency_key: putKey,
        transition: {
          kind: "save_step",
          step: { step_id: "basics", value: secondDraft.document.values.basics! },
        },
      },
      randomUUID(),
    );
    expect(crossPut).toMatchObject({
      outcome: "idempotency_mismatch",
      document: { competition_id: second.competitionId, revision: secondDraft.document.revision },
    });

    const baseKey = `aggregate-base-put-${randomUUID()}`;
    const preferences = firstPut.outcome === "saved" ? firstPut.document.values.format_preferences! : null;
    if (!preferences) throw new Error("Expected seeded format preferences");
    const baseSave = await runtime.autosaveSetupDraft(
      { accountId },
      first.competitionId,
      {
        expected_revision: firstPut.outcome === "saved" ? firstPut.document.revision : 0,
        idempotency_key: baseKey,
        transition: { kind: "save_step", step: { step_id: "format_preferences", value: preferences } },
      },
      randomUUID(),
    );
    expect(baseSave.outcome).toBe("saved");
    const crossBaseSave = await runtime.autosaveSetupDraft(
      { accountId },
      second.competitionId,
      {
        expected_revision: secondDraft.document.revision,
        idempotency_key: baseKey,
        transition: {
          kind: "save_step",
          step: { step_id: "format_preferences", value: secondDraft.document.values.format_preferences! },
        },
      },
      randomUUID(),
    );
    expect(crossBaseSave).toMatchObject({
      outcome: "idempotency_mismatch",
      document: { competition_id: second.competitionId, revision: secondDraft.document.revision },
    });
  });

  it("executes the all-five sport default and switch matrix", async () => {
    for (const sourceSport of sports) {
      for (const targetSport of sports) {
        if (targetSport === sourceSport) continue;
        const fixture = await createCompetitionFixture(sourceSport, `Matrix ${sourceSport} to ${targetSport}`);
        const created = await runtime.createSetupDraft(
          { accountId },
          fixture.competitionId,
          `matrix-create-${randomUUID()}`,
          randomUUID(),
        );
        const result = await runtime.patchSetupDraft(
          { accountId },
          fixture.competitionId,
          {
            expected_revision: created.document.revision,
            idempotency_key: `matrix-patch-${randomUUID()}`,
            step: { step_id: "basics", value: basicsFor(created.document, targetSport) },
          },
          randomUUID(),
        );
        expect(result.outcome, `${sourceSport} -> ${targetSport}`).toBe("saved");
        const state = required(
          await client<
            {
              sport_code: string;
              competition_settings_sport: string;
              division_settings_sport: string;
              slot_minutes: number;
              recommended_slot: number;
            }[]
          >`SELECT competition.sport_code,
              competition_settings.sport_code competition_settings_sport,
              division_settings.sport_code division_settings_sport,
              area.slot_minutes,
              (pack.definition->>'recommendedSlotMinutes')::int recommended_slot
            FROM competitions competition
            JOIN competition_sport_settings competition_settings ON competition_settings.competition_id=competition.id
            JOIN division_sport_settings division_settings ON division_settings.competition_id=competition.id
            JOIN sport_pack_versions pack ON pack.sport_code=competition_settings.sport_code
              AND pack.version=competition_settings.pack_version
            JOIN playing_areas area ON area.competition_id=competition.id
            WHERE competition.id=${fixture.competitionId}`,
        );
        expect(state, `${sourceSport} -> ${targetSport}`).toEqual({
          sport_code: targetSport,
          competition_settings_sport: targetSport,
          division_settings_sport: targetSport,
          slot_minutes: SPORT_PACKS[targetSport].recommendedSlotMinutes,
          recommended_slot: SPORT_PACKS[targetSport].recommendedSlotMinutes,
        });
      }
    }
  });

  it("keeps the real PATCH r4-to-r5 then PUT r5-to-r6 chain ordered, replay-safe, and stale-safe", async () => {
    const fixture = await createCompetitionFixture("badminton", "Revision chain");
    let document = (
      await runtime.createSetupDraft({ accountId }, fixture.competitionId, `chain-create-${randomUUID()}`, randomUUID())
    ).document;
    const preferences = document.values.format_preferences;
    if (!preferences) throw new Error("Expected seeded format preferences");
    for (let revision = 1; revision < 4; revision += 1) {
      const saved = await runtime.patchSetupDraft(
        { accountId },
        fixture.competitionId,
        {
          expected_revision: document.revision,
          idempotency_key: `chain-prime-${randomUUID()}`,
          step: { step_id: "format_preferences", value: preferences },
        },
        randomUUID(),
      );
      expect(saved.outcome).toBe("saved");
      if (saved.outcome !== "saved") throw new Error("Expected priming patch to save");
      document = saved.document;
    }
    expect(document.revision).toBe(4);

    const patchKey = `chain-r4-r5-${randomUUID()}`;
    const patchRequest = {
      expected_revision: 4,
      idempotency_key: patchKey,
      step: { step_id: "basics" as const, value: basicsFor(document, "badminton") },
    };
    const patched = await runtime.patchSetupDraft({ accountId }, fixture.competitionId, patchRequest, randomUUID());
    expect(patched).toMatchObject({ outcome: "saved", document: { revision: 5, current_step: "basics" } });
    const patchReplay = await runtime.patchSetupDraft({ accountId }, fixture.competitionId, patchRequest, randomUUID());
    expect(patchReplay).toMatchObject({ outcome: "idempotent_replay", document: { revision: 5 } });
    const patchMismatch = await runtime.patchSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        ...patchRequest,
        step: { ...patchRequest.step, value: { ...patchRequest.step.value, name: "Different payload" } },
      },
      randomUUID(),
    );
    expect(patchMismatch.outcome).toBe("idempotency_mismatch");

    const putKey = `chain-r5-r6-${randomUUID()}`;
    const putRequest = {
      expected_revision: 5,
      idempotency_key: putKey,
      transition: { kind: "save_step" as const, step: patchRequest.step },
    };
    const advanced = await runtime.autosaveSetupDraft({ accountId }, fixture.competitionId, putRequest, randomUUID());
    expect(advanced).toMatchObject({ outcome: "saved", document: { revision: 6, current_step: "capacity" } });
    expect(
      await runtime.autosaveSetupDraft({ accountId }, fixture.competitionId, putRequest, randomUUID()),
    ).toMatchObject({ outcome: "idempotent_replay", document: { revision: 6, current_step: "capacity" } });
    expect(
      await runtime.autosaveSetupDraft(
        { accountId },
        fixture.competitionId,
        {
          ...putRequest,
          transition: {
            kind: "save_step",
            step: {
              ...putRequest.transition.step,
              value: { ...putRequest.transition.step.value, name: "Different PUT payload" },
            },
          },
        },
        randomUUID(),
      ),
    ).toMatchObject({ outcome: "idempotency_mismatch", document: { revision: 6 } });
    expect(
      await runtime.autosaveSetupDraft(
        { accountId },
        fixture.competitionId,
        { ...putRequest, idempotency_key: `chain-stale-${randomUUID()}`, expected_revision: 5 },
        randomUUID(),
      ),
    ).toMatchObject({ outcome: "conflict", current: { revision: 6 } });
  });

  it("locks sport changes for started, in-progress, final, and corrected competitions", async () => {
    for (const state of ["started", "in_progress", "final", "corrected"] as const) {
      const fixture = await createCompetitionFixture("badminton", `Sport lock ${state}`);
      const created = await runtime.createSetupDraft(
        { accountId },
        fixture.competitionId,
        `lock-create-${randomUUID()}`,
        randomUUID(),
      );
      if (state === "started") {
        await client`UPDATE competitions SET first_match_started_at=now() WHERE id=${fixture.competitionId}`;
      } else {
        const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
        const formatId = randomUUID();
        await client`INSERT INTO format_revisions(
            id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract
          ) VALUES(${formatId},${fixture.competitionId},${fixture.divisionId},1,${client.json(graph)},
            phase4_sha256_json(${client.json(graph)}::jsonb),${accountId},'phase3')`;
        await client`SELECT phase4_materialize_format_revision(${formatId})`;
        await client`UPDATE matches SET state=${state}
          WHERE id=(SELECT id FROM matches WHERE format_revision_id=${formatId} ORDER BY ordinal LIMIT 1)`;
      }
      await expect(
        runtime.patchSetupDraft(
          { accountId },
          fixture.competitionId,
          {
            expected_revision: created.document.revision,
            idempotency_key: `lock-patch-${randomUUID()}`,
            step: { step_id: "basics", value: basicsFor(created.document, "table_tennis") },
          },
          randomUUID(),
        ),
        state,
      ).rejects.toMatchObject({ statusCode: 409, code: "COMPETITION_SPORT_LOCKED" });
    }
  });

  it("preserves the pinned old-pack default after that pack is superseded", async () => {
    const fixture = await createCompetitionFixture("canoe_polo", "Pinned pack");
    const created = await runtime.createSetupDraft(
      { accountId },
      fixture.competitionId,
      `pinned-create-${randomUUID()}`,
      randomUUID(),
    );
    await client`INSERT INTO account_platform_roles(account_id,role,reason,granted_by)
      VALUES(${accountId},'platform_admin','Gate B pinned-pack test',${accountId})`;
    const replacement = {
      ...structuredClone(SPORT_PACKS.canoe_polo),
      version: `0.1.0-gate-b-${randomUUID()}`,
      recommendedSlotMinutes: 35,
      recommendedSettings: { ...structuredClone(SPORT_PACKS.canoe_polo.recommendedSettings), slotMinutes: 35 },
    };
    await phase3.createSportPackDraft({ accountId }, replacement, randomUUID());
    await phase3.activateSportPack(
      { accountId },
      "canoe_polo",
      replacement.version,
      1,
      fixture.packVersion,
      randomUUID(),
    );
    expect(
      required(
        await client<{ pack_version: string }[]>`
          SELECT pack_version FROM competition_sport_settings WHERE competition_id=${fixture.competitionId}`,
      ).pack_version,
    ).toBe(fixture.packVersion);

    const result = await runtime.patchSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: created.document.revision,
        idempotency_key: `pinned-patch-${randomUUID()}`,
        step: { step_id: "basics", value: basicsFor(created.document, "badminton") },
      },
      randomUUID(),
    );
    expect(result.outcome).toBe("saved");
    expect(
      required(
        await client<{ slot_minutes: number }[]>`
          SELECT slot_minutes FROM playing_areas WHERE competition_id=${fixture.competitionId}`,
      ).slot_minutes,
    ).toBe(SPORT_PACKS.badminton.recommendedSlotMinutes);
  });

  it("keeps organiser and viewer setup reads/resume/create/PUT/PATCH permissions and side effects exact", async () => {
    const fixture = await createCompetitionFixture("badminton", "Permission counts");
    const beforeCreate = await evidenceCounts();
    await expect(
      runtime.createSetupDraft(
        { accountId: viewerId },
        fixture.competitionId,
        `viewer-create-${randomUUID()}`,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_DENIED" });
    expect(await evidenceCounts()).toEqual(beforeCreate);

    await runtime.createSetupDraft(
      { accountId },
      fixture.competitionId,
      `permission-create-${randomUUID()}`,
      randomUUID(),
    );
    expect(await evidenceCounts()).toEqual({
      receipts: beforeCreate.receipts + 1,
      audits: beforeCreate.audits + 1,
      outbox: beforeCreate.outbox + 1,
    });

    const beforeReads = await evidenceCounts();
    expect(await runtime.readSetupDraft({ accountId }, fixture.competitionId)).toMatchObject({ permission: "write" });
    expect(await runtime.readSetupDraft({ accountId: viewerId }, fixture.competitionId)).toMatchObject({
      permission: "read",
      read_only: true,
    });
    expect(
      await runtime.resumeSetupDraft(
        { accountId: viewerId },
        fixture.competitionId,
        `viewer-resume-${randomUUID()}`,
        randomUUID(),
      ),
    ).toMatchObject({ permission: "read", read_only: true });
    expect(await evidenceCounts()).toEqual(beforeReads);

    const resumed = await runtime.resumeSetupDraft(
      { accountId },
      fixture.competitionId,
      `owner-resume-${randomUUID()}`,
      randomUUID(),
    );
    expect(resumed.competition_id).toBe(fixture.competitionId);
    expect(await evidenceCounts()).toEqual({
      receipts: beforeReads.receipts + 1,
      audits: beforeReads.audits,
      outbox: beforeReads.outbox,
    });

    for (const operation of ["PATCH", "PUT"] as const) {
      const beforeDenied = await evidenceCounts();
      const request = {
        expected_revision: resumed.revision,
        idempotency_key: `viewer-${operation.toLowerCase()}-${randomUUID()}`,
        step: { step_id: "basics" as const, value: basicsFor(resumed, "badminton") },
      };
      const denied =
        operation === "PATCH"
          ? runtime.patchSetupDraft({ accountId: viewerId }, fixture.competitionId, request, randomUUID())
          : runtime.autosaveSetupDraft(
              { accountId: viewerId },
              fixture.competitionId,
              { ...request, transition: { kind: "save_step" as const, step: request.step } },
              randomUUID(),
            );
      await expect(denied).rejects.toMatchObject({ statusCode: 403 });
      expect(await evidenceCounts()).toEqual(beforeDenied);
    }

    const beforePatch = await evidenceCounts();
    const patched = await runtime.patchSetupDraft(
      { accountId },
      fixture.competitionId,
      {
        expected_revision: resumed.revision,
        idempotency_key: `owner-patch-${randomUUID()}`,
        step: { step_id: "basics", value: basicsFor(resumed, "badminton") },
      },
      randomUUID(),
    );
    expect(patched.outcome).toBe("saved");
    expect(await evidenceCounts()).toEqual({
      receipts: beforePatch.receipts + 1,
      audits: beforePatch.audits + 2,
      outbox: beforePatch.outbox + 2,
    });
    if (patched.outcome !== "saved") throw new Error("Expected owner patch to save");

    const beforePut = await evidenceCounts();
    expect(
      await runtime.autosaveSetupDraft(
        { accountId },
        fixture.competitionId,
        {
          expected_revision: patched.document.revision,
          idempotency_key: `owner-put-${randomUUID()}`,
          transition: {
            kind: "save_step",
            step: { step_id: "basics", value: patched.document.values.basics! },
          },
        },
        randomUUID(),
      ),
    ).toMatchObject({ outcome: "saved" });
    expect(await evidenceCounts()).toEqual({
      receipts: beforePut.receipts + 1,
      audits: beforePut.audits + 2,
      outbox: beforePut.outbox + 2,
    });
  });

  it("returns a truthful read-only setup document to viewers", async () => {
    const document = await runtime.readSetupDraft({ accountId: viewerId }, competitionId);
    expect(document).toMatchObject({ permission: "read", read_only: true, autosave: { status: "read_only" } });
    await expect(
      runtime.patchSetupDraft(
        { accountId: viewerId },
        competitionId,
        {
          expected_revision: document.revision,
          idempotency_key: `viewer-patch-${randomUUID()}`,
          step: { step_id: "format_preferences", value: document.values.format_preferences! },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
