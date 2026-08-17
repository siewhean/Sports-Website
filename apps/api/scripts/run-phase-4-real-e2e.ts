import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { hashSessionSecret, systemClock, type PostgresJsSql } from "@matchday/identity";
import {
  DomainScheduleOptimizer,
  PostgresScheduleJobStore,
  ScheduleJobQueue,
  SchedulerRuntime,
} from "@matchday/scheduler";
import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../src/app.js";
import { DeterministicPhase4AiStub } from "../src/phase-4-ai-provider.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../src/phase-4-reliable-runtime.js";
import { verifiedScoringRateLimitSessionId } from "../src/scoring-rate-limit-identity.js";

const defaultApiPort = 4101;
const defaultWebPort = 3103;
const minimumUnprivilegedPort = 1024;
const maximumPort = 65_535;
const realE2eProjectNames = [
  "phase-4-real-phone-chromium",
  "phase-4-real-tablet-webkit",
  "phase-4-real-desktop-chromium",
] as const;
type RealE2eProjectName = (typeof realE2eProjectNames)[number];

export function resolveHarnessPorts(environment: NodeJS.ProcessEnv): { apiPort: number; webPort: number } {
  const resolvePort = (name: "PHASE4_E2E_API_PORT" | "PHASE4_E2E_WEB_PORT", fallback: number): number => {
    const raw = environment[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer port, received ${JSON.stringify(raw)}`);
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < minimumUnprivilegedPort || port > maximumPort)
      throw new Error(
        `${name} must be between ${minimumUnprivilegedPort} and ${maximumPort}, received ${JSON.stringify(raw)}`,
      );
    return port;
  };

  const apiPort = resolvePort("PHASE4_E2E_API_PORT", defaultApiPort);
  const webPort = resolvePort("PHASE4_E2E_WEB_PORT", defaultWebPort);
  if (apiPort === webPort) throw new Error("PHASE4_E2E_API_PORT and PHASE4_E2E_WEB_PORT must be different");
  return { apiPort, webPort };
}

export function resolveHarnessRunCount(environment: NodeJS.ProcessEnv): 1 | 2 {
  const raw = environment.PHASE4_E2E_RUNS;
  if (raw === undefined || raw.trim() === "") return 2;
  if (raw === "1" || raw === "2") return Number(raw) as 1 | 2;
  throw new Error(`PHASE4_E2E_RUNS must be 1 or 2, received ${JSON.stringify(raw)}`);
}

export function resolveHarnessProjects(environment: NodeJS.ProcessEnv): readonly RealE2eProjectName[] {
  const requested = environment.PHASE4_E2E_PROJECT?.trim();
  if (!requested) return realE2eProjectNames;
  if ((realE2eProjectNames as readonly string[]).includes(requested)) return [requested as RealE2eProjectName];
  throw new Error(
    `PHASE4_E2E_PROJECT must be one of ${realE2eProjectNames.join(", ")}, received ${JSON.stringify(requested)}`,
  );
}

const { apiPort, webPort } = resolveHarnessPorts(process.env);
const httpsProxyPort = webPort + 1;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `https://localhost:${httpsProxyPort}`;
const databasePrefix = "matchday_phase4_e2e_";
const schemaPrefix = "test_phase4_e2e_";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const adminDatabaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const baseRedisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";

type Tail = { label: string; lines: string[] };
type RunningProcess = { child: ChildProcess; tail: Tail };
const activeProcesses = new Set<RunningProcess>();
type Isolation =
  | { kind: "database"; databaseName: string; databaseUrl: string }
  | { kind: "schema"; schema: string; databaseUrl: string };

type RunConfiguration = {
  recordFile: string;
  redisDatabase: number;
};

type IsolationRecord = {
  run: number;
  status: "passed" | "failed";
  started_at_utc: string;
  finished_at_utc: string;
  postgres: { kind: Isolation["kind"]; identifier: string } | null;
  redis: {
    logical_database: number;
    namespace_redacted: string | null;
    namespace_hash: string | null;
    initial_owned_key_count: number | null;
    final_owned_key_count: number | null;
    unrelated_guard_preserved: boolean | null;
  };
};

export type RedisOwnership = {
  queueName: string;
  rateLimitNameSpace: string;
  namespaceHash: string;
  scanPatterns: readonly string[];
};

type SeedState = {
  apiOrigin: string;
  webOrigin: string;
  organisationId: string;
  fixtureKey: string;
  organiserCookie: string;
};

type BrowserJourneyResult = {
  project: string;
  competitionId: string;
  slug: string;
  divisionIds: [string, string];
  moved: {
    match_id: string;
    playing_area_id: string;
    slot_id: string;
    start_epoch_ms: number;
    end_epoch_ms: number;
  };
};

type V1BrowserJourneyResult = {
  project: string;
  competitionId: string;
  slug: string;
  divisionIds: [string, string];
  matchId: string;
  moved: {
    match_id: string;
    playing_area_id: string;
    start_epoch_ms: number;
    end_epoch_ms: number;
  };
};

/**
 * A deliberately fuller V1 proof than the setup/single-result journey above.
 * The browser creates one eight-entry division, completes every group fixture
 * through the scorekeeper surface, then completes an automatically populated
 * championship bracket through the final and bronze match. The ids are only receipts for the database
 * oracle; no scoring decision is made outside the rendered application.
 */
type V1CompetitionJourneyResult = {
  project: string;
  competitionId: string;
  slug: string;
  divisionId: string;
  groupMatchIds: string[];
  progressedMatchIds: string[];
  completedMatchIds?: string[];
  initialStage?: "groups" | "championship";
  correctedMatchId?: string;
};

function safeIdentifier(value: string, prefix: string): string {
  if (!value.startsWith(prefix) || !/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error(`Refusing unsafe database identifier: ${value}`);
  return value;
}

function databaseUrlFor(name: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function redisUrlForLogicalDatabase(logicalDatabase: number): string {
  if (!Number.isInteger(logicalDatabase) || logicalDatabase < 0 || logicalDatabase > 15)
    throw new Error(`Refusing unsafe Redis logical database: ${logicalDatabase}`);
  const url = new URL(baseRedisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:")
    throw new Error(`Phase 4 real E2E requires a redis URL, received ${url.protocol}`);
  url.pathname = `/${logicalDatabase}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sanitizedIsolationIdentifier(isolation: Isolation): string {
  return isolation.kind === "database" ? isolation.databaseName : isolation.schema;
}

const queueNamePattern =
  /^matchday-phase4-real-e2e-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const redisScanCount = 100;
const redisUnlinkBatchSize = 100;
const maximumOwnedRedisKeys = 25_000;
const maximumRedisScanIterations = 10_000;
const redactedRedisNamespace = "matchday-phase4-real-e2e-[uuid]";

export function sha256Identifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createRedisOwnership(queueName: string): RedisOwnership {
  const match = queueNamePattern.exec(queueName);
  if (!match?.[1]) throw new Error("Refusing non-canonical Phase 4 real E2E queue name");
  const runId = match[1];
  const rateLimitNameSpace = `matchday:phase4-real-e2e:rate-limit:${runId}:`;
  const scanPatterns = [
    `bull:${queueName}:*`,
    `bull:${queueName}.dead-letter:*`,
    `matchday:job-cancellation:bull:${queueName}:*`,
    `${rateLimitNameSpace}*`,
  ] as const;
  return {
    queueName,
    rateLimitNameSpace,
    namespaceHash: sha256Identifier(`${queueName}\0${rateLimitNameSpace}`),
    scanPatterns,
  };
}

export function isOwnedRedisKey(ownership: RedisOwnership, key: string): boolean {
  return (
    key.startsWith(`bull:${ownership.queueName}:`) ||
    key.startsWith(`bull:${ownership.queueName}.dead-letter:`) ||
    key.startsWith(`matchday:job-cancellation:bull:${ownership.queueName}:`) ||
    key.startsWith(ownership.rateLimitNameSpace)
  );
}

async function scanOwnedRedisKeys(redis: Redis, ownership: RedisOwnership): Promise<string[]> {
  const ownedKeys = new Set<string>();
  for (const pattern of ownership.scanPatterns) {
    let cursor = "0";
    let iterations = 0;
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", redisScanCount);
      cursor = nextCursor;
      iterations += 1;
      if (iterations > maximumRedisScanIterations)
        throw new Error(`Phase 4 Redis owned-key scan exceeded ${maximumRedisScanIterations} iterations`);
      for (const key of keys) {
        if (!isOwnedRedisKey(ownership, key))
          throw new Error(`Phase 4 Redis scan returned a key outside the owned namespace`);
        ownedKeys.add(key);
        if (ownedKeys.size > maximumOwnedRedisKeys)
          throw new Error(`Phase 4 Redis owned-key count exceeded ${maximumOwnedRedisKeys}`);
      }
    } while (cursor !== "0");
  }
  return [...ownedKeys].sort();
}

export async function assertEmptyOwnedRedisNamespace(redis: Redis, ownership: RedisOwnership): Promise<number> {
  const keys = await scanOwnedRedisKeys(redis, ownership);
  if (keys.length !== 0)
    throw new Error(
      `Phase 4 Redis startup found ${keys.length} keys in namespace ${ownership.namespaceHash}; refusing deletion`,
    );
  return keys.length;
}

export async function unlinkOwnedRedisKeys(redis: Redis, ownership: RedisOwnership): Promise<number> {
  const keys = await scanOwnedRedisKeys(redis, ownership);
  for (let index = 0; index < keys.length; index += redisUnlinkBatchSize) {
    const batch = keys.slice(index, index + redisUnlinkBatchSize);
    if (batch.length > 0) await redis.unlink(...batch);
  }
  const remaining = await scanOwnedRedisKeys(redis, ownership);
  if (remaining.length !== 0)
    throw new Error(`Phase 4 Redis cleanup left ${remaining.length} keys in namespace ${ownership.namespaceHash}`);
  return remaining.length;
}

async function appendIsolationRecord(recordFile: string, record: IsolationRecord): Promise<void> {
  await mkdir(path.dirname(recordFile), { recursive: true, mode: 0o700 });
  await appendFile(recordFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function appendTail(tail: Tail, chunk: Buffer | string): void {
  tail.lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  if (tail.lines.length > 200) tail.lines.splice(0, tail.lines.length - 200);
}

function printTail(tail: Tail): void {
  if (tail.lines.length) process.stderr.write(`\n[${tail.label} — bounded tail]\n${tail.lines.join("\n")}\n`);
}

function startProcess(label: string, command: string, args: string[], env: NodeJS.ProcessEnv): RunningProcess {
  const tail: Tail = { label, lines: [] };
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => appendTail(tail, chunk));
  child.stderr?.on("data", (chunk) => appendTail(tail, chunk));
  const running = { child, tail };
  activeProcesses.add(running);
  child.once("exit", () => activeProcesses.delete(running));
  return running;
}

async function runProcess(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  printOnSuccess = false,
): Promise<void> {
  const running = startProcess(label, command, args, env);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    running.child.once("error", reject);
    running.child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    printTail(running.tail);
    throw new Error(`${label} exited with code ${String(exitCode)}`);
  }
  if (printOnSuccess) printTail(running.tail);
}

async function stopProcess(running: RunningProcess | null): Promise<void> {
  if (!running?.child.pid || running.child.exitCode !== null) return;
  const target = process.platform === "win32" ? running.child.pid : -running.child.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => running.child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // The process exited between the timeout and forced shutdown.
    }
  }
}

async function waitFor(url: string, label: string, running?: RunningProcess, expectedBuildId?: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (running && running.child.exitCode !== null)
      throw new Error(`${label} exited before readiness with code ${String(running.child.exitCode)}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      const buildId = response.headers.get("x-matchday-build-id");
      if (response.ok && (!expectedBuildId || buildId === expectedBuildId)) return;
      lastError = response.ok
        ? `build ${buildId ?? "(missing)"}, expected ${expectedBuildId}`
        : `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function prepareIsolation(admin: Sql): Promise<Isolation> {
  const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  const privilege = await admin<{ allowed: boolean }[]>`
    SELECT (rolcreatedb OR rolsuper) AS allowed FROM pg_roles WHERE rolname=current_user
  `;
  if (privilege[0]?.allowed) {
    const databaseName = safeIdentifier(`${databasePrefix}${suffix}`, databasePrefix);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = databaseUrlFor(databaseName);
    await migrateDatabase({ databaseUrl, migrationsDirectory });
    return { kind: "database", databaseName, databaseUrl };
  }
  const schema = safeIdentifier(`${schemaPrefix}${suffix}`, schemaPrefix);
  await migrateDatabase({ databaseUrl: adminDatabaseUrl, migrationsDirectory, schema });
  return { kind: "schema", schema, databaseUrl: adminDatabaseUrl };
}

function connectIsolation(isolation: Isolation): Sql {
  return isolation.kind === "schema"
    ? postgres(isolation.databaseUrl, {
        max: 10,
        onnotice: () => undefined,
        connection: { search_path: `${isolation.schema},public` },
      })
    : postgres(isolation.databaseUrl, { max: 10, onnotice: () => undefined });
}

async function seed(sql: Sql, fixtureKey: string): Promise<SeedState> {
  const accountId = randomUUID();
  const organisationId = randomUUID();
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO accounts (id,primary_email,display_name,email_verified_at)
      VALUES (${accountId},${`organiser+${fixtureKey}@phase4-e2e.test`},'Phase 4 E2E Organiser',now())
    `;
    await transaction`
      INSERT INTO organisations (id,name,slug)
      VALUES (${organisationId},'Phase 4 E2E Org',${`phase-4-e2e-org-${fixtureKey}`})
    `;
    await transaction`
      INSERT INTO organisation_memberships (organisation_id,account_id,role,status)
      VALUES (${organisationId},${accountId},'owner','active')
    `;
  });
  const sessionId = randomUUID();
  const sessionSecret = randomBytes(32).toString("base64url");
  const now = new Date();
  await sql`INSERT INTO identity_sessions(
    id,account_id,secret_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at
  ) VALUES(
    ${sessionId},${accountId},${hashSessionSecret(sessionSecret)},${now},${now},
    ${new Date(now.getTime() + 30 * 60_000)},${new Date(now.getTime() + 12 * 60 * 60_000)}
  )`;
  return {
    apiOrigin,
    webOrigin,
    organisationId,
    fixtureKey,
    organiserCookie: `matchday_session=${sessionId}.${sessionSecret}`,
  };
}

async function assertDatabaseOracle(sql: Sql, result: BrowserJourneyResult): Promise<void> {
  const rows = await sql<
    {
      setup_count: number;
      published_count: number;
      schedule_version: number;
      audit_count: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM setup_drafts WHERE competition_id=${result.competitionId}) setup_count,
      (SELECT count(*)::int FROM schedule_revisions WHERE competition_id=${result.competitionId} AND status='published') published_count,
      (SELECT schedule_version::int FROM competition_publications WHERE competition_id=${result.competitionId}) schedule_version,
      (SELECT count(*)::int FROM audit_events WHERE target_id=${result.competitionId} OR target_id IN (
        SELECT id::text FROM schedule_revisions WHERE competition_id=${result.competitionId}
      )) audit_count
  `;
  const row = rows[0];
  if (!row || row.setup_count !== 1 || row.published_count !== 1 || row.schedule_version !== 1)
    throw new Error(`Phase 4 persistence oracle failed: ${JSON.stringify(row)}`);
  if (row.audit_count < 4) throw new Error(`Phase 4 audit oracle was incomplete: ${JSON.stringify(row)}`);
  const moved = await sql<
    {
      published_revision_id: string;
      parent_revision_id: string;
      match_id: string;
      playing_area_id: string;
      starts_at: Date | string;
      ends_at: Date | string;
    }[]
  >`
    SELECT child.schedule_revision_id published_revision_id,sr.parent_revision_id,
           child.match_id,child.playing_area_id,child.starts_at,child.ends_at
    FROM competition_publications cp
    JOIN schedule_revisions sr ON sr.id=cp.published_schedule_revision_id
    JOIN scheduled_matches child ON child.schedule_revision_id=sr.id
    JOIN scheduled_matches parent ON parent.schedule_revision_id=sr.parent_revision_id AND parent.match_id=child.match_id
    WHERE cp.competition_id=${result.competitionId}
      AND (child.playing_area_id,child.starts_at,child.ends_at)
          IS DISTINCT FROM (parent.playing_area_id,parent.starts_at,parent.ends_at)
  `;
  const changed = moved[0];
  if (
    moved.length !== 1 ||
    !changed ||
    changed.match_id !== result.moved.match_id ||
    changed.playing_area_id !== result.moved.playing_area_id ||
    new Date(changed.starts_at).getTime() !== result.moved.start_epoch_ms ||
    new Date(changed.ends_at).getTime() !== result.moved.end_epoch_ms
  )
    throw new Error(`Published move oracle failed: ${JSON.stringify(moved)}`);
  const projectionRows = await sql<{ projection: unknown }[]>`
    SELECT p.projection FROM competition_publications cp
    JOIN public_competition_projections p ON p.competition_id=cp.competition_id
      AND p.schedule_version=cp.schedule_version AND p.result_version=cp.result_version
    WHERE cp.competition_id=${result.competitionId}
  `;
  const projection = projectionRows[0]?.projection;
  const projectionObject =
    typeof projection === "string"
      ? (JSON.parse(projection) as Record<string, unknown>)
      : (projection as Record<string, unknown> | undefined);
  const divisions = Array.isArray(projectionObject?.divisions) ? projectionObject.divisions : [];
  const schedule = divisions.flatMap((division) => {
    if (division === null || typeof division !== "object") return [];
    const divisionSchedule = (division as Record<string, unknown>).schedule;
    return Array.isArray(divisionSchedule) ? divisionSchedule : [];
  });
  const publicMoved = schedule.find(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).id === changed.match_id,
  );
  const publicArea =
    publicMoved?.area !== null && typeof publicMoved?.area === "object"
      ? (publicMoved.area as Record<string, unknown>)
      : undefined;
  if (
    !publicMoved ||
    publicMoved.starts_at !== new Date(result.moved.start_epoch_ms).toISOString() ||
    publicMoved.ends_at !== new Date(result.moved.end_epoch_ms).toISOString() ||
    publicArea?.id !== result.moved.playing_area_id
  )
    throw new Error(`Public move projection oracle failed: ${JSON.stringify(publicMoved)}`);
  const aggregate = await sql<
    {
      sport_code: string;
      division_count: number;
      entry_count: number;
      settings_count: number;
      competition_settings_valid: boolean;
      division_settings_valid: boolean;
      published_formats: number;
      exact_formats: number;
      materialised_matches: number;
      schedule_jobs: number;
      schedule_objectives: number;
      child_revisions: number;
      lock_count: number;
      outbox_count: number;
      setup_read_only: boolean;
      audit_actions: string[];
      outbox_types: string[];
      selected_recommendation: boolean;
      setup_schedule_valid: boolean;
      setup_publication_valid: boolean;
      locked_different_match: boolean;
      division_ids: string[];
    }[]
  >`
    SELECT c.sport_code,
      (SELECT count(*)::int FROM divisions d WHERE d.competition_id=c.id) division_count,
      (SELECT count(*)::int FROM division_entries e JOIN divisions d ON d.id=e.division_id
        WHERE d.competition_id=c.id AND e.status IN ('active','confirmed')) entry_count,
      (SELECT count(*)::int FROM division_sport_settings s WHERE s.competition_id=c.id) settings_count,
      (SELECT count(*)=1 FROM competition_sport_settings s
        JOIN sport_pack_versions p ON p.sport_code=s.sport_code AND p.version=s.pack_version
        WHERE s.competition_id=c.id AND s.sport_code=c.sport_code) competition_settings_valid,
      (SELECT count(*)=2 FROM division_sport_settings s
        JOIN sport_pack_versions p ON p.sport_code=s.sport_code AND p.version=s.pack_version
        WHERE s.competition_id=c.id AND s.sport_code=c.sport_code) division_settings_valid,
      (SELECT count(*)::int FROM format_revisions f WHERE f.competition_id=c.id AND f.status='published') published_formats,
      (SELECT count(*)::int FROM format_revisions f WHERE f.competition_id=c.id
        AND f.status='published' AND phase4_materialization_is_exact(f.id)
        AND f.graph_materialization_hash=phase4_expected_materialization_hash(f.id)) exact_formats,
      (SELECT count(*)::int FROM matches m JOIN format_revisions f ON f.id=m.format_revision_id
        WHERE f.competition_id=c.id) materialised_matches,
      (SELECT count(*)::int FROM schedule_generation_jobs j WHERE j.competition_id=c.id) schedule_jobs,
      (SELECT count(DISTINCT objective)::int FROM schedule_generation_jobs j WHERE j.competition_id=c.id) schedule_objectives,
      (SELECT count(*)::int FROM schedule_revisions r WHERE r.competition_id=c.id AND r.parent_revision_id IS NOT NULL) child_revisions,
      (SELECT count(*)::int FROM schedule_assignment_locks l WHERE l.competition_id=c.id) lock_count,
      (SELECT count(*)::int FROM outbox_events o WHERE o.aggregate_id=c.id::text OR o.payload->>'competition_id'=c.id::text) outbox_count,
      (SELECT status='completed' FROM setup_drafts s WHERE s.competition_id=c.id ORDER BY created_at DESC LIMIT 1) setup_read_only,
      (SELECT array_agg(DISTINCT a.action ORDER BY a.action) FROM audit_events a
        WHERE a.organisation_id=c.organisation_id) audit_actions,
      (SELECT array_agg(DISTINCT o.event_type ORDER BY o.event_type) FROM outbox_events o
        WHERE o.aggregate_id=c.id::text OR o.payload->>'competition_id'=c.id::text
          OR o.aggregate_id IN (SELECT id::text FROM setup_drafts WHERE competition_id=c.id)
          OR o.aggregate_id IN (SELECT id::text FROM format_revisions WHERE competition_id=c.id)
          OR o.aggregate_id IN (SELECT id::text FROM schedule_revisions WHERE competition_id=c.id)
          OR o.aggregate_id IN (SELECT id::text FROM schedule_generation_jobs WHERE competition_id=c.id)
          OR o.aggregate_id IN (SELECT id::text FROM matches WHERE competition_id=c.id)) outbox_types,
      (SELECT s.steps->'format_recommendations'->>'selected_recommendation_id' IS NOT NULL
        FROM setup_drafts s WHERE s.competition_id=c.id) selected_recommendation,
      (SELECT NOT phase4_setup_schedule_evidence_stale(
          c.id,s.steps->'capacity',s.steps->'settings',s.steps->'format_recommendations',s.steps->'schedule_review')
        FROM setup_drafts s WHERE s.competition_id=c.id) setup_schedule_valid,
      (SELECT NOT phase4_setup_publication_evidence_stale(
          c.id,s.steps->'capacity',s.steps->'settings',s.steps->'schedule_review',s.steps->'review_publish')
        FROM setup_drafts s WHERE s.competition_id=c.id) setup_publication_valid,
      (SELECT bool_and(l.match_id<>${result.moved.match_id})
        FROM schedule_assignment_locks l WHERE l.competition_id=c.id) locked_different_match,
      (SELECT array_agg(d.id::text ORDER BY d.id::text) FROM divisions d WHERE d.competition_id=c.id) division_ids
    FROM competitions c WHERE c.id=${result.competitionId}
  `;
  const aggregateRow = aggregate[0];
  if (
    !aggregateRow ||
    aggregateRow.sport_code !== "canoe_polo" ||
    aggregateRow.division_count !== 2 ||
    aggregateRow.entry_count !== 16 ||
    aggregateRow.settings_count !== 2 ||
    !aggregateRow.competition_settings_valid ||
    !aggregateRow.division_settings_valid ||
    aggregateRow.published_formats !== 2 ||
    aggregateRow.exact_formats !== 2 ||
    aggregateRow.materialised_matches <= 0 ||
    aggregateRow.schedule_jobs < 3 ||
    aggregateRow.schedule_objectives !== 3 ||
    aggregateRow.child_revisions < 1 ||
    aggregateRow.lock_count !== 1 ||
    aggregateRow.outbox_count <= 0 ||
    !aggregateRow.setup_read_only ||
    !aggregateRow.selected_recommendation ||
    !aggregateRow.setup_schedule_valid ||
    !aggregateRow.setup_publication_valid ||
    !aggregateRow.locked_different_match ||
    JSON.stringify(aggregateRow.division_ids) !== JSON.stringify([...result.divisionIds].sort())
  )
    throw new Error(`Browser-owned aggregate oracle failed: ${JSON.stringify(aggregateRow)}`);
  const expectedEvidence = [
    "setup.created",
    "setup.saved",
    "format.published",
    "schedule.option.accepted",
    "schedule.assignment.locked",
    "schedule.match.moved",
    "schedule.published",
  ];
  for (const action of expectedEvidence) {
    if (!aggregateRow.audit_actions.includes(action))
      throw new Error(`Missing audit evidence ${action}: ${JSON.stringify(aggregateRow.audit_actions)}`);
    if (!aggregateRow.outbox_types.includes(action))
      throw new Error(`Missing outbox evidence ${action}: ${JSON.stringify(aggregateRow.outbox_types)}`);
  }
  process.stdout.write(
    `Phase 4 persistence oracle: ${JSON.stringify({ ...row, moved_match_id: changed.match_id, published_revision_id: changed.published_revision_id, parent_revision_id: changed.parent_revision_id })}\n`,
  );
}

async function assertV1DatabaseOracle(sql: Sql, result: V1BrowserJourneyResult): Promise<void> {
  const [aggregate] = await sql<
    {
      division_count: number;
      entry_count: number;
      published_formats: number;
      materialised_formats: number;
      published_schedules: number;
      child_revisions: number;
      schedule_version: number;
      result_version: number;
      finalised_results: number;
      audit_count: number;
      outbox_count: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM divisions WHERE competition_id=c.id) division_count,
      (SELECT count(*)::int FROM division_entries entry JOIN divisions division ON division.id=entry.division_id
        WHERE division.competition_id=c.id AND entry.status IN ('active','confirmed')) entry_count,
      (SELECT count(*)::int FROM format_revisions WHERE competition_id=c.id AND status='published') published_formats,
      (SELECT count(*)::int FROM format_revisions format WHERE format.competition_id=c.id AND status='published'
        AND phase4_materialization_is_exact(format.id)) materialised_formats,
      (SELECT count(*)::int FROM schedule_revisions WHERE competition_id=c.id AND status='published') published_schedules,
      (SELECT count(*)::int FROM schedule_revisions WHERE competition_id=c.id AND parent_revision_id IS NOT NULL) child_revisions,
      COALESCE((SELECT schedule_version::int FROM competition_publications WHERE competition_id=c.id),0) schedule_version,
      COALESCE((SELECT result_version::int FROM competition_publications WHERE competition_id=c.id),0) result_version,
      (SELECT count(*)::int FROM match_result_snapshots snapshot JOIN matches match ON match.id=snapshot.match_id
        WHERE match.competition_id=c.id AND snapshot.state='final') finalised_results,
      (SELECT count(*)::int FROM audit_events WHERE organisation_id=c.organisation_id) audit_count,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=c.id::text
        OR payload->>'competition_id'=c.id::text) outbox_count
    FROM competitions c WHERE c.id=${result.competitionId}
  `;
  if (
    !aggregate ||
    aggregate.division_count !== 2 ||
    aggregate.entry_count !== 8 ||
    aggregate.published_formats !== 2 ||
    aggregate.materialised_formats !== 2 ||
    aggregate.published_schedules !== 1 ||
    aggregate.child_revisions < 1 ||
    aggregate.schedule_version !== 1 ||
    aggregate.result_version < 1 ||
    aggregate.finalised_results !== 1 ||
    aggregate.audit_count < 5 ||
    aggregate.outbox_count < 5
  )
    throw new Error(`V1 aggregate persistence oracle failed: ${JSON.stringify(aggregate)}`);

  const [moved] = await sql<
    { match_id: string; playing_area_id: string; starts_at: Date | string; ends_at: Date | string }[]
  >`
    SELECT scheduled.match_id,scheduled.playing_area_id,scheduled.starts_at,scheduled.ends_at
    FROM competition_publications publication
    JOIN scheduled_matches scheduled ON scheduled.schedule_revision_id=publication.published_schedule_revision_id
    WHERE publication.competition_id=${result.competitionId} AND scheduled.match_id=${result.moved.match_id}
  `;
  if (
    !moved ||
    moved.playing_area_id !== result.moved.playing_area_id ||
    new Date(moved.starts_at).getTime() !== result.moved.start_epoch_ms ||
    new Date(moved.ends_at).getTime() !== result.moved.end_epoch_ms
  )
    throw new Error(`V1 moved schedule oracle failed: ${JSON.stringify(moved)}`);

  const [projectionRow] = await sql<{ projection: unknown }[]>`
    SELECT projection.projection
    FROM public_competition_projections projection
    JOIN competition_publications publication ON publication.competition_id=projection.competition_id
      AND publication.schedule_version=projection.schedule_version
      AND publication.result_version=projection.result_version
    WHERE projection.competition_id=${result.competitionId}
  `;
  const projection =
    typeof projectionRow?.projection === "string"
      ? (JSON.parse(projectionRow.projection) as Record<string, unknown>)
      : (projectionRow?.projection as Record<string, unknown> | undefined);
  const divisions = Array.isArray(projection?.divisions) ? projection.divisions : [];
  const publicMatches = divisions.flatMap((division) =>
    division && typeof division === "object" && Array.isArray((division as Record<string, unknown>).schedule)
      ? ((division as Record<string, unknown>).schedule as Array<Record<string, unknown>>)
      : [],
  );
  if (!publicMatches.some((match) => match.id === result.moved.match_id))
    throw new Error("V1 public projection omitted the moved match");
  const resultRows = await sql<{ event_type: string; sequence: number }[]>`
    SELECT event_type,sequence FROM canonical_score_events WHERE match_id=${result.matchId} ORDER BY sequence
  `;
  const expectedEventTypes = ["match_started", "goal", "period_change", "finalisation"];
  if (
    JSON.stringify(resultRows.map((row) => row.event_type)) !== JSON.stringify(expectedEventTypes) ||
    resultRows.some((row, index) => row.sequence !== index + 1)
  )
    throw new Error(`V1 scoring oracle failed: ${JSON.stringify(resultRows)}`);
  process.stdout.write(`V1 simple journey persistence oracle: ${JSON.stringify(aggregate)}\n`);
}

async function assertV1CompetitionDatabaseOracle(sql: Sql, result: V1CompetitionJourneyResult): Promise<void> {
  const [aggregate] = await sql<
    {
      division_count: number;
      entry_count: number;
      published_formats: number;
      exact_formats: number;
      published_schedules: number;
      opening_finalised: number;
      progressed_finalised: number;
      completed_finalised: number;
      automatic_qualifiers: number;
      unresolved_qualifiers: number;
      standings_snapshots: number;
      bracket_snapshots: number;
      public_result_version: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM divisions WHERE competition_id=c.id) division_count,
      (SELECT count(*)::int FROM division_entries entry JOIN divisions division ON division.id=entry.division_id
        WHERE division.competition_id=c.id AND entry.status IN ('active','confirmed')) entry_count,
      (SELECT count(*)::int FROM format_revisions WHERE competition_id=c.id AND status='published') published_formats,
      (SELECT count(*)::int FROM format_revisions format WHERE format.competition_id=c.id AND status='published'
        AND phase4_materialization_is_exact(format.id)) exact_formats,
      (SELECT count(*)::int FROM schedule_revisions WHERE competition_id=c.id AND status='published') published_schedules,
      (SELECT count(*)::int FROM matches match JOIN match_result_snapshots snapshot ON snapshot.match_id=match.id
        WHERE match.competition_id=c.id AND match.id = ANY(${sql.array(result.groupMatchIds)}::uuid[]) AND snapshot.state='final') opening_finalised,
      (SELECT count(*)::int FROM matches match JOIN match_result_snapshots snapshot ON snapshot.match_id=match.id
        WHERE match.competition_id=c.id AND match.id = ANY(${sql.array(result.progressedMatchIds)}::uuid[])
          AND snapshot.state='final' AND match.home_entry_id IS NOT NULL AND match.away_entry_id IS NOT NULL) progressed_finalised,
      (SELECT count(*)::int FROM matches match JOIN match_result_snapshots snapshot ON snapshot.match_id=match.id
        WHERE match.competition_id=c.id AND match.id = ANY(${sql.array(result.completedMatchIds ?? [...result.groupMatchIds, ...result.progressedMatchIds])}::uuid[])
          AND snapshot.state='final' AND match.home_entry_id IS NOT NULL AND match.away_entry_id IS NOT NULL) completed_finalised,
      (SELECT count(*)::int FROM advancement_slots slot JOIN matches match ON match.id=slot.match_id
        WHERE slot.competition_id=c.id AND match.graph_stage_id='championship'
          AND slot.control='automatic' AND slot.entry_id IS NOT NULL) automatic_qualifiers,
      (SELECT count(*)::int FROM advancement_slots slot JOIN matches match ON match.id=slot.match_id
        WHERE slot.competition_id=c.id AND match.graph_stage_id='championship'
          AND slot.control='automatic' AND slot.entry_id IS NULL) unresolved_qualifiers,
      (SELECT count(*)::int FROM standings_snapshots WHERE competition_id=c.id) standings_snapshots,
      (SELECT count(*)::int FROM bracket_snapshots WHERE competition_id=c.id) bracket_snapshots,
      COALESCE((SELECT result_version::int FROM competition_publications WHERE competition_id=c.id),0) public_result_version
    FROM competitions c WHERE c.id=${result.competitionId}
  `;
  const expectedOpeningIds = [...new Set(result.groupMatchIds)].sort();
  const actualOpeningIds = await sql<{ id: string }[]>`
    SELECT match.id::text AS id FROM matches match JOIN match_result_snapshots snapshot ON snapshot.match_id=match.id
    WHERE match.competition_id=${result.competitionId} AND match.id = ANY(${sql.array(result.groupMatchIds)}::uuid[]) AND snapshot.state='final'
    ORDER BY match.id::text
  `;
  const correction = result.correctedMatchId
    ? await sql<{ reopened: number; corrected: number; reversals: number }[]>`
        SELECT
          (SELECT count(*)::int FROM audit_events WHERE target_id=${result.correctedMatchId} AND action='result.reopened') reopened,
          (SELECT count(*)::int FROM audit_events WHERE target_id=${result.correctedMatchId} AND action='result.corrected') corrected,
          (SELECT count(*)::int FROM canonical_score_events WHERE match_id=${result.correctedMatchId} AND event_type='reversal') reversals
      `
    : [{ reopened: 0, corrected: 0, reversals: 0 }];
  const [currentProjection] = await sql<{ projection: unknown }[]>`
    SELECT projection.projection
    FROM competitions competition
    JOIN competition_publications publication ON publication.competition_id=competition.id
    JOIN public_competition_projections projection
      ON projection.competition_id=competition.id
      AND projection.schedule_version=publication.schedule_version
      AND projection.result_version=publication.result_version
    WHERE competition.id=${result.competitionId}
    LIMIT 1
  `;
  const projectionValue = currentProjection?.projection;
  const projectionRecord =
    typeof projectionValue === "string"
      ? (JSON.parse(projectionValue) as Record<string, unknown>)
      : projectionValue && typeof projectionValue === "object" && !Array.isArray(projectionValue)
        ? (projectionValue as Record<string, unknown>)
        : null;
  const divisions = Array.isArray(projectionRecord?.divisions) ? projectionRecord.divisions : [];
  const currentDivision =
    divisions.length === 1 && typeof divisions[0] === "object" && divisions[0] !== null
      ? (divisions[0] as Record<string, unknown>)
      : null;
  const projectionHasStandings =
    currentDivision?.standings !== null &&
    currentDivision?.standings !== undefined &&
    projectionRecord?.standings !== null;
  const projectionHasBracket =
    currentDivision?.bracket !== null && currentDivision?.bracket !== undefined && projectionRecord?.bracket !== null;
  const bracketRecord =
    currentDivision?.bracket && typeof currentDivision.bracket === "object" && !Array.isArray(currentDivision.bracket)
      ? (currentDivision.bracket as Record<string, unknown>)
      : null;
  const bracketPayload =
    bracketRecord?.bracket && typeof bracketRecord.bracket === "object" && !Array.isArray(bracketRecord.bracket)
      ? (bracketRecord.bracket as Record<string, unknown>)
      : bracketRecord;
  const bracketMatches = Array.isArray(bracketPayload?.matches) ? bracketPayload.matches : [];
  const projectionHasCanonicalBracket = result.progressedMatchIds.every((matchId) =>
    bracketMatches.some(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        ((candidate as Record<string, unknown>).matchId === matchId ||
          (candidate as Record<string, unknown>).match_id === matchId ||
          (candidate as Record<string, unknown>).id === matchId),
    ),
  );
  const progressedMatches = await sql<{ id: string; home_entry_id: string | null; away_entry_id: string | null }[]>`
    SELECT id::text AS id,home_entry_id,away_entry_id FROM matches
    WHERE id = ANY(${sql.array(result.progressedMatchIds)}::uuid[])
  `;
  const projectedSchedule = Array.isArray(currentDivision?.schedule) ? currentDivision.schedule : [];
  const projectionHasProgressedParticipants =
    progressedMatches.length === result.progressedMatchIds.length &&
    progressedMatches.every((match) => {
      const projected = projectedSchedule.find(
        (candidate): candidate is Record<string, unknown> =>
          candidate !== null && typeof candidate === "object" && candidate.id === match.id,
      );
      const projectedHome =
        projected?.home && typeof projected.home === "object"
          ? ((projected.home as Record<string, unknown>).id ?? null)
          : null;
      const projectedAway =
        projected?.away && typeof projected.away === "object"
          ? ((projected.away as Record<string, unknown>).id ?? null)
          : null;
      return (
        match.home_entry_id !== null &&
        match.away_entry_id !== null &&
        projectedHome === match.home_entry_id &&
        projectedAway === match.away_entry_id
      );
    });
  if (
    !aggregate ||
    aggregate.division_count !== 1 ||
    aggregate.entry_count !== (result.initialStage === "championship" ? 16 : 8) ||
    aggregate.published_formats !== 1 ||
    aggregate.exact_formats !== 1 ||
    aggregate.published_schedules !== 1 ||
    aggregate.opening_finalised !== result.groupMatchIds.length ||
    aggregate.progressed_finalised !== result.progressedMatchIds.length ||
    aggregate.completed_finalised !==
      (result.completedMatchIds ?? [...result.groupMatchIds, ...result.progressedMatchIds]).length ||
    aggregate.automatic_qualifiers < (result.initialStage === "championship" ? 14 : 6) ||
    aggregate.unresolved_qualifiers !== 0 ||
    aggregate.standings_snapshots < 1 ||
    aggregate.bracket_snapshots < 1 ||
    aggregate.public_result_version <
      (result.completedMatchIds ?? [...result.groupMatchIds, ...result.progressedMatchIds]).length ||
    !projectionHasStandings ||
    !projectionHasBracket ||
    !projectionHasCanonicalBracket ||
    !projectionHasProgressedParticipants ||
    JSON.stringify(actualOpeningIds.map((row) => row.id)) !== JSON.stringify(expectedOpeningIds) ||
    (result.correctedMatchId !== undefined &&
      (correction[0]?.reopened !== 1 || correction[0]?.corrected !== 1 || correction[0]?.reversals !== 1))
  )
    throw new Error(
      `V1 competition persistence oracle failed: ${JSON.stringify({
        aggregate,
        actualOpeningIds,
        correction: correction[0],
        projection: projectionRecord
          ? {
              keys: Object.keys(projectionRecord).sort(),
              division_count: divisions.length,
              division_keys: currentDivision ? Object.keys(currentDivision).sort() : [],
              projectionHasStandings,
              projectionHasBracket,
              projectionHasCanonicalBracket,
              projectionHasProgressedParticipants,
            }
          : null,
      })}`,
    );
  process.stdout.write(`V1 competition persistence oracle: ${JSON.stringify(aggregate)}\n`);
}

async function cleanupIsolation(admin: Sql, isolation: Isolation | null): Promise<void> {
  if (!isolation) return;
  if (isolation.kind === "database") {
    const name = safeIdentifier(isolation.databaseName, databasePrefix);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } else {
    await dropTestSchema(isolation.databaseUrl, isolation.schema);
  }
}

function assertPinnedToolchain(): void {
  if (process.version !== "v24.18.0")
    throw new Error(`Phase 4 real E2E requires Node v24.18.0; received ${process.version}`);
  const packageManager = process.env.npm_config_user_agent ?? "";
  if (!packageManager.startsWith("pnpm/10.33.0 "))
    throw new Error(`Phase 4 real E2E requires pnpm 10.33.0; received ${packageManager || "unknown"}`);
}

export async function runOnce(runNumber: number, configuration: RunConfiguration): Promise<void> {
  const startedAt = new Date().toISOString();
  const temp = await mkdtemp(path.join(tmpdir(), "matchday-phase4-e2e-"));
  const stateFile = path.join(temp, "state.json");
  const resultFile = path.join(temp, "browser-journeys.ndjson");
  const admin = postgres(adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  const redisUrl = redisUrlForLogicalDatabase(configuration.redisDatabase);
  const csrfSecret = randomBytes(32).toString("base64url");
  let isolation: Isolation | null = null;
  let sql: Sql | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let web: RunningProcess | null = null;
  let httpsProxy: RunningProcess | null = null;
  let scheduler: SchedulerRuntime | null = null;
  let scheduleQueue: ScheduleJobQueue | null = null;
  let queueName: string | null = null;
  let redisOwnership: RedisOwnership | null = null;
  let unrelatedGuardKey: string | null = null;
  let rateLimitRedis: Redis | null = null;
  let primaryError: unknown = null;
  let initialOwnedRedisKeyCount: number | null = null;
  let finalOwnedRedisKeyCount: number | null = null;
  let unrelatedGuardPreserved: boolean | null = null;
  const markInterrupted = () => {
    for (const running of activeProcesses) void stopProcess(running);
  };
  process.once("SIGINT", markInterrupted);
  process.once("SIGTERM", markInterrupted);
  try {
    if (!process.env.CI) {
      await runProcess(
        "local infrastructure",
        "docker",
        ["compose", "-f", "infra/local/compose.yaml", "up", "-d", "--wait", "postgres", "redis"],
        process.env,
      );
    }
    rateLimitRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    queueName = `matchday-phase4-real-e2e-${randomUUID()}`;
    redisOwnership = createRedisOwnership(queueName);
    initialOwnedRedisKeyCount = await assertEmptyOwnedRedisNamespace(rateLimitRedis, redisOwnership);
    unrelatedGuardKey = `bull:${queueName}-foreign:ttl-sentinel`;
    const guardCreated = await rateLimitRedis.set(unrelatedGuardKey, "preserve", "PX", 300_000, "NX");
    if (guardCreated !== "OK") throw new Error("Phase 4 Redis unrelated TTL guard already existed");
    process.stdout.write(
      `Phase 4 Redis startup isolation: ${JSON.stringify({
        logical_database: configuration.redisDatabase,
        namespace_redacted: redactedRedisNamespace,
        namespace_hash: redisOwnership.namespaceHash,
        initial_owned_key_count: initialOwnedRedisKeyCount,
      })}\n`,
    );
    isolation = await prepareIsolation(admin);
    sql = connectIsolation(isolation);
    const identitySql = sql as unknown as PostgresJsSql;
    const phase2 = new Phase2Runtime(
      identitySql,
      phase2DomainAdapter,
      undefined,
      undefined,
      "phase-4-e2e-fallback-code-hmac-secret",
    );
    const phase3 = new Phase3Runtime(identitySql, phase3DomainAdapter);
    scheduleQueue = new ScheduleJobQueue({ queueName, redisUrl });
    scheduler = new SchedulerRuntime({
      queueName,
      redisUrl,
      workerId: `phase4-real-e2e-${randomUUID()}`,
      store: new PostgresScheduleJobStore(sql),
      // The harness itself runs through tsx, while production runs the built
      // scheduler. Do not make solver startup inherit tsx loader hooks that
      // are absent from the production worker process.
      optimizer: new DomainScheduleOptimizer({ maxIterationsPerRun: 3, workerExecArgv: [] }),
      concurrency: 1,
      processor: { leaseMs: 5_000, cancellationPollMs: 20, maxYieldIntervalMs: 1_000 },
      onHealthChange: (health) => {
        if (health.reason) process.stdout.write(`Phase 4 scheduler health: ${JSON.stringify(health)}\n`);
      },
      onDeadLettered: (event) => {
        process.stdout.write(
          `Phase 4 scheduler dead letter: ${JSON.stringify({
            type: event.type,
            namespace_redacted: redactedRedisNamespace,
            namespace_hash: redisOwnership?.namespaceHash,
            job_id_sha256: sha256Identifier(event.jobId),
            job_name: event.jobName,
            attempts_made: event.attemptsMade,
            dead_lettered_at: event.deadLetteredAt,
          })}\n`,
        );
      },
    });
    const phase4 = new ReliableGateBPhase4Runtime(
      identitySql,
      phase3,
      scheduleQueue,
      {
        mode: "stub",
        provider: new DeterministicPhase4AiStub(),
        timeoutMs: 2_000,
        maximumAttempts: 1,
        cacheTtlSeconds: 3_600,
      },
      undefined,
      phase2,
    );
    await scheduler.start();
    const projectNames = resolveHarnessProjects(process.env);
    const projects: Record<string, SeedState> = {};
    for (const [index, projectName] of projectNames.entries()) {
      projects[projectName] = await seed(sql, `project-${index + 1}`);
    }
    await writeFile(stateFile, `${JSON.stringify({ projects })}\n`, { mode: 0o600 });
    await writeFile(resultFile, "", { mode: 0o600 });

    const config = parseConfig({
      ...process.env,
      APP_ENV: "test",
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      API_ALLOWED_ORIGINS: webOrigin,
      DATABASE_URL: isolation.databaseUrl,
      REDIS_URL: redisUrl,
      IDENTITY_CSRF_HMAC_SECRET: csrfSecret,
      LOG_LEVEL: "info",
    });
    const identity = new IdentityApiRuntime(
      new UnavailableIdentityProvider(),
      new PostgresIdentityUnitOfWork(identitySql),
      csrfSecret,
      systemClock,
    );
    const databaseProbe = async () => {
      try {
        return (await sql?.unsafe<{ ok: number }[]>("SELECT 1 ok"))?.[0]?.ok === 1;
      } catch {
        return false;
      }
    };
    app = await buildApp({
      config,
      probes: {
        database: databaseProbe,
        queue: databaseProbe,
        redis: async () => (await rateLimitRedis?.ping()) === "PONG",
      },
      rateLimitRedis,
      rateLimitNameSpace: redisOwnership.rateLimitNameSpace,
      resolveVerifiedScoringRateLimitSessionId: async (request) => {
        const sessionId = request.headers["x-scoring-session-id"];
        const sessionToken = request.headers["x-scoring-session-token"];
        if (typeof sessionId !== "string" || typeof sessionToken !== "string") return null;
        if (sessionToken.length < 32 || sessionToken.length > 256) return null;
        return verifiedScoringRateLimitSessionId(sql!, sessionId, sessionToken);
      },
      identityRuntime: identity,
      phase2Runtime: phase2,
      phase3Runtime: phase3,
      phase4Runtime: phase4,
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    await waitFor(`${apiOrigin}/health/ready`, "Phase 4 API");
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MATCHDAY_API_BASE_URL: apiOrigin,
      // The production web BFF seals the scoring-session cookie. This must be
      // present in the isolated browser journey or it deliberately refuses to
      // exchange the one-time access fragment before calling the API.
      SCORING_SESSION_SEAL_KEY: randomBytes(32).toString("base64url"),
      PHASE4_E2E_WEB_BASE_URL: webOrigin,
      PHASE4_E2E_STATE_FILE: stateFile,
      PHASE4_E2E_RESULT_FILE: resultFile,
      PHASE4_E2E_OUTPUT_DIR: process.env.PHASE4_E2E_OUTPUT_DIR ?? path.join(temp, "playwright-output"),
    };
    delete runtimeEnv.MATCHDAY_PHASE2_DATA_MODE;
    delete runtimeEnv.NEXT_PUBLIC_MATCHDAY_API_BASE_URL;
    await runProcess("production web build", "pnpm", ["--filter", "@matchday/web", "build"], runtimeEnv);
    process.stdout.write("Production web build: PASS\n");
    const webBuildId = (await readFile(path.join(root, "apps/web/.next/BUILD_ID"), "utf8")).trim();
    web = startProcess(
      "production web",
      "pnpm",
      ["--filter", "@matchday/web", "start", "--hostname", "127.0.0.1", "--port", String(webPort)],
      runtimeEnv,
    );
    await waitFor(`http://127.0.0.1:${webPort}/`, "production web", web, webBuildId);
    httpsProxy = startProcess("production web HTTPS proxy", "node", ["apps/web/tests/helpers/https-proxy.mjs"], {
      ...runtimeEnv,
      HTTPS_PROXY_UPSTREAM_PORT: String(webPort),
      HTTPS_PROXY_PORT: String(httpsProxyPort),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (httpsProxy.child.exitCode !== null)
      throw new Error(
        `production web HTTPS proxy exited before readiness with code ${String(httpsProxy.child.exitCode)}`,
      );
    const firstProjectName = projectNames[0];
    if (!firstProjectName) throw new Error("At least one real E2E browser project is required");
    const probeState = projects[firstProjectName]!;
    // Node's built-in fetch deliberately rejects our throwaway self-signed
    // browser proxy certificate. The browser journey uses that HTTPS origin;
    // this build/readiness probe may safely target Next directly.
    const formatProbe = await fetch(`http://127.0.0.1:${webPort}/organiser/competitions/new`, {
      headers: { cookie: probeState.organiserCookie },
    });
    const formatProbeBody = await formatProbe.text();
    if (!formatProbe.ok || !formatProbeBody.includes("Create competition"))
      throw new Error(
        `Production competition-create probe failed with HTTP ${formatProbe.status}: ${formatProbeBody
          .replaceAll(/<script[\s\S]*?<\/script>/g, " ")
          .replaceAll(/<style[\s\S]*?<\/style>/g, " ")
          .replaceAll(/<[^>]+>/g, " ")
          .replaceAll(/\s+/g, " ")
          .slice(0, 4_000)}`,
      );
    const playwrightConfig = process.env.PHASE4_E2E_PLAYWRIGHT_CONFIG ?? "playwright.phase4-real.config.ts";
    await runProcess(
      "Phase 4 real Playwright",
      "pnpm",
      [
        "--filter",
        "@matchday/web",
        "exec",
        "playwright",
        "test",
        "--config",
        playwrightConfig,
        ...projectNames.flatMap((projectName) => ["--project", projectName]),
      ],
      runtimeEnv,
      true,
    );
    const journeyResults = (await readFile(resultFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BrowserJourneyResult | V1BrowserJourneyResult | V1CompetitionJourneyResult);
    for (const projectName of projectNames) {
      const state = projects[projectName];
      const journey = journeyResults.find((result) => result.project === projectName);
      if (!state || !journey) throw new Error(`Browser journey result missing for ${projectName}`);
      if (process.env.PHASE4_E2E_JOURNEY === "v1") await assertV1DatabaseOracle(sql, journey as V1BrowserJourneyResult);
      else if (process.env.PHASE4_E2E_JOURNEY === "v1-competition")
        await assertV1CompetitionDatabaseOracle(sql, journey as V1CompetitionJourneyResult);
      else await assertDatabaseOracle(sql, journey as BrowserJourneyResult);
    }
  } catch (error) {
    printTail(web?.tail ?? { label: "production web", lines: [] });
    primaryError = error;
  } finally {
    const cleanupErrors: Error[] = [];
    const cleanup = async (label: string, action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`));
      }
    };
    await cleanup("HTTPS proxy shutdown", () => stopProcess(httpsProxy));
    await cleanup("Web shutdown", () => stopProcess(web));
    await cleanup("API shutdown", async () => app?.close());
    await cleanup("Scheduler shutdown", async () => scheduler?.stop());
    await cleanup("Schedule queue shutdown", async () => scheduleQueue?.close());
    await cleanup("Owned Redis namespace cleanup", async () => {
      const ownership = redisOwnership;
      const guardKey = unrelatedGuardKey;
      if (!ownership || !guardKey) return;
      const activeRedis = rateLimitRedis;
      const ownedCleanupRedis = !activeRedis || activeRedis.status === "end";
      const cleanupRedis = ownedCleanupRedis ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : activeRedis;
      try {
        finalOwnedRedisKeyCount = await unlinkOwnedRedisKeys(cleanupRedis, ownership);
        const [guardValue, guardTtl] = await Promise.all([cleanupRedis.get(guardKey), cleanupRedis.pttl(guardKey)]);
        unrelatedGuardPreserved = guardValue === "preserve" && guardTtl > 0;
        if (!unrelatedGuardPreserved)
          throw new Error("Phase 4 Redis owned cleanup removed or expired the unrelated near-prefix TTL guard");
        await cleanupRedis.unlink(guardKey);
        process.stdout.write(
          `Phase 4 Redis shutdown isolation: ${JSON.stringify({
            logical_database: configuration.redisDatabase,
            namespace_redacted: redactedRedisNamespace,
            namespace_hash: ownership.namespaceHash,
            final_owned_key_count: finalOwnedRedisKeyCount,
            unrelated_guard_preserved: unrelatedGuardPreserved,
          })}\n`,
        );
      } finally {
        if (ownedCleanupRedis) await cleanupRedis.quit();
      }
    });
    await cleanup("Redis shutdown", async () => {
      if (rateLimitRedis?.status !== "end") await rateLimitRedis?.quit();
    });
    await cleanup("Database connection shutdown", async () => sql?.end({ timeout: 2 }));
    await cleanup("Isolation cleanup", () => cleanupIsolation(admin, isolation));
    await cleanup("Administrative connection shutdown", async () => admin.end({ timeout: 2 }));
    await cleanup("Temporary artifact cleanup", () => rm(temp, { recursive: true, force: true }));
    process.off("SIGINT", markInterrupted);
    process.off("SIGTERM", markInterrupted);
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors, cleanupErrors.map((error) => error.message).join("; "));
      primaryError = primaryError
        ? new AggregateError([primaryError, cleanupError], "E2E and cleanup failed")
        : cleanupError;
    }
    await appendIsolationRecord(configuration.recordFile, {
      run: runNumber,
      status: primaryError ? "failed" : "passed",
      started_at_utc: startedAt,
      finished_at_utc: new Date().toISOString(),
      postgres: isolation ? { kind: isolation.kind, identifier: sanitizedIsolationIdentifier(isolation) } : null,
      redis: {
        logical_database: configuration.redisDatabase,
        namespace_redacted: redisOwnership ? redactedRedisNamespace : null,
        namespace_hash: redisOwnership?.namespaceHash ?? null,
        initial_owned_key_count: initialOwnedRedisKeyCount,
        final_owned_key_count: finalOwnedRedisKeyCount,
        unrelated_guard_preserved: unrelatedGuardPreserved,
      },
    });
  }
  if (primaryError) throw primaryError;
  process.stdout.write(
    `Phase 4 real E2E run ${runNumber} passed with Redis database ${configuration.redisDatabase}.\n`,
  );
}

async function main(): Promise<void> {
  assertPinnedToolchain();
  const recordFile =
    process.env.PHASE4_E2E_ISOLATION_RECORD_FILE ?? path.join(root, "artifacts/qa/phase4-real-isolation.ndjson");
  await mkdir(path.dirname(recordFile), { recursive: true, mode: 0o700 });
  await writeFile(recordFile, "", { mode: 0o600 });
  const runCount = resolveHarnessRunCount(process.env);
  await runOnce(1, { recordFile, redisDatabase: 14 });
  if (runCount === 2) await runOnce(2, { recordFile, redisDatabase: 15 });
  process.stdout.write(`Phase 4 real E2E isolation records: ${recordFile}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
