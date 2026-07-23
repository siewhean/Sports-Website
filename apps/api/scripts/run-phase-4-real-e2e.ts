import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const apiPort = 4101;
const webPort = 3103;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://localhost:${webPort}`;
const csrfSecret = randomBytes(32).toString("base64url");
const databasePrefix = "matchday_phase4_e2e_";
const schemaPrefix = "test_phase4_e2e_";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const adminDatabaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";

type Tail = { label: string; lines: string[] };
type RunningProcess = { child: ChildProcess; tail: Tail };
const activeProcesses = new Set<RunningProcess>();
type Isolation =
  | { kind: "database"; databaseName: string; databaseUrl: string }
  | { kind: "schema"; schema: string; databaseUrl: string };

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
  const schedule = Array.isArray(projectionObject?.schedule) ? projectionObject.schedule : [];
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

async function cleanupIsolation(admin: Sql, isolation: Isolation | null): Promise<void> {
  if (!isolation) return;
  if (isolation.kind === "database") {
    const name = safeIdentifier(isolation.databaseName, databasePrefix);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } else {
    await dropTestSchema(isolation.databaseUrl, isolation.schema);
  }
}

async function unlinkQueueKeys(redis: Redis, pattern: string, phase: "startup" | "shutdown"): Promise<void> {
  let cursor = "0";
  let scanned = 0;
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    scanned += keys.length;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== "0");
  const [, remaining] = await redis.scan("0", "MATCH", pattern, "COUNT", 100);
  if (remaining.length > 0)
    throw new Error(`Phase 4 Redis ${phase} cleanup left ${remaining.length} queue keys for ${pattern}`);
  process.stdout.write(`Phase 4 Redis ${phase} cleanup: ${JSON.stringify({ pattern, scanned, deleted })}\n`);
}

function assertPinnedToolchain(): void {
  if (process.version !== "v24.18.0")
    throw new Error(`Phase 4 real E2E requires Node v24.18.0; received ${process.version}`);
  const packageManager = process.env.npm_config_user_agent ?? "";
  if (!packageManager.startsWith("pnpm/10.33.0 "))
    throw new Error(`Phase 4 real E2E requires pnpm 10.33.0; received ${packageManager || "unknown"}`);
}

async function main(): Promise<void> {
  assertPinnedToolchain();
  const temp = await mkdtemp(path.join(tmpdir(), "matchday-phase4-e2e-"));
  const stateFile = path.join(temp, "state.json");
  const resultFile = path.join(temp, "browser-journeys.ndjson");
  const admin = postgres(adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  let isolation: Isolation | null = null;
  let sql: Sql | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let web: RunningProcess | null = null;
  let scheduler: SchedulerRuntime | null = null;
  let scheduleQueue: ScheduleJobQueue | null = null;
  let queueName: string | null = null;
  let rateLimitRedis: Redis | null = null;
  let primaryError: unknown = null;
  const markInterrupted = () => {
    for (const running of activeProcesses) void stopProcess(running);
  };
  process.once("SIGINT", markInterrupted);
  process.once("SIGTERM", markInterrupted);
  try {
    await runProcess(
      "local infrastructure",
      "docker",
      ["compose", "-f", "infra/local/compose.yaml", "up", "-d", "--wait", "postgres", "redis"],
      process.env,
    );
    rateLimitRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    queueName = `matchday-phase4-real-e2e-${randomUUID()}`;
    isolation = await prepareIsolation(admin);
    sql = connectIsolation(isolation);
    const identitySql = sql as unknown as PostgresJsSql;
    const phase2 = new Phase2Runtime(identitySql, phase2DomainAdapter);
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
        process.stdout.write(`Phase 4 scheduler dead letter: ${JSON.stringify(event)}\n`);
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
    const projectNames = [
      "phase-4-real-phone-chromium",
      "phase-4-real-tablet-webkit",
      "phase-4-real-desktop-chromium",
    ] as const;
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
    await waitFor(`${webOrigin}/`, "production web", web, webBuildId);
    const probeState = projects[projectNames[0]]!;
    const formatProbe = await fetch(`${webOrigin}/organiser/competitions/new`, {
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
        "playwright.phase4-real.config.ts",
        ...(process.env.PHASE4_E2E_PROJECT ? ["--project", process.env.PHASE4_E2E_PROJECT] : []),
      ],
      runtimeEnv,
      true,
    );
    const journeyResults = (await readFile(resultFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BrowserJourneyResult);
    const projectsToVerify = process.env.PHASE4_E2E_PROJECT ? [process.env.PHASE4_E2E_PROJECT] : projectNames;
    for (const projectName of projectsToVerify) {
      const state = projects[projectName];
      const journey = journeyResults.find((result) => result.project === projectName);
      if (!state || !journey) throw new Error(`Browser journey result missing for ${projectName}`);
      await assertDatabaseOracle(sql, journey);
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
    await cleanup("Web shutdown", () => stopProcess(web));
    await cleanup("API shutdown", async () => app?.close());
    await cleanup("Scheduler shutdown", async () => scheduler?.stop());
    await cleanup("Schedule queue shutdown", async () => scheduleQueue?.close());
    await cleanup("Schedule queue Redis key cleanup", async () => {
      const cleanupQueueName = queueName;
      if (!cleanupQueueName) return;
      const activeRedis = rateLimitRedis;
      const ownedCleanupRedis = !activeRedis || activeRedis.status === "end";
      const cleanupRedis = ownedCleanupRedis ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : activeRedis;
      try {
        await unlinkQueueKeys(cleanupRedis, `bull:${cleanupQueueName}*`, "shutdown");
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
  }
  if (primaryError) throw primaryError;
  process.stdout.write(
    `Phase 4 real E2E passed (${isolation?.kind === "database" ? "disposable database" : "isolated schema"}).\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
