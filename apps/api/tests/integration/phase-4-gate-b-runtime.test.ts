import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
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
let client!: Sql;
let phase3!: Phase3Runtime;
let runtime!: ReliableGateBPhase4Runtime;
let accountId = "";
let viewerId = "";
let organisationId = "";
let competitionId = "";
let divisionId = "";

function required<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (!value) throw new Error("Expected database row");
  return value;
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

  // Create one event for each sport used by this test so Phase 3 installs and
  // validates the active immutable product pack before the Gate B switch.
  await phase3.createCompetition(
    { accountId },
    {
      organisationId,
      name: "Badminton Pack Seed",
      slug: "badminton-pack-seed",
      sportCode: "badminton",
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
  it("patches Basics in place and atomically switches every pinned rule scope", async () => {
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
    const [state] = await client<{
      competition_sport: string;
      competition_settings_sport: string;
      division_settings_sport: string;
      slot_minutes: number;
      pack_version: string;
    }[]>`SELECT competition.sport_code competition_sport,
      competition_settings.sport_code competition_settings_sport,
      division_settings.sport_code division_settings_sport,
      area.slot_minutes,competition_settings.pack_version
      FROM competitions competition
      JOIN competition_sport_settings competition_settings ON competition_settings.competition_id=competition.id
      JOIN division_sport_settings division_settings ON division_settings.competition_id=competition.id
      JOIN playing_areas area ON area.competition_id=competition.id
      WHERE competition.id=${competitionId}`;
    expect(state).toMatchObject({
      competition_sport: "badminton",
      competition_settings_sport: "badminton",
      division_settings_sport: "badminton",
      slot_minutes: 20,
    });
    expect(outcome.document.values.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "competition", pack_version: state!.pack_version }),
        expect.objectContaining({ scope: "division", pack_version: state!.pack_version }),
      ]),
    );
    expect(await client`SELECT 1 FROM audit_events WHERE action='competition.setup_basics.updated'`).toHaveLength(1);
    expect(await client`SELECT 1 FROM outbox_events WHERE event_type='competition.setup_basics.updated'`).toHaveLength(1);
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
