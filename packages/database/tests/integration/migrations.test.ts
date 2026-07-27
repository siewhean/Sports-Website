import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";
import { populatedUpgradeTestName, populatedUpgradeTimeoutMs } from "./migration-test-settings.js";

const config = parseConfig(process.env);
const schema = `test_migrations_${randomUUID().replaceAll("-", "")}`;
const concurrentSchema = `test_migrations_concurrent_${randomUUID().replaceAll("-", "")}`;
const populatedSchema = `test_migrations_populated_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
// Full-suite integration runs intentionally contend for the same local PostgreSQL instance.
// Keep this larger ceiling scoped to the empty-schema tests that apply the complete chain.
const fullMigrationChainTimeoutMs = 15_000;

beforeAll(async () =>
  Promise.all([schema, concurrentSchema, populatedSchema].map((name) => dropTestSchema(config.databaseUrl, name))),
);
afterAll(async () =>
  Promise.all([schema, concurrentSchema, populatedSchema].map((name) => dropTestSchema(config.databaseUrl, name))),
);

describe("foundation migrations", () => {
  it(
    "apply from an empty schema and are idempotent",
    async () => {
      const expectedMigrations = (await readdir(migrationsDirectory))
        .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
        .sort();
      const first = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
      const second = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
      expect(first.applied).toEqual(expectedMigrations);
      expect(second.applied).toEqual([]);
      expect(second.current).toEqual(expectedMigrations);

      const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
      try {
        const [extension] = await sql<{ namespace: string }[]>`
          SELECT namespace.nspname AS namespace
          FROM pg_extension extension
          JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
          WHERE extension.extname='pgcrypto'
        `;
        expect(extension).toEqual({ namespace: "public" });

        const [dependencies] = await sql<
          { hashSemanticsPreserved: boolean; scheduleDependsOnSha: boolean; shaDependsOnCanonical: boolean }[]
        >`
        SELECT
          phase4_schedule_problem_hash(
            jsonb_build_object('job_id', '00000000-0000-4000-8000-000000000001', 'value', 1)
          ) = phase4_sha256_json(jsonb_build_object('value', 1)) AS "hashSemanticsPreserved",
          EXISTS (
            SELECT 1
            FROM pg_depend dependency
            WHERE dependency.classid = 'pg_proc'::regclass
              AND dependency.refclassid = 'pg_proc'::regclass
              AND dependency.objid = to_regprocedure(${`${schema}.phase4_schedule_problem_hash(jsonb)`})
              AND dependency.refobjid = to_regprocedure(${`${schema}.phase4_sha256_json(jsonb)`})
          ) AS "scheduleDependsOnSha",
          EXISTS (
            SELECT 1
            FROM pg_depend dependency
            WHERE dependency.classid = 'pg_proc'::regclass
              AND dependency.refclassid = 'pg_proc'::regclass
              AND dependency.objid = to_regprocedure(${`${schema}.phase4_sha256_json(jsonb)`})
              AND dependency.refobjid = to_regprocedure(${`${schema}.phase3_canonical_jsonb(jsonb)`})
          ) AS "shaDependsOnCanonical"
      `;
        expect(dependencies).toEqual({
          hashSemanticsPreserved: true,
          scheduleDependsOnSha: true,
          shaDependsOnCanonical: true,
        });
      } finally {
        await sql.end({ timeout: 2 });
      }
    },
    fullMigrationChainTimeoutMs,
  );

  it(
    "serializes concurrent migration attempts for the same empty schema",
    async () => {
      const expectedMigrations = (await readdir(migrationsDirectory))
        .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
        .sort();
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema: concurrentSchema }),
        ),
      );

      expect(results.map((result) => result.applied.length).sort((left, right) => left - right)).toEqual([
        0,
        expectedMigrations.length,
      ]);
      expect(results.every((result) => result.current.join() === expectedMigrations.join())).toBe(true);
    },
    fullMigrationChainTimeoutMs,
  );

  it(
    populatedUpgradeTestName,
    async () => {
      const copiedDirectory = await mkdtemp(path.join(os.tmpdir(), "matchday-populated-migrations-"));
      await cp(migrationsDirectory, copiedDirectory, { recursive: true });
      const forwardMigrationNames = [
        "0020_phase4_format_recommendation_evidence.sql",
        "0021_phase4_schedule_job_progress.sql",
        "0022_phase4_schedule_revision_provenance.sql",
        "0023_phase4_schedule_publication_expiry.sql",
        "0024_phase4_ai_quota_reason.sql",
        "0025_phase4_schedule_concurrency_hardening.sql",
        "0026_phase4_setup_lineage_reconciliation.sql",
        "0028_gate_c_access_foundation.sql",
      ] as const;
      const forwardMigrations = await Promise.all(
        forwardMigrationNames.map(async (name) => {
          const migrationPath = path.join(copiedDirectory, name);
          return { name, migrationPath, source: await readFile(migrationPath, "utf8") };
        }),
      );
      await Promise.all(forwardMigrations.map(({ migrationPath }) => rm(migrationPath)));
      await migrateDatabase({
        databaseUrl: config.databaseUrl,
        migrationsDirectory: copiedDirectory,
        schema: populatedSchema,
      });
      const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: populatedSchema } });
      try {
        const account = randomUUID();
        const organisation = randomUUID();
        const competition = randomUUID();
        await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${account},${`${account}@example.test`},'Upgrade owner')`;
        await sql.begin(async (tx) => {
          await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisation},'Upgrade org',${`upgrade-${organisation}`})`;
          await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
            VALUES(${organisation},${account},'owner','active')`;
        });
        const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
        const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) hash`;
        await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
          VALUES('canoe_polo','upgrade-1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;
        await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
          venue,address,country_code,locale,plan_tier)
          VALUES(${competition},${organisation},${account},'Upgrade Cup',${`upgrade-cup-${competition}`},'canoe_polo',
          'Asia/Singapore','2027-01-01','2027-01-01','Arena','1 Road','SG','en-SG','organiser_pro')`;
        await sql`INSERT INTO competition_sport_settings(competition_id,updated_by,sport_code,pack_version,
          pack_schema_version,recommended_snapshot,settings_override)
          VALUES(${competition},${account},'canoe_polo','upgrade-1',1,'{}'::jsonb,'{}'::jsonb)`;
        const division = randomUUID();
        const placeholder = randomUUID();
        const secondPlaceholder = randomUUID();
        await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
          VALUES(${division},${competition},'Open',16)`;
        await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status)
          VALUES
            (${placeholder},${division},'Placeholder 1',1,'placeholder','confirmed'),
            (${secondPlaceholder},${division},'Placeholder 2',2,'placeholder','confirmed')`;
        const formatRevision = randomUUID();
        const match = randomUUID();
        const definition = {
          id: formatRevision,
          schemaVersion: 1,
          entryCount: 2,
          stages: [
            {
              id: "final-stage",
              label: "Final",
              kind: "single_elimination",
              order: 1,
              groupIds: [],
              groupSize: null,
              outputRanks: 2,
              matchIds: [match],
            },
          ],
          matches: [
            {
              id: match,
              stageId: "final-stage",
              round: 1,
              order: 1,
              purpose: "championship",
              home: { type: "entry_seed", seed: 1 },
              away: { type: "entry_seed", seed: 2 },
            },
          ],
          terminalMatchIds: [match],
        };
        const [definitionHash] = await sql<{ hash: string }[]>`
          SELECT phase4_sha256_json(${sql.json(definition)}) hash`;
        await sql`INSERT INTO format_revisions(
          id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract
        ) VALUES(
          ${formatRevision},${competition},${division},1,${sql.json(definition)},${definitionHash!.hash},${account},'phase3'
        )`;
        await sql`INSERT INTO matches(
          id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal
        ) VALUES(${match},${competition},${division},${formatRevision},'UPGRADE-FINAL','final',1,1)`;
        const accessPass = randomUUID();
        const revokedAccessPass = randomUUID();
        const expiredAccessPass = randomUUID();
        const accessSession = randomUUID();
        const legacyFallbackCode = "012345678901";
        const revokedLegacyFallbackCode = "112345678901";
        const expiredLegacyFallbackCode = "212345678901";
        await sql`INSERT INTO scoring_access_passes(
          id,match_id,secret_hash,short_code_hash,expires_at,created_at,revoked_at,created_by
        ) VALUES
        (
          ${accessPass},${match},${Buffer.alloc(32, 1)},
          ${createHash("sha256").update(legacyFallbackCode, "utf8").digest()},
          '2100-01-01T12:00:00Z',now(),NULL,${account}
        ),
        (
          ${revokedAccessPass},${match},${Buffer.alloc(32, 4)},
          ${createHash("sha256").update(revokedLegacyFallbackCode, "utf8").digest()},
          '2100-01-01T12:00:00Z',now(),now(),${account}
        ),
        (
          ${expiredAccessPass},${match},${Buffer.alloc(32, 5)},
          ${createHash("sha256").update(expiredLegacyFallbackCode, "utf8").digest()},
          '2000-01-01T12:00:00Z','1999-01-01T12:00:00Z',NULL,${account}
        )`;
        await sql`INSERT INTO scoring_access_sessions(
          id,access_pass_id,match_id,session_token_hash,generation,issued_at,expires_at
        ) VALUES(
          ${accessSession},${accessPass},${match},${Buffer.alloc(32, 3)},7,
          '2027-01-01T08:00:00Z','2027-01-01T09:00:00Z'
        )`;
        await sql`SELECT phase4_create_setup_draft(${organisation},${competition},${account},'upgrade-create','upgrade-request')`;
        const existingLedger = randomUUID();
        await sql`INSERT INTO ai_action_ledger(id,organisation_id,actor_account_id,competition_id,action,request_id,
          correlation_id,idempotency_key,request_fingerprint,schema_version,input_character_count,outcome,cache_status,
          charged_units,attempts,duration_ms,failure_code,metadata,completed_at)
          VALUES(${existingLedger},${organisation},${account},${competition},'text_to_brief','upgrade-ai-request',
          'upgrade-ai-request','upgrade-ai-request',${"a".repeat(64)},'1.0',12,'manual_fallback','not_checked',
          0,1,5,'unknown','{"provider_mode":"stub"}'::jsonb,now())`;
        const [beforeUpgrade] = await sql<
          { confirmed_count: number; placeholder_count: number; entry_ids: string[] }[]
        >`SELECT
            (steps#>>'{entries,divisions,0,confirmed_count}')::int confirmed_count,
            (steps#>>'{entries,divisions,0,placeholder_count}')::int placeholder_count,
            steps#>'{entries,divisions,0,entry_ids}' entry_ids
          FROM setup_drafts WHERE competition_id=${competition}`;
        expect(beforeUpgrade).toMatchObject({ confirmed_count: 2, placeholder_count: 2 });
        expect(beforeUpgrade?.entry_ids.toSorted()).toEqual([placeholder, secondPlaceholder].toSorted());
        await Promise.all(forwardMigrations.map(({ migrationPath, source }) => writeFile(migrationPath, source)));
        const upgraded = await migrateDatabase({
          databaseUrl: config.databaseUrl,
          migrationsDirectory: copiedDirectory,
          schema: populatedSchema,
        });
        expect(upgraded.applied).toEqual(forwardMigrationNames);
        const [afterUpgrade] = await sql<
          { confirmed_count: number; placeholder_count: number; entry_ids: string[] }[]
        >`SELECT
            (steps#>>'{entries,divisions,0,confirmed_count}')::int confirmed_count,
            (steps#>>'{entries,divisions,0,placeholder_count}')::int placeholder_count,
            steps#>'{entries,divisions,0,entry_ids}' entry_ids
          FROM setup_drafts WHERE competition_id=${competition}`;
        expect(afterUpgrade).toMatchObject({ confirmed_count: 0, placeholder_count: 2 });
        expect(afterUpgrade?.entry_ids.toSorted()).toEqual([placeholder, secondPlaceholder].toSorted());
        expect(await sql`SELECT 1 FROM phase4_format_recommendation_sets`).toEqual([]);
        expect(
          await sql`
            SELECT competition_id,mode,generation,octet_length(device_id_hash) device_hash_bytes
            FROM scoring_access_sessions WHERE id=${accessSession}
          `,
        ).toEqual([{ competition_id: competition, mode: "writer", generation: 7, device_hash_bytes: 32 }]);
        expect(
          await sql`
            SELECT role,scope,secret_hash,short_code_hash,fallback_code_hash_version
            FROM scoring_access_passes WHERE id=${accessPass}
          `,
        ).toEqual([
          {
            role: "scorekeeper",
            scope: ["score:read", "score:write", "score:reverse", "score:finalise"],
            secret_hash: Buffer.alloc(32, 1),
            short_code_hash: null,
            fallback_code_hash_version: "rotation_required",
          },
        ]);
        expect(
          await sql`
            SELECT id,secret_hash,short_code_hash,fallback_code_hash_version
            FROM scoring_access_passes
            WHERE id IN (${revokedAccessPass},${expiredAccessPass})
            ORDER BY id
          `,
        ).toEqual(
          [
            {
              id: revokedAccessPass,
              secret_hash: Buffer.alloc(32, 4),
              short_code_hash: null,
              fallback_code_hash_version: "unavailable",
            },
            {
              id: expiredAccessPass,
              secret_hash: Buffer.alloc(32, 5),
              short_code_hash: null,
              fallback_code_hash_version: "unavailable",
            },
          ].toSorted((left, right) => left.id.localeCompare(right.id)),
        );
        expect(
          await sql`
            SELECT action,metadata->>'competition_id' competition_id,
                   after_state->>'fallback_code_status' fallback_code_status
            FROM audit_events
            WHERE target_id=${accessPass}::text
              AND action='scoring_access.fallback_rotation_required'
          `,
        ).toEqual([
          {
            action: "scoring_access.fallback_rotation_required",
            competition_id: competition,
            fallback_code_status: "rotation_required",
          },
        ]);
        expect(
          await sql`
            SELECT
              (SELECT count(*)::integer FROM audit_events
                WHERE target_id IN (${revokedAccessPass}::text,${expiredAccessPass}::text)
                  AND action='scoring_access.fallback_rotation_required') audit_count,
              (SELECT count(*)::integer FROM outbox_events
                WHERE aggregate_id IN (${revokedAccessPass}::text,${expiredAccessPass}::text)
                  AND event_type='scoring_access.fallback_rotation_required') outbox_count
          `,
        ).toEqual([{ audit_count: 0, outbox_count: 0 }]);
        expect(
          await sql`
            SELECT event_type,payload->>'competition_id' competition_id,
                   payload->>'fallback_code_status' fallback_code_status
            FROM outbox_events
            WHERE aggregate_id=${accessPass}::text
              AND event_type='scoring_access.fallback_rotation_required'
          `,
        ).toEqual([
          {
            event_type: "scoring_access.fallback_rotation_required",
            competition_id: competition,
            fallback_code_status: "rotation_required",
          },
        ]);
        const fallbackRotationEvidence = JSON.stringify(
          await sql`
            SELECT metadata,after_state,NULL::jsonb payload
            FROM audit_events WHERE target_id=${accessPass}::text
            UNION ALL
            SELECT NULL::jsonb,NULL::jsonb,payload
            FROM outbox_events WHERE aggregate_id=${accessPass}::text
          `,
        );
        expect(fallbackRotationEvidence).not.toContain(legacyFallbackCode);
        expect(fallbackRotationEvidence).not.toContain(
          createHash("sha256").update(legacyFallbackCode, "utf8").digest("hex"),
        );
        expect(fallbackRotationEvidence).not.toContain(revokedLegacyFallbackCode);
        expect(fallbackRotationEvidence).not.toContain(expiredLegacyFallbackCode);
        expect(
          await sql`SELECT id,outcome,charged_units,failure_code FROM ai_action_ledger WHERE id=${existingLedger}`,
        ).toEqual([{ id: existingLedger, outcome: "manual_fallback", charged_units: 0, failure_code: "unknown" }]);
        await sql`INSERT INTO ai_action_ledger(organisation_id,actor_account_id,competition_id,action,request_id,
          correlation_id,idempotency_key,request_fingerprint,schema_version,input_character_count,outcome,cache_status,
          charged_units,attempts,duration_ms,failure_code,metadata,completed_at)
          VALUES(${organisation},${account},${competition},'text_to_brief','upgrade-ai-quota','upgrade-ai-quota',
          'upgrade-ai-quota',${"b".repeat(64)},'1.0',12,'manual_fallback','not_checked',0,0,0,'quota_exhausted',
          '{"provider_mode":"stub"}'::jsonb,now())`;
        expect(await sql`SELECT failure_code FROM ai_action_ledger WHERE idempotency_key='upgrade-ai-quota'`).toEqual([
          { failure_code: "quota_exhausted" },
        ]);
        expect(
          (
            await sql<
              { expiry: string }[]
            >`SELECT phase4_schedule_expiry('2027-01-31T10:15:00Z'::timestamptz)::text expiry`
          )[0]?.expiry,
        ).toContain("2027-02-28 10:15:00");
      } finally {
        await sql.end({ timeout: 2 });
        await rm(copiedDirectory, { recursive: true, force: true });
      }
    },
    populatedUpgradeTimeoutMs,
  );

  it("rejects checksum drift in an already-applied migration", async () => {
    const copiedDirectory = await mkdtemp(path.join(os.tmpdir(), "matchday-migrations-"));
    const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
    try {
      await sql`UPDATE schema_migrations SET checksum=NULL WHERE name='0001_foundation.sql'`;
      await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
      const [pinned] = await sql<{ checksum: string | null }[]>`
        SELECT checksum FROM schema_migrations WHERE name='0001_foundation.sql'`;
      expect(pinned?.checksum).toMatch(/^[0-9a-f]{64}$/);

      await cp(migrationsDirectory, copiedDirectory, { recursive: true });
      await appendFile(path.join(copiedDirectory, "0001_foundation.sql"), "\n-- unexpected drift\n");
      await expect(
        migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory: copiedDirectory, schema }),
      ).rejects.toThrow(/checksum mismatch: 0001_foundation\.sql/i);
    } finally {
      await sql.end({ timeout: 2 });
      await rm(copiedDirectory, { recursive: true, force: true });
    }
  });
});
