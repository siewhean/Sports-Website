import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_p3_short_codes_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
let tempDir: string | null = null;

beforeAll(async () => {
  await dropTestSchema(config.databaseUrl, schema);
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  await dropTestSchema(config.databaseUrl, schema);
});

describe("Migration 0077: division short codes", () => {
  it("backfills non-archived competitions and preserves archived immutability during real migration", async () => {
    // 1. Prepare migrations up to 0076
    tempDir = await mkdtemp(path.join(os.tmpdir(), "p3-mig-"));
    // Copy all migrations through 0076
    const { readdir } = await import("node:fs/promises");
    const allFiles = (await readdir(migrationsDirectory)).filter((f) => f.endsWith(".sql")).sort();
    const upTo76 = allFiles.slice(0, allFiles.indexOf("0076_daily_court_reserves.sql") + 1);
    for (const f of upTo76) {
      await cp(path.join(migrationsDirectory, f), path.join(tempDir, f));
    }

    // Run migrations up to 0076
    await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory: tempDir, schema });

    const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
    const accountId = randomUUID();
    const orgId = randomUUID();

    try {
      await sql`INSERT INTO accounts (id, primary_email, display_name) VALUES (${accountId}, 'p3@example.com', 'P3 User')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations (id, name, slug) VALUES (${orgId}, 'P3 Org', 'p3-org')`;
        await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${orgId}, ${accountId}, 'owner', 'active')`;
      });

      // 2. Seed active competition with multiple divisions to test auto-suggest and collision
      const compActive = randomUUID();
      await sql`
        INSERT INTO competitions (
          id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on,
          venue, address, country_code, locale, plan_tier, status
        ) VALUES (
          ${compActive}, ${orgId}, ${accountId}, 'P3 Active Comp', 'p3-active-comp',
          'badminton', 'Asia/Singapore', '2026-11-01', '2026-11-02', 'Hall A', '1 Test St', 'SG', 'en-SG', 'free', 'draft'
        )
      `;
      const divM = randomUUID();
      const divM2 = randomUUID();
      const divU18 = randomUUID();
      const divX = randomUUID();
      await sql`
        INSERT INTO divisions (id, competition_id, name, team_limit)
        VALUES
          (${divM}, ${compActive}, 'Men''s Open', 8),
          (${divM2}, ${compActive}, 'Men''s B', 8),
          (${divU18}, ${compActive}, 'Under 18', 8),
          (${divX}, ${compActive}, 'Mixed Open', 8)
      `;

      // 3. Seed archived competition
      const compArchived = randomUUID();
      await sql`
        INSERT INTO competitions (
          id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on,
          venue, address, country_code, locale, plan_tier, status
        ) VALUES (
          ${compArchived}, ${orgId}, ${accountId}, 'P3 Archived Comp', 'p3-archived-comp',
          'badminton', 'Asia/Singapore', '2026-11-01', '2026-11-02', 'Hall A', '1 Test St', 'SG', 'en-SG', 'free', 'draft'
        )
      `;
      const divArchived = randomUUID();
      await sql`
        INSERT INTO divisions (id, competition_id, name, team_limit)
        VALUES (${divArchived}, ${compArchived}, 'Men''s Open', 8)
      `;
      await sql`UPDATE competitions SET status = 'archived', archived_from_status = 'draft', archived_at = now() WHERE id = ${compArchived}`;

      // 4. Now copy 0077 into tempDir and run migration
      await cp(
        path.join(migrationsDirectory, "0077_redesign_p3_division_short_codes.sql"),
        path.join(tempDir, "0077_redesign_p3_division_short_codes.sql"),
      );

      const secondMigrate = await migrateDatabase({
        databaseUrl: config.databaseUrl,
        migrationsDirectory: tempDir,
        schema,
      });
      expect(secondMigrate.applied).toEqual(["0077_redesign_p3_division_short_codes.sql"]);

      // 5. Verify backfill results on active competition
      const rows = await sql<{ id: string; short_code: string }[]>`
        SELECT id, short_code FROM divisions WHERE competition_id = ${compActive}
      `;
      const codeMap = Object.fromEntries(rows.map((r) => [r.id, r.short_code]));
      expect(new Set([codeMap[divM], codeMap[divM2]])).toEqual(new Set(["M", "M2"]));
      expect(codeMap[divU18]).toBe("U18");
      expect(codeMap[divX]).toBe("X");

      // 6. Verify archived competition is untouched and has NULL short_code
      const [archivedRow] = await sql<{ short_code: string | null }[]>`
        SELECT short_code FROM divisions WHERE id = ${divArchived}
      `;
      expect(archivedRow?.short_code).toBeNull();

      // 7. Verify constraints on newly added column
      await expect(
        sql`
          INSERT INTO divisions (id, competition_id, name, team_limit, short_code)
          VALUES (${randomUUID()}, ${compActive}, 'Test Div', 8, 'lower')
        `,
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO divisions (id, competition_id, name, team_limit, short_code)
          VALUES (${randomUUID()}, ${compActive}, 'Test Div 2', 8, 'TOOLONG')
        `,
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO divisions (id, competition_id, name, team_limit, short_code)
          VALUES (${randomUUID()}, ${compActive}, 'Duplicate Short Code', 8, 'M')
        `,
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});
