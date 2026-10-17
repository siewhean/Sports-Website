/**
 * Track R8: Staging Replica Migration Safety Regression Test
 *
 * Verifies that database schema migrations execute safely and reliably against
 * realistic staging data containing ARCHIVED competitions with frozen match graphs.
 *
 * This directly guards against "the 0073 problem" where migrations with data backfills
 * fail against archived competitions due to immutable archive triggers (aa_matches_phase3_archive_guard).
 */

import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const config = parseConfig(process.env);
const databaseUrl = config.databaseUrl;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const temporaryDirectories: string[] = [];
const temporarySchemas: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  while (temporarySchemas.length > 0) {
    const schema = temporarySchemas.pop();
    if (schema) await dropTestSchema(databaseUrl, schema);
  }
});

async function createIsolatedSchema(prefix: string): Promise<string> {
  const schema = `test_r8_replica_${prefix}_${randomUUID().replaceAll("-", "")}`;
  temporarySchemas.push(schema);
  await dropTestSchema(databaseUrl, schema);
  return schema;
}

async function copyMigrationsThrough(lastMigration: string) {
  const allFiles = (await readdir(migrationsDirectory)).filter((f) => f.endsWith(".sql")).sort();
  const index = allFiles.indexOf(lastMigration);
  if (index === -1) throw new Error(`Target migration not found: ${lastMigration}`);

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "r8-replica-mig-"));
  temporaryDirectories.push(targetDir);

  const selected = allFiles.slice(0, index + 1);
  for (const file of selected) {
    await cp(path.join(migrationsDirectory, file), path.join(targetDir, file));
  }
  return { directory: targetDir, allMigrations: allFiles, initialFiles: selected };
}

async function copyAdditionalMigrations(targetDir: string, files: string[]) {
  for (const file of files) {
    await cp(path.join(migrationsDirectory, file), path.join(targetDir, file));
  }
}

function fourEntryEliminationDefinition(
  formatRevisionId: string,
  semi1Id: string,
  semi2Id: string,
  finalId: string,
): postgres.JSONValue {
  return {
    id: formatRevisionId,
    schemaVersion: 1,
    entryCount: 4,
    stages: [
      {
        id: "knockout",
        label: "Knockout",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 4,
        matchIds: [semi1Id, semi2Id, finalId],
      },
    ],
    matches: [
      {
        id: semi1Id,
        stageId: "knockout",
        round: 1,
        order: 1,
        purpose: "progression",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 4 },
      },
      {
        id: semi2Id,
        stageId: "knockout",
        round: 1,
        order: 2,
        purpose: "progression",
        home: { type: "entry_seed", seed: 2 },
        away: { type: "entry_seed", seed: 3 },
      },
      {
        id: finalId,
        stageId: "knockout",
        round: 2,
        order: 3,
        purpose: "championship",
        home: { type: "winner", matchId: semi1Id },
        away: { type: "winner", matchId: semi2Id },
      },
    ],
    terminalMatchIds: [finalId],
  };
}

describeInfrastructure("Track R8: Staging Replica Migration Safety", () => {
  it("executes migrations against a replica with archived competitions without violating archive immutability", async () => {
    const schema = await createIsolatedSchema("archived_safety");
    const { directory: copiedDir, allMigrations } = await copyMigrationsThrough("0072_round_robin_recommendations.sql");

    // 1. Initial migration to pre-0073
    const initialMigrate = await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });
    expect(initialMigrate.applied.at(-1)).toBe("0072_round_robin_recommendations.sql");

    const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
    const accountId = randomUUID();
    const organisationId = randomUUID();

    async function seedMaterialisedKnockout(label: string) {
      const competitionId = randomUUID();
      const divisionId = randomUUID();
      const formatRevisionId = randomUUID();

      await sql`
        INSERT INTO competitions (
          id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on,
          venue, address, country_code, locale, plan_tier
        ) VALUES (
          ${competitionId}, ${organisationId}, ${accountId}, ${`R8 Replica ${label}`}, ${`r8-${label}-${competitionId}`},
          'badminton', 'Asia/Singapore', '2026-10-01', '2026-10-02', 'Hall A', '1 Sports Ave', 'SG', 'en-SG', 'organiser_pro'
        );
      `;

      await sql`
        INSERT INTO competition_sport_settings (
          competition_id, updated_by, sport_code, pack_version, pack_schema_version, recommended_snapshot, settings_override
        ) VALUES (
          ${competitionId}, ${accountId}, 'badminton', 'r8-pack-v1', 1, '{}'::jsonb, '{}'::jsonb
        );
      `;

      await sql`
        INSERT INTO divisions (id, competition_id, name, team_limit)
        VALUES (${divisionId}, ${competitionId}, 'Open', 16);
      `;

      await sql`
        INSERT INTO division_entries (id, division_id, name, seed, entry_type, status) VALUES
          (${randomUUID()}, ${divisionId}, 'Seed 1', 1, 'team', 'confirmed'),
          (${randomUUID()}, ${divisionId}, 'Seed 2', 2, 'team', 'confirmed'),
          (${randomUUID()}, ${divisionId}, 'Seed 3', 3, 'team', 'confirmed'),
          (${randomUUID()}, ${divisionId}, 'Seed 4', 4, 'team', 'confirmed');
      `;

      const definition = fourEntryEliminationDefinition(formatRevisionId, randomUUID(), randomUUID(), randomUUID());
      const [definitionHash] = await sql<
        { hash: string }[]
      >`SELECT phase4_sha256_json(${sql.json(definition)}) AS hash`;

      await sql`
        INSERT INTO format_revisions (
          id, competition_id, division_id, revision, definition, definition_hash, status, created_by, validation_contract
        ) VALUES (
          ${formatRevisionId}, ${competitionId}, ${divisionId}, 1, ${sql.json(definition)}, ${definitionHash!.hash}, 'draft', ${accountId}, 'phase3'
        );
      `;

      await sql`SELECT phase4_materialize_format_revision(${formatRevisionId});`;
      return { competitionId, formatRevisionId };
    }

    try {
      await sql`INSERT INTO accounts (id, primary_email, display_name) VALUES (${accountId}, ${`${accountId}@example.test`}, 'R8 Owner');`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations (id, name, slug) VALUES (${organisationId}, 'R8 Org', ${`r8-org-${organisationId}`});`;
        await tx`INSERT INTO organisation_memberships (organisation_id, account_id, role, status) VALUES (${organisationId}, ${accountId}, 'owner', 'active');`;
      });

      const pack = { recommendedSlotMinutes: 20, recommendedSettings: { slotMinutes: 20 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
      await sql`
        INSERT INTO sport_pack_versions (sport_code, version, schema_version, definition, definition_hash, status, activated_at)
        VALUES ('badminton', 'r8-pack-v1', 1, ${sql.json(pack)}, ${packHash!.hash}, 'active', now());
      `;

      const active = await seedMaterialisedKnockout("active");
      const archived = await seedMaterialisedKnockout("archived");

      // Explicitly archive the second competition
      await sql`UPDATE competitions SET status = 'archived', archived_from_status = 'draft', archived_at = now() WHERE id = ${archived.competitionId};`;

      // Baseline: Pre-0073 labels penultimate rounds as 'quarterfinal'
      const stagesFor = async (fId: string) =>
        sql<{ id: string; stage: string; round_number: number; ordinal: number }[]>`
          SELECT id, stage, round_number, ordinal FROM matches WHERE format_revision_id = ${fId} ORDER BY ordinal;
        `;

      const activeBefore = await stagesFor(active.formatRevisionId);
      const archivedBefore = await stagesFor(archived.formatRevisionId);

      expect(activeBefore.map((m) => m.stage)).toEqual(["quarterfinal", "quarterfinal", "final"]);
      expect(archivedBefore.map((m) => m.stage)).toEqual(["quarterfinal", "quarterfinal", "final"]);

      // 2. Apply remaining forward migrations (including 0073 and 0074)
      const forwardFiles = allMigrations.filter((name) => name >= "0073_fix_semifinal_stage_labelling.sql");
      await copyAdditionalMigrations(copiedDir, forwardFiles);

      const upgrade = await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });
      expect(upgrade.applied).toEqual(forwardFiles);

      // 3. Verify outcomes
      // Active competition semifinals are relabeled
      const activeAfter = await stagesFor(active.formatRevisionId);
      expect(activeAfter.map((m) => m.stage)).toEqual(["semifinal", "semifinal", "final"]);

      // Archived competition remains frozen and untouched
      const archivedAfter = await stagesFor(archived.formatRevisionId);
      expect(archivedAfter).toEqual(archivedBefore);

      // Verify triggers are active
      const [archiveTrigger] = await sql<{ tgenabled: string }[]>`
        SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'aa_matches_phase3_archive_guard' AND tgrelid = to_regclass(current_schema() || '.matches');
      `;
      expect(archiveTrigger?.tgenabled).toBe("O");

      const [projTrigger] = await sql<{ tgenabled: string }[]>`
        SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'aa_matches_phase4_projection_guard' AND tgrelid = to_regclass(current_schema() || '.matches');
      `;
      expect(projTrigger?.tgenabled).toBe("O");
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 45_000);
});
