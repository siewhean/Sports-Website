import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_gate_c_fallback_history_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

let sql!: Sql;

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 1, connection: { search_path: schema } });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Gate C fallback-code history uniqueness", () => {
  it("keeps fallback-code hashes unique across active, expired, and revoked retained passes", async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname=${schema}
        AND tablename='scoring_access_passes'
        AND indexname='scoring_access_pass_active_code_unique'
    `;

    expect(rows).toHaveLength(1);
    const definition = rows[0]!.indexdef.toLowerCase();
    expect(definition).toContain("create unique index");
    expect(definition).toContain("short_code_hash");
    expect(definition).toContain("short_code_hash is not null");
    expect(definition).not.toContain("revoked_at");
    expect(definition).not.toContain("expires_at");
  });
});
