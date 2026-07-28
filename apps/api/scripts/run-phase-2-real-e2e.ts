import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS, type SportId } from "@matchday/domain";
import { hashSessionSecret, systemClock, type PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../src/app.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { RedisScoringAccessRateLimiter } from "../src/scoring-access-rate-limit.js";
import { Redis } from "ioredis";
import {
  passedPlaywrightTestCount,
  redactedIdentifierHash,
  redisLogicalDatabase,
  retainedArtifacts,
  type GateCEvidenceScope,
} from "./gate-c-access-evidence.js";
import {
  canonicalGateCC2ScreenshotPaths,
  canonicalGateCC2ResultSnapshot,
  validateGateCC2BrowserReceipt,
  validateGateCC2SemanticReceipt,
  type GateCC2BrowserReceipt,
  type GateCC2Project,
  type GateCC2SemanticReceipt,
} from "./gate-c-c2-evidence.js";

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
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const evidenceScope = (process.env.PHASE2_E2E_EVIDENCE_SCOPE ?? "gate-c-access") as GateCEvidenceScope;
if (!["gate-c-access", "gate-c-c2"].includes(evidenceScope)) {
  throw new Error(`Unsupported real-E2E evidence scope: ${evidenceScope}`);
}
const retainedArtifactsRoot = path.join(root, "artifacts/qa", evidenceScope, sourceSha);

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
  sports?: GateCC2SportSeed[];
};

type GateCC2SportSeed = {
  sportId: SportId;
  competitionId: string;
  divisionId: string;
  matchId: string;
  downstreamMatchId: string | null;
  slug: string;
  homeName: string;
  awayName: string;
  accessToken: string;
  secondaryDivision?: {
    divisionId: string;
    matchId: string;
    homeName: string;
    awayName: string;
    accessToken: string;
  };
  action: {
    eventType: string;
    accessibleName: string;
    participantRequired: boolean;
    manualTimeRequired: boolean;
  };
};

const gateCC2Actions: Readonly<Record<SportId, Omit<GateCC2SportSeed["action"], "accessibleName">>> = {
  canoe_polo: { eventType: "goal", participantRequired: true, manualTimeRequired: true },
  badminton: { eventType: "point", participantRequired: false, manualTimeRequired: false },
  table_tennis: { eventType: "point", participantRequired: false, manualTimeRequired: false },
  volleyball: { eventType: "point", participantRequired: false, manualTimeRequired: false },
  basketball: { eventType: "three_point_score", participantRequired: false, manualTimeRequired: true },
};
const gateCC2SettingsOverrides: Readonly<Record<SportId, Readonly<Record<string, number>>>> = {
  canoe_polo: { periods: 1 },
  badminton: { bestOf: 1, regularTargetPoints: 1, winBy: 1, pointCap: 1 },
  table_tennis: { bestOf: 1, regularTargetPoints: 1, winBy: 1, pointCap: 1 },
  volleyball: { bestOf: 1, regularTargetPoints: 1, decidingTargetPoints: 1, winBy: 1, pointCap: 1 },
  basketball: { periods: 1 },
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
    throw new Error(`PHASE2_E2E_RETAIN_DIR must stay under artifacts/qa/${evidenceScope}/${sourceSha}`);
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
  const runtime = new Phase2Runtime(
    sql as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    "phase-2-e2e-fallback-code-hmac-secret",
  );
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
  const sports: SportId[] =
    evidenceScope === "gate-c-c2"
      ? ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]
      : ["canoe_polo"];
  for (const sportId of sports) {
    const pack = SPORT_PACKS[sportId];
    const hashes = await sql<{ value: string }[]>`
      SELECT phase4_sha256_json(${sql.json(pack)}) AS value
    `;
    await sql`
      INSERT INTO sport_pack_versions (
        sport_code,version,schema_version,definition,definition_hash,status,activated_at
      ) VALUES (
        ${sportId},${pack.version},${pack.schemaVersion},${sql.json(pack)},${hashes[0]!.value},'active',now()
      )
    `;
  }

  const c2Sports: GateCC2SportSeed[] = [];
  let probeAccessToken = "";
  for (const [sportIndex, sportId] of sports.entries()) {
    const pack = SPORT_PACKS[sportId];
    const slug = evidenceScope === "gate-c-c2" ? `gate-c-c2-${sportId.replaceAll("_", "-")}` : "phase-2-real-e2e";
    const competition = await runtime.createCompetition(
      actor,
      {
        organisationId,
        name: evidenceScope === "gate-c-c2" ? `Gate C C2 ${pack.displayName} Cup` : "Phase 2 Real E2E Cup",
        slug,
        timezone: "Asia/Singapore",
        startsOn: "2026-08-01",
        endsOn: "2026-08-01",
      },
      randomUUID(),
    );
    await sql.begin(async (transaction) => {
      await transaction`UPDATE competitions SET sport_code=${sportId} WHERE id=${competition.id}`;
      await transaction`
        UPDATE competition_sport_settings SET
          sport_code=${sportId},
          pack_version=${pack.version},
          pack_schema_version=${pack.schemaVersion},
          recommended_snapshot=${transaction.json(pack.recommendedSettings)},
          settings_override=${transaction.json(evidenceScope === "gate-c-c2" ? gateCC2SettingsOverrides[sportId] : {})}
        WHERE competition_id=${competition.id}
      `;
    });
    const division = await runtime.createDivision(actor, competition.id, { name: "Open", teamLimit: 8 }, randomUUID());
    await runtime.replaceEntries(
      actor,
      competition.id,
      division.id,
      Array.from({ length: 8 }, (_, index) => ({
        name: `${pack.displayName} Team ${index + 1}`,
        seed: index + 1,
      })),
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
    const existingDependency =
      evidenceScope === "gate-c-c2" && sportIndex === 0
        ? (
            await sql<{ source_match_id: string; downstream_match_id: string }[]>`
              SELECT dependency.source_match_id,dependency.match_id AS downstream_match_id
              FROM match_dependencies dependency
              JOIN matches source ON source.id=dependency.source_match_id
              WHERE source.format_revision_id=${format.id}
                AND source.home_entry_id IS NOT NULL
                AND source.away_entry_id IS NOT NULL
              ORDER BY source.ordinal,dependency.match_id
              LIMIT 1
            `
          )[0]
        : null;
    if (evidenceScope === "gate-c-c2" && sportIndex === 0 && !existingDependency) {
      throw new Error("Canonical C2 format has no existing resolved-source dependency for conflict evidence");
    }
    const firstMatch =
      format.matches.find((match) => match.id === existingDependency?.source_match_id) ??
      format.matches.find((match) => match.homeEntryId && match.awayEntryId);
    if (!firstMatch?.homeEntryId || !firstMatch.awayEntryId) {
      throw new Error(`Canonical ${sportId} seed has no resolved match`);
    }
    const participants = await sql<{ id: string; name: string }[]>`
      SELECT id,name FROM division_entries WHERE id IN (${firstMatch.homeEntryId},${firstMatch.awayEntryId})
    `;
    const names = new Map(participants.map((entry) => [entry.id, entry.name]));
    const homeName = names.get(firstMatch.homeEntryId) ?? `${pack.displayName} Home`;
    const awayName = names.get(firstMatch.awayEntryId) ?? `${pack.displayName} Away`;
    const access = await runtime.createAccessPass(
      actor,
      competition.id,
      firstMatch.id,
      {
        expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        role: "scorekeeper",
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    if (!access.token) throw new Error(`Canonical ${sportId} seed did not issue a raw one-time token`);
    const probeMatch = format.matches.find(
      (match) => match.id !== firstMatch.id && match.homeEntryId && match.awayEntryId,
    );
    if (!probeMatch) throw new Error(`Canonical ${sportId} seed has no second resolved match`);
    if (sportIndex === 0) {
      const probeAccess = await runtime.createAccessPass(
        actor,
        competition.id,
        probeMatch.id,
        {
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          role: "scorekeeper",
          idempotencyKey: randomUUID(),
        },
        randomUUID(),
      );
      if (!probeAccess.token) throw new Error("Transport probe access token was not issued");
      probeAccessToken = probeAccess.token;
    }
    let downstreamMatchId: string | null = null;
    if (evidenceScope === "gate-c-c2" && sportIndex === 0) {
      downstreamMatchId = existingDependency!.downstream_match_id;
    }
    const schedule = await runtime.generateSchedule(actor, competition.id, format.id, randomUUID());
    await runtime.publishSchedule(actor, competition.id, schedule.id, randomUUID());
    if (downstreamMatchId) await sql`UPDATE matches SET state='in_progress' WHERE id=${downstreamMatchId}`;
    const scoreEvent = pack.eventTypes.find((event) => event.id === gateCC2Actions[sportId].eventType);
    if (!scoreEvent) throw new Error(`C2 action is unavailable for ${sportId}`);
    let secondaryDivision: GateCC2SportSeed["secondaryDivision"];
    if (evidenceScope === "gate-c-c2" && sportId === "badminton") {
      const [secondary] = await sql<{ id: string }[]>`
        INSERT INTO divisions(competition_id,name,team_limit)
        VALUES(${competition.id},'Women',8)
        RETURNING id
      `;
      if (!secondary) throw new Error("C2 multi-division seed did not create its second division");
      await runtime.replaceEntries(
        actor,
        competition.id,
        secondary.id,
        Array.from({ length: 8 }, (_, index) => ({
          name: `${pack.displayName} Women ${index + 1}`,
          seed: index + 1,
        })),
        randomUUID(),
      );
      const secondaryFormat = await runtime.generateFormat(actor, competition.id, secondary.id, randomUUID());
      const secondaryMatch = secondaryFormat.matches.find((match) => match.homeEntryId && match.awayEntryId);
      if (!secondaryMatch?.homeEntryId || !secondaryMatch.awayEntryId) {
        throw new Error("C2 multi-division seed has no resolved second-division match");
      }
      const secondaryParticipants = await sql<{ id: string; name: string }[]>`
        SELECT id,name FROM division_entries
        WHERE id IN (${secondaryMatch.homeEntryId},${secondaryMatch.awayEntryId})
      `;
      const secondaryNames = new Map(secondaryParticipants.map((entry) => [entry.id, entry.name]));
      const secondaryAccess = await runtime.createAccessPass(
        actor,
        competition.id,
        secondaryMatch.id,
        {
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          role: "scorekeeper",
          idempotencyKey: randomUUID(),
        },
        randomUUID(),
      );
      if (!secondaryAccess.token) throw new Error("C2 multi-division access token was not issued");
      secondaryDivision = {
        divisionId: secondary.id,
        matchId: secondaryMatch.id,
        homeName: secondaryNames.get(secondaryMatch.homeEntryId) ?? "Badminton Women Home",
        awayName: secondaryNames.get(secondaryMatch.awayEntryId) ?? "Badminton Women Away",
        accessToken: secondaryAccess.token,
      };
    }
    c2Sports.push({
      sportId,
      competitionId: competition.id,
      divisionId: division.id,
      matchId: firstMatch.id,
      downstreamMatchId,
      slug,
      homeName,
      awayName,
      accessToken: access.token,
      ...(secondaryDivision ? { secondaryDivision } : {}),
      action: {
        ...gateCC2Actions[sportId],
        accessibleName: `${scoreEvent.label} ${homeName}`,
      },
    });
  }
  const primary = c2Sports[0];
  if (!primary || !probeAccessToken) throw new Error("Canonical seed did not produce its primary aggregate");

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
    competitionId: primary.competitionId,
    divisionId: primary.divisionId,
    matchId: primary.matchId,
    slug: primary.slug,
    homeName: primary.homeName,
    awayName: primary.awayName,
    accessToken: primary.accessToken,
    probeAccessToken,
    organiserCookie: `matchday_session=${sessionId}.${sessionSecret}`,
    csrfToken,
    ...(evidenceScope === "gate-c-c2" ? { sports: c2Sports } : {}),
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

async function assertGateCC2DatabaseOracle(
  sql: Sql,
  state: SeedState,
  browser: GateCC2BrowserReceipt,
): Promise<GateCC2SemanticReceipt> {
  if (!state.sports || state.sports.length !== 5) {
    throw new Error("Gate C C2 database oracle requires five distinct seeded aggregates");
  }
  const sports: GateCC2SemanticReceipt["database"]["sports"] = [];
  for (const sport of state.sports) {
    const [stream, events, results, publication, correction, standings, audit, outbox] = await Promise.all([
      sql<
        {
          sport_code: string;
          pack_version: string;
          settings_fingerprint: string;
          current_version: number;
        }[]
      >`
        SELECT sport_code,pack_version,settings_fingerprint,current_version
        FROM match_score_streams WHERE match_id=${sport.matchId}
      `,
      sql<
        {
          event_type: string;
          sequence: number;
          aggregate_version: number;
          client_event_id: string;
          reversal_target_event_id: string | null;
          reason: string | null;
          actor_valid: boolean;
        }[]
      >`
        SELECT event_type,sequence,aggregate_version,client_event_id,reversal_target_event_id,reason,
          ((actor_access_session_id IS NOT NULL)::integer + (actor_account_id IS NOT NULL)::integer = 1) AS actor_valid
        FROM canonical_score_events
        WHERE competition_id=${sport.competitionId} AND match_id=${sport.matchId}
        ORDER BY aggregate_version
      `,
      sql<
        {
          result_version: number;
          through_sequence: number;
          state: string;
          home_score: number;
          away_score: number;
          snapshot: {
            winner: string | null;
            lifecycle: string;
            segments: Array<{
              number: number;
              home: number;
              away: number;
              completed: boolean;
              winner: string | null;
            }>;
          };
        }[]
      >`
        SELECT result_version,through_sequence,state,home_score,away_score,snapshot FROM match_result_snapshots
        WHERE match_id=${sport.matchId} ORDER BY result_version
      `,
      sql<{ result_version: number }[]>`
        SELECT result_version FROM competition_publications WHERE competition_id=${sport.competitionId}
      `,
      sql<
        {
          count: number;
          from_aggregate_version: number;
          through_aggregate_version: number;
          result_version: number;
        }[]
      >`
        SELECT count(*)::integer AS count,
          min(from_aggregate_version)::integer AS from_aggregate_version,
          min(through_aggregate_version)::integer AS through_aggregate_version,
          min(result_version)::integer AS result_version
        FROM score_correction_transactions
        WHERE competition_id=${sport.competitionId} AND match_id=${sport.matchId}
      `,
      sql<
        {
          result_version: number;
          row_count: number;
          settings_version: string;
          advancement_slot_count: number;
          advancement_conflict_count: number;
        }[]
      >`
        SELECT snapshot.result_version,snapshot.settings_version,
          CASE
            WHEN jsonb_typeof(snapshot.standings)='array' THEN jsonb_array_length(snapshot.standings)
            ELSE COALESCE((
              SELECT sum(jsonb_array_length(group_value->'rows'))::integer
              FROM jsonb_each(snapshot.standings->'groups') groups(group_id,group_value)
            ),0)
          END AS row_count,
          (SELECT count(*)::integer FROM advancement_slots slot
            WHERE slot.competition_id=${sport.competitionId}
              AND slot.division_id=snapshot.division_id
              AND slot.result_version<=snapshot.result_version) AS advancement_slot_count,
          (SELECT count(*)::integer FROM advancement_conflicts conflict
            WHERE conflict.competition_id=${sport.competitionId}
              AND conflict.division_id=snapshot.division_id
              AND conflict.result_version=snapshot.result_version) AS advancement_conflict_count
        FROM standings_snapshots snapshot
        WHERE snapshot.competition_id=${sport.competitionId}
        ORDER BY snapshot.result_version DESC LIMIT 1
      `,
      sql<{ action: string }[]>`
        SELECT DISTINCT action FROM audit_events
        WHERE target_type='match' AND target_id=${sport.matchId}
        ORDER BY action
      `,
      sql<{ event_type: string }[]>`
        SELECT DISTINCT event_type FROM outbox_events
        WHERE aggregate_type='match' AND aggregate_id=${sport.matchId}
        ORDER BY event_type
      `,
    ]);
    const canonicalResults = results.map((result) => canonicalGateCC2ResultSnapshot(result.snapshot));
    const streamRow = stream[0];
    const correctionRow = correction[0];
    const standingsRow = standings[0];
    sports.push({
      sport_id: sport.sportId,
      event_types: events.map((event) => event.event_type),
      sequences: events.map((event) => event.sequence),
      aggregate_versions: events.map((event) => event.aggregate_version),
      row_count: events.length,
      distinct_client_event_count: new Set(events.map((event) => event.client_event_id)).size,
      result_versions: results.map((result) => result.result_version),
      result_states: results.map((result) => result.state),
      result_scores: results.map((result) => `${result.home_score}:${result.away_score}`),
      result_winners: canonicalResults.map((result) => result.winner ?? ""),
      result_lifecycles: canonicalResults.map((result) => result.lifecycle),
      result_segment_states: canonicalResults.map((result) => result.segmentState),
      publication_result_version: publication[0]?.result_version ?? -1,
      correction_transactions: correctionRow?.count ?? -1,
      correction_from_version: correctionRow?.from_aggregate_version ?? -1,
      correction_through_version: correctionRow?.through_aggregate_version ?? -1,
      correction_result_version: correctionRow?.result_version ?? -1,
      result_through_sequences: results.map((result) => result.through_sequence),
      stream_sport_code: streamRow?.sport_code ?? "",
      stream_pack_version: streamRow?.pack_version ?? "",
      settings_fingerprint: streamRow?.settings_fingerprint ?? "",
      stream_current_version: streamRow?.current_version ?? -1,
      reversal_target_count: events.filter((event) => event.reversal_target_event_id !== null).length,
      reasoned_reversal_count: events.filter(
        (event) => event.event_type === "reversal" && Boolean(event.reason?.trim()),
      ).length,
      valid_actor_count: events.filter((event) => event.actor_valid).length,
      standings_result_version: standingsRow?.result_version ?? -1,
      standings_row_count: standingsRow?.row_count ?? -1,
      standings_settings_version: standingsRow?.settings_version ?? "",
      advancement_slot_count: standingsRow?.advancement_slot_count ?? -1,
      advancement_conflict_count: standingsRow?.advancement_conflict_count ?? -1,
      audit_actions: audit.map((entry) => entry.action),
      outbox_event_types: outbox.map((entry) => entry.event_type),
    });
  }
  const conflicts = await sql<
    {
      corrected_match_id: string;
      downstream_match_id: string;
      result_version: number;
      reason: string;
      status: string;
      acknowledged_by_account_id: string | null;
      acknowledgement_reason: string | null;
    }[]
  >`
    SELECT corrected_match_id,downstream_match_id,result_version,reason,status,
      acknowledged_by_account_id,acknowledgement_reason
    FROM result_conflicts
    WHERE competition_id=ANY(${state.sports.map((sport) => sport.competitionId)}::uuid[])
    ORDER BY created_at,id
  `;
  const [conflictAudit, conflictOutbox] = await Promise.all([
    sql<{ action: string }[]>`
      SELECT DISTINCT action FROM audit_events
      WHERE target_type='result_conflict'
        AND target_id IN (
          SELECT id::text FROM result_conflicts
          WHERE competition_id=ANY(${state.sports.map((sport) => sport.competitionId)}::uuid[])
        )
      ORDER BY action
    `,
    sql<{ event_type: string }[]>`
      SELECT DISTINCT event_type FROM outbox_events
      WHERE aggregate_type='result_conflict'
        AND aggregate_id IN (
          SELECT id::text FROM result_conflicts
          WHERE competition_id=ANY(${state.sports.map((sport) => sport.competitionId)}::uuid[])
        )
      ORDER BY event_type
    `,
  ]);
  const multiDivisionSport = state.sports.find((sport) => sport.secondaryDivision);
  if (!multiDivisionSport?.secondaryDivision) {
    throw new Error("Gate C C2 database oracle requires the two-division seed");
  }
  const [projectionRow] = await sql<{ projection: unknown }[]>`
    SELECT projection FROM public_competition_projections projection
    JOIN competition_publications publication
      ON publication.competition_id=projection.competition_id
     AND publication.schedule_version=projection.schedule_version
     AND publication.result_version=projection.result_version
    WHERE projection.competition_id=${multiDivisionSport.competitionId}
  `;
  const publicProjection =
    typeof projectionRow?.projection === "string"
      ? (JSON.parse(projectionRow.projection) as Record<string, unknown>)
      : (projectionRow?.projection as Record<string, unknown> | undefined);
  const divisionPackages = Array.isArray(publicProjection?.divisions)
    ? (publicProjection.divisions as Array<Record<string, unknown>>)
    : [];
  const [matchRows, entryRows, resultRows] = await Promise.all([
    sql<{ id: string; division_id: string }[]>`
      SELECT id,division_id FROM matches WHERE competition_id=${multiDivisionSport.competitionId}
    `,
    sql<{ id: string; division_id: string }[]>`
      SELECT entry.id,entry.division_id FROM division_entries entry
      JOIN divisions division ON division.id=entry.division_id
      WHERE division.competition_id=${multiDivisionSport.competitionId}
    `,
    sql<{ match_id: string; result_version: number; division_id: string }[]>`
      SELECT snapshot.match_id,snapshot.result_version,match.division_id
      FROM match_result_snapshots snapshot
      JOIN matches match ON match.id=snapshot.match_id
      WHERE match.competition_id=${multiDivisionSport.competitionId}
      ORDER BY snapshot.result_version
    `,
  ]);
  const matchDivisions = new Map(matchRows.map((row) => [row.id, row.division_id]));
  const entryDivisions = new Map(entryRows.map((row) => [row.id, row.division_id]));
  const nestedReferences = (value: unknown): string[] => {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(nestedReferences);
    return Object.entries(value).flatMap(([key, item]) => [
      ...([
        "id",
        "entryId",
        "entry_id",
        "matchId",
        "match_id",
        "homeEntryId",
        "awayEntryId",
        "home_entry_id",
        "away_entry_id",
      ].includes(key) && typeof item === "string"
        ? [item]
        : []),
      ...nestedReferences(item),
    ]);
  };
  let crossDivisionReferenceCount = 0;
  for (const divisionPackage of divisionPackages) {
    const division = divisionPackage.division as Record<string, unknown> | undefined;
    const divisionId = typeof division?.id === "string" ? division.id : "";
    for (const reference of nestedReferences({
      schedule: divisionPackage.schedule,
      results: divisionPackage.results,
      standings: divisionPackage.standings,
      bracket: divisionPackage.bracket,
    })) {
      const referencedDivision = matchDivisions.get(reference) ?? entryDivisions.get(reference);
      if (referencedDivision && referencedDivision !== divisionId) crossDivisionReferenceCount += 1;
    }
  }
  const receipt: GateCC2SemanticReceipt = {
    artifact_kind: "gate-c-c2-semantic-oracle",
    project_name: browser.project_name,
    browser,
    database: {
      sports,
      downstream_conflicts: {
        created: conflicts.length,
        acknowledged: conflicts.filter((row) => row.status === "acknowledged").length,
        corrected_match_id: conflicts[0]?.corrected_match_id ?? "",
        downstream_match_id: conflicts[0]?.downstream_match_id ?? "",
        result_version: conflicts[0]?.result_version ?? -1,
        reason: conflicts[0]?.reason ?? "",
        acknowledgement_actor_present: Boolean(conflicts[0]?.acknowledged_by_account_id),
        acknowledgement_reason: conflicts[0]?.acknowledgement_reason ?? "",
        audit_actions: conflictAudit.map((entry) => entry.action),
        outbox_event_types: conflictOutbox.map((entry) => entry.event_type),
      },
      multi_division: {
        competition_id: multiDivisionSport.competitionId,
        division_ids: [multiDivisionSport.divisionId, multiDivisionSport.secondaryDivision.divisionId],
        global_result_versions: resultRows.map((row) => row.result_version),
        primary_result_versions: resultRows
          .filter((row) => row.division_id === multiDivisionSport.divisionId)
          .map((row) => row.result_version),
        secondary_result_versions: resultRows
          .filter((row) => row.division_id === multiDivisionSport.secondaryDivision!.divisionId)
          .map((row) => row.result_version),
        public_division_count: divisionPackages.length,
        cross_division_reference_count: crossDivisionReferenceCount,
      },
    },
  };
  const sourceSport = state.sports.find((sport) => sport.sportId === "canoe_polo");
  if (
    !sourceSport ||
    receipt.database.downstream_conflicts.corrected_match_id !== sourceSport.matchId ||
    receipt.database.downstream_conflicts.downstream_match_id !== sourceSport.downstreamMatchId
  ) {
    throw new Error("Gate C C2 downstream conflict is not bound to the seeded source and downstream matches");
  }
  return validateGateCC2SemanticReceipt(receipt, browser.project_name);
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
  const startedAt = new Date();
  const startedAtNanoseconds = process.hrtime.bigint();
  const temp = await mkdtemp(path.join(tmpdir(), "matchday-phase2-e2e-"));
  const stateFile = path.join(temp, "state.json");
  const retainedDirectory = retainedArtifactsDirectory();
  if (retainedDirectory) {
    await mkdir(retainedArtifactsRoot, { recursive: true });
    if ((await realpath(retainedArtifactsRoot)) !== retainedArtifactsRoot) {
      throw new Error("Gate C access retention root must not traverse symlinks");
    }
    await mkdir(path.dirname(retainedDirectory), { recursive: true });
    await mkdir(retainedDirectory);
    if (!(await realpath(retainedDirectory)).startsWith(`${retainedArtifactsRoot}${path.sep}`)) {
      throw new Error("Gate C access retained directory escaped its exact-SHA root");
    }
  }
  const admin = postgres(adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  let isolation: Isolation | null = null;
  let sql: Sql | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let redis: Redis | null = null;
  let redisNamespace: string | null = null;
  let redisGuardKey: string | null = null;
  let initialOwnedRedisKeyCount: number | null = null;
  let finalOwnedRedisKeyCount: number | null = null;
  let redisGuardPreserved = false;
  let playwrightPassCount: number | null = null;
  let c2SemanticReceipt: GateCC2SemanticReceipt | null = null;
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
      SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "phase-2-e2e-fallback-code-hmac-secret",
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
    initialOwnedRedisKeyCount = dirtyOwnedKeys.length;
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
        config.scoringAccess.fallbackCodeHmacSecret,
      ),
      phase3Runtime: new Phase3Runtime(identitySql, phase3DomainAdapter),
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
      GATE_C_ACCESS_PLAYWRIGHT_JSON: path.join(temp, "playwright-output", "results.json"),
      GATE_C_C2_PLAYWRIGHT_JSON: path.join(temp, "playwright-output", "results.json"),
      GATE_C_C2_BROWSER_RECEIPT: path.join(temp, "playwright-output", "c2-browser-receipt.json"),
      GATE_C_C2_SEMANTIC_RECEIPT: path.join(temp, "playwright-output", "c2-semantic-receipt.json"),
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
    if (process.env.PHASE2_E2E_PROJECT) {
      const report = JSON.parse(readFileSync(runtimeEnv.GATE_C_ACCESS_PLAYWRIGHT_JSON!, "utf8")) as unknown;
      playwrightPassCount = passedPlaywrightTestCount(report, process.env.PHASE2_E2E_PROJECT);
    }
    if (evidenceScope === "gate-c-c2") {
      const browserReceipt = validateGateCC2BrowserReceipt(
        JSON.parse(readFileSync(runtimeEnv.GATE_C_C2_BROWSER_RECEIPT!, "utf8")) as unknown,
        process.env.PHASE2_E2E_PROJECT as GateCC2Project,
      );
      c2SemanticReceipt = await assertGateCC2DatabaseOracle(sql, state, browserReceipt);
      await writeFile(runtimeEnv.GATE_C_C2_SEMANTIC_RECEIPT!, `${JSON.stringify(c2SemanticReceipt, null, 2)}\n`, {
        flag: "wx",
      });
    } else if (process.env.PHASE2_E2E_SKIP_PHASE2_ORACLE === "1") {
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
      finalOwnedRedisKeyCount = remainingOwnedKeys.length;
      if (remainingOwnedKeys.length !== 0) {
        throw new Error(`Redis scoring-access cleanup left ${remainingOwnedKeys.length} owned keys`);
      }
      redisGuardPreserved = (await redis.get(redisGuardKey)) === "preserve";
      if (!redisGuardPreserved) {
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
      if (!retainedDirectory) return;
      const outputDirectory = path.join(temp, "playwright-output");
      try {
        await access(outputDirectory);
      } catch {
        return;
      }
      await cp(outputDirectory, path.join(retainedDirectory, "playwright-output"), {
        recursive: true,
        force: false,
        errorOnExist: true,
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
  if (retainedDirectory && process.env.PHASE2_E2E_PROJECT) {
    if (
      !isolation ||
      !redisNamespace ||
      initialOwnedRedisKeyCount !== 0 ||
      finalOwnedRedisKeyCount !== 0 ||
      !redisGuardPreserved ||
      !playwrightPassCount ||
      (evidenceScope === "gate-c-c2" && !c2SemanticReceipt)
    ) {
      throw new Error("Gate C access run did not produce complete isolation evidence");
    }
    const retained = await retainedArtifacts(retainedDirectory);
    const databaseIdentifier = isolation.kind === "database" ? isolation.databaseName : isolation.schema;
    const retainedScreenshotPaths = retained
      .filter((artifact) => artifact.path.endsWith(".png"))
      .map((artifact) => artifact.path);
    const record = {
      schema_version: 1,
      artifact_kind: `${evidenceScope}-project-evidence`,
      source_sha: sourceSha,
      project_name: process.env.PHASE2_E2E_PROJECT,
      pass_count: playwrightPassCount,
      started_at: startedAt.toISOString(),
      duration_ms: Number(process.hrtime.bigint() - startedAtNanoseconds) / 1_000_000,
      ...(c2SemanticReceipt ? { semantic_oracle: c2SemanticReceipt } : {}),
      postgresql: {
        isolation_kind: isolation.kind,
        identifier_sha256: redactedIdentifierHash(evidenceScope, "postgres", databaseIdentifier),
      },
      redis: {
        logical_database: redisLogicalDatabase(redisUrl),
        namespace_sha256: redactedIdentifierHash(evidenceScope, "redis-namespace", redisNamespace),
        initial_owned_key_count: initialOwnedRedisKeyCount,
        final_owned_key_count: finalOwnedRedisKeyCount,
        unrelated_guard_preserved: redisGuardPreserved,
      },
      screenshot_paths:
        evidenceScope === "gate-c-c2"
          ? canonicalGateCC2ScreenshotPaths(retainedScreenshotPaths)
          : retainedScreenshotPaths,
      result_paths: retained.filter((artifact) => artifact.path.endsWith(".json")).map((artifact) => artifact.path),
      artifacts: retained,
    };
    await writeFile(path.join(retainedDirectory, "project-evidence.json"), `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
    });
  }
  process.stdout.write(
    `Phase 2 real E2E passed (${isolation?.kind === "database" ? "disposable database" : "isolated schema"}).\n`,
  );
}

function formatFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const primary = error.stack ?? error.message;
  if (!(error instanceof AggregateError)) return primary;
  return [primary, ...error.errors.map((cause, index) => `[cause ${index + 1}] ${formatFailure(cause)}`)].join("\n");
}

main().catch((error) => {
  process.stderr.write(`${formatFailure(error)}\n`);
  process.exitCode = 1;
});
