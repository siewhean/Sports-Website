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

  it("applies a purchased tier to existing competitions and blocks new over-limit entries after lapse", async () => {
    const accountId = (
      await client<{ id: string }[]>`
        INSERT INTO accounts (primary_email, display_name, email_verified_at)
        VALUES (${`owner-${randomUUID()}@example.com`}, 'Owner', now()) RETURNING id
      `
    )[0]!.id;
    const organisationId = (
      await client<{ id: string }[]>`
        INSERT INTO organisations (name, slug)
        VALUES ('Paid Org', ${`paid-org-${randomUUID()}`}) RETURNING id
      `
    )[0]!.id;
    const competitionId = (
      await client<{ id: string }[]>`
        INSERT INTO competitions
          (organisation_id, created_by, name, slug, sport_code, status, timezone, starts_on, ends_on, venue, plan_tier)
        VALUES
          (${organisationId}, ${accountId}, 'Paid Competition', ${`paid-comp-${randomUUID()}`},
           'basketball', 'draft', 'Asia/Singapore', '2027-08-01', '2027-08-02', 'Arena', 'free')
        RETURNING id
      `
    )[0]!.id;
    const divisionId = (
      await client<{ id: string }[]>`
        INSERT INTO divisions (competition_id, name, team_limit)
        VALUES (${competitionId}, 'Open', 48) RETURNING id
      `
    )[0]!.id;

    await client`
      INSERT INTO organisation_subscriptions
        (organisation_id, tier, status, current_period_start, current_period_end)
      VALUES (${organisationId}, 'event_pass', 'active', now(), now() + interval '30 days')
    `;

    const [upgraded] = await client<{ plan_tier: string }[]>`
      SELECT plan_tier FROM competitions WHERE id=${competitionId}
    `;
    expect(upgraded?.plan_tier).toBe("event_pass");

    for (let index = 1; index <= 17; index += 1) {
      await client`
        INSERT INTO division_entries (division_id, name, entry_type, status)
        VALUES (${divisionId}, ${`Team ${index}`}, 'team', 'active')
      `;
    }

    await client`
      UPDATE organisation_subscriptions
      SET status='past_due', updated_at=now()
      WHERE organisation_id=${organisationId}
    `;

    await expect(
      client`
        INSERT INTO division_entries (division_id, name, entry_type, status)
        VALUES (${divisionId}, 'Team 18', 'team', 'active')
      `,
    ).rejects.toThrow(/free plan permits at most 16 active entries/i);

    const [retained] = await client<{ plan_tier: string }[]>`
      SELECT plan_tier FROM competitions WHERE id=${competitionId}
    `;
    expect(retained?.plan_tier).toBe("event_pass");
  });
});
