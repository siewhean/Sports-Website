import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const config = parseConfig(process.env);
const databaseUrl = config.databaseUrl;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const temporaryDirectories: string[] = [];
const temporarySchemas: string[] = [];

function sha256Digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function twoEntryDefinition(formatRevisionId: string, matchId: string): postgres.JSONValue {
  return {
    id: formatRevisionId,
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
        matchIds: [matchId],
      },
    ],
    matches: [
      {
        id: matchId,
        stageId: "final-stage",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: [matchId],
  };
}

function threeEntryEliminationDefinition(
  formatRevisionId: string,
  matchId: string,
  downstreamMatchId: string,
): postgres.JSONValue {
  return {
    id: formatRevisionId,
    schemaVersion: 1,
    entryCount: 3,
    stages: [
      {
        id: "knockout",
        label: "Knockout",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 3,
        matchIds: [matchId, downstreamMatchId],
      },
    ],
    matches: [
      {
        id: matchId,
        stageId: "knockout",
        round: 1,
        order: 1,
        purpose: "progression",
        home: { type: "entry_seed", seed: 2 },
        away: { type: "entry_seed", seed: 3 },
      },
      {
        id: downstreamMatchId,
        stageId: "knockout",
        round: 2,
        order: 2,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "winner", matchId },
      },
    ],
    terminalMatchIds: [downstreamMatchId],
  };
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

async function createIsolatedSchema(prefix: string): Promise<string> {
  const schema = `test_matrix_${prefix}_${randomUUID().replaceAll("-", "")}`;
  temporarySchemas.push(schema);
  await dropTestSchema(databaseUrl, schema);
  return schema;
}

async function copyMigrationsThrough(lastMigration: string): Promise<{ directory: string; allMigrations: string[] }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-matrix-"));
  temporaryDirectories.push(directory);
  await cp(migrationsDirectory, directory, { recursive: true });
  const allMigrations = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  await Promise.all(allMigrations.filter((name) => name > lastMigration).map((name) => rm(path.join(directory, name))));
  return { directory, allMigrations };
}

async function copyMigrationFiles(targetDirectory: string, migrationNames: string[]): Promise<void> {
  await Promise.all(
    migrationNames.map(async (name) => {
      const source = path.join(migrationsDirectory, name);
      const target = path.join(targetDirectory, name);
      await cp(source, target);
    }),
  );
}

async function expectColumnAbsent(sql: Sql, schema: string, tableName: string, columnName: string): Promise<void> {
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema=${schema} AND table_name=${tableName} AND column_name=${columnName}
  `;
  expect(columns).toEqual([]);
}

afterEach(async () => {
  await Promise.all(temporarySchemas.splice(0).map((schema) => dropTestSchema(databaseUrl, schema)));
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describeInfrastructure("Temporal Database Migration Matrix (R3)", () => {
  // ---------------------------------------------------------------------------
  // Scenario 1: Empty DB
  // ---------------------------------------------------------------------------
  it("Scenario 1: Empty DB - applies all 56 migrations idempotently from clean state", async () => {
    const schema = await createIsolatedSchema("s1_empty");
    const allExpectedMigrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
      .sort();
    expect(allExpectedMigrations).toHaveLength(59);

    // 1st run: all 59 migrations apply
    const firstRun = await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    expect(firstRun.applied).toEqual(allExpectedMigrations);
    expect(firstRun.current).toEqual(allExpectedMigrations);

    // 2nd run: 0 applied, state unchanged (idempotency)
    const secondRun = await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.current).toEqual(allExpectedMigrations);

    const sql = postgres(databaseUrl, { max: 1, connection: { search_path: schema } });
    try {
      // Verify pgcrypto extension
      const [extension] = await sql<{ namespace: string }[]>`
        SELECT namespace.nspname AS namespace
        FROM pg_extension extension
        JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
        WHERE extension.extname='pgcrypto'
      `;
      expect(extension).toEqual({ namespace: "public" });

      // Verify schema_migrations table has all 59 migrations with valid SHA256 checksums
      const recordedMigrations = await sql<{ name: string; checksum: string }[]>`
        SELECT name, checksum FROM schema_migrations ORDER BY name
      `;
      expect(recordedMigrations).toHaveLength(59);
      expect(recordedMigrations.map((r) => r.name)).toEqual(allExpectedMigrations);
      expect(recordedMigrations.every((r) => /^[0-9a-f]{64}$/u.test(r.checksum))).toBe(true);

      // Verify core Gate C relations and functions are present
      const relations = await sql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
      `;
      const tableNames = new Set(relations.map((r) => r.tablename));
      expect(tableNames.has("canonical_score_events")).toBe(true);
      expect(tableNames.has("scoring_access_passes")).toBe(true);
      expect(tableNames.has("scoring_access_sessions")).toBe(true);
      expect(tableNames.has("match_writer_leases")).toBe(true);
      expect(tableNames.has("identity_session_assurance")).toBe(true);
      expect(tableNames.has("scoring_offline_authorizations")).toBe(true);
      expect(tableNames.has("schedule_repair_cases")).toBe(true);
      expect(tableNames.has("result_repair_cases")).toBe(true);
      expect(tableNames.has("public_projection_versions")).toBe(true);
      expect(tableNames.has("scoring_access_hmac_key_versions")).toBe(true);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Scenario 2: Historical pre-C2 populated dataset (migrated to 0027 -> forward 0028..0052)
  // ---------------------------------------------------------------------------
  it("Scenario 2: Historical pre-C2 - upgrades populated 0027 dataset forward through 0028..0052", async () => {
    const schema = await createIsolatedSchema("s2_prec2");
    const { directory: copiedDir, allMigrations } = await copyMigrationsThrough(
      "0027_phase4_schedule_stage_dependencies.sql",
    );

    // Migrate up to 0027
    const initialMigrate = await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });
    expect(initialMigrate.applied).toHaveLength(27);

    const sql = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      connection: { search_path: schema },
    });

    const accountId = randomUUID();
    const organisationId = randomUUID();
    const competitionId = randomUUID();
    const divisionId = randomUUID();
    const siblingDivisionId = randomUUID();
    const homeEntryId = randomUUID();
    const awayEntryId = randomUUID();
    const siblingEntryId = randomUUID();
    const formatRevisionId = randomUUID();
    const matchId = randomUUID();
    const playingAreaId = randomUUID();
    const scheduleRevisionId = randomUUID();
    const accessPassId = randomUUID();
    const revokedPassId = randomUUID();
    const expiredPassId = randomUUID();
    const accessSessionId = randomUUID();
    const startedEventId = randomUUID();
    const goalEventId = randomUUID();
    const reversalEventId = randomUUID();
    const correctionEventId = randomUUID();
    const outboxKey = `s2-outbox-${randomUUID()}`;
    const auditRequestId = `s2-audit-${randomUUID()}`;

    try {
      // Populate full Phase 4 world
      await sql`INSERT INTO accounts(id,primary_email,display_name)
        VALUES(${accountId},${`${accountId}@example.test`},'Scenario 2 Owner')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations(id,name,slug)
          VALUES(${organisationId},'Scenario 2 Org',${`s2-org-${organisationId}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
      });

      const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
      await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
        VALUES('canoe_polo','s2-pack-v1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;

      await sql`INSERT INTO competitions(
          id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
          venue,address,country_code,locale,plan_tier
        ) VALUES(
          ${competitionId},${organisationId},${accountId},'Scenario 2 Cup',${`s2-cup-${competitionId}`},
          'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','Arena','1 Road','SG','en-SG','organiser_pro'
        )`;
      await sql`INSERT INTO competition_sport_settings(
          competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
        ) VALUES(
          ${competitionId},${accountId},'canoe_polo','s2-pack-v1',1,'{}'::jsonb,'{}'::jsonb
        )`;

      await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
        VALUES
          (${divisionId},${competitionId},'Open',16),
          (${siblingDivisionId},${competitionId},'Masters',16)`;
      await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status)
        VALUES
          (${homeEntryId},${divisionId},'Team Home',1,'placeholder','confirmed'),
          (${awayEntryId},${divisionId},'Team Away',2,'placeholder','confirmed'),
          (${siblingEntryId},${siblingDivisionId},'Sibling Entry',1,'placeholder','confirmed')`;

      const definition = twoEntryDefinition(formatRevisionId, matchId);
      const [definitionHash] = await sql<{ hash: string }[]>`
        SELECT phase4_sha256_json(${sql.json(definition)}) AS hash
      `;
      await sql`INSERT INTO format_revisions(
          id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract
        ) VALUES(
          ${formatRevisionId},${competitionId},${divisionId},1,${sql.json(definition)},${definitionHash!.hash},${accountId},'phase3'
        )`;
      await sql`INSERT INTO matches(
          id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id
        ) VALUES(
          ${matchId},${competitionId},${divisionId},${formatRevisionId},'S2-FINAL','final',1,1,${homeEntryId},${awayEntryId}
        )`;

      await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
        VALUES(${playingAreaId},${competitionId},'Main Pitch',30)`;
      await sql`INSERT INTO schedule_revisions(
          id,competition_id,format_revision_id,revision,input_hash,created_by
        ) VALUES(
          ${scheduleRevisionId},${competitionId},${formatRevisionId},1,${sha256Digest(scheduleRevisionId)},${accountId}
        )`;
      await sql`INSERT INTO scheduled_matches(
          schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
        ) VALUES(
          ${scheduleRevisionId},${matchId},${competitionId},${playingAreaId},'2027-01-01T08:00:00Z','2027-01-01T08:30:00Z'
        )`;

      // Pre-C2 scoring passes (legacy schema before 0028/0030)
      const legacyCode = "123456789012";
      await sql`INSERT INTO scoring_access_passes(
          id,match_id,secret_hash,short_code_hash,expires_at,created_at,revoked_at,created_by
        ) VALUES
        (${accessPassId},${matchId},${Buffer.alloc(32, 1)},${createHash("sha256").update(legacyCode).digest()},'2100-01-01T12:00:00Z',now(),NULL,${accountId}),
        (${revokedPassId},${matchId},${Buffer.alloc(32, 2)},${createHash("sha256").update("223456789012").digest()},'2100-01-01T12:00:00Z',now(),now(),${accountId}),
        (${expiredPassId},${matchId},${Buffer.alloc(32, 3)},${createHash("sha256").update("323456789012").digest()},'2000-01-01T12:00:00Z','1999-01-01T12:00:00Z',NULL,${accountId})`;

      await sql`INSERT INTO scoring_access_sessions(
          id,access_pass_id,match_id,session_token_hash,generation,issued_at,expires_at
        ) VALUES(
          ${accessSessionId},${accessPassId},${matchId},${Buffer.alloc(32, 4)},7,'2027-01-01T08:00:00Z','2027-01-01T09:00:00Z'
        )`;
      await sql`INSERT INTO division_sport_settings(
          division_id,competition_id,sport_code,pack_version,settings_override,updated_by
        ) VALUES(${divisionId},${competitionId},'canoe_polo','s2-pack-v1','{"allowUnknownScorer":true}'::jsonb,${accountId})`;

      // Legacy score_events table (prior to 0029 canonical transformation)
      await sql`INSERT INTO score_events(
          match_id,client_event_id,sequence,writer_generation,event_type,team_slot,scorer,
          manual_period,manual_event_seconds,payload,actor_access_session_id,actor_account_id,
          correction_reason,occurred_at
        ) VALUES
        (${matchId},${startedEventId},1,7,'match_started',NULL,NULL,1,0,'{}'::jsonb,${accessSessionId},NULL,NULL,now()),
        (${matchId},${goalEventId},2,7,'goal_added','home','Player 1',1,20,'{}'::jsonb,${accessSessionId},NULL,NULL,now()),
        (${matchId},${reversalEventId},3,7,'goal_reversed',NULL,NULL,1,25,${sql.json({ reversal_target_event_id: goalEventId })},${accessSessionId},NULL,'Correction',now()),
        (${matchId},${correctionEventId},4,1,'correction',NULL,NULL,NULL,NULL,'{"home_score":1,"away_score":0}'::jsonb,NULL,${accountId},'Admin correction',now())`;

      await sql`INSERT INTO match_result_snapshots(
          match_id,result_version,through_sequence,home_score,away_score,state,snapshot
        ) VALUES(${matchId},1,4,1,0,'corrected','{"homeScore":1,"awayScore":0}'::jsonb)`;

      // Outbox and audit events to verify byte retention
      const outboxPayload = JSON.stringify({ competition_id: competitionId, match_id: matchId });
      await sql`INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
        VALUES('match',${matchId},'scoring_event.appended',to_jsonb(${outboxPayload}::text),${outboxKey})`;
      await sql`INSERT INTO audit_events(
          request_id,actor_type,organisation_id,action,target_type,target_id,before_state,after_state
        ) VALUES(
          ${auditRequestId},'system',${organisationId},'scoring_event.appended','match',${matchId},
          to_jsonb(${"before-state"}::text),to_jsonb(${"after-state"}::text)
        )`;

      const [preAudit] = await sql<{ payload: string; before_state: string; after_state: string }[]>`
        SELECT outbox.payload::text payload, audit.before_state::text before_state, audit.after_state::text after_state
        FROM outbox_events outbox JOIN audit_events audit ON audit.request_id=${auditRequestId}
        WHERE outbox.idempotency_key=${outboxKey}
      `;
      expect(preAudit).toBeTruthy();

      // Now copy forward migrations 0028..0052 into directory
      const forwardMigrationNames = allMigrations.filter((name) => name >= "0028_gate_c_access_foundation.sql");
      await copyMigrationFiles(copiedDir, forwardMigrationNames);

      // Run forward migrations to HEAD (0052)
      const forwardMigrate = await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });
      expect(forwardMigrate.applied).toEqual(forwardMigrationNames);
      expect(forwardMigrate.current).toEqual(allMigrations);

      // Assertions on upgraded database state:
      // 1. scheduled_matches now has division_id, home_entry_id, away_entry_id
      const [scheduledMatch] = await sql<{ division_id: string; home_entry_id: string; away_entry_id: string }[]>`
        SELECT division_id, home_entry_id, away_entry_id FROM scheduled_matches
        WHERE schedule_revision_id=${scheduleRevisionId} AND match_id=${matchId}
      `;
      expect(scheduledMatch).toEqual({
        division_id: divisionId,
        home_entry_id: homeEntryId,
        away_entry_id: awayEntryId,
      });

      // 2. Canonical score events populated
      const canonicalEvents = await sql<{ event_type: string; aggregate_version: number }[]>`
        SELECT event_type, aggregate_version FROM canonical_score_events
        WHERE match_id=${matchId} ORDER BY aggregate_version
      `;
      expect(canonicalEvents).toEqual([
        { event_type: "match_started", aggregate_version: 1 },
        { event_type: "goal", aggregate_version: 2 },
        { event_type: "reversal", aggregate_version: 3 },
        { event_type: "legacy_correction", aggregate_version: 4 },
      ]);

      // 3. Fallback code status on scoring passes
      const [activePass] = await sql<{ fallback_code_hash_version: string }[]>`
        SELECT fallback_code_hash_version FROM scoring_access_passes WHERE id=${accessPassId}
      `;
      expect(activePass?.fallback_code_hash_version).toBe("rotation_required");

      // 4. Audit & outbox byte-for-byte SHA256 integrity
      const [postAudit] = await sql<{ payload: string; before_state: string; after_state: string }[]>`
        SELECT outbox.payload::text payload, audit.before_state::text before_state, audit.after_state::text after_state
        FROM outbox_events outbox JOIN audit_events audit ON audit.request_id=${auditRequestId}
        WHERE outbox.idempotency_key=${outboxKey}
      `;
      expect(postAudit).toEqual(preAudit);
      expect(sha256Digest(JSON.stringify(postAudit))).toBe(sha256Digest(JSON.stringify(preAudit)));
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 45_000);

  // ---------------------------------------------------------------------------
  // Scenario 3: Current-main DB (0032–0035 with unseeded entries & identity assurance)
  // ---------------------------------------------------------------------------
  it("Scenario 3: Current-main DB - upgrades populated 0035 state forward through 0036..0052", async () => {
    const schema = await createIsolatedSchema("s3_currentmain");
    const { directory: copiedDir, allMigrations } = await copyMigrationsThrough(
      "0035_identity_authentication_assurance.sql",
    );

    // Migrate up to 0035
    const initialMigrate = await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });
    expect(initialMigrate.applied).toHaveLength(35);

    const sql = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      connection: { search_path: schema },
    });

    const accountId = randomUUID();
    const organisationId = randomUUID();
    const competitionId = randomUUID();
    const divisionId = randomUUID();
    const formatRevisionId = randomUUID();
    const semi1Id = randomUUID();
    const semi2Id = randomUUID();
    const finalId = randomUUID();
    const session1Id = randomUUID();
    const session2Id = randomUUID();
    const session3Id = randomUUID();

    try {
      // 1. Seed accounts, orgs, competitions
      await sql`INSERT INTO accounts(id,primary_email,display_name)
        VALUES(${accountId},${`${accountId}@example.test`},'Scenario 3 Main Owner')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations(id,name,slug)
          VALUES(${organisationId},'Scenario 3 Org',${`s3-org-${organisationId}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
      });

      const pack = { recommendedSlotMinutes: 20, recommendedSettings: { slotMinutes: 20 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
      await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
        VALUES('badminton','s3-pack-v1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;

      await sql`INSERT INTO competitions(
          id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
          venue,address,country_code,locale,plan_tier
        ) VALUES(
          ${competitionId},${organisationId},${accountId},'Scenario 3 Cup',${`s3-cup-${competitionId}`},
          'badminton','Asia/Singapore','2027-02-01','2027-02-01','Main Hall','1 Ave','SG','en-SG','organiser_pro'
        )`;
      await sql`INSERT INTO competition_sport_settings(
          competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
        ) VALUES(
          ${competitionId},${accountId},'badminton','s3-pack-v1',1,'{}'::jsonb,'{}'::jsonb
        )`;

      // 2. Unseeded division entries and V1 unseeded format revision definition (0032–0034 behavior)
      await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
        VALUES(${divisionId},${competitionId},'Open Singles',16)`;
      const entry1 = randomUUID();
      const entry2 = randomUUID();
      const unseeded3 = randomUUID();
      const unseeded4 = randomUUID();
      await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
        (${entry1},${divisionId},'Seeded 1',1,'team','confirmed'),
        (${entry2},${divisionId},'Seeded 2',2,'team','confirmed'),
        (${unseeded3},${divisionId},'Unseeded 3',NULL,'team','confirmed'),
        (${unseeded4},${divisionId},'Unseeded 4',NULL,'team','confirmed')`;

      const definition = fourEntryEliminationDefinition(formatRevisionId, semi1Id, semi2Id, finalId);
      const [definitionHash] = await sql<{ hash: string }[]>`
        SELECT phase4_sha256_json(${sql.json(definition)}) AS hash
      `;
      await sql`INSERT INTO format_revisions(
          id,competition_id,division_id,revision,definition,definition_hash,status,created_by,validation_contract
        ) VALUES(
          ${formatRevisionId},${competitionId},${divisionId},1,${sql.json(definition)},${definitionHash!.hash},'draft',${accountId},'phase3'
        )`;

      // Materialize direct entry sources via 0034 function
      const [materializedCount] = await sql<{ phase4_materialize_format_revision: number }[]>`
        SELECT phase4_materialize_format_revision(${formatRevisionId})
      `;
      expect(materializedCount?.phase4_materialize_format_revision).toBe(3);

      // Verify unseeded slots were assigned correctly to round 1 matches
      const matches = await sql<{ id: string; home_entry_id: string; away_entry_id: string }[]>`
        SELECT id, home_entry_id, away_entry_id FROM matches WHERE format_revision_id=${formatRevisionId} ORDER BY ordinal
      `;
      expect(matches).toHaveLength(3);
      expect(matches[0]?.home_entry_id).toBe(entry1);
      expect(matches[0]?.away_entry_id).toBeTruthy(); // Assigned unseeded entry
      expect(matches[1]?.home_entry_id).toBe(entry2);
      expect(matches[1]?.away_entry_id).toBeTruthy();

      // 3. Seed identity_session_assurance records (0035 schema)
      await sql`INSERT INTO identity_sessions(id,account_id,secret_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES
        (${session1Id},${accountId},${sha256Digest(session1Id)},now(),now(),now()+interval '1 hour',now()+interval '1 day'),
        (${session2Id},${accountId},${sha256Digest(session2Id)},now(),now(),now()+interval '1 hour',now()+interval '1 day'),
        (${session3Id},${accountId},${sha256Digest(session3Id)},now(),now(),now()+interval '1 hour',now()+interval '1 day')`;

      await sql`INSERT INTO identity_session_assurance(
          session_id,assurance_level,authentication_methods,mfa_performed,phishing_resistant
        ) VALUES
        (${session1Id},'single_factor','{}'::text[],false,false),
        (${session2Id},'multi_factor',ARRAY['mfa'],true,false),
        (${session3Id},'phishing_resistant',ARRAY['mfa','webauthn'],true,true)`;

      const assuranceRows = await sql<{ session_id: string; assurance_level: string }[]>`
        SELECT session_id, assurance_level FROM identity_session_assurance ORDER BY assurance_level
      `;
      expect(assuranceRows).toHaveLength(3);

      // 4. Now copy and apply forward Gate C and Phase 6 migrations 0036..0059
      const forwardGateCMigrations = allMigrations.filter((name) => name >= "0036_gate_c_offline_replay.sql");
      expect(forwardGateCMigrations).toHaveLength(24);
      await copyMigrationFiles(copiedDir, forwardGateCMigrations);

      const upgradeResult = await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });
      expect(upgradeResult.applied).toEqual(forwardGateCMigrations);
      expect(upgradeResult.current).toEqual(allMigrations);

      // 5. Verify integrity of pre-existing state after forward upgrade
      const postAssurance = await sql<{ session_id: string; assurance_level: string }[]>`
        SELECT session_id, assurance_level FROM identity_session_assurance ORDER BY assurance_level
      `;
      expect(postAssurance).toEqual(assuranceRows);

      const postMatches = await sql<{ id: string; home_entry_id: string; away_entry_id: string }[]>`
        SELECT id, home_entry_id, away_entry_id FROM matches WHERE format_revision_id=${formatRevisionId} ORDER BY ordinal
      `;
      expect(postMatches).toEqual(matches);

      // 6. Verify Gate C forward structures are ready to accept records
      expect(
        await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema=current_schema() AND table_name='scoring_offline_authorizations'
        `,
      ).toEqual([{ table_name: "scoring_offline_authorizations" }]);
      expect(
        await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema=current_schema() AND table_name='result_repair_cases'
        `,
      ).toEqual([{ table_name: "result_repair_cases" }]);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 45_000);

  // ---------------------------------------------------------------------------
  // Scenario 4: Malformed pre-0030 (atomic failure)
  // ---------------------------------------------------------------------------
  it("Scenario 4: Malformed pre-0030 - aborts with atomic rollback on invalid history", async () => {
    // Subscenario 4A: mismatched writer_generation
    {
      const schema = await createIsolatedSchema("s4a_malformed_writer");
      const { directory: copiedDir } = await copyMigrationsThrough("0029_gate_c_five_sport_scoring.sql");
      await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });

      const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
      try {
        const accountId = randomUUID();
        const organisationId = randomUUID();
        const competitionId = randomUUID();
        const divisionId = randomUUID();
        const matchId = randomUUID();
        const formatRevisionId = randomUUID();
        const passId = randomUUID();
        const sessionId = randomUUID();
        const entry1Id = randomUUID();
        const entry2Id = randomUUID();

        await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${accountId},${`${accountId}@example.test`},'S4 Owner')`;
        await sql.begin(async (tx) => {
          await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'S4 Org',${`s4-${organisationId}`})`;
          await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
            VALUES(${organisationId},${accountId},'owner','active')`;
        });

        const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
        const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
        await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
          VALUES('canoe_polo','s4-pack-v1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;

        await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
          VALUES(${competitionId},${organisationId},${accountId},'S4 Cup',${`s4-${competitionId}`},'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','organiser_pro')`;
        await sql`INSERT INTO competition_sport_settings(competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override)
          VALUES(${competitionId},${accountId},'canoe_polo','s4-pack-v1',1,'{}'::jsonb,'{}'::jsonb)`;

        await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',16)`;
        await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
          (${entry1Id},${divisionId},'Team 1',1,'placeholder','confirmed'),
          (${entry2Id},${divisionId},'Team 2',2,'placeholder','confirmed')`;

        const def = twoEntryDefinition(formatRevisionId, matchId);
        const [defHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(def)}) AS hash`;
        await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
          VALUES(${formatRevisionId},${competitionId},${divisionId},1,${sql.json(def)},${defHash!.hash},${accountId},'phase3')`;

        await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id) VALUES
          (${matchId},${competitionId},${divisionId},${formatRevisionId},'M1','final',1,1,${entry1Id},${entry2Id})`;

        await sql`INSERT INTO match_score_streams(
            match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint,current_version
          ) VALUES(
            ${matchId},${competitionId},${divisionId},'canoe_polo','s4-pack-v1','{}'::jsonb,${"a".repeat(64)},0
          )`;

        await sql`INSERT INTO scoring_access_passes(id,competition_id,match_id,secret_hash,short_code_hash,fallback_code_hash_version,expires_at,created_by)
          VALUES(${passId},${competitionId},${matchId},${randomBytes(32)},${randomBytes(32)},'hmac_sha256_v1','2100-01-01T12:00:00Z',${accountId})`;
        await sql`INSERT INTO scoring_access_sessions(id,access_pass_id,competition_id,match_id,session_token_hash,generation,device_id_hash,issued_at,expires_at)
          VALUES(${sessionId},${passId},${competitionId},${matchId},${randomBytes(32)},7,${randomBytes(32)},'2027-01-01T08:00:00Z','2100-01-01T09:00:00Z')`;

        // Inject mismatched writer_generation (event has generation 8 vs session generation 7)
        await sql`INSERT INTO canonical_score_events(
            competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
            command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
          ) VALUES(
            ${competitionId},${divisionId},${matchId},${randomUUID()},1,1,'goal',
            '{"type":"goal"}'::jsonb,${"b".repeat(64)},${sessionId},8,'2027-01-01T08:01:00Z'
          )`;

        await copyMigrationFiles(copiedDir, ["0030_gate_c_published_schedule_participants.sql"]);
        await expect(migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema })).rejects.toThrow(
          /writer generations that do not match their scoring sessions/i,
        );

        // Atomic rollback assertion: home_entry_id column must NOT exist and 0030 is NOT in schema_migrations
        await expectColumnAbsent(sql, schema, "scheduled_matches", "home_entry_id");
        const [applied0030] = await sql<{ count: string }[]>`
          SELECT count(*)::text count FROM schema_migrations WHERE name='0030_gate_c_published_schedule_participants.sql'
        `;
        expect(applied0030?.count).toBe("0");
      } finally {
        await sql.end({ timeout: 2 });
      }
    }

    // Subscenario 4B: invalid result_conflicts receipt
    {
      const schema = await createIsolatedSchema("s4b_malformed_conflict");
      const { directory: copiedDir } = await copyMigrationsThrough("0029_gate_c_five_sport_scoring.sql");
      await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });

      const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
      try {
        const accountId = randomUUID();
        const organisationId = randomUUID();
        const competitionId = randomUUID();
        const divisionId = randomUUID();
        const matchId = randomUUID();
        const downstreamMatchId = randomUUID();
        const formatRevisionId = randomUUID();
        const entry1Id = randomUUID();
        const entry2Id = randomUUID();
        const entry3Id = randomUUID();

        await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${accountId},${`${accountId}@example.test`},'S4B Owner')`;
        await sql.begin(async (tx) => {
          await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'S4B Org',${`s4b-${organisationId}`})`;
          await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
            VALUES(${organisationId},${accountId},'owner','active')`;
        });
        await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
          VALUES(${competitionId},${organisationId},${accountId},'S4B Cup',${`s4b-${competitionId}`},'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','organiser_pro')`;
        await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',16)`;
        await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
          (${entry1Id},${divisionId},'Team 1',1,'placeholder','confirmed'),
          (${entry2Id},${divisionId},'Team 2',2,'placeholder','confirmed'),
          (${entry3Id},${divisionId},'Team 3',3,'placeholder','confirmed')`;

        const def = threeEntryEliminationDefinition(formatRevisionId, matchId, downstreamMatchId);
        const [defHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(def)}) AS hash`;
        await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
          VALUES(${formatRevisionId},${competitionId},${divisionId},1,${sql.json(def)},${defHash!.hash},${accountId},'phase3')`;

        await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id) VALUES
          (${matchId},${competitionId},${divisionId},${formatRevisionId},'M1','semifinal',1,1,${entry2Id},${entry3Id}),
          (${downstreamMatchId},${competitionId},${divisionId},${formatRevisionId},'M2','final',2,2,${entry1Id},NULL)`;

        // Inject invalid acknowledged result conflict with NULL reason
        await sql`INSERT INTO result_conflicts(
            competition_id,division_id,corrected_match_id,downstream_match_id,result_version,reason,status,
            acknowledged_at,acknowledged_by_account_id,acknowledgement_client_event_id,acknowledgement_fingerprint,
            acknowledgement_reason
          ) VALUES(
            ${competitionId},${divisionId},${matchId},${downstreamMatchId},1,
            'downstream_match_started','acknowledged','2027-01-01T08:10:00Z',${accountId},${randomUUID()},
            ${"c".repeat(64)},NULL
          )`;

        await copyMigrationFiles(copiedDir, ["0030_gate_c_published_schedule_participants.sql"]);
        await expect(migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema })).rejects.toThrow(
          /invalid lifecycle receipt/i,
        );

        // Atomic rollback assertion
        await expectColumnAbsent(sql, schema, "scheduled_matches", "home_entry_id");
        const [applied0030] = await sql<{ count: string }[]>`
          SELECT count(*)::text count FROM schema_migrations WHERE name='0030_gate_c_published_schedule_participants.sql'
        `;
        expect(applied0030?.count).toBe("0");
      } finally {
        await sql.end({ timeout: 2 });
      }
    }
  }, 35_000);

  // ---------------------------------------------------------------------------
  // Scenario 5: Malformed pre-0031 (atomic failure)
  // ---------------------------------------------------------------------------
  it("Scenario 5: Malformed pre-0031 - aborts with atomic rollback on sibling division participant", async () => {
    const schema = await createIsolatedSchema("s5_malformed_sibling");
    const { directory: copiedDir } = await copyMigrationsThrough("0030_gate_c_published_schedule_participants.sql");
    await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });

    const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
    try {
      const accountId = randomUUID();
      const organisationId = randomUUID();
      const competitionId = randomUUID();
      const divisionId = randomUUID();
      const siblingDivisionId = randomUUID();
      const matchId = randomUUID();
      const formatRevisionId = randomUUID();
      const scheduleRevisionId = randomUUID();
      const playingAreaId = randomUUID();
      const siblingEntryId = randomUUID();
      const entry1Id = randomUUID();
      const entry2Id = randomUUID();

      await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${accountId},${`${accountId}@example.test`},'S5 Owner')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'S5 Org',${`s5-${organisationId}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
      });
      await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
        VALUES(${competitionId},${organisationId},${accountId},'S5 Cup',${`s5-${competitionId}`},'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','organiser_pro')`;
      await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES
        (${divisionId},${competitionId},'Open',16),
        (${siblingDivisionId},${competitionId},'Sibling',16)`;
      await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
        (${entry1Id},${divisionId},'Open Entry 1',1,'placeholder','confirmed'),
        (${entry2Id},${divisionId},'Open Entry 2',2,'placeholder','confirmed'),
        (${siblingEntryId},${siblingDivisionId},'Sibling Entry',1,'placeholder','confirmed')`;

      const def = twoEntryDefinition(formatRevisionId, matchId);
      const [defHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(def)}) AS hash`;
      await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
        VALUES(${formatRevisionId},${competitionId},${divisionId},1,${sql.json(def)},${defHash!.hash},${accountId},'phase3')`;

      await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id)
        VALUES(${matchId},${competitionId},${divisionId},${formatRevisionId},'M1','final',1,1,${entry1Id},${entry2Id})`;

      await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes) VALUES(${playingAreaId},${competitionId},'Court 1',30)`;
      await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,created_by)
        VALUES(${scheduleRevisionId},${competitionId},${formatRevisionId},1,${sha256Digest(scheduleRevisionId)},${accountId})`;

      await sql`INSERT INTO scheduled_matches(
          schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at,home_entry_id,away_entry_id
        ) VALUES(
          ${scheduleRevisionId},${matchId},${competitionId},${playingAreaId},
          '2027-01-01T08:00:00Z','2027-01-01T08:30:00Z',${entry1Id},${entry2Id}
        )`;

      // Update scheduled_matches to point to sibling entry (belonging to different division)
      await sql`UPDATE scheduled_matches
        SET home_entry_id=${siblingEntryId}
        WHERE schedule_revision_id=${scheduleRevisionId} AND match_id=${matchId}`;

      await copyMigrationFiles(copiedDir, ["0031_gate_c_participant_snapshot_fencing.sql"]);
      await expect(migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema })).rejects.toThrow(
        /scheduled participant snapshots must belong to the authoritative match division and competition/i,
      );

      // Atomic rollback assertion: division_id column must NOT exist and 0031 is NOT in schema_migrations
      await expectColumnAbsent(sql, schema, "scheduled_matches", "division_id");
      const [applied0031] = await sql<{ count: string }[]>`
        SELECT count(*)::text count FROM schema_migrations WHERE name='0031_gate_c_participant_snapshot_fencing.sql'
      `;
      expect(applied0031?.count).toBe("0");
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Scenario 6: Repaired malformed DB -> clean upgrade to HEAD (0052)
  // ---------------------------------------------------------------------------
  it("Scenario 6: Repaired malformed DB - cleanly upgrades to HEAD (0052) after data remediation", async () => {
    const schema = await createIsolatedSchema("s6_repaired");
    const { directory: copiedDir, allMigrations } = await copyMigrationsThrough("0029_gate_c_five_sport_scoring.sql");
    await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });

    const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
    try {
      const accountId = randomUUID();
      const organisationId = randomUUID();
      const competitionId = randomUUID();
      const divisionId = randomUUID();
      const siblingDivisionId = randomUUID();
      const matchId = randomUUID();
      const downstreamMatchId = randomUUID();
      const formatRevisionId = randomUUID();
      const passId = randomUUID();
      const sessionId = randomUUID();
      const validEntryId = randomUUID();
      const validEntry2Id = randomUUID();
      const validEntry3Id = randomUUID();
      const siblingEntryId = randomUUID();
      const playingAreaId = randomUUID();
      const scheduleRevisionId = randomUUID();
      const canonicalEventId = randomUUID();

      await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${accountId},${`${accountId}@example.test`},'S6 Owner')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'S6 Org',${`s6-${organisationId}`})`;
        await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
      });

      const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
      await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
        VALUES('canoe_polo','s6-pack-v1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;

      await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,plan_tier)
        VALUES(${competitionId},${organisationId},${accountId},'S6 Cup',${`s6-${competitionId}`},'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','organiser_pro')`;
      await sql`INSERT INTO competition_sport_settings(competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override)
        VALUES(${competitionId},${accountId},'canoe_polo','s6-pack-v1',1,'{}'::jsonb,'{}'::jsonb)`;

      await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES
        (${divisionId},${competitionId},'Open',16),
        (${siblingDivisionId},${competitionId},'Sibling',16)`;
      await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
        (${validEntryId},${divisionId},'Valid Open Entry 1',1,'placeholder','confirmed'),
        (${validEntry2Id},${divisionId},'Valid Open Entry 2',2,'placeholder','confirmed'),
        (${validEntry3Id},${divisionId},'Valid Open Entry 3',3,'placeholder','confirmed'),
        (${siblingEntryId},${siblingDivisionId},'Sibling Entry',1,'placeholder','confirmed')`;

      const def = threeEntryEliminationDefinition(formatRevisionId, matchId, downstreamMatchId);
      const [defHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(def)}) AS hash`;
      await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
        VALUES(${formatRevisionId},${competitionId},${divisionId},1,${sql.json(def)},${defHash!.hash},${accountId},'phase3')`;

      await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id) VALUES
        (${matchId},${competitionId},${divisionId},${formatRevisionId},'M1','semifinal',1,1,${validEntry2Id},${validEntry3Id}),
        (${downstreamMatchId},${competitionId},${divisionId},${formatRevisionId},'M2','final',2,2,${validEntryId},NULL)`;

      await sql`INSERT INTO match_score_streams(
          match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint,current_version
        ) VALUES(
          ${matchId},${competitionId},${divisionId},'canoe_polo','s6-pack-v1','{}'::jsonb,${"a".repeat(64)},0
        )`;

      await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes) VALUES(${playingAreaId},${competitionId},'Court 1',30)`;
      await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,created_by)
        VALUES(${scheduleRevisionId},${competitionId},${formatRevisionId},1,${sha256Digest(scheduleRevisionId)},${accountId})`;

      await sql`INSERT INTO scoring_access_passes(id,competition_id,match_id,secret_hash,short_code_hash,fallback_code_hash_version,expires_at,created_by)
        VALUES(${passId},${competitionId},${matchId},${randomBytes(32)},${randomBytes(32)},'hmac_sha256_v1','2100-01-01T12:00:00Z',${accountId})`;
      await sql`INSERT INTO scoring_access_sessions(id,access_pass_id,competition_id,match_id,session_token_hash,generation,device_id_hash,issued_at,expires_at)
        VALUES(${sessionId},${passId},${competitionId},${matchId},${randomBytes(32)},7,${randomBytes(32)},'2027-01-01T08:00:00Z','2100-01-01T09:00:00Z')`;

      // 1. Initially inject malformed writer generation
      await sql`INSERT INTO canonical_score_events(
          id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
          command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
        ) VALUES(
          ${canonicalEventId},${competitionId},${divisionId},${matchId},${randomUUID()},1,1,'goal',
          '{"type":"goal"}'::jsonb,${"b".repeat(64)},${sessionId},8,'2027-01-01T08:01:00Z'
        )`;

      // 2. Initially inject malformed result_conflict
      await sql`INSERT INTO result_conflicts(
          competition_id,division_id,corrected_match_id,downstream_match_id,result_version,reason,status,
          acknowledged_at,acknowledged_by_account_id,acknowledgement_client_event_id,acknowledgement_fingerprint,
          acknowledgement_reason
        ) VALUES(
          ${competitionId},${divisionId},${matchId},${downstreamMatchId},1,
          'downstream_match_started','acknowledged','2027-01-01T08:10:00Z',${accountId},${randomUUID()},
          ${"c".repeat(64)},NULL
        )`;

      // 3. Initially inject scheduled_match with valid matches
      await sql`INSERT INTO scheduled_matches(
          schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
        ) VALUES(
          ${scheduleRevisionId},${matchId},${competitionId},${playingAreaId},
          '2027-01-01T08:00:00Z','2027-01-01T08:30:00Z'
        )`;

      // -------------------------------------------------------------
      // Execute Data Remediation (as per production runbook)
      // -------------------------------------------------------------
      // Remediation 1: align writer_generation with scoring session (operational runbook trigger-safe update)
      await sql`ALTER TABLE canonical_score_events DISABLE TRIGGER canonical_score_events_immutable`;
      await sql`UPDATE canonical_score_events
        SET writer_generation=7
        WHERE id=${canonicalEventId}`;
      await sql`ALTER TABLE canonical_score_events ENABLE TRIGGER canonical_score_events_immutable`;

      // Remediation 2: populate valid acknowledgement reason for acknowledged conflict (operational runbook trigger-safe update)
      await sql`ALTER TABLE result_conflicts DISABLE TRIGGER result_conflicts_lifecycle_guard`;
      await sql`UPDATE result_conflicts
        SET acknowledgement_reason='Production remediation: acknowledged by organiser'
        WHERE corrected_match_id=${matchId} AND status='acknowledged' AND acknowledgement_reason IS NULL`;
      await sql`ALTER TABLE result_conflicts ENABLE TRIGGER result_conflicts_lifecycle_guard`;

      // Copy all forward migrations 0030..0052
      const forwardMigrations = allMigrations.filter(
        (name) => name >= "0030_gate_c_published_schedule_participants.sql",
      );
      await copyMigrationFiles(copiedDir, forwardMigrations);

      // Now run forward migration across all remaining migrations to HEAD (0052)
      const upgradeResult = await migrateDatabase({ databaseUrl, migrationsDirectory: copiedDir, schema });
      expect(upgradeResult.applied).toEqual(forwardMigrations);
      expect(upgradeResult.current).toEqual(allMigrations);

      // Verify repaired data invariants
      const [repairedEvent] = await sql<{ writer_generation: number }[]>`
        SELECT writer_generation FROM canonical_score_events WHERE id=${canonicalEventId}
      `;
      expect(repairedEvent?.writer_generation).toBe(7);

      const [repairedConflict] = await sql<{ acknowledgement_reason: string }[]>`
        SELECT acknowledgement_reason FROM result_conflicts WHERE corrected_match_id=${matchId}
      `;
      expect(repairedConflict?.acknowledgement_reason).toBe("Production remediation: acknowledged by organiser");

      const [repairedSchedule] = await sql<{ division_id: string; home_entry_id: string }[]>`
        SELECT division_id, home_entry_id FROM scheduled_matches WHERE match_id=${matchId}
      `;
      expect(repairedSchedule?.division_id).toBe(divisionId);
      expect(repairedSchedule?.home_entry_id).toBe(validEntry2Id);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 45_000);
});
