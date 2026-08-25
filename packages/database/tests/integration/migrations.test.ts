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
      // This fixture intentionally applies and rolls back DDL through a second
      // connection. Avoid retaining prepared plans across those relation OID
      // changes so the post-upgrade assertions exercise the migrated schema.
      const sql = postgres(config.databaseUrl, {
        max: 1,
        prepare: false,
        connection: { search_path: populatedSchema },
      });
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
        const siblingDivision = randomUUID();
        const placeholder = randomUUID();
        const secondPlaceholder = randomUUID();
        const siblingEntry = randomUUID();
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
          id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,
          home_entry_id,away_entry_id
        ) VALUES(
          ${match},${competition},${division},${formatRevision},'UPGRADE-FINAL','final',1,1,
          ${placeholder},${secondPlaceholder}
        )`;
        const playingArea = randomUUID();
        const scheduleRevision = randomUUID();
        await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
          VALUES(${playingArea},${competition},'Upgrade court',30)`;
        await sql`INSERT INTO schedule_revisions(
          id,competition_id,format_revision_id,revision,input_hash,created_by
        ) VALUES(
          ${scheduleRevision},${competition},${formatRevision},1,
          ${createHash("sha256").update(scheduleRevision).digest("hex")},${account}
        )`;
        await sql`INSERT INTO scheduled_matches(
          schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
        ) VALUES(
          ${scheduleRevision},${match},${competition},${playingArea},
          '2027-01-01T08:00:00Z','2027-01-01T08:30:00Z'
        )`;
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
        await sql`INSERT INTO division_sport_settings(
          division_id,competition_id,sport_code,pack_version,settings_override,updated_by
        ) VALUES(
          ${division},${competition},'canoe_polo','upgrade-1',
          '{"allowUnknownScorer":true}'::jsonb,${account}
        )`;
        const startedEvent = randomUUID();
        const goalEvent = randomUUID();
        const reversalEvent = randomUUID();
        const correctionEvent = randomUUID();
        await sql`INSERT INTO score_events(
          match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
          manual_period,manual_event_seconds,payload,actor_access_session_id,actor_account_id,
          correction_reason,occurred_at
        ) VALUES
          (${match},${startedEvent},1,7,'match_started',NULL,NULL,1,0,'{}'::jsonb,${accessSession},NULL,NULL,now()),
          (${match},${goalEvent},2,7,'goal_added','home','Player 1',1,25,'{}'::jsonb,${accessSession},NULL,NULL,now()),
          (${match},${reversalEvent},3,7,'goal_reversed',NULL,NULL,1,30,
            ${sql.json({ reversal_target_event_id: goalEvent })},${accessSession},NULL,'Incorrect scorer',now()),
          (${match},${correctionEvent},4,1,'correction',NULL,NULL,NULL,NULL,
            '{"home_score":1,"away_score":0}'::jsonb,NULL,${account},'Legacy authorised correction',now())`;
        await sql`INSERT INTO match_result_snapshots(
          match_id,result_version,through_sequence,home_score,away_score,state,snapshot
        ) VALUES(
          ${match},1,4,1,0,'corrected',
          '{"corrected":true,"homeScore":1,"awayScore":0,"state":"corrected"}'::jsonb
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
        await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
          VALUES(${siblingDivision},${competition},'Masters',16)`;
        await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status)
          VALUES(${siblingEntry},${siblingDivision},'Sibling division entry',1,'placeholder','confirmed')`;
        const participantFenceMigration = forwardMigrations.find(
          ({ name }) => name === "0031_gate_c_participant_snapshot_fencing.sql",
        );
        const unseededScheduleMigration = forwardMigrations.find(
          ({ name }) => name === "0032_v1_unseeded_schedule_source_mapping.sql",
        );
        const unseededScheduleGraphShapeMigration = forwardMigrations.find(
          ({ name }) => name === "0033_v1_unseeded_schedule_graph_shape_fix.sql",
        );
        const materialisedDirectEntrySourcesMigration = forwardMigrations.find(
          ({ name }) => name === "0034_v1_materialize_direct_entry_sources.sql",
        );
        if (!participantFenceMigration) throw new Error("Expected participant-fencing migration");
        if (!unseededScheduleMigration) throw new Error("Expected unseeded schedule migration");
        if (!unseededScheduleGraphShapeMigration) throw new Error("Expected unseeded schedule graph-shape migration");
        if (!materialisedDirectEntrySourcesMigration)
          throw new Error("Expected direct-entry materialisation migration");
        await Promise.all(
          forwardMigrations
            .filter(
              ({ name }) =>
                name !== participantFenceMigration.name &&
                name !== unseededScheduleMigration.name &&
                name !== unseededScheduleGraphShapeMigration.name &&
                name !== materialisedDirectEntrySourcesMigration.name,
            )
            .map(({ migrationPath, source }) => writeFile(migrationPath, source)),
        );
        const upgradedBeforeParticipantFence = await migrateDatabase({
          databaseUrl: config.databaseUrl,
          migrationsDirectory: copiedDirectory,
          schema: populatedSchema,
        });
        expect(upgradedBeforeParticipantFence.applied).toEqual(
          forwardMigrationNames.filter(
            (name) =>
              name !== participantFenceMigration.name &&
              name !== unseededScheduleMigration.name &&
              name !== unseededScheduleGraphShapeMigration.name &&
              name !== materialisedDirectEntrySourcesMigration.name,
          ),
        );
        await sql`UPDATE scheduled_matches
          SET home_entry_id=${siblingEntry}
          WHERE schedule_revision_id=${scheduleRevision} AND match_id=${match}`;
        await writeFile(participantFenceMigration.migrationPath, participantFenceMigration.source);
        await expect(
          migrateDatabase({
            databaseUrl: config.databaseUrl,
            migrationsDirectory: copiedDirectory,
            schema: populatedSchema,
          }),
        ).rejects.toThrow(/participant snapshots must belong to the authoritative match division and competition/i);
        await sql`UPDATE scheduled_matches
          SET home_entry_id=${placeholder}
          WHERE schedule_revision_id=${scheduleRevision} AND match_id=${match}`;
        const upgraded = await migrateDatabase({
          databaseUrl: config.databaseUrl,
          migrationsDirectory: copiedDirectory,
          schema: populatedSchema,
        });
        expect(upgraded.applied).toEqual(["0031_gate_c_participant_snapshot_fencing.sql"]);
        await writeFile(unseededScheduleMigration.migrationPath, unseededScheduleMigration.source);
        expect(
          await migrateDatabase({
            databaseUrl: config.databaseUrl,
            migrationsDirectory: copiedDirectory,
            schema: populatedSchema,
          }),
        ).toMatchObject({ applied: ["0032_v1_unseeded_schedule_source_mapping.sql"] });
        await writeFile(unseededScheduleGraphShapeMigration.migrationPath, unseededScheduleGraphShapeMigration.source);
        expect(
          await migrateDatabase({
            databaseUrl: config.databaseUrl,
            migrationsDirectory: copiedDirectory,
            schema: populatedSchema,
          }),
        ).toMatchObject({ applied: ["0033_v1_unseeded_schedule_graph_shape_fix.sql"] });
        await writeFile(
          materialisedDirectEntrySourcesMigration.migrationPath,
          materialisedDirectEntrySourcesMigration.source,
        );
        expect(
          await migrateDatabase({
            databaseUrl: config.databaseUrl,
            migrationsDirectory: copiedDirectory,
            schema: populatedSchema,
          }),
        ).toMatchObject({ applied: ["0034_v1_materialize_direct_entry_sources.sql"] });
        const [afterUpgrade] = await sql<
          { confirmed_count: number; placeholder_count: number; entry_ids: string[] }[]
        >`SELECT
            (steps#>>'{entries,divisions,0,confirmed_count}')::int confirmed_count,
            (steps#>>'{entries,divisions,0,placeholder_count}')::int placeholder_count,
            steps#>'{entries,divisions,0,entry_ids}' entry_ids
          FROM setup_drafts WHERE competition_id=${competition}`;
        expect(afterUpgrade).toMatchObject({ confirmed_count: 0, placeholder_count: 2 });
        expect(afterUpgrade?.entry_ids.toSorted()).toEqual([placeholder, secondPlaceholder].toSorted());
        expect(
          await sql`
            SELECT division_id,home_entry_id,away_entry_id
            FROM scheduled_matches
            WHERE schedule_revision_id=${scheduleRevision} AND match_id=${match}
          `,
        ).toEqual([
          {
            division_id: division,
            home_entry_id: placeholder,
            away_entry_id: secondPlaceholder,
          },
        ]);
        expect(await sql`SELECT 1 FROM phase4_format_recommendation_sets`).toEqual([]);
        expect(
          await sql`
            SELECT competition_id,mode,generation,octet_length(device_id_hash) device_hash_bytes
            FROM scoring_access_sessions WHERE id=${accessSession}
          `,
        ).toEqual([{ competition_id: competition, mode: "writer", generation: 7, device_hash_bytes: 32 }]);
        expect(
          await sql`
            SELECT sport_code,pack_version,current_version,
              settings_snapshot->>'allowUnknownScorer' allow_unknown_scorer
            FROM match_score_streams WHERE match_id=${match}
          `,
        ).toEqual([
          {
            sport_code: "canoe_polo",
            pack_version: "upgrade-1",
            current_version: 4,
            allow_unknown_scorer: "true",
          },
        ]);
        expect(
          await sql`
            SELECT event_type,aggregate_version,reversal_target_event_id,legacy_score_event_id
            FROM canonical_score_events WHERE match_id=${match} ORDER BY aggregate_version
          `,
        ).toMatchObject([
          { event_type: "match_started", aggregate_version: 1 },
          { event_type: "goal", aggregate_version: 2 },
          { event_type: "reversal", aggregate_version: 3 },
          { event_type: "legacy_correction", aggregate_version: 4 },
        ]);
        expect(
          await sql<{ indexname: string }[]>`
            SELECT index_class.relname AS indexname
            FROM pg_class index_class
            JOIN pg_namespace namespace ON namespace.oid=index_class.relnamespace
            JOIN pg_index index_metadata ON index_metadata.indexrelid=index_class.oid
            WHERE namespace.nspname=current_schema()
              AND index_class.relname='canonical_score_events_one_reversal_per_target_idx'
              AND index_metadata.indisunique
          `,
        ).toEqual([{ indexname: "canonical_score_events_one_reversal_per_target_idx" }]);
        expect(
          await sql<{ conname: string }[]>`
            SELECT conname
            FROM pg_constraint
            WHERE conrelid='canonical_score_events'::regclass
              AND conname='canonical_score_events_writer_generation_fkey'
          `,
        ).toEqual([{ conname: "canonical_score_events_writer_generation_fkey" }]);

        await sql`INSERT INTO match_writer_leases(
          competition_id,match_id,access_session_id,generation,acquired_at,expires_at
        ) VALUES(
          ${competition},${match},${accessSession},7,clock_timestamp(),clock_timestamp()+interval '5 minutes'
        )`;
        await expect(
          sql`INSERT INTO canonical_score_events(
            id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
          ) VALUES(
            ${randomUUID()},${competition},${division},${match},${randomUUID()},5,5,'incident',
            '{}'::jsonb,${"b".repeat(64)},${accessSession},8,now()
          )`,
        ).rejects.toThrow(/active writer lease/i);

        await expect(
          sql`INSERT INTO canonical_score_events(
            id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
          ) VALUES(
            ${randomUUID()},${competition},${division},${match},${randomUUID()},5,5,'incident',
            '{}'::jsonb,${"c".repeat(64)},${accessSession},7,now()
          )`,
        ).resolves.toHaveLength(0);

        await sql`UPDATE match_writer_leases
          SET acquired_at=clock_timestamp()-interval '2 minutes',
              expires_at=clock_timestamp()-interval '1 minute'
          WHERE match_id=${match}`;
        await expect(
          sql`INSERT INTO canonical_score_events(
            id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
          ) VALUES(
            ${randomUUID()},${competition},${division},${match},${randomUUID()},6,6,'incident',
            '{}'::jsonb,${"d".repeat(64)},${accessSession},7,now()
          )`,
        ).rejects.toThrow(/active writer lease/i);
        await sql`UPDATE match_writer_leases
          SET acquired_at=clock_timestamp(),expires_at=clock_timestamp()+interval '5 minutes'
          WHERE match_id=${match}`;

        await sql`UPDATE scoring_access_sessions
          SET issued_at=clock_timestamp()-interval '2 minutes',
              expires_at=clock_timestamp()-interval '1 minute',
              last_heartbeat_at=clock_timestamp()-interval '2 minutes'
          WHERE id=${accessSession}`;
        await expect(
          sql`INSERT INTO canonical_score_events(
            id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
          ) VALUES(
            ${randomUUID()},${competition},${division},${match},${randomUUID()},6,6,'incident',
            '{}'::jsonb,${"e".repeat(64)},${accessSession},7,now()
          )`,
        ).rejects.toThrow(/active writer scoring session/i);
        await sql`UPDATE scoring_access_sessions
          SET issued_at=clock_timestamp(),
              expires_at=clock_timestamp()+interval '1 hour',
              last_heartbeat_at=clock_timestamp()
          WHERE id=${accessSession}`;

        await sql`UPDATE scoring_access_sessions SET revoked_at=clock_timestamp() WHERE id=${accessSession}`;
        await expect(
          sql`INSERT INTO canonical_score_events(
            id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
          ) VALUES(
            ${randomUUID()},${competition},${division},${match},${randomUUID()},6,6,'incident',
            '{}'::jsonb,${"f".repeat(64)},${accessSession},7,now()
          )`,
        ).rejects.toThrow(/active writer scoring session/i);
        await sql`UPDATE scoring_access_sessions SET revoked_at=NULL WHERE id=${accessSession}`;

        await sql`UPDATE scoring_access_passes SET revoked_at=clock_timestamp() WHERE id=${accessPass}`;
        await expect(
          sql`INSERT INTO canonical_score_events(
            id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
          ) VALUES(
            ${randomUUID()},${competition},${division},${match},${randomUUID()},6,6,'incident',
            '{}'::jsonb,${"a".repeat(64)},${accessSession},7,now()
          )`,
        ).rejects.toThrow(/active writer scoring session/i);
        await sql`UPDATE scoring_access_passes SET revoked_at=NULL WHERE id=${accessPass}`;

        await sql`DELETE FROM match_writer_leases WHERE match_id=${match}`;
        await sql`UPDATE scoring_access_sessions SET mode='transferred' WHERE id=${accessSession}`;
        await expect(sql`UPDATE scoring_access_sessions SET generation=8 WHERE id=${accessSession}`).rejects.toThrow(
          /canonical_score_events_writer_generation_fkey|foreign key/i,
        );

        await expect(
          sql`INSERT INTO canonical_score_events(
            id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_account_id,device_timestamp
          ) VALUES(
            ${randomUUID()},${competition},${division},${match},${randomUUID()},6,6,'incident',
            '{}'::jsonb,${"0".repeat(64)},${account},now()
          )`,
        ).resolves.toHaveLength(0);

        const [canonicalGoal] = await sql<{ id: string }[]>`
          SELECT id FROM canonical_score_events
          WHERE match_id=${match} AND event_type='goal'
        `;
        await sql`ALTER TABLE canonical_score_events DISABLE TRIGGER canonical_score_events_reversal_guard`;
        try {
          await expect(
            sql`INSERT INTO canonical_score_events(
              id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
              command,command_fingerprint,actor_account_id,device_timestamp,reversal_target_event_id,reason
            ) VALUES(
              ${randomUUID()},${competition},${division},${match},${randomUUID()},7,7,'reversal',
              '{}'::jsonb,${"1".repeat(64)},${account},now(),${canonicalGoal!.id},'Duplicate reversal'
            )`,
          ).rejects.toThrow(/canonical_score_events_one_reversal_per_target_idx|duplicate key/i);
        } finally {
          await sql`ALTER TABLE canonical_score_events ENABLE TRIGGER canonical_score_events_reversal_guard`;
        }
        expect(
          await sql`SELECT home_score,away_score,state,through_sequence
            FROM match_result_snapshots WHERE match_id=${match}`,
        ).toEqual([{ home_score: 1, away_score: 0, state: "corrected", through_sequence: 4 }]);
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
            >`SELECT (phase4_schedule_expiry('2027-01-31T10:15:00Z'::timestamptz) AT TIME ZONE 'UTC')::text expiry`
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
