import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeInfra = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_w2_billing_receipts_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let sql: Sql;

describeInfra("0071 billing receipt minimisation", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined, connection: { search_path: schema } });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await dropTestSchema(databaseUrl, schema);
  });

  it("unwraps double-encoded rows and strips customer PII idempotently", async () => {
    const legacy = {
      id: "evt_legacy",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: "cs_legacy",
          amount_total: 4900,
          currency: "usd",
          payment_status: "paid",
          customer_details: { email: "legacy@example.test", name: "Legacy Buyer" },
          metadata: { organisation_id: "org", tier: "event_pass" },
        },
      },
    };
    // Reproduce the historic driver behaviour: the jsonb column holds a JSON *string*.
    await sql`INSERT INTO billing_webhook_receipts(provider_event_id,event_type,status,payload)
      VALUES('evt_legacy','checkout.session.completed','processed',to_jsonb(${JSON.stringify(legacy)}::text))`;
    const migration = await readFile(
      path.join(migrationsDirectory, "0071_w2sec_billing_receipt_minimisation_casual_ttl.sql"),
      "utf8",
    );
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    const [row] = await sql<{ kind: string; payload: string }[]>`
      SELECT jsonb_typeof(payload) AS kind, payload::text AS payload
      FROM billing_webhook_receipts WHERE provider_event_id='evt_legacy'`;
    expect(row?.kind).toBe("object");
    expect(row?.payload).not.toContain("legacy@example.test");
    expect(row?.payload).not.toContain("livemode");
    expect(JSON.parse(row!.payload)).toMatchObject({
      id: "evt_legacy",
      data: { object: { id: "cs_legacy", amount_total: 4900, payment_status: "paid" } },
    });
  });
});
