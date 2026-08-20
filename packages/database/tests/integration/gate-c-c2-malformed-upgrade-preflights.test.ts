import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const temporaryDirectories: string[] = [];
const temporarySchemas: string[] = [];

type UpgradeWorld = Readonly<{
  accountId: string;
  competitionId: string;
  divisionId: string;
  siblingDivisionId: string;
  homeEntryId: string;
  awayEntryId: string;
  siblingEntryId: string;
  matchId: string;
  downstreamMatchId: string;
  accessSessionId: string;
  scheduleRevisionId: string;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function definition(formatRevisionId: string, matchId: string, downstreamMatchId: string): Record<string, unknown> {
  return {
    id: formatRevisionId,
    schemaVersion: 1,
    entryCount: 2,
    stages: [
      {
        id: "knockout",
        label: "Knockout",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 2,
        matchIds: [matchId, downstreamMatchId],
      },
    ],
    matches: [
      {
        id: matchId,
        stageId: "knockout",
        round: 1,
        order: 1,
        purpose: "semifinal",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
      {
        id: downstreamMatchId,
        stageId: "knockout",
        round: 2,
        order: 2,
        purpose: "championship",
        home: { type: "match_winner", matchId },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: [downstreamMatchId],
  };
}

async function migrationCopyThrough(lastMigration: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-gate-c-c2-preflight-"));
  temporaryDirectories.push(directory);
  await cp(migrationsDirectory, directory, { recursive: true });
  const files = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  await Promise.all(files.filter((name) => name > lastMigration).map((name) => rm(path.join(directory, name))));
  return directory;
}

async function addMigration(directory: string, name: string): Promise<void> {
  await cp(path.join(migrationsDirectory, name), path.join(directory, name));
}

async function createSchema(directory: string): Promise<{ schema: string; sql: Sql }> {
  const schema = `test_gate_c_c2_preflight_${randomUUID().replaceAll("-", "")}`;
  temporarySchemas.push(schema);
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory: directory, schema });
  return {
    schema,
    sql: postgres(databaseUrl, { max: 2, prepare: false, connection: { search_path: schema } }),
  };
}

async function seedUpgradeWorld(sql: Sql): Promise<UpgradeWorld> {
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
  const downstreamMatchId = randomUUID();
  const playingAreaId = randomUUID();
  const scheduleRevisionId = randomUUID();
  const accessPassId = randomUUID();
  const accessSessionId = randomUUID();
  const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
  const graph = definition(formatRevisionId, matchId, downstreamMatchId);

  await sql`INSERT INTO accounts(id,primary_email,display_name)
    VALUES(${accountId},${`${accountId}@example.test`},'Gate C preflight owner')`;
  await sql`INSERT INTO organisations(id,name,slug)
    VALUES(${organisationId},'Gate C preflight org',${`gate-c-preflight-${organisationId}`})`;
  await sql`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
    VALUES(${organisationId},${accountId},'owner','active')`;

  const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
  await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
    VALUES('canoe_polo','gate-c-preflight-v1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;

  await sql`INSERT INTO competitions(
      id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,
      venue,address,country_code,locale,plan_tier
    ) VALUES(
      ${competitionId},${organisationId},${accountId},'Gate C Preflight Cup',${`gate-c-preflight-cup-${competitionId}`},
      'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','Arena','1 Road','SG','en-SG','organiser_pro'
    )`;
  await sql`INSERT INTO competition_sport_settings(
      competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override
    ) VALUES(
      ${competitionId},${accountId},'canoe_polo','gate-c-preflight-v1',1,'{}'::jsonb,'{}'::jsonb
    )`;

  await sql`INSERT INTO divisions(id,competition_id,name,team_limit)
    VALUES
      (${divisionId},${competitionId},'Open',16),
      (${siblingDivisionId},${competitionId},'Sibling',16)`;
  await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status)
    VALUES
      (${homeEntryId},${divisionId},'Home',1,'team','confirmed'),
      (${awayEntryId},${divisionId},'Away',2,'team','confirmed'),
      (${siblingEntryId},${siblingDivisionId},'Sibling',1,'team','confirmed')`;

  const [definitionHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(graph)}) AS hash`;
  await sql`INSERT INTO format_revisions(
      id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract
    ) VALUES(
      ${formatRevisionId},${competitionId},${divisionId},1,${sql.json(graph)},${definitionHash!.hash},${accountId},'phase3'
    )`;
  await sql`INSERT INTO matches(
      id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id
    ) VALUES
      (${matchId},${competitionId},${divisionId},${formatRevisionId},'C2-A','semifinal',1,1,${homeEntryId},${awayEntryId}),
      (${downstreamMatchId},${competitionId},${divisionId},${formatRevisionId},'C2-B','final',2,2,${homeEntryId},${awayEntryId})`;

  await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes)
    VALUES(${playingAreaId},${competitionId},'Court 1',30)`;
  await sql`INSERT INTO schedule_revisions(
      id,competition_id,format_revision_id,revision,input_hash,created_by
    ) VALUES(
      ${scheduleRevisionId},${competitionId},${formatRevisionId},1,${digest(scheduleRevisionId)},${accountId}
    )`;
  await sql`INSERT INTO scheduled_matches(
      schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
    ) VALUES(
      ${scheduleRevisionId},${matchId},${competitionId},${playingAreaId},
      '2027-01-01T08:00:00Z','2027-01-01T08:30:00Z'
    )`;

  await sql`INSERT INTO scoring_access_passes(
      id,competition_id,match_id,secret_hash,short_code_hash,fallback_code_hash_version,expires_at,created_by
    ) VALUES(
      ${accessPassId},${competitionId},${matchId},${randomBytes(32)},${randomBytes(32)},'hmac_sha256_v1',
      '2100-01-01T12:00:00Z',${accountId}
    )`;
  await sql`INSERT INTO scoring_access_sessions(
      id,access_pass_id,competition_id,match_id,session_token_hash,generation,device_id_hash,issued_at,expires_at
    ) VALUES(
      ${accessSessionId},${accessPassId},${competitionId},${matchId},${randomBytes(32)},7,${randomBytes(32)},
      '2027-01-01T08:00:00Z','2100-01-01T09:00:00Z'
    )`;

  await sql`INSERT INTO match_score_streams(
      match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint,current_version
    ) VALUES(
      ${matchId},${competitionId},${divisionId},'canoe_polo','gate-c-preflight-v1','{}'::jsonb,${"a".repeat(64)},0
    )`;

  return {
    accountId,
    competitionId,
    divisionId,
    siblingDivisionId,
    homeEntryId,
    awayEntryId,
    siblingEntryId,
    matchId,
    downstreamMatchId,
    accessSessionId,
    scheduleRevisionId,
  };
}

async function expectColumnAbsent(sql: Sql, schema: string, columnName: string): Promise<void> {
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema=${schema} AND table_name='scheduled_matches' AND column_name=${columnName}
  `;
  expect(columns).toEqual([]);
}

afterEach(async () => {
  await Promise.all(temporarySchemas.splice(0).map((schema) => dropTestSchema(databaseUrl, schema)));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describeInfrastructure("Gate C C2 malformed upgrade preflights", () => {
  it("aborts migration 0030 when retained canonical history has a mismatched writer generation", async () => {
    const directory = await migrationCopyThrough("0029_gate_c_five_sport_scoring.sql");
    const { schema, sql } = await createSchema(directory);
    try {
      const world = await seedUpgradeWorld(sql);
      await sql`INSERT INTO canonical_score_events(
          competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
          command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
        ) VALUES(
          ${world.competitionId},${world.divisionId},${world.matchId},${randomUUID()},1,1,'goal',
          '{"type":"goal"}'::jsonb,${"b".repeat(64)},${world.accessSessionId},8,'2027-01-01T08:01:00Z'
        )`;

      await addMigration(directory, "0030_gate_c_published_schedule_participants.sql");
      await expect(migrateDatabase({ databaseUrl, migrationsDirectory: directory, schema })).rejects.toThrow(
        /writer generations that do not match their scoring sessions/i,
      );
      await expectColumnAbsent(sql, schema, "home_entry_id");
    } finally {
      await sql.end({ timeout: 2 });
    }
  });

  it("aborts migration 0030 when a retained result-conflict receipt exploits nullable CHECK semantics", async () => {
    const directory = await migrationCopyThrough("0029_gate_c_five_sport_scoring.sql");
    const { schema, sql } = await createSchema(directory);
    try {
      const world = await seedUpgradeWorld(sql);
      await sql`INSERT INTO result_conflicts(
          competition_id,division_id,corrected_match_id,downstream_match_id,result_version,reason,status,
          acknowledged_at,acknowledged_by_account_id,acknowledgement_client_event_id,acknowledgement_fingerprint,
          acknowledgement_reason
        ) VALUES(
          ${world.competitionId},${world.divisionId},${world.matchId},${world.downstreamMatchId},1,
          'downstream_match_started','acknowledged','2027-01-01T08:10:00Z',${world.accountId},${randomUUID()},
          ${"c".repeat(64)},NULL
        )`;

      await addMigration(directory, "0030_gate_c_published_schedule_participants.sql");
      await expect(migrateDatabase({ databaseUrl, migrationsDirectory: directory, schema })).rejects.toThrow(
        /invalid lifecycle receipt/i,
      );
      await expectColumnAbsent(sql, schema, "home_entry_id");
    } finally {
      await sql.end({ timeout: 2 });
    }
  });

  it("aborts migration 0031 when a published participant snapshot belongs to another division", async () => {
    const directory = await migrationCopyThrough("0030_gate_c_published_schedule_participants.sql");
    const { schema, sql } = await createSchema(directory);
    try {
      const world = await seedUpgradeWorld(sql);
      await sql`UPDATE scheduled_matches
        SET home_entry_id=${world.siblingEntryId}
        WHERE schedule_revision_id=${world.scheduleRevisionId} AND match_id=${world.matchId}`;

      await addMigration(directory, "0031_gate_c_participant_snapshot_fencing.sql");
      await expect(migrateDatabase({ databaseUrl, migrationsDirectory: directory, schema })).rejects.toThrow(
        /scheduled participant snapshots must belong to the authoritative match division and competition/i,
      );
      await expectColumnAbsent(sql, schema, "division_id");
    } finally {
      await sql.end({ timeout: 2 });
    }
  });
});
