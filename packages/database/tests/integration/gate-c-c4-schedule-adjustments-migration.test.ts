import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_gate_c_c4_schedule_adjustments_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

beforeAll(async () => dropTestSchema(config.databaseUrl, schema));
afterAll(async () => dropTestSchema(config.databaseUrl, schema));

describe("Gate C C4 schedule adjustment migration", () => {
  it("applies the established append-only guard to repair match adjustments", async () => {
    const result = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
    expect(result.applied).toContain("0037_gate_c_repair_schedule_adjustments.sql");

    const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
    try {
      expect(
        await sql<{ function_name: string }[]>`
          SELECT procedure.proname AS function_name
          FROM pg_trigger trigger
          JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
          WHERE trigger.tgrelid='schedule_repair_match_adjustments'::regclass
            AND trigger.tgname='schedule_repair_match_adjustments_immutable'
        `,
      ).toEqual([{ function_name: "phase3_prevent_append_only_mutation" }]);
    } finally {
      await sql.end({ timeout: 2 });
    }
  });
});
