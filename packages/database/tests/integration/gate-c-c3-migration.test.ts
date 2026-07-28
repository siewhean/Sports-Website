import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_gate_c_c3_migration_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const migrationName = "0032_gate_c_offline_replay.sql";

beforeAll(async () => dropTestSchema(config.databaseUrl, schema));
afterAll(async () => dropTestSchema(config.databaseUrl, schema));

describe("Gate C C3 migration", () => {
  it("preserves historical audit and outbox bytes while adding offline authority", async () => {
    const copiedDirectory = await mkdtemp(path.join(os.tmpdir(), "matchday-gate-c-c3-migration-"));
    await cp(migrationsDirectory, copiedDirectory, { recursive: true });
    const migrationPath = path.join(copiedDirectory, migrationName);
    const migrationSource = await readFile(migrationPath, "utf8");
    await rm(migrationPath);

    await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory: copiedDirectory, schema });
    const sql = postgres(config.databaseUrl, {
      max: 1,
      prepare: false,
      connection: { search_path: schema },
    });
    try {
      const organisationId = randomUUID();
      await sql`INSERT INTO organisations(id,name,slug)
        VALUES(${organisationId},'C3 migration org',${`c3-migration-${organisationId}`})`;

      const outboxKey = `c3-double-encoded-${randomUUID()}`;
      const auditRequestId = `c3-double-encoded-audit-${randomUUID()}`;
      const wrappedOutbox = JSON.stringify({ competition_id: randomUUID(), match_id: randomUUID() });
      const wrappedAfter = JSON.stringify({ event_type: "goal", aggregate_version: 2 });
      await sql`INSERT INTO outbox_events(
        aggregate_type,aggregate_id,event_type,payload,idempotency_key
      ) VALUES(
        'match','c3-history','scoring_event.appended',to_jsonb(${wrappedOutbox}::text),${outboxKey}
      )`;
      await sql`INSERT INTO audit_events(
        request_id,actor_type,organisation_id,action,target_type,target_id,before_state,after_state
      ) VALUES(
        ${auditRequestId},'system',${organisationId},'scoring_event.appended','match','c3-history',
        to_jsonb(${"preserve-before"}::text),to_jsonb(${wrappedAfter}::text)
      )`;

      const [before] = await sql<{
        payload: string;
        before_state: string;
        after_state: string;
        payload_hash: string;
        before_hash: string;
        after_hash: string;
      }[]>`
        SELECT outbox.payload::text payload,audit.before_state::text before_state,audit.after_state::text after_state,
          encode(digest(convert_to(outbox.payload::text,'UTF8'),'sha256'),'hex') payload_hash,
          encode(digest(convert_to(audit.before_state::text,'UTF8'),'sha256'),'hex') before_hash,
          encode(digest(convert_to(audit.after_state::text,'UTF8'),'sha256'),'hex') after_hash
        FROM outbox_events outbox
        JOIN audit_events audit ON audit.request_id=${auditRequestId}
        WHERE outbox.idempotency_key=${outboxKey}
      `;
      if (!before) throw new Error("Expected pre-migration history fixture");

      await writeFile(migrationPath, migrationSource);
      const result = await migrateDatabase({
        databaseUrl: config.databaseUrl,
        migrationsDirectory: copiedDirectory,
        schema,
      });
      expect(result.applied).toEqual([migrationName]);

      const [after] = await sql<{
        payload: string;
        before_state: string;
        after_state: string;
        payload_hash: string;
        before_hash: string;
        after_hash: string;
        payload_type: string;
        before_type: string;
        after_type: string;
      }[]>`
        SELECT outbox.payload::text payload,audit.before_state::text before_state,audit.after_state::text after_state,
          encode(digest(convert_to(outbox.payload::text,'UTF8'),'sha256'),'hex') payload_hash,
          encode(digest(convert_to(audit.before_state::text,'UTF8'),'sha256'),'hex') before_hash,
          encode(digest(convert_to(audit.after_state::text,'UTF8'),'sha256'),'hex') after_hash,
          jsonb_typeof(outbox.payload) payload_type,
          jsonb_typeof(audit.before_state) before_type,
          jsonb_typeof(audit.after_state) after_type
        FROM outbox_events outbox
        JOIN audit_events audit ON audit.request_id=${auditRequestId}
        WHERE outbox.idempotency_key=${outboxKey}
      `;
      if (!after) throw new Error("Expected post-migration history fixture");
      expect(after).toMatchObject({
        ...before,
        payload_type: "string",
        before_type: "string",
        after_type: "string",
      });
      await expect(
        sql`UPDATE audit_events SET action=action WHERE request_id=${auditRequestId}`,
      ).rejects.toThrow(/append-only/i);
      expect(
        await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema=current_schema() AND table_name='scoring_offline_authorizations'
        `,
      ).toEqual([{ table_name: "scoring_offline_authorizations" }]);
      expect(migrationSource).not.toContain("DISABLE TRIGGER audit_events_no_update");
      expect(migrationSource).not.toMatch(/UPDATE\s+audit_events/iu);
      expect(migrationSource).not.toMatch(/UPDATE\s+outbox_events/iu);
    } finally {
      await sql.end({ timeout: 2 });
      await rm(copiedDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
