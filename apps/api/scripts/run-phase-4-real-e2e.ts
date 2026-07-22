import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import type { Phase4SetupDocument, Phase4SetupStepValue } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { hashSessionSecret, systemClock, type PostgresJsSql } from "@matchday/identity";
import { ScheduleJobQueue } from "@matchday/scheduler";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../src/app.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../src/phase-4-reliable-runtime.js";

const apiPort = 4104;
const webPort = 3104;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://localhost:${webPort}`;
const csrfSecret = "phase-4-e2e-csrf-secret-at-least-32-bytes";
const databasePrefix = "matchday_phase4_e2e_";
const schemaPrefix = "test_phase4_e2e_";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const adminDatabaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14";

type Tail = { label: string; lines: string[] };
type RunningProcess = { child: ChildProcess; tail: Tail };
type Isolation =
  | { kind: "database"; databaseName: string; databaseUrl: string }
  | { kind: "schema"; schema: string; databaseUrl: string };

type Fixture = Readonly<{
  competitionId: string;
  recommendationName: string;
  setupRevision: number;
}>;

type GateBRealState = Readonly<{
  apiOrigin: string;
  webOrigin: string;
  databaseUrl: string;
  schema: string | null;
  recommendationCompetitionId: string;
  completedCompetitionId: string;
  recommendationName: string;
  recommendationRevision: number;
  organiserCookieName: string;
  organiserCookieValue: string;
  csrfToken: string;
}>;

const activeProcesses = new Set<RunningProcess>();

function safeIdentifier(value: string, prefix: string): string {
  if (!value.startsWith(prefix) || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Refusing unsafe database identifier: ${value}`);
  }
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
  if (tail.lines.length > 180) tail.lines.splice(0, tail.lines.length - 180);
}

function printTail(tail: Tail): void {
  if (!tail.lines.length) return;
  process.stderr.write(`\n[${tail.label} — bounded tail]\n${tail.lines.join("\n")}\n`);
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

async function runProcess(label: string, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const running = startProcess(label, command, args, env);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    running.child.once("error", reject);
    running.child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    printTail(running.tail);
    throw new Error(`${label} exited with code ${String(exitCode)}`);
  }
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

async function waitFor(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok || (response.status >= 300 && response.status < 400)) return;
      lastError = `HTTP ${response.status}`;
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
        max: 12,
        onnotice: () => undefined,
        connection: { search_path: `${isolation.schema},public` },
      })
    : postgres(isolation.databaseUrl, { max: 12, onnotice: () => undefined });
}

function required<T>(rows: readonly T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

async function saveStep(
  runtime: ReliableGateBPhase4Runtime,
  accountId: string,
  competitionId: string,
  document: Phase4SetupDocument,
  step: Phase4SetupStepValue,
): Promise<Phase4SetupDocument> {
  const result = await runtime.autosaveSetupDraft(
    { accountId },
    competitionId,
    {
      expected_revision: document.revision,
      idempotency_key: `gate-b-e2e-${step.step_id}-${randomUUID()}`,
      transition: { kind: "save_step", step },
    },
    randomUUID(),
  );
  if (result.outcome !== "saved" && result.outcome !== "idempotent_replay") {
    throw new Error(`Unable to save ${step.step_id}: ${result.outcome}`);
  }
  return result.document;
}

async function createRecommendationFixture(
  sql: Sql,
  phase3: Phase3Runtime,
  phase4: ReliableGateBPhase4Runtime,
  accountId: string,
  organisationId: string,
  suffix: string,
): Promise<Fixture> {
  const competition = await phase3.createCompetition(
    { accountId },
    {
      organisationId,
      name: `Gate B Real ${suffix}`,
      slug: `gate-b-real-${suffix}-${randomUUID()}`,
      sportCode: "badminton",
      venue: "Real E2E Sports Hall",
      address: "1 Browser Journey Road",
      countryCode: "SG",
      startsOn: "2027-08-01",
      endsOn: "2027-08-01",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
  );
  const divisionId = randomUUID();
  await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competition.id},'Singles',8)`;
  for (let seed = 1; seed <= 8; seed += 1) {
    await sql`INSERT INTO division_entries(id,division_id,name,seed,status)
      VALUES(${randomUUID()},${divisionId},${`Player ${suffix} ${seed}`},${seed},'confirmed')`;
  }
  const pack = required(
    await sql<{ pack_version: string }[]>`
      SELECT pack_version FROM competition_sport_settings WHERE competition_id=${competition.id}`,
    "Competition sport settings were not created",
  );
  await sql`INSERT INTO division_sport_settings(
    division_id,competition_id,sport_code,pack_version,settings_override,updated_by
  ) VALUES(${divisionId},${competition.id},'badminton',${pack.pack_version},'{}'::jsonb,${accountId})`;
  await phase3.replaceCapacity(
    { accountId },
    competition.id,
    {
      revision: 1,
      areas: [
        {
          name: "Court 1",
          slotMinutes: 40,
          availability: [{ date: "2027-08-01", startTime: "08:00", endTime: "22:00" }],
        },
      ],
    },
    randomUUID(),
  );

  let document = (await phase4.createSetupDraft(
    { accountId },
    competition.id,
    `gate-b-e2e-create-${randomUUID()}`,
    randomUUID(),
  )).document;
  if (!document.values.basics) throw new Error("Seeded setup has no basics");
  document = await saveStep(phase4, accountId, competition.id, document, {
    step_id: "basics",
    value: document.values.basics,
  });
  if (!document.values.capacity) throw new Error("Seeded setup has no capacity");
  document = await saveStep(phase4, accountId, competition.id, document, {
    step_id: "capacity",
    value: document.values.capacity,
  });
  if (!document.values.settings) throw new Error("Seeded setup has no settings");
  document = await saveStep(phase4, accountId, competition.id, document, {
    step_id: "settings",
    value: document.values.settings,
  });
  if (!document.values.entries) throw new Error("Seeded setup has no entries");
  document = await saveStep(phase4, accountId, competition.id, document, {
    step_id: "entries",
    value: document.values.entries,
  });
  if (!document.values.format_preferences) throw new Error("Seeded setup has no format preferences");
  document = await saveStep(phase4, accountId, competition.id, document, {
    step_id: "format_preferences",
    value: {
      ...document.values.format_preferences,
      minimum_matches: { per_entry: 1 },
      ranking: { rank_all_entries: false },
      placement: { required: false },
      priority: { value: "speed" },
    },
  });
  const recommendation = document.values.format_recommendations?.recommendations[0];
  if (!recommendation) throw new Error("Capacity-filtered recommendation was not generated");
  if (document.current_step !== "format_recommendations") {
    throw new Error(`Unexpected setup step after recommendations: ${document.current_step}`);
  }
  return {
    competitionId: competition.id,
    recommendationName: recommendation.name,
    setupRevision: document.revision,
  };
}

async function seed(sql: Sql, isolation: Isolation, queue: ScheduleJobQueue): Promise<GateBRealState> {
  const accountId = randomUUID();
  const organisationId = randomUUID();
  await sql.begin(async (transaction) => {
    await transaction`INSERT INTO accounts(id,primary_email,display_name,email_verified_at)
      VALUES(${accountId},'organiser@phase4-e2e.test','Gate B Real Organiser',now())`;
    await transaction`INSERT INTO organisations(id,name,slug)
      VALUES(${organisationId},'Gate B Real Organisation',${`gate-b-real-${organisationId}`})`;
    await transaction`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${accountId},'owner','active')`;
  });

  const identitySql = sql as unknown as PostgresJsSql;
  const phase2 = new Phase2Runtime(identitySql, phase2DomainAdapter);
  const phase3 = new Phase3Runtime(identitySql, phase3DomainAdapter);
  const phase4 = new ReliableGateBPhase4Runtime(
    identitySql,
    phase3,
    queue,
    { mode: "disabled", provider: null, timeoutMs: 2_000, maximumAttempts: 1, cacheTtlSeconds: 3_600 },
    undefined,
    phase2,
  );

  const recommendation = await createRecommendationFixture(
    sql,
    phase3,
    phase4,
    accountId,
    organisationId,
    "recommendations",
  );
  const completed = await createRecommendationFixture(sql, phase3, phase4, accountId, organisationId, "completed");
  const allSteps = [
    "basics",
    "capacity",
    "settings",
    "entries",
    "format_preferences",
    "format_recommendations",
    "schedule_review",
    "review_publish",
  ];
  await sql`UPDATE setup_drafts
    SET status='completed',current_step='review_publish',completed_steps=${sql.json(allSteps)},
        revision=revision+1,completed_at=now(),updated_at=now()
    WHERE competition_id=${completed.competitionId}`;

  const sessionId = randomUUID();
  const sessionSecret = randomBytes(32).toString("base64url");
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + 30 * 60_000);
  const absoluteExpiresAt = new Date(now.getTime() + 12 * 60 * 60_000);
  await sql`INSERT INTO identity_sessions(
    id,account_id,secret_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at
  ) VALUES(${sessionId},${accountId},${hashSessionSecret(sessionSecret)},${now},${now},${idleExpiresAt},${absoluteExpiresAt})`;
  const csrfToken = createHmac("sha256", csrfSecret)
    .update(`matchday-csrf-v1:${sessionId}`, "utf8")
    .digest("base64url");

  return {
    apiOrigin,
    webOrigin,
    databaseUrl: isolation.databaseUrl,
    schema: isolation.kind === "schema" ? isolation.schema : null,
    recommendationCompetitionId: recommendation.competitionId,
    completedCompetitionId: completed.competitionId,
    recommendationName: recommendation.recommendationName,
    recommendationRevision: recommendation.setupRevision,
    organiserCookieName: "matchday_session",
    organiserCookieValue: `${sessionId}.${sessionSecret}`,
    csrfToken,
  };
}

async function assertDatabaseOracle(sql: Sql, state: GateBRealState): Promise<void> {
  const recommendation = required(
    await sql<{
      revision: number;
      current_step: string;
      selected_recommendation_id: string | null;
      recommendation_count: number;
    }[]>`SELECT revision,current_step,
      steps#>>'{format_recommendations,selected_recommendation_id}' selected_recommendation_id,
      jsonb_array_length(steps#>'{format_recommendations,recommendations}')::int recommendation_count
      FROM setup_drafts WHERE competition_id=${state.recommendationCompetitionId}`,
    "Recommendation setup disappeared",
  );
  if (
    recommendation.revision !== state.recommendationRevision ||
    recommendation.current_step !== "format_recommendations" ||
    recommendation.selected_recommendation_id !== null ||
    recommendation.recommendation_count < 1
  ) {
    throw new Error(`Recommendation resume oracle failed: ${JSON.stringify(recommendation)}`);
  }
  const completed = required(
    await sql<{ status: string; current_step: string; completed_at: Date | null }[]>`
      SELECT status,current_step,completed_at FROM setup_drafts WHERE competition_id=${state.completedCompetitionId}`,
    "Completed setup disappeared",
  );
  if (completed.status !== "completed" || completed.current_step !== "review_publish" || !completed.completed_at) {
    throw new Error(`Completed setup oracle failed: ${JSON.stringify(completed)}`);
  }
  const invalidationEvents = await sql<{ count: number }[]>`
    SELECT count(*)::int count FROM audit_events
    WHERE action='setup.references.refreshed' AND target_id=(
      SELECT id::text FROM setup_drafts WHERE competition_id=${state.recommendationCompetitionId}
    )`;
  if ((invalidationEvents[0]?.count ?? 0) !== 0) {
    throw new Error(`No-change resume emitted invalidation evidence: ${JSON.stringify(invalidationEvents[0])}`);
  }
}

async function cleanupIsolation(admin: Sql, isolation: Isolation | null): Promise<void> {
  if (!isolation) return;
  if (isolation.kind === "database") {
    const name = safeIdentifier(isolation.databaseName, databasePrefix);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    return;
  }
  await dropTestSchema(isolation.databaseUrl, isolation.schema);
}

async function main(): Promise<void> {
  const temp = await mkdtemp(path.join(tmpdir(), "matchday-phase4-e2e-"));
  const stateFile = path.join(temp, "state.json");
  const admin = postgres(adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  const queueName = `matchday-gate-b-real-${randomUUID()}`;
  let isolation: Isolation | null = null;
  let sql: Sql | null = null;
  let queue: ScheduleJobQueue | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let web: RunningProcess | null = null;
  let primaryError: unknown = null;
  let cleanupError: AggregateError | null = null;
  let interrupted = false;

  const markInterrupted = () => {
    interrupted = true;
    for (const running of activeProcesses) void stopProcess(running);
  };
  process.once("SIGINT", markInterrupted);
  process.once("SIGTERM", markInterrupted);

  try {
    await runProcess(
      "local PostgreSQL and Redis",
      "docker",
      ["compose", "-f", "infra/local/compose.yaml", "up", "-d", "--wait", "postgres", "redis"],
      process.env,
    );
    isolation = await prepareIsolation(admin);
    sql = connectIsolation(isolation);
    queue = new ScheduleJobQueue({ queueName, redisUrl });
    const state = await seed(sql, isolation, queue);
    await writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });

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
    if (config.identity.sessionCookieName !== state.organiserCookieName) {
      throw new Error(`Unexpected session cookie name: ${config.identity.sessionCookieName}`);
    }
    const identitySql = sql as unknown as PostgresJsSql;
    const identity = new IdentityApiRuntime(
      new UnavailableIdentityProvider(),
      new PostgresIdentityUnitOfWork(identitySql),
      csrfSecret,
      systemClock,
    );
    const phase2 = new Phase2Runtime(identitySql, phase2DomainAdapter);
    const phase3 = new Phase3Runtime(identitySql, phase3DomainAdapter);
    const phase4 = new ReliableGateBPhase4Runtime(
      identitySql,
      phase3,
      queue,
      { mode: "disabled", provider: null, timeoutMs: 2_000, maximumAttempts: 1, cacheTtlSeconds: 3_600 },
      undefined,
      phase2,
    );
    const databaseProbe = async () => {
      try {
        return (await sql?.unsafe<{ ok: number }[]>("SELECT 1 AS ok"))?.[0]?.ok === 1;
      } catch {
        return false;
      }
    };
    app = await buildApp({
      config,
      probes: { database: databaseProbe, queue: async () => true, redis: async () => true },
      identityRuntime: identity,
      phase2Runtime: phase2,
      phase3Runtime: phase3,
      phase4Runtime: phase4,
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    await waitFor(`${apiOrigin}/health/ready`, "Gate B API");

    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      APP_ENV: "test",
      MATCHDAY_API_BASE_URL: apiOrigin,
      MATCHDAY_PHASE2_DATA_MODE: "api",
      PHASE4_E2E_WEB_BASE_URL: webOrigin,
      PHASE4_E2E_STATE_FILE: stateFile,
      PHASE4_E2E_OUTPUT_DIR: path.join(temp, "playwright-output"),
    };
    delete runtimeEnv.NEXT_PUBLIC_MATCHDAY_API_BASE_URL;
    await runProcess("production web build", "pnpm", ["--filter", "@matchday/web", "build"], runtimeEnv);
    web = startProcess(
      "production web",
      "pnpm",
      ["--filter", "@matchday/web", "start", "--hostname", "127.0.0.1", "--port", String(webPort)],
      runtimeEnv,
    );
    await waitFor(`${webOrigin}/`, "production web");
    await runProcess(
      "Gate B real Playwright",
      "pnpm",
      ["--filter", "@matchday/web", "exec", "playwright", "test", "--config", "playwright.gate-b-real.config.ts"],
      runtimeEnv,
    );
    await assertDatabaseOracle(sql, state);
    if (interrupted) throw new Error("Gate B real E2E was interrupted");
  } catch (error) {
    printTail(web?.tail ?? { label: "production web", lines: [] });
    primaryError = error;
  } finally {
    const cleanupErrors: Error[] = [];
    const cleanup = async (label: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };
    await cleanup("Web process shutdown failed", () => stopProcess(web));
    await cleanup("API shutdown failed", async () => app?.close());
    await cleanup("Schedule queue shutdown failed", async () => queue?.close());
    await cleanup("Isolated connection shutdown failed", async () => sql?.end({ timeout: 2 }));
    await cleanup("Isolation cleanup failed", () => cleanupIsolation(admin, isolation));
    await cleanup("Administrative connection shutdown failed", async () => admin.end({ timeout: 2 }));
    await cleanup("Temporary artifact cleanup failed", () => rm(temp, { recursive: true, force: true }));
    process.off("SIGINT", markInterrupted);
    process.off("SIGTERM", markInterrupted);
    if (cleanupErrors.length) cleanupError = new AggregateError(cleanupErrors, cleanupErrors.map((item) => item.message).join("; "));
  }

  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "E2E and cleanup failed");
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  process.stdout.write(
    `Gate B real E2E passed (${isolation?.kind === "database" ? "disposable database" : "isolated schema"}).\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
