import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import postgres, { type Sql } from "postgres";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase6_entitlement_entries_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;

describeInfrastructure("Phase 6 effective entry entitlements", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, {
      max: 4,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end();
    await dropTestSchema(databaseUrl, schema);
  });

  it("scopes Event Pass entry capacity to the purchased competition and never to a sibling", async () => {
    const accountId = (
      await client<{ id: string }[]>`
        INSERT INTO accounts (primary_email, display_name, email_verified_at)
        VALUES (${`owner-${randomUUID()}@example.com`}, 'Owner', now()) RETURNING id
      `
    )[0]!.id;
    const organisationId = randomUUID();
    await client.begin(async (tx) => {
      await tx`INSERT INTO organisations (id, name, slug) VALUES (${organisationId}, 'Paid Org', ${`paid-org-${randomUUID()}`})`;
      await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${organisationId}, ${accountId}, 'owner', 'active')`;
    });
    const competitionA = (
      await client<{ id: string }[]>`
        INSERT INTO competitions
          (organisation_id, created_by, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, plan_tier)
        VALUES
          (${organisationId}, ${accountId}, 'Paid Competition', ${`paid-comp-${randomUUID()}`},
           'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', 'free')
        RETURNING id
      `
    )[0]!.id;
    const competitionB = (
      await client<{ id: string }[]>`
        INSERT INTO competitions
          (organisation_id, created_by, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, plan_tier)
        VALUES
          (${organisationId}, ${accountId}, 'Sibling Competition', ${`sibling-comp-${randomUUID()}`},
           'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', 'free')
        RETURNING id
      `
    )[0]!.id;
    const divisionA = (
      await client<{ id: string }[]>`
        INSERT INTO divisions (competition_id, name, team_limit)
        VALUES (${competitionA}, 'Open', 48) RETURNING id
      `
    )[0]!.id;
    const divisionB = (
      await client<{ id: string }[]>`
        INSERT INTO divisions (competition_id, name, team_limit)
        VALUES (${competitionB}, 'Open', 48) RETURNING id
      `
    )[0]!.id;

    await expect(
      client`
        INSERT INTO organisation_subscriptions
          (organisation_id, tier, status, current_period_start, current_period_end)
        VALUES (${organisationId}, 'event_pass', 'active', now(), now() + interval '30 days')
      `,
    ).rejects.toThrow(/Event Pass entitlement must be scoped to a competition/i);
    await client`
      INSERT INTO entitlement_grants
        (organisation_id, competition_id, tier, feature, source, quantity, idempotency_key, expires_at)
      VALUES
        (${organisationId}, ${competitionA}, 'event_pass', 'unlimited_entries', 'purchase', 1, ${`pass-${randomUUID()}`}, now() + interval '30 days')
    `;

    const tiers = await client<{ id: string; tier: string }[]>`
      SELECT id, matchday_effective_plan_tier(id) AS tier
      FROM competitions
      WHERE id IN (${competitionA}, ${competitionB})
    `;
    expect(Object.fromEntries(tiers.map((tier) => [tier.id, tier.tier]))).toEqual({
      [competitionA]: "event_pass",
      [competitionB]: "free",
    });

    for (let index = 1; index <= 17; index += 1) {
      await client`
        INSERT INTO division_entries (division_id, name, entry_type, status)
        VALUES (${divisionA}, ${`Pass Team ${index}`}, 'team', 'active')
      `;
    }
    for (let index = 1; index <= 16; index += 1) {
      await client`
        INSERT INTO division_entries (division_id, name, entry_type, status)
        VALUES (${divisionB}, ${`Sibling Team ${index}`}, 'team', 'active')
      `;
    }

    await expect(
      client`
        INSERT INTO division_entries (division_id, name, entry_type, status)
        VALUES (${divisionB}, 'Sibling Team 17', 'team', 'active')
      `,
    ).rejects.toThrow(/free plan permits at most 16 active entries/i);
  });
});
