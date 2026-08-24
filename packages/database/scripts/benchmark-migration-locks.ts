import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { dropTestSchema, migrateDatabase } from "../src/migrations.js";
import { cleanupC2MigrationLockResources, type C2CleanupOutcome } from "./migration-lock-cleanup.js";
import {
  c2MigrationLockFixtureExpectedRows,
  resolveC2MigrationLockFixtureProfile,
  type C2MigrationLockFixtureProfile,
} from "./migration-lock-profile.js";

const configuredDatabaseUrl = process.env.DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("DATABASE_URL is required for the isolated Gate C C2 benchmark");
const databaseUrl: string = configuredDatabaseUrl;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

interface LockSample {
  tableName: string;
  lockMode: string;
  granted: boolean;
  querySnippet: string;
  timestampMs: number;
}

interface ProfileResult {
  profileName: string;
  description: string;
  migration0030DurationMs: number;
  migration0031DurationMs: number;
  totalDurationMs: number;
  tableLockModes: Record<string, string[]>;
  lockWaitQueueMax: number;
  concurrentQueriesExecuted: number;
  concurrentQueriesBlocked: number;
  concurrentQueriesTimedOut: number;
  concurrentQueriesDeadlocked: number;
  concurrentQueryLatenciesMs: {
    min: number;
    p50: number;
    p95: number;
    max: number;
  };
  fixtureRows: ReturnType<typeof c2MigrationLockFixtureExpectedRows>;
  cleanup: C2CleanupOutcome;
  retainedRawLog?: { path: string; sha256: string };
  rawObservation?: {
    lockSamples: LockSample[];
    traffic: { executed: number; blocked: number; timedOut: number; deadlocked: number; latencies: number[] };
  };
}

interface RollbackBenchmarkResult {
  scenario: string;
  preflightFailureTriggered: string;
  ddlAttemptDurationMs: number;
  rollbackDurationMs: number;
  postRollbackLocksRemaining: number;
  lockReleaseVerified: boolean;
  cleanup: C2CleanupOutcome;
}

interface GateCLockBenchmarkReport {
  schemaVersion: 3;
  artifactKind: "gate-c-c2-migration-lock-benchmark";
  sourceSha: string;
  executionClassification: "controlled_staging_observation";
  timestamp: string;
  engine: string;
  postgresVersion: string;
  database: {
    databaseNameHash: string;
    databaseSizeBytes: number;
  };
  fixtureProfile: C2MigrationLockFixtureProfile;
  fixtureRows: {
    competitions: number;
    divisions: number;
    matches: number;
    scheduledMatches: number;
    scoreEvents: number;
    scoringSessions: number;
    resultConflicts: number;
  };
  profiles: Record<string, ProfileResult>;
  abortRollback: RollbackBenchmarkResult;
  recommendations: {
    lockTimeoutSec: number;
    statementTimeoutSec: number;
    maintenanceWindowRequired: true;
    writeDrainRequired: true;
    operationalAdvice: string[];
  };
  cleanup: {
    schemasDropped: number;
    temporaryMigrationDirectoriesRemoved: number;
    cleanupFailures: string[];
  };
}

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

class LockMonitor {
  private active = false;
  private samples: LockSample[] = [];
  private pollIntervalHandle: NodeJS.Timeout | null = null;
  private monitorSql: Sql;
  private schemaName: string;

  constructor(schemaName: string) {
    this.schemaName = schemaName;
    this.monitorSql = postgres(databaseUrl, { max: 1 });
  }

  public start(): void {
    this.active = true;
    this.samples = [];
    this.pollIntervalHandle = setInterval(async () => {
      if (!this.active) return;
      try {
        const rows = await this.monitorSql<
          {
            table_name: string;
            lock_mode: string;
            granted: boolean;
            query: string | null;
          }[]
        >`
          SELECT
            c.relname AS table_name,
            l.mode AS lock_mode,
            l.granted,
            a.query
          FROM pg_locks l
          JOIN pg_class c ON c.oid = l.relation
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE n.nspname = ${this.schemaName}
        `;
        const now = performance.now();
        for (const row of rows) {
          this.samples.push({
            tableName: row.table_name,
            lockMode: row.lock_mode,
            granted: row.granted,
            querySnippet: (row.query ?? "").slice(0, 100),
            timestampMs: now,
          });
        }
      } catch {
        // Ignore sampling errors during DDL teardown
      }
    }, 5);
  }

  public async stop(): Promise<LockSample[]> {
    this.active = false;
    if (this.pollIntervalHandle) {
      clearInterval(this.pollIntervalHandle);
      this.pollIntervalHandle = null;
    }
    await this.monitorSql.end({ timeout: 2 });
    return this.samples;
  }
}

interface BenchmarkWriterTarget {
  competitionId: string;
  divisionId: string;
  matchId: string;
  accessSessionId: string;
  nextVersion: number;
}

async function preparePopulatedSchema(
  prefix: string,
  fixtureProfile: C2MigrationLockFixtureProfile,
): Promise<{
  schema: string;
  tempMigrationsDir: string;
  competitionId: string;
  divisionId: string;
  matchId: string;
  accountId: string;
  scheduleRevisionId: string;
  accessPassId: string;
  accessSessionId: string;
  writerTargets: BenchmarkWriterTarget[];
  fixtureRows: ReturnType<typeof c2MigrationLockFixtureExpectedRows>;
}> {
  const schema = `test_bench_lock_${prefix}_${randomUUID().replaceAll("-", "")}`;
  await dropTestSchema(databaseUrl, schema);

  const tempMigrationsDir = await mkdtemp(path.join(os.tmpdir(), "matchday-bench-"));
  await cp(migrationsDirectory, tempMigrationsDir, { recursive: true });

  const allMigrations = (await readdir(tempMigrationsDir)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(n)).sort();

  // Keep only migrations up to 0029
  await Promise.all(
    allMigrations
      .filter((n) => n > "0029_gate_c_five_sport_scoring.sql")
      .map((n) => rm(path.join(tempMigrationsDir, n))),
  );

  await migrateDatabase({ databaseUrl, migrationsDirectory: tempMigrationsDir, schema });

  try {
    const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
    const accountId = randomUUID();
    const fixtureRows = c2MigrationLockFixtureExpectedRows(fixtureProfile);
    const writerTargets: BenchmarkWriterTarget[] = [];
    let firstCompetitionId = "";
    let firstDivisionId = "";
    let firstMatchId = "";
    let firstScheduleRevisionId = "";
    let firstAccessPassId = "";
    let firstAccessSessionId = "";

    try {
      await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${accountId},${`${accountId}@example.test`},'Bench Owner')`;
      const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
      const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
      await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
      VALUES('canoe_polo','bench-pack-v1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;

      for (let competitionOrdinal = 1; competitionOrdinal <= fixtureProfile.competitions; competitionOrdinal += 1) {
        const organisationId = randomUUID();
        const competitionId = randomUUID();
        const playingAreaId = randomUUID();
        await sql.begin(async (tx) => {
          await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},${`Bench Org ${competitionOrdinal}`},${`bench-org-${organisationId}`})`;
          await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
          VALUES(${organisationId},${accountId},'owner','active')`;
        });
        await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,venue,address,country_code,locale,plan_tier)
        VALUES(${competitionId},${organisationId},${accountId},${`Bench Cup ${competitionOrdinal}`},${`bench-cup-${competitionId}`},'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','Arena','1 Road','SG','en-SG','organiser_pro')`;
        await sql`INSERT INTO competition_sport_settings(competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override)
        VALUES(${competitionId},${accountId},'canoe_polo','bench-pack-v1',1,'{}'::jsonb,'{}'::jsonb)`;
        await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes) VALUES(${playingAreaId},${competitionId},'Pitch 1',30)`;

        for (let divisionOrdinal = 1; divisionOrdinal <= fixtureProfile.divisionsPerCompetition; divisionOrdinal += 1) {
          const divisionId = randomUUID();
          const homeEntryId = randomUUID();
          const awayEntryId = randomUUID();
          const formatRevisionId = randomUUID();
          const scheduleRevisionId = randomUUID();
          const matchIds = Array.from({ length: fixtureProfile.matchesPerDivision }, () => randomUUID());
          await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},${`Open ${divisionOrdinal}`},16)`;
          await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
          (${homeEntryId},${divisionId},'Home Team',1,'placeholder','confirmed'),
          (${awayEntryId},${divisionId},'Away Team',2,'placeholder','confirmed')`;
          const def = twoEntryDefinition(formatRevisionId, matchIds[0]!);
          const [defHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(def)}) AS hash`;
          await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
          VALUES(${formatRevisionId},${competitionId},${divisionId},1,${sql.json(def)},${defHash!.hash},${accountId},'phase3')`;
          await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,created_by)
          VALUES(${scheduleRevisionId},${competitionId},${formatRevisionId},1,${sha256Digest(scheduleRevisionId)},${accountId})`;

          for (const [matchIndex, matchId] of matchIds.entries()) {
            const accessPassId = randomUUID();
            const accessSessionId = randomUUID();
            await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id)
            VALUES(${matchId},${competitionId},${divisionId},${formatRevisionId},${`BENCH-${competitionOrdinal}-${divisionOrdinal}-${matchIndex + 1}`},'pool',1,${matchIndex + 1},${homeEntryId},${awayEntryId})`;
            await sql`INSERT INTO scheduled_matches(schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at)
            VALUES(${scheduleRevisionId},${matchId},${competitionId},${playingAreaId},'2027-01-01T08:00:00Z','2027-01-01T08:30:00Z')`;
            await sql`INSERT INTO match_score_streams(match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint,current_version)
            VALUES(${matchId},${competitionId},${divisionId},'canoe_polo','bench-pack-v1','{}'::jsonb,${sha256Digest(`stream-${matchId}`)},${fixtureProfile.scoreEventsPerMatch})`;
            for (
              let sessionOrdinal = 1;
              sessionOrdinal <= fixtureProfile.scoringSessionsPerMatch;
              sessionOrdinal += 1
            ) {
              const sessionPassId = sessionOrdinal === 1 ? accessPassId : randomUUID();
              const sessionId = sessionOrdinal === 1 ? accessSessionId : randomUUID();
              await sql`INSERT INTO scoring_access_passes(id,competition_id,match_id,secret_hash,short_code_hash,fallback_code_hash_version,expires_at,created_by)
              VALUES(${sessionPassId},${competitionId},${matchId},${randomBytes(32)},${randomBytes(32)},'hmac_sha256_v1','2100-01-01T12:00:00Z',${accountId})`;
              await sql`INSERT INTO scoring_access_sessions(id,access_pass_id,competition_id,match_id,session_token_hash,generation,device_id_hash,issued_at,expires_at,mode)
              VALUES(${sessionId},${sessionPassId},${competitionId},${matchId},${randomBytes(32)},${sessionOrdinal},${randomBytes(32)},'2027-01-01T08:00:00Z','2100-01-01T09:00:00Z','writer')`;
              await sql`INSERT INTO match_writer_leases(match_id,competition_id,access_session_id,generation,session_mode,expires_at)
              VALUES(${matchId},${competitionId},${sessionId},${sessionOrdinal},'writer','2100-01-01T09:00:00Z')
              ON CONFLICT (match_id) DO NOTHING`;
            }
            for (let eventOrdinal = 1; eventOrdinal <= fixtureProfile.scoreEventsPerMatch; eventOrdinal += 1) {
              await sql`INSERT INTO canonical_score_events(competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp)
              VALUES(${competitionId},${divisionId},${matchId},${randomUUID()},${eventOrdinal},${eventOrdinal},'goal','{"type":"goal"}'::jsonb,${sha256Digest(`event-${matchId}-${eventOrdinal}`)},${accessSessionId},1,now())`;
            }
            writerTargets.push({
              competitionId,
              divisionId,
              matchId,
              accessSessionId,
              nextVersion: fixtureProfile.scoreEventsPerMatch + 1,
            });
            if (!firstMatchId) {
              firstCompetitionId = competitionId;
              firstDivisionId = divisionId;
              firstMatchId = matchId;
              firstScheduleRevisionId = scheduleRevisionId;
              firstAccessPassId = accessPassId;
              firstAccessSessionId = accessSessionId;
            }
          }
          for (
            let conflictOrdinal = 0;
            conflictOrdinal < fixtureProfile.resultConflictsPerCompetition && conflictOrdinal < matchIds.length - 1;
            conflictOrdinal += 1
          ) {
            if (divisionOrdinal !== 1) break;
            await sql`INSERT INTO result_conflicts(competition_id,division_id,corrected_match_id,downstream_match_id,result_version,reason)
            VALUES(${competitionId},${divisionId},${matchIds[conflictOrdinal]!},${matchIds[conflictOrdinal + 1]!},${conflictOrdinal + 1},'downstream_match_started')`;
          }
        }
      }
    } finally {
      await sql.end({ timeout: 2 });
    }

    const countSql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
    let observedRows:
      | {
          competitions: string;
          divisions: string;
          matches: string;
          scheduled_matches: string;
          score_events: string;
          scoring_sessions: string;
          result_conflicts: string;
        }
      | undefined;
    try {
      [observedRows] = await countSql<
        {
          competitions: string;
          divisions: string;
          matches: string;
          scheduled_matches: string;
          score_events: string;
          scoring_sessions: string;
          result_conflicts: string;
        }[]
      >`
      SELECT
        (SELECT count(*) FROM competitions)::text AS competitions,
        (SELECT count(*) FROM divisions)::text AS divisions,
        (SELECT count(*) FROM matches)::text AS matches,
        (SELECT count(*) FROM scheduled_matches)::text AS scheduled_matches,
        (SELECT count(*) FROM canonical_score_events)::text AS score_events,
        (SELECT count(*) FROM scoring_access_sessions)::text AS scoring_sessions,
        (SELECT count(*) FROM result_conflicts)::text AS result_conflicts
    `;
    } finally {
      await countSql.end({ timeout: 2 });
    }
    const actualRows = {
      competitions: Number(observedRows?.competitions ?? "0"),
      divisions: Number(observedRows?.divisions ?? "0"),
      matches: Number(observedRows?.matches ?? "0"),
      scheduledMatches: Number(observedRows?.scheduled_matches ?? "0"),
      scoreEvents: Number(observedRows?.score_events ?? "0"),
      scoringSessions: Number(observedRows?.scoring_sessions ?? "0"),
      resultConflicts: Number(observedRows?.result_conflicts ?? "0"),
    };
    if (JSON.stringify(actualRows) !== JSON.stringify(fixtureRows)) {
      throw new Error(
        `C2 fixture row-count mismatch: expected ${JSON.stringify(fixtureRows)}, got ${JSON.stringify(actualRows)}`,
      );
    }

    return {
      schema,
      tempMigrationsDir,
      competitionId: firstCompetitionId,
      divisionId: firstDivisionId,
      matchId: firstMatchId,
      accountId,
      scheduleRevisionId: firstScheduleRevisionId,
      accessPassId: firstAccessPassId,
      accessSessionId: firstAccessSessionId,
      writerTargets,
      fixtureRows: actualRows,
    };
  } catch (error) {
    // A failed observation must not leave its disposable staging schema or
    // copied migration directory behind for the next controlled run.
    await Promise.allSettled([
      dropTestSchema(databaseUrl, schema),
      rm(tempMigrationsDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

function calculatePercentiles(latencies: number[]): { min: number; p50: number; p95: number; max: number } {
  if (latencies.length === 0) return { min: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    min: Math.round(sorted[0]! * 100) / 100,
    p50: Math.round(sorted[Math.floor(sorted.length * 0.5)]! * 100) / 100,
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 100) / 100,
    max: Math.round(sorted.at(-1)! * 100) / 100,
  };
}

interface PreparedSchemaContext {
  schema: string;
  tempMigrationsDir: string;
  competitionId: string;
  divisionId: string;
  matchId: string;
  accountId: string;
  scheduleRevisionId: string;
  accessPassId: string;
  accessSessionId: string;
  writerTargets: BenchmarkWriterTarget[];
  fixtureRows: ReturnType<typeof c2MigrationLockFixtureExpectedRows>;
}

async function benchmarkProfile(
  profileName: string,
  description: string,
  fixtureProfile: C2MigrationLockFixtureProfile,
  trafficWorker:
    | ((
        sql: Sql,
        stopSignal: { stop: boolean },
        context: PreparedSchemaContext,
      ) => Promise<{ executed: number; blocked: number; timedOut: number; deadlocked: number; latencies: number[] }>)
    | null,
): Promise<ProfileResult> {
  const prepared = await preparePopulatedSchema(profileName.toLowerCase().replace(/[^a-z0-9]/g, "_"), fixtureProfile);
  const { schema, tempMigrationsDir } = prepared;
  const monitor = new LockMonitor(schema);
  const trafficSql = postgres(databaseUrl, { max: 5, connection: { search_path: schema } });
  const stopSignal = { stop: false };
  let trafficPromise: Promise<{
    executed: number;
    blocked: number;
    timedOut: number;
    deadlocked: number;
    latencies: number[];
  }> | null = null;
  if (trafficWorker) {
    trafficPromise = trafficWorker(trafficSql, stopSignal, prepared);
  }
  monitor.start();

  async function runMigrationWithRetry(action: () => Promise<unknown>, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await action();
        return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/deadlock/i.test(message) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 50 * attempt));
          continue;
        }
        throw err;
      }
    }
  }

  let m0030Duration = 0;
  let m0031Duration = 0;
  let trafficStats = { executed: 0, blocked: 0, timedOut: 0, deadlocked: 0, latencies: [] as number[] };
  let lockSamples: LockSample[] = [];
  let cleanup: C2CleanupOutcome | undefined;
  let profileFailure: unknown;

  monitor.start();
  try {
    await cp(
      path.join(migrationsDirectory, "0030_gate_c_published_schedule_participants.sql"),
      path.join(tempMigrationsDir, "0030_gate_c_published_schedule_participants.sql"),
    );
    const t0 = performance.now();
    await runMigrationWithRetry(() => migrateDatabase({ databaseUrl, migrationsDirectory: tempMigrationsDir, schema }));
    m0030Duration = performance.now() - t0;

    await cp(
      path.join(migrationsDirectory, "0031_gate_c_participant_snapshot_fencing.sql"),
      path.join(tempMigrationsDir, "0031_gate_c_participant_snapshot_fencing.sql"),
    );
    const t1 = performance.now();
    await runMigrationWithRetry(() => migrateDatabase({ databaseUrl, migrationsDirectory: tempMigrationsDir, schema }));
    m0031Duration = performance.now() - t1;
  } catch (error) {
    profileFailure = error;
  } finally {
    stopSignal.stop = true;
    const [traffic, connection, monitorResult] = await Promise.allSettled([
      trafficPromise ?? Promise.resolve(trafficStats),
      trafficSql.end({ timeout: 2 }),
      monitor.stop(),
    ]);
    if (traffic.status === "fulfilled") trafficStats = traffic.value;
    else profileFailure ??= traffic.reason;
    if (connection.status === "rejected") profileFailure ??= connection.reason;
    if (monitorResult.status === "fulfilled") lockSamples = monitorResult.value;
    else profileFailure ??= monitorResult.reason;
    cleanup = await cleanupC2MigrationLockResources(
      () => dropTestSchema(databaseUrl, schema),
      () => rm(tempMigrationsDir, { recursive: true, force: true }),
    );
  }
  if (!cleanup) throw new Error(`C2 ${profileName} cleanup outcome was not collected`);
  if (cleanup.failures.length > 0) {
    throw new Error(`C2 ${profileName} cleanup failed: ${cleanup.failures.join("; ")}`, { cause: profileFailure });
  }
  if (profileFailure) throw profileFailure;

  const tableLockModes: Record<string, Set<string>> = {};
  let maxWaitQueue = 0;
  let currentWait = 0;

  for (const sample of lockSamples) {
    if (!tableLockModes[sample.tableName]) {
      tableLockModes[sample.tableName] = new Set();
    }
    tableLockModes[sample.tableName]!.add(sample.lockMode);
    if (!sample.granted) {
      currentWait += 1;
      if (currentWait > maxWaitQueue) maxWaitQueue = currentWait;
    }
  }

  const serializedLocks: Record<string, string[]> = {};
  for (const [table, modes] of Object.entries(tableLockModes)) {
    serializedLocks[table] = Array.from(modes);
  }

  return {
    profileName,
    description,
    migration0030DurationMs: Math.round(m0030Duration * 100) / 100,
    migration0031DurationMs: Math.round(m0031Duration * 100) / 100,
    totalDurationMs: Math.round((m0030Duration + m0031Duration) * 100) / 100,
    tableLockModes: serializedLocks,
    lockWaitQueueMax: maxWaitQueue,
    concurrentQueriesExecuted: trafficStats.executed,
    concurrentQueriesBlocked: trafficStats.blocked,
    concurrentQueriesTimedOut: trafficStats.timedOut,
    concurrentQueriesDeadlocked: trafficStats.deadlocked,
    concurrentQueryLatenciesMs: calculatePercentiles(trafficStats.latencies),
    fixtureRows: prepared.fixtureRows,
    cleanup,
    rawObservation: { lockSamples, traffic: trafficStats },
  };
}

async function benchmarkAbortRollback(fixtureProfile: C2MigrationLockFixtureProfile): Promise<RollbackBenchmarkResult> {
  const prepared = await preparePopulatedSchema("rollback_test", fixtureProfile);
  const { schema, tempMigrationsDir, matchId, competitionId, divisionId } = prepared;
  let failureTriggered = "";
  let attemptDuration = 0;
  let locksRemaining = 0;
  let cleanup: C2CleanupOutcome | undefined;
  let operationFailure: unknown;
  try {
    const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
    try {
      // Inject malformed writer generation.
      await sql`INSERT INTO canonical_score_events(
        competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
        command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
      ) VALUES(
        ${competitionId},${divisionId},${matchId},${randomUUID()},99,99,'goal',
        '{"type":"goal"}'::jsonb,${sha256Digest("bad-gen")},${prepared.accessSessionId},999,now()
      )`;
    } finally {
      await sql.end({ timeout: 2 });
    }

    await cp(
      path.join(migrationsDirectory, "0030_gate_c_published_schedule_participants.sql"),
      path.join(tempMigrationsDir, "0030_gate_c_published_schedule_participants.sql"),
    );
    const t0 = performance.now();
    try {
      await migrateDatabase({ databaseUrl, migrationsDirectory: tempMigrationsDir, schema });
    } catch (error: unknown) {
      failureTriggered = error instanceof Error ? error.message : String(error);
    }
    attemptDuration = performance.now() - t0;

    // Verify immediate lock release post-abort.
    const checkSql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await checkSql<{ count: string }[]>`
        SELECT count(*)::text count
        FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema}
      `;
      locksRemaining = parseInt(rows[0]?.count ?? "0", 10);
    } finally {
      await checkSql.end({ timeout: 2 });
    }
  } catch (error) {
    operationFailure = error;
  } finally {
    cleanup = await cleanupC2MigrationLockResources(
      () => dropTestSchema(databaseUrl, schema),
      () => rm(tempMigrationsDir, { recursive: true, force: true }),
    );
  }
  if (!cleanup || cleanup.failures.length > 0) {
    throw new Error(`C2 abort-rollback cleanup failed: ${cleanup?.failures.join("; ") ?? "outcome missing"}`, {
      cause: operationFailure,
    });
  }
  if (operationFailure) throw operationFailure;

  return {
    scenario: "Malformed pre-0030 writer generation preflight abort",
    preflightFailureTriggered: failureTriggered,
    ddlAttemptDurationMs: Math.round(attemptDuration * 100) / 100,
    rollbackDurationMs: Math.round(attemptDuration * 100) / 100,
    postRollbackLocksRemaining: locksRemaining,
    lockReleaseVerified: locksRemaining === 0,
    cleanup,
  };
}

async function main(): Promise<void> {
  if (process.env.GATE_C_C2_CONTROLLED_STAGING !== "1") {
    throw new Error("Refusing migration-lock benchmark without GATE_C_C2_CONTROLLED_STAGING=1");
  }
  console.log("Starting Gate C 0030/0031 Production Lock Benchmarks...");
  const fixtureProfile = resolveC2MigrationLockFixtureProfile();
  const sourceSha = (await import("node:child_process"))
    .execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
      encoding: "utf8",
    })
    .trim();

  const mainSql = postgres(databaseUrl, { max: 1 });
  let postgresVersion = "unknown";
  let databaseNameHash = "unknown";
  let databaseSizeBytes = 0;
  try {
    const [v] = await mainSql<{ server_version: string }[]>`SHOW server_version`;
    postgresVersion = v?.server_version ?? "unknown";
    const [metadata] = await mainSql<{ name: string; size_bytes: string }[]>`
      SELECT current_database() AS name, pg_database_size(current_database())::text AS size_bytes
    `;
    databaseNameHash = sha256Digest(metadata?.name ?? "unknown");
    databaseSizeBytes = Number(metadata?.size_bytes ?? "0");
  } finally {
    await mainSql.end({ timeout: 2 });
  }

  // Profile 1: Baseline (No traffic)
  console.log("Benchmarking Profile 1: Baseline (No traffic)...");
  const p1 = await benchmarkProfile(
    "Baseline",
    "Isolated DDL execution with zero concurrent client traffic",
    fixtureProfile,
    null,
  );

  // Profile 2: Public reads (concurrent SELECT on scheduled_matches and score events)
  console.log("Benchmarking Profile 2: Public reads...");
  const p2 = await benchmarkProfile(
    "PublicReads",
    "Continuous concurrent read queries against scheduled_matches and canonical_score_events",
    fixtureProfile,
    async (sql, stopSignal) => {
      let executed = 0;
      let blocked = 0;
      let timedOut = 0;
      let deadlocked = 0;
      const latencies: number[] = [];
      const workerCount = 5;

      const runWorker = async () => {
        while (!stopSignal.stop) {
          const start = performance.now();
          try {
            await sql`SELECT * FROM scheduled_matches LIMIT 10`;
            await sql`SELECT * FROM canonical_score_events ORDER BY aggregate_version DESC LIMIT 10`;
            const lat = performance.now() - start;
            latencies.push(lat);
            if (lat > 50) blocked += 1;
            executed += 1;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (/deadlock/i.test(message)) deadlocked += 1;
            else if (/timeout/i.test(message)) timedOut += 1;
          }
          await new Promise((r) => setImmediate(r));
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return { executed, blocked, timedOut, deadlocked, latencies };
    },
  );

  // Profile 3: Organiser reads (concurrent SELECT on result_conflicts and scoring_access_passes)
  console.log("Benchmarking Profile 3: Organiser reads...");
  const p3 = await benchmarkProfile(
    "OrganiserReads",
    "Continuous concurrent organiser queries against result_conflicts and scoring_access_passes",
    fixtureProfile,
    async (sql, stopSignal) => {
      let executed = 0;
      let blocked = 0;
      let timedOut = 0;
      let deadlocked = 0;
      const latencies: number[] = [];
      const workerCount = 5;

      const runWorker = async () => {
        while (!stopSignal.stop) {
          const start = performance.now();
          try {
            await sql`SELECT * FROM result_conflicts WHERE status='open'`;
            await sql`SELECT * FROM scoring_access_passes WHERE revoked_at IS NULL`;
            const lat = performance.now() - start;
            latencies.push(lat);
            if (lat > 50) blocked += 1;
            executed += 1;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (/deadlock/i.test(message)) deadlocked += 1;
            else if (/timeout/i.test(message)) timedOut += 1;
          }
          await new Promise((r) => setImmediate(r));
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return { executed, blocked, timedOut, deadlocked, latencies };
    },
  );

  // Profile 4: Writer mutations (concurrent score appends and session lease renewals)
  console.log("Benchmarking Profile 4: Writer mutations...");
  const p4 = await benchmarkProfile(
    "WriterMutations",
    "Continuous canonical score appends and writer-lease renewals during DDL",
    fixtureProfile,
    async (sql, stopSignal, context) => {
      let executed = 0;
      let blocked = 0;
      let timedOut = 0;
      let deadlocked = 0;
      const latencies: number[] = [];
      const workerCount = 3;

      const runWorker = async (workerIndex: number) => {
        // Each worker owns a distinct stream so every operation is a canonical
        // append rather than a lease-only synthetic write or an artificial race.
        const target = context.writerTargets[workerIndex % context.writerTargets.length]!;
        while (!stopSignal.stop) {
          const start = performance.now();
          try {
            await sql.begin(async (tx) => {
              await tx`
                UPDATE scoring_access_sessions
                SET expires_at = now() + interval '2 hours'
                WHERE id = ${target.accessSessionId}
              `;
              await tx`
                INSERT INTO match_writer_leases(match_id, competition_id, access_session_id, generation, session_mode, expires_at)
                VALUES(${target.matchId}, ${target.competitionId}, ${target.accessSessionId}, 1, 'writer', now() + interval '1 hour')
                ON CONFLICT (match_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
              `;
              const version = target.nextVersion++;
              await tx`
                INSERT INTO canonical_score_events(
                  competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
                  command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
                ) VALUES(
                  ${target.competitionId},${target.divisionId},${target.matchId},${randomUUID()},${version},${version},'goal',
                  '{"type":"goal"}'::jsonb,${sha256Digest(`runtime-event-${target.matchId}-${version}`)},${target.accessSessionId},1,now()
                )
              `;
              await tx`UPDATE match_score_streams SET current_version=${version} WHERE match_id=${target.matchId}`;
            });
            const lat = performance.now() - start;
            latencies.push(lat);
            if (lat > 50) blocked += 1;
            executed += 1;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (/deadlock/i.test(message)) deadlocked += 1;
            else if (/timeout/i.test(message)) timedOut += 1;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      };

      await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => runWorker(workerIndex)));
      return { executed, blocked, timedOut, deadlocked, latencies };
    },
  );

  // Abort Rollback scenario
  console.log("Benchmarking Abort Rollback Behavior...");
  const abortRollback = await benchmarkAbortRollback(fixtureProfile);

  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..");
  const artifactDirectory = path.resolve(repoRoot, "artifacts/qa/gate-c-c2", sourceSha);
  const retainedProfiles: Array<[string, ProfileResult]> = [
    ["baseline", p1],
    ["public-reads", p2],
    ["organiser-reads", p3],
    ["writer-mutations", p4],
  ];
  for (const [name, profile] of retainedProfiles) {
    const rawObservation = profile.rawObservation;
    if (!rawObservation) throw new Error(`C2 ${name} profile has no retained raw observation`);
    const content = JSON.stringify(rawObservation, null, 2);
    const logPath = path.resolve(artifactDirectory, "raw", `${name}.json`);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, content, "utf-8");
    profile.retainedRawLog = {
      path: path.relative(repoRoot, logPath).split(path.sep).join("/"),
      sha256: sha256Digest(content),
    };
    delete profile.rawObservation;
  }

  const report: GateCLockBenchmarkReport = {
    schemaVersion: 3,
    artifactKind: "gate-c-c2-migration-lock-benchmark",
    sourceSha,
    executionClassification: "controlled_staging_observation",
    timestamp: new Date().toISOString(),
    engine: "PostgreSQL",
    postgresVersion,
    database: {
      databaseNameHash,
      databaseSizeBytes,
    },
    fixtureProfile,
    fixtureRows: p1.fixtureRows,
    profiles: {
      baseline: p1,
      publicReads: p2,
      organiserReads: p3,
      writerMutations: p4,
    },
    abortRollback,
    recommendations: {
      lockTimeoutSec: 3,
      statementTimeoutSec: 30,
      maintenanceWindowRequired: true,
      writeDrainRequired: true,
      operationalAdvice: [
        "This benchmark is an observation collector, never a Gate C PASS receipt.",
        "Maintain a write drain and approved maintenance window until a representative controlled-staging execution demonstrates safe reader and canonical writer outcomes.",
        "Set lock_timeout = '3s' and statement_timeout = '30s'; treat timeout or deadlock observations as failed evidence, not retry-only success.",
      ],
    },
    cleanup: {
      schemasDropped:
        [p1, p2, p3, p4].filter((profile) => profile.cleanup.schemaDropped).length +
        (abortRollback.cleanup.schemaDropped ? 1 : 0),
      temporaryMigrationDirectoriesRemoved:
        [p1, p2, p3, p4].filter((profile) => profile.cleanup.temporaryMigrationDirectoryRemoved).length +
        (abortRollback.cleanup.temporaryMigrationDirectoryRemoved ? 1 : 0),
      cleanupFailures: [p1, p2, p3, p4, abortRollback].flatMap((result) => result.cleanup.failures),
    },
  };

  const jsonContent = JSON.stringify(report, null, 2);

  // Observations belong only under the ignored exact-SHA artifact root. Never rewrite historical docs/qa evidence.
  const artifactsPath = path.resolve(artifactDirectory, "migration-lock-benchmark.json");
  await mkdir(path.dirname(artifactsPath), { recursive: true });
  await writeFile(artifactsPath, jsonContent, "utf-8");

  console.log(`Gate C Lock Benchmarks generated successfully:`);
  console.log(`- ${artifactsPath}`);
  console.log(jsonContent);
}

main().catch((err) => {
  console.error("Lock benchmark error:", err);
  process.exit(1);
});
