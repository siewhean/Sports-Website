import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultFormatTemplates } from "../../../domain/src/index.js";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";
import { contendedMigrationTestTimeoutMs } from "./migration-test-settings.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const schema = `test_phase4_setup_upgrade_${randomUUID().replaceAll("-", "")}`;
let sql!: Sql;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

async function insertIdentity(target: Sql, label: string) {
  const account = randomUUID();
  const organisation = randomUUID();
  await target`INSERT INTO accounts(id,primary_email,display_name)
    VALUES(${account},${`${account}@example.test`},${label})`;
  await target.begin(async (transaction) => {
    await transaction`INSERT INTO organisations(id,name,slug)
      VALUES(${organisation},${label},${`upgrade-${organisation}`})`;
    await transaction`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisation},${account},'owner','active')`;
  });
  return { account, organisation };
}

async function insertActivePack(target: Sql, sport: string, slotMinutes: number) {
  const definition = { recommendedSlotMinutes: slotMinutes, recommendedSettings: { slotMinutes } };
  await target`INSERT INTO sport_pack_versions(
    sport_code,version,schema_version,definition,definition_hash,status,activated_at
  ) VALUES(${sport},'canonical-1',1,${target.json(definition)},${hash(definition)},'active',now())`;
}

async function makePre0014Directory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-pre-0014-"));
  for (const name of (await readdir(migrationsDirectory)).filter((value) => /^00(0[1-9]|1[0-3])_/.test(value))) {
    await cp(path.join(migrationsDirectory, name), path.join(directory, name));
  }
  return directory;
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined, connection: { search_path: schema } });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("Phase 4 Assisted Setup upgrade safety", () => {
  it.each([
    ["canoe_polo", 30],
    ["badminton", 20],
    ["table_tennis", 15],
    ["volleyball", 45],
    ["basketball", 40],
  ] as const)("seeds the canonical %s slot default", async (sport, slotMinutes) => {
    const { account, organisation } = await insertIdentity(sql, `Canonical ${sport}`);
    await insertActivePack(sql, sport, slotMinutes);
    const competition = randomUUID();
    const area = randomUUID();
    await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier
    ) VALUES(
      ${competition},${organisation},${account},${sport},${`${sport.replaceAll("_", "-")}-${competition}`},${sport},
      'Asia/Singapore','2027-05-01','2027-05-02','organiser_pro'
    )`;
    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
      VALUES(${area},${competition},'Area 1',${slotMinutes})`;
    await sql`INSERT INTO competition_availability_windows(competition_id,playing_area_id,starts_at,ends_at)
      VALUES(${competition},${area},'2027-05-01T00:00:00Z','2027-05-01T04:00:00Z')`;
    const [draft] = await sql<{ value: { steps: { capacity: { effective: { slotMinutes: number } } } } }[]>`
      SELECT phase4_create_setup_draft(
        ${organisation},${competition},${account},${`create-${sport}`},${`request-${sport}`}
      ) value`;
    expect(draft?.value.steps.capacity.effective.slotMinutes).toBe(slotMinutes);
  });

  it(
    "fails closed when the selected sport has no valid active pack",
    async () => {
      const missingSchema = `test_phase4_missing_pack_${randomUUID().replaceAll("-", "")}`;
      let missingSql: Sql | undefined;
      try {
        await migrateDatabase({ databaseUrl, migrationsDirectory, schema: missingSchema });
        missingSql = postgres(databaseUrl, {
          max: 1,
          onnotice: () => undefined,
          connection: { search_path: missingSchema },
        });
        const { account, organisation } = await insertIdentity(missingSql, "Missing pack");
        const competition = randomUUID();
        await missingSql`INSERT INTO competitions(
        id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier
      ) VALUES(
        ${competition},${organisation},${account},'Missing pack',${`missing-${competition}`},'badminton',
        'Asia/Singapore','2027-06-01','2027-06-02','organiser_pro'
      )`;
        await expect(
          missingSql`SELECT phase4_create_setup_draft(
          ${organisation},${competition},${account},'missing-pack-create','missing-pack-request'
        )`,
        ).rejects.toThrow(/requires a valid active sport pack/i);
      } finally {
        await missingSql?.end({ timeout: 2 });
        await dropTestSchema(databaseUrl, missingSchema);
      }
    },
    contendedMigrationTestTimeoutMs,
  );

  it(
    "upgrades populated pre-0014 setup and template data through the real migrator",
    async () => {
      const upgradeSchema = `test_phase4_pre0014_${randomUUID().replaceAll("-", "")}`;
      const partialDirectory = await makePre0014Directory();
      let upgradeSql: Sql | undefined;
      try {
        await migrateDatabase({ databaseUrl, migrationsDirectory: partialDirectory, schema: upgradeSchema });
        upgradeSql = postgres(databaseUrl, {
          max: 1,
          onnotice: () => undefined,
          connection: { search_path: upgradeSchema },
        });
        const { account, organisation } = await insertIdentity(upgradeSql, "Populated upgrade");
        await insertActivePack(upgradeSql, "badminton", 20);
        const competition = randomUUID();
        const sourceDivision = randomUUID();
        const targetDivision = randomUUID();
        await upgradeSql`INSERT INTO competitions(
        id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier
      ) VALUES(
        ${competition},${organisation},${account},'Existing cup',${`existing-${competition}`},'badminton',
        'Asia/Singapore','2027-07-01','2027-07-02','organiser_pro'
      )`;
        await upgradeSql`INSERT INTO setup_drafts(organisation_id,competition_id,created_by,updated_by)
        VALUES(${organisation},${competition},${account},${account})`;
        await upgradeSql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES
        (${sourceDivision},${competition},'Source',8),(${targetDivision},${competition},'Target',8)`;
        const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
        const layout = {
          schema_version: 1,
          stage_positions: graph.stages.map((stage, index) => ({ stage_id: stage.id, x: index * 200, y: 0 })),
        };
        const sourceRevision = randomUUID();
        await upgradeSql`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract,source_kind
      ) VALUES(
        ${sourceRevision},${competition},${sourceDivision},1,${upgradeSql.json(graph)},${hash(graph)},
        ${upgradeSql.json(layout)},${account},'phase3','manual'
      )`;
        const [templateVersion] = await upgradeSql<{ id: string; template_id: string }[]>`
        SELECT id,template_id FROM phase4_create_format_template(
          ${organisation},${sourceRevision},${account},'Existing template','Archived after use','upgrade-template-create'
        )`;
        await upgradeSql`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,
        validation_contract,source_kind,template_version_id
      ) VALUES(
        ${randomUUID()},${competition},${targetDivision},1,${upgradeSql.json(graph)},${hash(graph)},
        ${upgradeSql.json(layout)},${account},'phase3','template',${templateVersion!.id}
      )`;
        await upgradeSql`SELECT phase4_archive_format_template(
        ${templateVersion!.template_id},${account},'upgrade-template-archive'
      )`;
        await upgradeSql.end();
        upgradeSql = undefined;

        const upgraded = await migrateDatabase({ databaseUrl, migrationsDirectory, schema: upgradeSchema });
        expect(upgraded.applied).toEqual([
          "0014_phase4_template_sport_guard.sql",
          "0015_phase4_setup_seed_and_patch.sql",
          "0016_phase4_setup_reference_refresh.sql",
          "0017_phase4_setup_upgrade_safety.sql",
          "0018_phase4_backup_restore_dependencies.sql",
          "0019_phase4_format_layout_revisions.sql",
          "0020_phase4_format_recommendation_evidence.sql",
          "0021_phase4_schedule_job_progress.sql",
          "0022_phase4_schedule_revision_provenance.sql",
          "0023_phase4_schedule_publication_expiry.sql",
          "0024_phase4_ai_quota_reason.sql",
          "0025_phase4_schedule_concurrency_hardening.sql",
          "0026_phase4_setup_lineage_reconciliation.sql",
          "0027_phase4_schedule_stage_dependencies.sql",
          "0028_gate_c_access_foundation.sql",
          "0029_gate_c_five_sport_scoring.sql",
          "0030_gate_c_published_schedule_participants.sql",
          "0031_gate_c_participant_snapshot_fencing.sql",
          "0032_v1_unseeded_schedule_source_mapping.sql",
          "0033_v1_unseeded_schedule_graph_shape_fix.sql",
          "0034_v1_materialize_direct_entry_sources.sql",
          "0035_identity_authentication_assurance.sql",
          "0036_gate_c_offline_replay.sql",
          "0037_gate_c_repair_public_truth_exports.sql",
          "0038_gate_c_repair_revision_fencing.sql",
          "0039_gate_c_repair_lineage_fencing.sql",
          "0040_gate_c_repair_publication_version_fencing.sql",
          "0041_gate_c_repair_append_only_compatibility.sql",
          "0042_gate_c_repair_schedule_adjustments.sql",
          "0043_gate_c_repair_schedule_participant_snapshots.sql",
          "0044_gate_c_multi_division_repair_projection_lineage.sql",
          "0045_gate_c_atomic_result_repair_cases.sql",
          "0046_gate_c_assign_result_repair_parent.sql",
          "0047_gate_c_scoring_access_hmac_key_versions.sql",
          "0048_phase3_sport_pack_hash_canonicalization.sql",
          "0049_phase3_sport_pack_hash_collation_fence.sql",
          "0050_phase3_sport_pack_hash_scope_fence.sql",
          "0051_gate_c_fallback_code_history_uniqueness.sql",
          "0052_gate_c_fallback_code_hmac_key_versions.sql",
          "0053_phase6_double_elimination_recommendations.sql",
          "0054_phase6_ai_provenance_and_accounting.sql",
          "0055_phase6_commercial_billing_entitlements.sql",
          "0056_phase6_double_elimination_completion_guard.sql",
          "0057_phase6_effective_entry_entitlements.sql",
          "0058_phase6_provider_subscription_state.sql",
          "0059_phase6_shared_ai_credits.sql",
          "0060_phase6_event_pass_competition_scope.sql",
          "0061_phase6_reject_organisation_event_pass.sql",
        ]);
        upgradeSql = postgres(databaseUrl, {
          max: 1,
          onnotice: () => undefined,
          connection: { search_path: upgradeSchema },
        });
        const [draft] = await upgradeSql<{ revision: number; steps: Record<string, unknown> }[]>`
        SELECT revision,steps FROM setup_drafts WHERE competition_id=${competition}`;
        expect(draft?.revision).toBeGreaterThan(1);
        expect(draft?.steps).toMatchObject({
          basics: { sport_code: "badminton" },
          format_preferences: { priority: { value: "participation" } },
        });
        expect(
          await upgradeSql`SELECT id,status FROM format_templates WHERE organisation_id=${organisation}`,
        ).toMatchObject([{ id: templateVersion!.template_id, status: "archived" }]);
      } finally {
        await upgradeSql?.end({ timeout: 2 });
        await rm(partialDirectory, { recursive: true, force: true });
        await dropTestSchema(databaseUrl, upgradeSchema);
      }
    },
    contendedMigrationTestTimeoutMs,
  );

  it(
    "rejects a populated pre-0014 cross-sport template application",
    async () => {
      const invalidSchema = `test_phase4_invalid_template_${randomUUID().replaceAll("-", "")}`;
      const partialDirectory = await makePre0014Directory();
      let invalidSql: Sql | undefined;
      try {
        await migrateDatabase({ databaseUrl, migrationsDirectory: partialDirectory, schema: invalidSchema });
        invalidSql = postgres(databaseUrl, {
          max: 1,
          onnotice: () => undefined,
          connection: { search_path: invalidSchema },
        });
        const { account, organisation } = await insertIdentity(invalidSql, "Invalid template upgrade");
        const badminton = randomUUID();
        const volleyball = randomUUID();
        const badmintonDivision = randomUUID();
        const volleyballDivision = randomUUID();
        await invalidSql`INSERT INTO competitions(
        id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier
      ) VALUES
        (${badminton},${organisation},${account},'Badminton',${`badminton-${badminton}`},'badminton','Asia/Singapore','2027-08-01','2027-08-02','organiser_pro'),
        (${volleyball},${organisation},${account},'Volleyball',${`volleyball-${volleyball}`},'volleyball','Asia/Singapore','2027-08-01','2027-08-02','organiser_pro')`;
        await invalidSql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES
        (${badmintonDivision},${badminton},'Open',8),(${volleyballDivision},${volleyball},'Open',8)`;
        const graph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
        const layout = {
          schema_version: 1,
          stage_positions: graph.stages.map((stage, index) => ({ stage_id: stage.id, x: index * 200, y: 0 })),
        };
        const source = randomUUID();
        await invalidSql`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,validation_contract,source_kind
      ) VALUES(
        ${source},${badminton},${badmintonDivision},1,${invalidSql.json(graph)},${hash(graph)},${invalidSql.json(layout)},
        ${account},'phase3','manual'
      )`;
        const [version] = await invalidSql<{ id: string }[]>`SELECT id FROM phase4_create_format_template(
        ${organisation},${source},${account},'Cross sport','Invalid legacy application','invalid-template-create'
      )`;
        await invalidSql`INSERT INTO format_revisions(
        id,competition_id,division_id,revision,definition,definition_hash,layout,created_by,
        validation_contract,source_kind,template_version_id
      ) VALUES(
        ${randomUUID()},${volleyball},${volleyballDivision},1,${invalidSql.json(graph)},${hash(graph)},${invalidSql.json(layout)},
        ${account},'phase3','template',${version!.id}
      )`;
        await invalidSql.end();
        invalidSql = undefined;

        await expect(migrateDatabase({ databaseUrl, migrationsDirectory, schema: invalidSchema })).rejects.toThrow(
          /pre-existing format template applications violate/i,
        );
      } finally {
        await invalidSql?.end({ timeout: 2 });
        await rm(partialDirectory, { recursive: true, force: true });
        await dropTestSchema(databaseUrl, invalidSchema);
      }
    },
    contendedMigrationTestTimeoutMs,
  );
});
