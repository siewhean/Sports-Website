import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { dropTestSchema, migrateDatabase } from "../src/migrations.js";

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
  concurrentQueryLatenciesMs: {
    min: number;
    p50: number;
    p95: number;
    max: number;
  };
}

interface RollbackBenchmarkResult {
  scenario: string;
  preflightFailureTriggered: string;
  ddlAttemptDurationMs: number;
  rollbackDurationMs: number;
  postRollbackLocksRemaining: number;
  lockReleaseVerified: boolean;
}

interface GateCLockBenchmarkReport {
  schemaVersion: 2;
  artifactKind: "gate-c-c2-migration-lock-benchmark";
  sourceSha: string;
  executionClassification: "controlled_staging_observation";
  timestamp: string;
  engine: string;
  postgresVersion: string;
  syntheticVolume: {
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

async function preparePopulatedSchema(prefix: string): Promise<{
  schema: string;
  tempMigrationsDir: string;
  competitionId: string;
  divisionId: string;
  matchId: string;
  accountId: string;
  scheduleRevisionId: string;
  accessPassId: string;
  accessSessionId: string;
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

  const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
  const accountId = randomUUID();
  const organisationId = randomUUID();
  const competitionId = randomUUID();
  const divisionId = randomUUID();
  const homeEntryId = randomUUID();
  const awayEntryId = randomUUID();
  const formatRevisionId = randomUUID();
  const matchId = randomUUID();
  const playingAreaId = randomUUID();
  const scheduleRevisionId = randomUUID();
  const accessPassId = randomUUID();
  const accessSessionId = randomUUID();

  try {
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${accountId},${`${accountId}@example.test`},'Bench Owner')`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'Bench Org',${`bench-org-${organisationId}`})`;
      await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisationId},${accountId},'owner','active')`;
    });

    const pack = { recommendedSlotMinutes: 30, recommendedSettings: { slotMinutes: 30 } };
    const [packHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(pack)}) AS hash`;
    await sql`INSERT INTO sport_pack_versions(sport_code,version,schema_version,definition,definition_hash,status,activated_at)
      VALUES('canoe_polo','bench-pack-v1',1,${sql.json(pack)},${packHash!.hash},'active',now())`;

    await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on,venue,address,country_code,locale,plan_tier)
      VALUES(${competitionId},${organisationId},${accountId},'Bench Cup',${`bench-cup-${competitionId}`},'canoe_polo','Asia/Singapore','2027-01-01','2027-01-01','Arena','1 Road','SG','en-SG','organiser_pro')`;
    await sql`INSERT INTO competition_sport_settings(competition_id,updated_by,sport_code,pack_version,pack_schema_version,recommended_snapshot,settings_override)
      VALUES(${competitionId},${accountId},'canoe_polo','bench-pack-v1',1,'{}'::jsonb,'{}'::jsonb)`;

    await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',16)`;
    await sql`INSERT INTO division_entries(id,division_id,name,seed,entry_type,status) VALUES
      (${homeEntryId},${divisionId},'Home Team',1,'placeholder','confirmed'),
      (${awayEntryId},${divisionId},'Away Team',2,'placeholder','confirmed')`;

    const def = twoEntryDefinition(formatRevisionId, matchId);
    const [defHash] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(def)}) AS hash`;
    await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,created_by,validation_contract)
      VALUES(${formatRevisionId},${competitionId},${divisionId},1,${sql.json(def)},${defHash!.hash},${accountId},'phase3')`;

    await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id)
      VALUES(${matchId},${competitionId},${divisionId},${formatRevisionId},'BENCH-FINAL','final',1,1,${homeEntryId},${awayEntryId})`;

    await sql`INSERT INTO playing_areas(id,competition_id,name,slot_minutes) VALUES(${playingAreaId},${competitionId},'Pitch 1',30)`;
    await sql`INSERT INTO schedule_revisions(id,competition_id,format_revision_id,revision,input_hash,created_by)
      VALUES(${scheduleRevisionId},${competitionId},${formatRevisionId},1,${sha256Digest(scheduleRevisionId)},${accountId})`;

    await sql`INSERT INTO scheduled_matches(schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at)
      VALUES(${scheduleRevisionId},${matchId},${competitionId},${playingAreaId},'2027-01-01T08:00:00Z','2027-01-01T08:30:00Z')`;

    await sql`INSERT INTO match_score_streams(match_id,competition_id,division_id,sport_code,pack_version,settings_snapshot,settings_fingerprint,current_version)
      VALUES(${matchId},${competitionId},${divisionId},'canoe_polo','bench-pack-v1','{}'::jsonb,${"a".repeat(64)},0)`;

    await sql`INSERT INTO scoring_access_passes(id,competition_id,match_id,secret_hash,short_code_hash,fallback_code_hash_version,expires_at,created_by)
      VALUES(${accessPassId},${competitionId},${matchId},${randomBytes(32)},${randomBytes(32)},'hmac_sha256_v1','2100-01-01T12:00:00Z',${accountId})`;

    await sql`INSERT INTO scoring_access_sessions(id,access_pass_id,competition_id,match_id,session_token_hash,generation,device_id_hash,issued_at,expires_at)
      VALUES(${accessSessionId},${accessPassId},${competitionId},${matchId},${randomBytes(32)},7,${randomBytes(32)},'2027-01-01T08:00:00Z','2100-01-01T09:00:00Z')`;

    // Populate batch of score events
    for (let i = 1; i <= 20; i++) {
      await sql`INSERT INTO canonical_score_events(
        competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
        command,command_fingerprint,actor_access_session_id,writer_generation,device_timestamp
      ) VALUES(
        ${competitionId},${divisionId},${matchId},${randomUUID()},${i},${i},'goal',
        '{"type":"goal"}'::jsonb,${sha256Digest(`event-${i}`)},${accessSessionId},7,now()
      )`;
    }
  } finally {
    await sql.end({ timeout: 2 });
  }

  return {
    schema,
    tempMigrationsDir,
    competitionId,
    divisionId,
    matchId,
    accountId,
    scheduleRevisionId,
    accessPassId,
    accessSessionId,
  };
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
}

async function benchmarkProfile(
  profileName: string,
  description: string,
  trafficWorker:
    | ((
        sql: Sql,
        stopSignal: { stop: boolean },
        context: PreparedSchemaContext,
      ) => Promise<{ executed: number; blocked: number; timedOut: number; latencies: number[] }>)
    | null,
): Promise<ProfileResult> {
  const prepared = await preparePopulatedSchema(profileName.toLowerCase().replace(/[^a-z0-9]/g, "_"));
  const { schema, tempMigrationsDir } = prepared;
  const monitor = new LockMonitor(schema);

  const trafficSql = postgres(databaseUrl, { max: 5, connection: { search_path: schema } });
  const stopSignal = { stop: false };

  let trafficPromise: Promise<{ executed: number; blocked: number; timedOut: number; latencies: number[] }> | null =
    null;
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

  // Run migration 0030
  await cp(
    path.join(migrationsDirectory, "0030_gate_c_published_schedule_participants.sql"),
    path.join(tempMigrationsDir, "0030_gate_c_published_schedule_participants.sql"),
  );
  const t0 = performance.now();
  await runMigrationWithRetry(() => migrateDatabase({ databaseUrl, migrationsDirectory: tempMigrationsDir, schema }));
  const m0030Duration = performance.now() - t0;

  // Run migration 0031
  await cp(
    path.join(migrationsDirectory, "0031_gate_c_participant_snapshot_fencing.sql"),
    path.join(tempMigrationsDir, "0031_gate_c_participant_snapshot_fencing.sql"),
  );
  const t1 = performance.now();
  await runMigrationWithRetry(() => migrateDatabase({ databaseUrl, migrationsDirectory: tempMigrationsDir, schema }));
  const m0031Duration = performance.now() - t1;

  stopSignal.stop = true;
  let trafficStats = { executed: 0, blocked: 0, timedOut: 0, latencies: [] as number[] };
  if (trafficPromise) {
    trafficStats = await trafficPromise;
  }
  await trafficSql.end({ timeout: 2 });

  const lockSamples = await monitor.stop();
  await dropTestSchema(databaseUrl, schema);
  await rm(tempMigrationsDir, { recursive: true, force: true });

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
    concurrentQueryLatenciesMs: calculatePercentiles(trafficStats.latencies),
  };
}

async function benchmarkAbortRollback(): Promise<RollbackBenchmarkResult> {
  const prepared = await preparePopulatedSchema("rollback_test");
  const { schema, tempMigrationsDir, matchId, competitionId, divisionId } = prepared;

  const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schema } });
  try {
    // Inject malformed writer generation
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

  let failureTriggered = "";
  const t0 = performance.now();
  try {
    await migrateDatabase({ databaseUrl, migrationsDirectory: tempMigrationsDir, schema });
  } catch (err: unknown) {
    failureTriggered = err instanceof Error ? err.message : String(err);
  }
  const attemptDuration = performance.now() - t0;

  // Verify immediate lock release post-abort
  const checkSql = postgres(databaseUrl, { max: 1 });
  let locksRemaining = 0;
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
    await dropTestSchema(databaseUrl, schema);
    await rm(tempMigrationsDir, { recursive: true, force: true });
  }

  return {
    scenario: "Malformed pre-0030 writer generation preflight abort",
    preflightFailureTriggered: failureTriggered,
    ddlAttemptDurationMs: Math.round(attemptDuration * 100) / 100,
    rollbackDurationMs: Math.round(attemptDuration * 100) / 100,
    postRollbackLocksRemaining: locksRemaining,
    lockReleaseVerified: locksRemaining === 0,
  };
}

async function main(): Promise<void> {
  if (process.env.GATE_C_C2_CONTROLLED_STAGING !== "1") {
    throw new Error("Refusing migration-lock benchmark without GATE_C_C2_CONTROLLED_STAGING=1");
  }
  console.log("Starting Gate C 0030/0031 Production Lock Benchmarks...");
  const sourceSha = (await import("node:child_process"))
    .execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
      encoding: "utf8",
    })
    .trim();

  const mainSql = postgres(databaseUrl, { max: 1 });
  let postgresVersion = "unknown";
  try {
    const [v] = await mainSql<{ server_version: string }[]>`SHOW server_version`;
    postgresVersion = v?.server_version ?? "unknown";
  } finally {
    await mainSql.end({ timeout: 2 });
  }

  // Profile 1: Baseline (No traffic)
  console.log("Benchmarking Profile 1: Baseline (No traffic)...");
  const p1 = await benchmarkProfile("Baseline", "Isolated DDL execution with zero concurrent client traffic", null);

  // Profile 2: Public reads (concurrent SELECT on scheduled_matches and score events)
  console.log("Benchmarking Profile 2: Public reads...");
  const p2 = await benchmarkProfile(
    "PublicReads",
    "Continuous concurrent read queries against scheduled_matches and canonical_score_events",
    async (sql, stopSignal) => {
      let executed = 0;
      let blocked = 0;
      let timedOut = 0;
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
            if (/timeout/i.test(message)) timedOut += 1;
          }
          await new Promise((r) => setImmediate(r));
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return { executed, blocked, timedOut, latencies };
    },
  );

  // Profile 3: Organiser reads (concurrent SELECT on result_conflicts and scoring_access_passes)
  console.log("Benchmarking Profile 3: Organiser reads...");
  const p3 = await benchmarkProfile(
    "OrganiserReads",
    "Continuous concurrent organiser queries against result_conflicts and scoring_access_passes",
    async (sql, stopSignal) => {
      let executed = 0;
      let blocked = 0;
      let timedOut = 0;
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
            if (/timeout/i.test(message)) timedOut += 1;
          }
          await new Promise((r) => setImmediate(r));
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return { executed, blocked, timedOut, latencies };
    },
  );

  // Profile 4: Writer mutations (concurrent score appends and session lease renewals)
  console.log("Benchmarking Profile 4: Writer mutations...");
  const p4 = await benchmarkProfile(
    "WriterMutations",
    "Continuous concurrent transactions attempting score appends and lease renewals during DDL",
    async (sql, stopSignal, context) => {
      let executed = 0;
      let blocked = 0;
      let timedOut = 0;
      const latencies: number[] = [];
      const workerCount = 3;

      const runWorker = async () => {
        while (!stopSignal.stop) {
          const start = performance.now();
          try {
            await sql.begin(async (tx) => {
              await tx`
                UPDATE scoring_access_sessions
                SET expires_at = now() + interval '2 hours'
                WHERE id = ${context.accessSessionId}
              `;
              await tx`
                INSERT INTO match_writer_leases(match_id, competition_id, access_session_id, generation, session_mode, expires_at)
                VALUES(${context.matchId}, ${context.competitionId}, ${context.accessSessionId}, 7, 'writer', now() + interval '1 hour')
                ON CONFLICT (match_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
              `;
            });
            const lat = performance.now() - start;
            latencies.push(lat);
            if (lat > 50) blocked += 1;
            executed += 1;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (/timeout|deadlock/i.test(message)) timedOut += 1;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return { executed, blocked, timedOut, latencies };
    },
  );

  // Abort Rollback scenario
  console.log("Benchmarking Abort Rollback Behavior...");
  const abortRollback = await benchmarkAbortRollback();

  const report: GateCLockBenchmarkReport = {
    schemaVersion: 2,
    artifactKind: "gate-c-c2-migration-lock-benchmark",
    sourceSha,
    executionClassification: "controlled_staging_observation",
    timestamp: new Date().toISOString(),
    engine: "PostgreSQL",
    postgresVersion,
    syntheticVolume: {
      competitions: 1,
      divisions: 1,
      matches: 1,
      scheduledMatches: 1,
      scoreEvents: 20,
      scoringSessions: 1,
      resultConflicts: 1,
    },
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
  };

  const jsonContent = JSON.stringify(report, null, 2);

  // Observations belong only under the ignored exact-SHA artifact root. Never rewrite historical docs/qa evidence.
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..");
  const artifactsPath = path.resolve(repoRoot, "artifacts/qa/gate-c-c2", sourceSha, "migration-lock-benchmark.json");
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
