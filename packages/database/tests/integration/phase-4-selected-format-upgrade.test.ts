import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_phase4_selected_format_upgrade_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

beforeAll(async () => dropTestSchema(config.databaseUrl, schema));
afterAll(async () => dropTestSchema(config.databaseUrl, schema));

describe("Phase 4 selected-format migration upgrade", () => {
  it("adds publication guards without rewriting existing setup drafts", async () => {
    const copiedDirectory = await mkdtemp(path.join(os.tmpdir(), "matchday-selected-format-upgrade-"));
    await cp(migrationsDirectory, copiedDirectory, { recursive: true });
    const migrationNames = [
      "0027_phase4_publish_selected_formats.sql",
      "0028_phase4_latest_schedule_publication.sql",
      "0030_phase4_idempotent_format_publication.sql",
    ] as const;
    const heldBack = await Promise.all(
      migrationNames.map(async (name) => {
        const migrationPath = path.join(copiedDirectory, name);
        const source = await readFile(migrationPath, "utf8");
        await rm(migrationPath);
        return { name, migrationPath, source };
      }),
    );
    await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory: copiedDirectory, schema });

    const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
    try {
      const account = randomUUID();
      const organisation = randomUUID();
      const competition = randomUUID();
      await sql`INSERT INTO accounts(id,primary_email,display_name)
        VALUES(${account},${`${account}@example.test`},'Selected-format upgrade owner')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations(id,name,slug)
          VALUES(${organisation},'Selected-format upgrade',${`selected-format-upgrade-${organisation}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisation},${account},'owner','active')`;
      });
      const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) hash`;
      await sql`INSERT INTO sport_pack_versions(
        sport_code,version,schema_version,definition,definition_hash,status,activated_at
      ) VALUES('canoe_polo','upgrade-selected-1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;
      await sql`INSERT INTO competitions(
        id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
        venue,address,country_code,locale,plan_tier
      ) VALUES(
        ${competition},${organisation},${account},'Upgrade Selected Cup',${`upgrade-selected-${competition}`},
        'canoe_polo','Asia/Singapore','2027-10-01','2027-10-01','Arena','1 Road','SG','en-SG','organiser_pro'
      )`;
      await sql`INSERT INTO competition_sport_settings(
        competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
      ) VALUES(
        ${competition},${account},'canoe_polo','upgrade-selected-1',1,
        ${sql.json(pack.recommendedSettings)},'{}'::jsonb
      )`;
      await sql`SELECT phase4_create_setup_draft(
        ${organisation},${competition},${account},'upgrade-selected-create','upgrade-selected-request'
      )`;
      const [before] = await sql<{ id: string; revision: number; steps: unknown; updated_at: Date }[]>`
        SELECT id,revision,steps,updated_at FROM setup_drafts WHERE competition_id=${competition}`;
      if (!before) throw new Error("Expected setup draft before migration");

      for (const migration of heldBack) await writeFile(migration.migrationPath, migration.source);
      const upgraded = await migrateDatabase({
        databaseUrl: config.databaseUrl,
        migrationsDirectory: copiedDirectory,
        schema,
      });
      expect(upgraded.applied).toEqual([...migrationNames]);

      const [after] = await sql<{ id: string; revision: number; steps: unknown; updated_at: Date }[]>`
        SELECT id,revision,steps,updated_at FROM setup_drafts WHERE competition_id=${competition}`;
      expect(after).toEqual(before);
      expect(
        await sql<{ trigger_name: string }[]>`
          SELECT tgname trigger_name FROM pg_trigger
          WHERE NOT tgisinternal AND (
            (tgrelid='setup_drafts'::regclass AND tgname='zz_setup_drafts_publish_selected_formats')
            OR
            (tgrelid='schedule_revisions'::regclass AND tgname='ab_schedule_revisions_latest_publication_guard')
          ) ORDER BY tgname`,
      ).toEqual([
        { trigger_name: "ab_schedule_revisions_latest_publication_guard" },
        { trigger_name: "zz_setup_drafts_publish_selected_formats" },
      ]);
      expect(
        await sql<{ function_name: string }[]>`
          SELECT proname function_name FROM pg_proc
          WHERE proname='phase4_publish_format_revision' AND pronamespace=current_schema()::regnamespace`,
      ).toEqual([{ function_name: "phase4_publish_format_revision" }]);
    } finally {
      await sql.end({ timeout: 2 });
      await rm(copiedDirectory, { recursive: true, force: true });
    }
  });
});
