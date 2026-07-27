import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { hashSessionSecret, systemClock, type PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../src/app.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { RedisScoringAccessRateLimiter } from "../src/scoring-access-rate-limit.js";
import { Redis } from "ioredis";

const apiPort = 4100;
const webPort = 3102;
const internalWebPort = 3103;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `https://localhost:${webPort}`;
const internalWebOrigin = `http://127.0.0.1:${internalWebPort}`;
const csrfSecret = "phase-2-e2e-csrf-secret-at-least-32-bytes";
const scoringAccessRateLimitSecret = "phase-2-e2e-scoring-access-rate-limit-secret";
const databasePrefix = "matchday_phase2_e2e_";
const schemaPrefix = "test_phase2_e2e_";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const adminDatabaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const retainedArtifactsRoot = path.join(root, "artifacts/qa/gate-c-access");

type Tail = { label: string; lines: string[] };
type RunningProcess = { child: ChildProcess; tail: Tail };
const activeProcesses = new Set<RunningProcess>();
type Isolation =
  | { kind: "database"; databaseName: string; databaseUrl: string }
  | { kind: "schema"; schema: string; databaseUrl: string };

type SeedState = {
  apiOrigin: string;
  webOrigin: string;
  databaseUrl: string;
  schema: string | null;
  competitionId: string;
  divisionId: string;
  matchId: string;
  slug: string;
  homeName: string;
  awayName: string;
  accessToken: string;
  probeAccessToken: string;
  organiserCookie: string;
  csrfToken: string;
};

function safeIdentifier(value: string, prefix: string): string {
  if (!value.startsWith(prefix) || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Refusing unsafe database identifier: ${value}`);
  }
  return value;
}

function retainedArtifactsDirectory(): string | null {
  const configured = process.env.PHASE2_E2E_RETAIN_DIR?.trim();
  if (!configured) return null;
  const resolved = path.resolve(root, configured);
  if (resolved !== retainedArtifactsRoot && !resolved.startsWith(`${retainedArtifactsRoot}${path.sep}`)) {
    throw new Error("PHASE2_E2E_RETAIN_DIR must stay under artifacts/qa/gate-c-access");
  }
  return resolved;
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
  if (tail.lines.length > 160) tail.lines.splice(0, tail.lines.length - 160);
}

async function startHttpsProxy(temp: string): Promise<https.Server> {
  const keyPath = path.join(temp, "loopback-key.pem");
  const certificatePath = path.join(temp, "loopback-certificate.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const server = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certificatePath) },
    (request, response) => {
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: internalWebPort,
          path: request.url,
          method: request.method,
          headers: {
            ...request.headers,
            host: `localhost:${webPort}`,
            "x-forwarded-host": `localhost:${webPort}`,
            "x-forwarded-proto": "https",
          },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", (error) => response.destroy(error));
      request.pipe(upstream);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(webPort, "127.0.0.1", resolve);
  });
  return server;
}

async function stopHttpsProxy(server: https.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
      // The child exited between the timeout and the forced shutdown.
    }
  }
}

async function waitFor(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function redisKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
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

async function seed(sql: Sql, isolation: Isolation): Promise<SeedState> {
  const runtime = new Phase2Runtime(sql as unknown as PostgresJsSql, phase2DomainAdapter);
  const accountId = randomUUID();
  const organisationId = randomUUID();
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO accounts (id,primary_email,display_name,email_verified_at)
      VALUES (${accountId},'organiser@phase2-e2e.test','Phase 2 E2E Organiser',now())
    `;
    await transaction`
      INSERT INTO organisations (id,name,slug) VALUES (${organisationId},'Phase 2 E2E Org','phase-2-e2e-org')
    `;
    await transaction`
      INSERT INTO organisation_memberships (organisation_id,account_id,role,status)
      VALUES (${organisationId},${accountId},'owner','active')
    `;
  });
  const actor = { accountId };
  const competition = await runtime.createCompetition(
    actor,
    {
      organisationId,
      name: "Phase 2 Real E2E Cup",
      slug: "phase-2-real-e2e",
      timezone: "Asia/Singapore",
      startsOn: "2026-08-01",
      endsOn: "2026-08-01",
    },
    randomUUID(),
  );
  await runtime.updateSettings(actor, competition.id, { periodMinutes: 10 }, randomUUID());
  const division = await runtime.createDivision(actor, competition.id, { name: "Open", teamLimit: 8 }, randomUUID());
  await runtime.replaceEntries(
    actor,
    competition.id,
    division.id,
    Array.from({ length: 8 }, (_, index) => ({ name: `E2E Team ${index + 1}`, seed: index + 1 })),
    randomUUID(),
  );
  await runtime.replaceCapacity(
    actor,
    competition.id,
    ["Court 1", "Court 2"].map((name) => ({
      name,
      windows: [{ startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-01T12:00:00.000Z" }],
    })),
    randomUUID(),
  );
  const format = await runtime.generateFormat(actor, competition.id, division.id, randomUUID());
  const schedule = await runtime.generateSchedule(actor, competition.id, format.id, randomUUID());
  await runtime.publishSchedule(actor, competition.id, schedule.id, randomUUID());
  const firstMatch = format.matches.find((match) => match.homeEntryId && match.awayEntryId);
  if (!firstMatch?.homeEntryId || !firstMatch.awayEntryId) throw new Error("Canonical seed has no resolved match");
  const participants = await sql<{ id: string; name: string }[]>`
    SELECT id,name FROM division_entries WHERE id IN (${firstMatch.homeEntryId},${firstMatch.awayEntryId})
  `;
  const names = new Map(participants.map((entry) => [entry.id, entry.name]));
  const access = await runtime.createAccessPass(
    actor,
    competition.id,
    firstMatch.id,
    new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    randomUUID(),
  );
  const probeMatch = format.matches.find(
    (match) => match.id !== firstMatch.id && match.homeEntryId && match.awayEntryId,
  );
  if (!probeMatch) throw new Error("Canonical seed has no second resolved match for transport probing");
  const probeAccess = await runtime.createAccessPass(
    actor,
    competition.id,
    probeMatch.id,
    new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    randomUUID(),
  );

  const sessionId = randomUUID();
  const sessionSecret = randomBytes(32).toString("base64url");
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + 30 * 60_000);
  const absoluteExpiresAt = new Date(now.getTime() + 12 * 60 * 60_000);
  await sql`
    INSERT INTO identity_sessions (
      id,account_id,secret_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at
    ) VALUES (
      ${sessionId},${accountId},${hashSessionSecret(sessionSecret)},${now},${now},${idleExpiresAt},${absoluteExpiresAt}
    )
  `;
  const csrfToken = createHmac("sha256", csrfSecret)
    .update(`matchday-csrf-v1:${sessionId}`, "utf8")
    .digest("base64url");
  return {
    apiOrigin,
    webOrigin,
    databaseUrl: isolation.databaseUrl,
    schema: isolation.kind === "schema" ? isolation.schema : null,
    competitionId: competition.id,
    divisionId: division.id,
    matchId: firstMatch.id,
    slug: "phase-2-real-e2e",
    homeName: names.get(firstMatch.homeEntryId) ?? "E2E Home",
    awayName: names.get(firstMatch.awayEntryId) ?? "E2E Away",
    accessToken: access.token,
    probeAccessToken: probeAccess.token,
    organiserCookie: `matchday_session=${sessionId}.${sessionSecret}`,
    csrfToken,
  };
}

async function assertDatabaseOracle(sql: Sql, state: SeedState): Promise<void> {
  const snapshots = await sql<
    {
      result_version: number;
      home_score: number;
      away_score: number;
      state: string;
    }[]
  >`
    SELECT result_version,home_score,away_score,state FROM match_result_snapshots
    WHERE match_id=${state.matchId} ORDER BY result_version
  `;
  const publication = await sql<{ schedule_version: number; result_version: number }[]>`
    SELECT schedule_version,result_version FROM competition_publications WHERE competition_id=${state.competitionId}
  `;
  const corrections = await sql<{ event_count: number; audit_count: number }[]>`
    SELECT
      (SELECT count(*)::integer FROM score_events
       WHERE match_id=${state.matchId} AND event_type='correction'
         AND correction_reason='Official score sheet correction') AS event_count,
      (SELECT count(*)::integer FROM audit_events
       WHERE target_id=${state.matchId} AND action='result.corrected'
         AND reason='Official score sheet correction') AS audit_count
  `;
  const expectedSnapshots = [
    { result_version: 1, home_score: 1, away_score: 0, state: "final" },
    { result_version: 2, home_score: 1, away_score: 1, state: "corrected" },
  ];
  if (JSON.stringify(snapshots) !== JSON.stringify(expectedSnapshots)) {
    throw new Error(`Result-version isolation oracle failed: ${JSON.stringify(snapshots)}`);
  }
  if (publication[0]?.schedule_version !== 1 || publication[0]?.result_version !== 2) {
    throw new Error(`Publication isolation oracle failed: ${JSON.stringify(publication[0])}`);
  }
  if (corrections[0]?.event_count !== 1 || corrections[0]?.audit_count !== 1) {
    throw new Error(`Correction audit oracle failed: ${JSON.stringify(corrections[0])}`);
  }
}

async function assertGateCAccessOracle(sql: Sql, state: SeedState): Promise<void> {
  const counts = await sql<
    {
      viewer_passes: number;
      scorekeeper_passes: number;
      viewer_sessions: number;
      transferred_sessions: number;
      approved_takeovers: number;
      access_attempts: number;
      required_audits: number;
      denial_outbox_events: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::integer FROM scoring_access_passes
       WHERE competition_id=${state.competitionId} AND role='viewer') AS viewer_passes,
      (SELECT count(*)::integer FROM scoring_access_passes
       WHERE competition_id=${state.competitionId} AND role='scorekeeper') AS scorekeeper_passes,
      (SELECT count(*)::integer FROM scoring_access_sessions
       WHERE competition_id=${state.competitionId} AND mode='viewer') AS viewer_sessions,
      (SELECT count(*)::integer FROM scoring_access_sessions
       WHERE competition_id=${state.competitionId} AND mode='transferred') AS transferred_sessions,
      (SELECT count(*)::integer FROM scoring_takeover_requests
       WHERE competition_id=${state.competitionId} AND status='approved') AS approved_takeovers,
      (SELECT count(*)::integer FROM scoring_access_attempts
       WHERE competition_id=${state.competitionId}) AS access_attempts,
      (SELECT count(*)::integer FROM audit_events
       WHERE action IN (
         'scoring_access.created','scoring_access.fallback_rotated','scoring_access.revoked',
         'scoring_takeover.requested','scoring_takeover.approved'
       ) AND (
         target_id IN (SELECT id::text FROM scoring_access_passes WHERE competition_id=${state.competitionId})
         OR target_id IN (SELECT id::text FROM scoring_takeover_requests WHERE competition_id=${state.competitionId})
       )) AS required_audits,
      (SELECT count(*)::integer FROM outbox_events
       WHERE event_type IN (
         'scoring_access.invalid','scoring_access.rate_limited','scoring_session.heartbeat_expired',
         'scoring_event.stale_submission_rejected'
       )) AS denial_outbox_events
  `;
  const row = counts[0];
  if (
    !row ||
    row.viewer_passes < 1 ||
    row.scorekeeper_passes < 2 ||
    row.viewer_sessions < 2 ||
    row.transferred_sessions !== 1 ||
    row.approved_takeovers !== 1 ||
    row.access_attempts < 4 ||
    row.required_audits < 7 ||
    row.denial_outbox_events !== 0
  ) {
    throw new Error(`Gate C access database oracle failed: ${JSON.stringify(row)}`);
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
  const temp = await mkdtemp(path.join(tmpdir(), "matchday-phase2-e2e-"));
  const stateFile = path.join(temp, "state.json");
  const admin = postgres(adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  let isolation: Isolation | null = null;
  let sql: Sql | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let redis: Redis | null = null;
  let redisNamespace: string | null = null;
  let redisGuardKey: string | null = null;
  let web: RunningProcess | null = null;
  let httpsProxy: https.Server | null = null;
  let interrupted = false;
  const markInterrupted = () => {
    interrupted = true;
    for (const running of activeProcesses) void stopProcess(running);
  };
  let primaryError: unknown = null;
  let cleanupError: AggregateError | null = null;
  process.once("SIGINT", markInterrupted);
  process.once("SIGTERM", markInterrupted);
  try {
    await runProcess(
      "local PostgreSQL",
      "docker",
      ["compose", "-f", "infra/local/compose.yaml", "up", "-d", "--wait", "postgres", "redis"],
      process.env,
    );
    isolation = await prepareIsolation(admin);
    sql = connectIsolation(isolation);
    const state = await seed(sql, isolation);
    await writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const config = parseConfig({
      ...process.env,
      APP_ENV: "test",
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      API_ALLOWED_ORIGINS: webOrigin,
      DATABASE_URL: isolation.databaseUrl,
      IDENTITY_CSRF_HMAC_SECRET: csrfSecret,
      SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: scoringAccessRateLimitSecret,
      LOG_LEVEL: "info",
    });
    const identitySql = sql as unknown as PostgresJsSql;
    const identity = new IdentityApiRuntime(
      new UnavailableIdentityProvider(),
      new PostgresIdentityUnitOfWork(identitySql),
      csrfSecret,
      systemClock,
    );
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    redisNamespace = `matchday:test:phase2-e2e:${randomUUID()}:`;
    redisGuardKey = `${redisNamespace.slice(0, -1)}-unrelated-guard`;
    const dirtyOwnedKeys = await redisKeys(redis, `${redisNamespace}*`);
    if (dirtyOwnedKeys.length > 0) {
      throw new Error(`Refusing dirty scoring-access Redis namespace (${dirtyOwnedKeys.length} owned keys)`);
    }
    await redis.set(redisGuardKey, "preserve", "EX", 900);
    const databaseProbe = async () => {
      try {
        const rows = await sql?.unsafe<{ ok: number }[]>("SELECT 1 AS ok");
        return rows?.[0]?.ok === 1;
      } catch {
        return false;
      }
    };
    app = await buildApp({
      config,
      probes: { database: databaseProbe, queue: databaseProbe, redis: async () => true },
      identityRuntime: identity,
      phase2Runtime: new Phase2Runtime(
        identitySql,
        phase2DomainAdapter,
        undefined,
        new RedisScoringAccessRateLimiter(redis, scoringAccessRateLimitSecret, redisNamespace),
      ),
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    await waitFor(`${apiOrigin}/health/ready`, "Phase 2 API");

    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MATCHDAY_API_BASE_URL: apiOrigin,
      PHASE2_E2E_API_BASE_URL: apiOrigin,
      PHASE2_E2E_WEB_BASE_URL: webOrigin,
      PHASE2_E2E_STATE_FILE: stateFile,
      PHASE2_E2E_OUTPUT_DIR: path.join(temp, "playwright-output"),
      SCORING_SESSION_SEAL_KEY: Buffer.alloc(32, 23).toString("base64url"),
    };
    delete runtimeEnv.MATCHDAY_PHASE2_DATA_MODE;
    delete runtimeEnv.NEXT_PUBLIC_MATCHDAY_API_BASE_URL;
    await runProcess("production web build", "pnpm", ["--filter", "@matchday/web", "build"], runtimeEnv);
    web = startProcess(
      "production web",
      "pnpm",
      ["--filter", "@matchday/web", "start", "--hostname", "127.0.0.1", "--port", String(internalWebPort)],
      runtimeEnv,
    );
    await waitFor(`${internalWebOrigin}/score`, "production web");
    httpsProxy = await startHttpsProxy(temp);
    const bffProbe = await fetch(`${internalWebOrigin}/api/scoring/access/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: webOrigin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": `localhost:${webPort}`,
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        token: state.probeAccessToken,
        deviceId: randomUUID(),
        deviceLabel: "Transport probe",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const bffProbeBody = await bffProbe.text();
    if (bffProbe.status !== 200 || !bffProbe.headers.get("set-cookie") || !bffProbeBody.includes('"match"')) {
      throw new Error(`Successful BFF transport probe failed with HTTP ${bffProbe.status}`);
    }
    await runProcess(
      "Phase 2 real Playwright",
      "pnpm",
      [
        "--filter",
        "@matchday/web",
        "exec",
        "playwright",
        "test",
        "--config",
        process.env.PHASE2_E2E_PLAYWRIGHT_CONFIG ?? "playwright.real.config.ts",
        ...(process.env.PHASE2_E2E_PROJECT ? ["--project", process.env.PHASE2_E2E_PROJECT] : []),
      ],
      runtimeEnv,
    );
    if (process.env.PHASE2_E2E_SKIP_PHASE2_ORACLE === "1") {
      await assertGateCAccessOracle(sql, state);
    } else {
      await assertDatabaseOracle(sql, state);
    }
    if (interrupted) throw new Error("Phase 2 E2E was interrupted");
  } catch (error) {
    printTail(web?.tail ?? { label: "production web", lines: [] });
    primaryError = error;
  } finally {
    const cleanupErrors: Error[] = [];
    const cleanup = async (label: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(
          new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
        );
      }
    };
    await cleanup("HTTPS proxy shutdown failed", () => stopHttpsProxy(httpsProxy));
    await cleanup("Web process shutdown failed", () => stopProcess(web));
    await cleanup("API shutdown failed", async () => {
      await app?.close();
    });
    await cleanup("Redis namespace cleanup failed", async () => {
      if (!redis || !redisNamespace || !redisGuardKey) return;
      const ownedKeys = await redisKeys(redis, `${redisNamespace}*`);
      if (ownedKeys.length > 0) await redis.unlink(...ownedKeys);
      const remainingOwnedKeys = await redisKeys(redis, `${redisNamespace}*`);
      if (remainingOwnedKeys.length !== 0) {
        throw new Error(`Redis scoring-access cleanup left ${remainingOwnedKeys.length} owned keys`);
      }
      if ((await redis.get(redisGuardKey)) !== "preserve") {
        throw new Error("Redis scoring-access cleanup removed the unrelated guard key");
      }
      await redis.unlink(redisGuardKey);
    });
    await cleanup("Redis connection shutdown failed", async () => {
      await redis?.quit();
    });
    await cleanup("Isolated connection shutdown failed", async () => {
      await sql?.end({ timeout: 2 });
    });
    await cleanup("Isolation cleanup failed", () => cleanupIsolation(admin, isolation));
    await cleanup("Administrative connection shutdown failed", async () => {
      await admin.end({ timeout: 2 });
    });
    await cleanup("Playwright artifact retention failed", async () => {
      const retained = retainedArtifactsDirectory();
      if (!retained) return;
      await rm(retained, { recursive: true, force: true });
      await mkdir(retained, { recursive: true });
      await cp(path.join(temp, "playwright-output"), path.join(retained, "playwright-output"), {
        recursive: true,
        force: true,
      });
    });
    await cleanup("Temporary artifact cleanup failed", () => rm(temp, { recursive: true, force: true }));
    process.off("SIGINT", markInterrupted);
    process.off("SIGTERM", markInterrupted);
    if (cleanupErrors.length) {
      cleanupError = new AggregateError(cleanupErrors, cleanupErrors.map((error) => error.message).join("; "));
    }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "E2E and cleanup failed");
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  process.stdout.write(
    `Phase 2 real E2E passed (${isolation?.kind === "database" ? "disposable database" : "isolated schema"}).\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
