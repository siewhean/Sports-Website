import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { DRAFT_SPORT_PACK_VERSION } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_redesign_p4_rules_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let client!: Sql;
let draftRuntime!: Phase3Runtime;
let federationRuntime!: Phase3Runtime;
let ownerId = "";
let organisationId = "";

function required<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (!value) throw new Error("Expected database row");
  return value;
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });
  ownerId = required(
    await client<{ id: string }[]>`INSERT INTO accounts (primary_email,display_name,email_verified_at)
      VALUES ('owner@rules.test','Owner',now()) RETURNING id`,
  ).id;
  await client.begin(async (tx) => {
    organisationId = required(
      await tx<{ id: string }[]>`INSERT INTO organisations (name,slug) VALUES ('Rules Org','rules-org') RETURNING id`,
    ).id;
    await tx`INSERT INTO organisation_memberships (organisation_id,account_id,role,status)
      VALUES (${organisationId},${ownerId},'owner','active')`;
  });
  const sql = client as unknown as PostgresJsSql;
  draftRuntime = new Phase3Runtime(sql, phase3DomainAdapter, undefined, { federationRulesEnabled: async () => false });
  federationRuntime = new Phase3Runtime(sql, phase3DomainAdapter, undefined, {
    federationRulesEnabled: async () => true,
  });
});

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

async function create(
  runtime: Phase3Runtime,
  sportCode: "canoe_polo" | "badminton" | "volleyball" | "basketball" | "table_tennis",
  startsOn: string,
) {
  return runtime.createCompetition(
    { accountId: ownerId },
    {
      organisationId,
      name: `Rules ${sportCode} ${startsOn}`,
      slug: `rules-${sportCode.replace("_", "-")}-${randomUUID()}`,
      sportCode,
      venue: "Hall",
      address: "1 Rules Road",
      countryCode: "SG",
      startsOn,
      endsOn: startsOn,
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
    `create-${randomUUID()}`,
  );
}

async function packVersion(competitionId: string) {
  return required(
    await client<{ pack_version: string }[]>`
      SELECT pack_version FROM competition_sport_settings WHERE competition_id=${competitionId}`,
  ).pack_version;
}

describeInfrastructure("Redesign Phase 4 sport rules", () => {
  it("keeps new competitions on the draft pack while redesign_p4_rules is off", async () => {
    const competition = await create(draftRuntime, "canoe_polo", "2027-03-01");
    expect(await packVersion(competition.id)).toBe(DRAFT_SPORT_PACK_VERSION);
  });

  it("starts new competitions from the federation pack when the flag is on, badminton by start date", async () => {
    const draft = await create(draftRuntime, "badminton", "2026-11-01");
    const before = await client`SELECT * FROM competition_sport_settings WHERE competition_id=${draft.id}`;

    const polo = await create(federationRuntime, "canoe_polo", "2027-03-01");
    const volleyball = await create(federationRuntime, "volleyball", "2027-03-01");
    const lastDay3x21 = await create(federationRuntime, "badminton", "2027-01-03");
    const firstDay3x15 = await create(federationRuntime, "badminton", "2027-01-04");
    expect(await packVersion(polo.id)).toBe("1.0.0");
    expect(await packVersion(volleyball.id)).toBe("1.0.0");
    expect(await packVersion(lastDay3x21.id)).toBe("1.0.0");
    expect(await packVersion(firstDay3x15.id)).toBe("1.1.0");

    const settings = await federationRuntime.readSettings({ accountId: ownerId }, firstDay3x15.id);
    expect(settings).toMatchObject({ pack_version: "1.1.0", effective: { regularTargetPoints: 15, pointCap: 21 } });
    const volleyballSettings = await federationRuntime.readSettings({ accountId: ownerId }, volleyball.id);
    expect(volleyballSettings.effective).toMatchObject({ bestOf: 5 });

    // The federation packs are registered beside the draft packs; the active pack and existing rows are untouched.
    const active = await client<{ sport_code: string; version: string }[]>`
      SELECT sport_code,version FROM sport_pack_versions WHERE status='active' ORDER BY sport_code`;
    expect(active.every((row) => row.version === DRAFT_SPORT_PACK_VERSION)).toBe(true);
    const registered = await client<{ version: string; status: string }[]>`
      SELECT version,status FROM sport_pack_versions WHERE sport_code='badminton' ORDER BY version`;
    expect(registered).toEqual([
      { version: DRAFT_SPORT_PACK_VERSION, status: "active" },
      { version: "1.0.0", status: "draft" },
      { version: "1.1.0", status: "draft" },
    ]);
    expect(await client`SELECT * FROM competition_sport_settings WHERE competition_id=${draft.id}`).toEqual(before);
    expect(await packVersion(draft.id)).toBe(DRAFT_SPORT_PACK_VERSION);
  });
});
