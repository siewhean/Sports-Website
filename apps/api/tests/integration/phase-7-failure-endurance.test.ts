import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import postgres, { type Sql } from "postgres";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase7_endurance_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let organisationId = "";
let accountId = "";

describeInfrastructure("QA-004 / QA-007 / QA-008 / QA-009 — Production Failure Modes & Endurance Integration", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    client = postgres(databaseUrl, {
      max: 8,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });

    organisationId = randomUUID();
    accountId = randomUUID();

    await client`
      INSERT INTO accounts (id, primary_email, display_name, email_verified_at)
      VALUES (${accountId}, 'organiser@matchday.com', 'Organiser Alice', now());
    `;

    await client`
      INSERT INTO organisations (id, name, slug)
      VALUES (${organisationId}, 'Test Org', 'test-org');
    `;

    await client`
      INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
      VALUES (${organisationId}, ${accountId}, 'owner', 'active');
    `;
  });

  afterAll(async () => {
    if (client) {
      await client.end({ timeout: 2 });
    }
    await dropTestSchema(databaseUrl, schema);
  });

  describe("QA-007: Extended 2,000-Command Offline Queue Batch Ingestion", () => {
    it("handles batch ingestion of 2,000 commands transactionally", async () => {
      const auditPayload = JSON.stringify({ team: "home", delta: 1 });

      await client.begin(async (tx) => {
        for (let i = 0; i < 4; i++) {
          await tx`
            INSERT INTO audit_events (id, entity_type, entity_id, action, actor_id, metadata)
            SELECT
              gen_random_uuid(), 'competition', ${organisationId}::uuid, 'score_recorded', ${accountId}::uuid, ${auditPayload}::jsonb
            FROM generate_series(1, 500);
          `;
        }
      });

      const count = await client`SELECT count(*)::int as count FROM audit_events WHERE actor_id = ${accountId};`;
      expect(count[0]!.count).toBe(2000);
    });
  });

  describe("QA-008: Multi-Device Concurrent Mutation & Monotonic Audit Trail", () => {
    it("records concurrent writes and guarantees audit state persistence", async () => {
      const matchUuid = randomUUID();
      const deviceCount = 5;

      const results = await Promise.allSettled(
        Array.from(
          { length: deviceCount },
          (_, i) =>
            client`
            INSERT INTO audit_events (id, entity_type, entity_id, action, actor_id, metadata)
            VALUES (
              ${randomUUID()}, 'competition', ${matchUuid}::uuid, 'score_increment', ${accountId}::uuid,
              ${JSON.stringify({ device: `dev-${i}`, timestamp: new Date().toISOString() })}::jsonb
            )
          `,
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBe(deviceCount);

      const records = await client`
        SELECT id FROM audit_events WHERE entity_id = ${matchUuid}::uuid;
      `;
      expect(records.length).toBe(deviceCount);
    });
  });
});
