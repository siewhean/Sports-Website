import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { BillingWebhookPayload } from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { EntitlementRuntime } from "../../src/entitlement-runtime.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase6_subscription_state_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let runtime!: EntitlementRuntime;

describeInfrastructure("Phase 6 provider subscription lifecycle", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, {
      max: 4,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });
    runtime = new EntitlementRuntime(client as unknown as PostgresJsSql);
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end();
    await dropTestSchema(databaseUrl, schema);
  });

  it("preserves past_due status and provider period boundaries from subscription.updated", async () => {
    const organisationId = (
      await client<{ id: string }[]>`
        INSERT INTO organisations (name, slug)
        VALUES ('Lifecycle Org', ${`lifecycle-${randomUUID()}`}) RETURNING id
      `
    )[0]!.id;

    await client`
      INSERT INTO organisation_subscriptions
        (organisation_id, tier, status, provider_subscription_id, current_period_start, current_period_end)
      VALUES (${organisationId}, 'organiser_pro', 'active', 'sub_lifecycle', now(), now() + interval '30 days')
    `;

    const periodStart = Math.floor(Date.parse("2027-08-01T00:00:00.000Z") / 1000);
    const periodEnd = Math.floor(Date.parse("2027-09-01T00:00:00.000Z") / 1000);
    const payload = {
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_lifecycle",
          status: "past_due",
          current_period_start: periodStart,
          current_period_end: periodEnd,
        },
      },
    } as unknown as BillingWebhookPayload;

    const secret = "phase6_subscription_state_secret";
    const rawPayload = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const digest = createHmac("sha256", secret).update(`${timestamp}.${rawPayload}`).digest("hex");

    await runtime.processBillingWebhook(`t=${timestamp},v1=${digest}`, rawPayload, payload, secret);

    const [subscription] = await client<
      { status: string; current_period_start: Date; current_period_end: Date }[]
    >`
      SELECT status, current_period_start, current_period_end
      FROM organisation_subscriptions
      WHERE organisation_id=${organisationId}
    `;

    expect(subscription?.status).toBe("past_due");
    expect(subscription?.current_period_start.toISOString()).toBe("2027-08-01T00:00:00.000Z");
    expect(subscription?.current_period_end.toISOString()).toBe("2027-09-01T00:00:00.000Z");

    const summary = await runtime.getBillingSummary(organisationId);
    expect(summary.tier).toBe("free");
    expect(summary.status).toBe("past_due");
  });
});
