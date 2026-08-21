import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { hashSessionSecret, systemClock, type PostgresJsSql } from "@matchday/identity";
import {
  C5_WORKLOAD_OPERATIONS,
  executeC5Workload,
  type C5WorkloadExecutor,
  type C5WorkloadOperation,
  type C5WorkloadProfile,
  type C5WorkloadReceipt,
} from "@matchday/observability";
import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../src/app.js";
import { GateCC4LifecycleOperations } from "../src/gate-c-c4-lifecycle.js";
import { GateCC4Operations } from "../src/gate-c-c4-operations.js";
import { GateCC4PostgresPublisher } from "../src/gate-c-c4-postgres-publisher.js";
import { GateCC4PublicTruthRuntime } from "../src/gate-c-c4-public-truth.js";
import { GateCC4Runtime } from "../src/gate-c-c4-runtime.js";
import { createGateCC5LeaseTakeoverExecutor, type GateCC5LeaseSession } from "../src/gate-c-c5-lease-takeover.js";
import { createGateCC5PublicCurrentExecutor } from "../src/gate-c-c5-public-current.js";
import {
  createGateCC5PublicResultConvergenceExecutor,
  type GateCC5PublicResultConvergenceTarget,
} from "../src/gate-c-c5-public-result-convergence.js";
import {
  createGateCC5RepairPublicationExecutor,
  type GateCC5RepairPublicationTarget,
} from "../src/gate-c-c5-repair-publication.js";
import {
  createGateCC5ScoreWriteResource,
  issueGateCC5ScoreWriteSessions,
  type GateCC5ScoreWriteResource,
} from "../src/gate-c-c5-score-write.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { FallbackKeyringPhase2Runtime } from "../src/phase-2-fallback-keyring-runtime.js";
import { RedisScoringAccessRateLimiter } from "../src/scoring-access-rate-limit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14";
const webOrigin = "http://localhost:3199";
const minimumSamples = 500;

export const approvedC5WorkloadProfile: C5WorkloadProfile = {
  profileId: "gate-c-real-runtime-certification-v2",
  durationSeconds: 900,
  scorekeeperCount: 5,
  publicReaderCount: 10,
  organiserWorkerCount: 5,
  approval: {
    owner: "matchday-platform-qa",
    approvedAtUtc: "2026-08-21T00:00:00.000Z",
    reference: "GATE-C-C5-REAL-RUNTIME-V2",
  },
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function assertCleanSourceTree(): void {
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error(`Refusing C5 certification on a dirty source tree:\n${dirty}`);
}

function scoringAuth(session: { session_id: string; session_token: string; generation: number | null }) {
  if (session.generation === null) throw new Error("C5 fixture did not acquire a writer generation");
  return { sessionId: session.session_id, sessionToken: session.session_token, generation: session.generation };
}

async function seedIdentity(sql: Sql): Promise<{
  accountId: string;
  organisationId: string;
  organiserCookie: string;
}> {
  const accountId = randomUUID();
  const organisationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO accounts (id,primary_email,display_name,email_verified_at)
      VALUES (${accountId},${`gate-c-c5-${accountId}@example.test`},'Gate C C5 Organiser',now())
    `;
    await tx`
      INSERT INTO organisations (id,name,slug)
      VALUES (${organisationId},'Gate C C5 Organisation',${`gate-c-c5-${organisationId.slice(0, 8)}`})
    `;
    await tx`
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
    ${new Date(now.getTime() + 60 * 60_000)},${new Date(now.getTime() + 12 * 60 * 60_000)}
  )`;
  return { accountId, organisationId, organiserCookie: `matchday_session=${sessionId}.${sessionSecret}` };
}

type CompetitionFixture = {
  competitionId: string;
  divisionId: string;
  slug: string;
  matches: Array<{ id: string; homeEntryId: string | null; awayEntryId: string | null }>;
};

async function createCompetitionFixture(
  phase2: Phase2Runtime,
  actor: { accountId: string },
  organisationId: string,
  key: string,
  entryCount: 8 | 16 = 8,
): Promise<CompetitionFixture> {
  const slug = `gate-c-c5-${key}`.replace(/[^a-z0-9-]/gu, "-").slice(0, 100);
  const competition = await phase2.createCompetition(
    actor,
    {
      organisationId,
      name: `Gate C C5 ${key}`,
      slug,
      timezone: "UTC",
      startsOn: "2026-08-21",
      endsOn: "2026-08-22",
    },
    randomUUID(),
  );
  const division = await phase2.createDivision(
    actor,
    competition.id,
    { name: "Open", teamLimit: entryCount },
    randomUUID(),
  );
  await phase2.replaceEntries(
    actor,
    competition.id,
    division.id,
    Array.from({ length: entryCount }, (_, index) => ({ name: `Team ${index + 1}`, seed: index + 1 })),
    randomUUID(),
  );
  await phase2.replaceCapacity(
    actor,
    competition.id,
    [
      {
        name: "Court 1",
        windows: [{ startsAt: "2026-08-21T08:00:00.000Z", endsAt: "2026-08-22T20:00:00.000Z" }],
      },
      {
        name: "Court 2",
        windows: [{ startsAt: "2026-08-21T08:00:00.000Z", endsAt: "2026-08-22T20:00:00.000Z" }],
      },
    ],
    randomUUID(),
  );
  const format = await phase2.generateFormat(actor, competition.id, division.id, randomUUID());
  const schedule = await phase2.generateSchedule(actor, competition.id, format.id, randomUUID());
  await phase2.publishSchedule(actor, competition.id, schedule.id, randomUUID());
  return {
    competitionId: competition.id,
    divisionId: division.id,
    slug,
    matches: format.matches.map((match) => ({
      id: match.id,
      homeEntryId: match.homeEntryId ?? null,
      awayEntryId: match.awayEntryId ?? null,
    })),
  };
}

async function createConvergenceTarget(
  phase2: Phase2Runtime,
  actor: { accountId: string },
  organisationId: string,
  apiOrigin: string,
  index: number,
): Promise<GateCC5PublicResultConvergenceTarget> {
  const fixture = await createCompetitionFixture(phase2, actor, organisationId, `convergence-${index}`);
  const match = fixture.matches.find((candidate) => candidate.homeEntryId && candidate.awayEntryId);
  if (!match) throw new Error(`C5 convergence fixture ${index} has no fully resolved match`);
  const pass = await phase2.createAccessPass(
    actor,
    fixture.competitionId,
    match.id,
    {
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotencyKey: `c5-convergence-${index}`,
    },
    randomUUID(),
  );
  if (!pass.token) throw new Error(`C5 convergence fixture ${index} pass issuance returned no one-time token`);
  const session = await phase2.exchangeAccess(
    {
      token: pass.token,
      expectedMatchId: match.id,
      deviceId: randomUUID(),
      deviceLabel: `C5 convergence ${index}`,
      ipAddress: "127.0.0.1",
    },
    randomUUID(),
  );
  const auth = scoringAuth(session);
  const warm = await phase2.appendCanonicalScoreEvent(
    auth,
    {
      client_event_id: randomUUID(),
      type: "match_started",
      occurred_at: new Date().toISOString(),
      segment_number: 1,
      manual_time_seconds: 0,
    },
    0,
    randomUUID(),
  );
  return {
    apiOrigin,
    slug: fixture.slug,
    matchId: match.id,
    sessionId: session.session_id,
    sessionToken: session.session_token,
    writerGeneration: auth.generation,
    expectedSequence: warm.aggregate_version,
  };
}

async function createRepairTarget(
  sql: Sql,
  phase2: Phase2Runtime,
  actor: { accountId: string },
  organisationId: string,
  organiserCookie: string,
  apiOrigin: string,
  index: number,
): Promise<GateCC5RepairPublicationTarget> {
  const fixture = await createCompetitionFixture(phase2, actor, organisationId, `repair-${index}`);
  const source = (
    await sql<{ match_id: string; downstream_match_id: string; division_id: string }[]>`
      SELECT source.id AS match_id,dependency.match_id AS downstream_match_id,source.division_id
      FROM match_dependencies dependency
      JOIN matches source ON source.id=dependency.source_match_id
      JOIN matches downstream ON downstream.id=dependency.match_id
      WHERE source.competition_id=${fixture.competitionId}
        AND downstream.state IN ('pending','ready')
      ORDER BY source.ordinal,source.id,dependency.match_id
      LIMIT 1
    `
  )[0];
  if (!source) throw new Error(`C5 repair fixture ${index} has no dependency target`);
  const entries = await sql<{ id: string }[]>`
    SELECT id FROM division_entries
    WHERE division_id=${source.division_id} AND status IN ('active','confirmed')
    ORDER BY seed,id LIMIT 2
  `;
  if (!entries[0] || !entries[1]) throw new Error(`C5 repair fixture ${index} has insufficient entries`);
  await sql`UPDATE matches SET home_entry_id=${entries[0].id},away_entry_id=${entries[1].id} WHERE id=${source.match_id}`;

  const pass = await phase2.createAccessPass(
    actor,
    fixture.competitionId,
    source.match_id,
    {
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      role: "scorekeeper",
      idempotencyKey: `c5-repair-score-${index}`,
    },
    randomUUID(),
  );
  if (!pass.token) throw new Error(`C5 repair fixture ${index} pass issuance returned no one-time token`);
  const session = await phase2.exchangeAccess(
    {
      token: pass.token,
      expectedMatchId: source.match_id,
      deviceId: randomUUID(),
      deviceLabel: `C5 repair scorer ${index}`,
      ipAddress: "127.0.0.1",
    },
    randomUUID(),
  );
  const auth = scoringAuth(session);
  await phase2.appendCanonicalScoreEvent(
    auth,
    {
      client_event_id: randomUUID(),
      type: "match_started",
      occurred_at: new Date().toISOString(),
      segment_number: 1,
      manual_time_seconds: 0,
    },
    0,
    randomUUID(),
  );
  await phase2.appendCanonicalScoreEvent(
    auth,
    {
      client_event_id: randomUUID(),
      type: "goal",
      occurred_at: new Date().toISOString(),
      team_slot: "home",
      participant_id: "C5 scorer",
      segment_number: 1,
      manual_time_seconds: 60,
    },
    1,
    randomUUID(),
  );
  await phase2.appendCanonicalScoreEvent(
    auth,
    {
      client_event_id: randomUUID(),
      type: "period_change",
      occurred_at: new Date().toISOString(),
      segment_number: 2,
      manual_time_seconds: 0,
    },
    2,
    randomUUID(),
  );
  await phase2.finalise(auth, randomUUID(), randomUUID(), 3);
  await sql`UPDATE matches SET state='in_progress' WHERE id=${source.downstream_match_id}`;
  const correctionClientEventId = randomUUID();
  await phase2.correctCanonicalMatch(
    actor,
    fixture.competitionId,
    source.match_id,
    {
      clientEventId: correctionClientEventId,
      reason: "Gate C C5 controlled correction before repair publication.",
      expectedAggregateVersion: 4,
      events: [
        {
          client_event_id: randomUUID(),
          type: "goal",
          occurred_at: new Date().toISOString(),
          team_slot: "away",
          participant_id: "C5 scorer",
          segment_number: 2,
          manual_time_seconds: 60,
        },
        {
          client_event_id: randomUUID(),
          type: "goal",
          occurred_at: new Date().toISOString(),
          team_slot: "away",
          participant_id: "C5 scorer",
          segment_number: 2,
          manual_time_seconds: 120,
        },
      ],
    },
    randomUUID(),
  );
  const correction = (
    await sql<{ id: string }[]>`
      SELECT id FROM score_correction_transactions
      WHERE match_id=${source.match_id} AND client_event_id=${correctionClientEventId}
    `
  )[0];
  if (!correction) throw new Error(`C5 repair fixture ${index} correction transaction missing`);
  return {
    apiOrigin,
    webOrigin,
    competitionId: fixture.competitionId,
    correctionTransactionId: correction.id,
    organiserCookie,
  };
}

async function mapConcurrent<T>(
  count: number,
  concurrency: number,
  create: (index: number) => Promise<T>,
): Promise<T[]> {
  const output = new Array<T>(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= count) return;
        output[index] = await create(index);
      }
    }),
  );
  return output;
}

export async function runC5BenchmarkAndEvidence() {
  const source = sourceSha();
  assertCleanSourceTree();

  const schema = `gate_c_c5_${process.pid}_${randomBytes(4).toString("hex")}`;
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  const sql = postgres(databaseUrl, {
    max: 30,
    onnotice: () => undefined,
    connection: { search_path: `${schema},public` },
  });
  const identitySql = sql as unknown as PostgresJsSql;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const csrfSecret = randomBytes(32).toString("base64url");
  const fallbackSecret = randomBytes(32).toString("base64url");
  const rateLimitSecret = randomBytes(32).toString("base64url");
  const config = parseConfig({
    ...process.env,
    APP_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "4199",
    API_ALLOWED_ORIGINS: webOrigin,
    MATCHDAY_PUBLIC_ORIGIN: webOrigin,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    IDENTITY_CSRF_HMAC_SECRET: csrfSecret,
    SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: rateLimitSecret,
    SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: fallbackSecret,
    LOG_LEVEL: "silent",
  });
  const identity = new IdentityApiRuntime(
    new UnavailableIdentityProvider(),
    new PostgresIdentityUnitOfWork(identitySql),
    csrfSecret,
    systemClock,
  );
  const phase2 = new FallbackKeyringPhase2Runtime(
    identitySql,
    phase2DomainAdapter,
    config.scoringAccess.fallbackCodeHmacKeyring,
    undefined,
    new RedisScoringAccessRateLimiter(
      redis,
      config.scoringAccess.rateLimitHmacKeyring,
      `matchday:gate-c-c5:${source.slice(0, 12)}:${randomUUID()}:scoring-access:`,
    ),
  );
  const c4Publisher = new GateCC4PostgresPublisher(phase2);
  const c4Runtime = new GateCC4Runtime(identitySql, c4Publisher);
  const c4Operations = new GateCC4Operations(identitySql, webOrigin);
  const c4Lifecycle = new GateCC4LifecycleOperations(identitySql);
  const c4PublicTruth = new GateCC4PublicTruthRuntime(identitySql);
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let scoreResource: GateCC5ScoreWriteResource | null = null;

  try {
    const identitySeed = await seedIdentity(sql);
    const actor = { accountId: identitySeed.accountId };
    app = await buildApp({
      config,
      probes: {
        database: async () => (await sql<{ ok: number }[]>`SELECT 1 AS ok`)[0]?.ok === 1,
        queue: async () => true,
        redis: async () => (await redis.ping()) === "PONG",
      },
      rateLimitRedis: redis,
      rateLimitNameSpace: `matchday:gate-c-c5:${source.slice(0, 12)}:${randomUUID()}:`,
      identityRuntime: identity,
      phase2Runtime: phase2,
      gateCC4Runtime: c4Runtime,
      gateCC4Operations: c4Operations,
      gateCC4Lifecycle: c4Lifecycle,
      gateCC4PublicTruthRuntime: c4PublicTruth,
      scoringAccessHmacKeySql: identitySql,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const apiOrigin = address.replace("[::1]", "127.0.0.1");

    const scoreFixture = await createCompetitionFixture(phase2, actor, identitySeed.organisationId, "score", 16);
    const scoreMatches = scoreFixture.matches.filter((match) => match.homeEntryId && match.awayEntryId).slice(0, 5);
    if (scoreMatches.length !== 5) throw new Error("C5 score benchmark requires five fully resolved matches");
    const scoreSessions = await issueGateCC5ScoreWriteSessions(
      phase2,
      actor,
      apiOrigin,
      scoreMatches.map((match) => ({
        competitionId: scoreFixture.competitionId,
        matchId: match.id,
        expectedSequence: 0,
      })),
    );
    scoreResource = await createGateCC5ScoreWriteResource(scoreSessions, { durationSeconds: 900 });

    const publicFixture = await createCompetitionFixture(phase2, actor, identitySeed.organisationId, "public");
    const publicExecutor = createGateCC5PublicCurrentExecutor({ apiOrigin, slug: publicFixture.slug });

    process.stdout.write("Provisioning 500 real public-convergence targets...\n");
    const convergenceTargets = await mapConcurrent(minimumSamples, 8, (index) =>
      createConvergenceTarget(phase2, actor, identitySeed.organisationId, apiOrigin, index),
    );
    const convergenceExecutor = createGateCC5PublicResultConvergenceExecutor(convergenceTargets);

    const leaseFixture = await createCompetitionFixture(phase2, actor, identitySeed.organisationId, "lease", 16);
    const leaseMatches = leaseFixture.matches.filter((match) => match.homeEntryId && match.awayEntryId).slice(0, 5);
    if (leaseMatches.length !== 5) throw new Error("C5 lease benchmark requires five fully resolved matches");
    const leaseBase = await issueGateCC5ScoreWriteSessions(
      phase2,
      actor,
      apiOrigin,
      leaseMatches.map((match) => ({
        competitionId: leaseFixture.competitionId,
        matchId: match.id,
        expectedSequence: 0,
      })),
    );
    const leaseExecutors = leaseBase.map((session, index) => {
      const match = leaseMatches[index];
      if (!match) throw new Error("C5 takeover fixture match is missing");
      const incumbent: GateCC5LeaseSession = {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        generation: session.writerGeneration,
      };
      return createGateCC5LeaseTakeoverExecutor({
        apiOrigin,
        webOrigin,
        competitionId: leaseFixture.competitionId,
        organiserCookie: identitySeed.organiserCookie,
        incumbent,
        createCandidate: async () => {
          const pass = await phase2.createAccessPass(
            actor,
            leaseFixture.competitionId,
            match.id,
            {
              expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
              role: "scorekeeper",
              idempotencyKey: `c5-lease-candidate-${randomUUID()}`,
            },
            randomUUID(),
          );
          if (!pass.token) throw new Error("C5 takeover candidate pass issuance returned no one-time token");
          const candidate = await phase2.exchangeAccess(
            {
              token: pass.token,
              expectedMatchId: match.id,
              deviceId: randomUUID(),
              deviceLabel: "C5 takeover candidate",
              ipAddress: "127.0.0.1",
            },
            randomUUID(),
          );
          if (candidate.mode !== "candidate" || candidate.generation !== session.writerGeneration) {
            throw new Error("C5 takeover candidate did not enter candidate mode at the active generation");
          }
          return {
            sessionId: candidate.session_id,
            sessionToken: candidate.session_token,
            generation: candidate.generation,
          };
        },
      });
    });
    const leaseExecutor: C5WorkloadExecutor = (invocation) => leaseExecutors[invocation.workerIndex]!(invocation);

    process.stdout.write("Provisioning 500 real repair-publication targets...\n");
    const repairTargets = await mapConcurrent(minimumSamples, 6, (index) =>
      createRepairTarget(
        sql,
        phase2,
        actor,
        identitySeed.organisationId,
        identitySeed.organiserCookie,
        apiOrigin,
        index,
      ),
    );
    const repairExecutor = createGateCC5RepairPublicationExecutor(repairTargets);

    const executors: Record<C5WorkloadOperation, C5WorkloadExecutor> = {
      score_event_acknowledgement: scoreResource.executor,
      public_current_conditional_read: publicExecutor,
      public_result_convergence: convergenceExecutor,
      lease_takeover: leaseExecutor,
      repair_publication: repairExecutor,
    };
    const operations = {} as Record<C5WorkloadOperation, C5WorkloadReceipt>;
    for (const operation of C5_WORKLOAD_OPERATIONS) {
      process.stdout.write(`Running real C5 operation: ${operation}\n`);
      operations[operation] = await executeC5Workload(
        {
          operation,
          profile: approvedC5WorkloadProfile,
          maximumSamples: minimumSamples,
          operationTimeoutMs: 60_000,
        },
        executors[operation],
      );
    }

    const postgresVersion = (await sql<{ version: string }[]>`SHOW server_version`)[0]?.version ?? "unknown";
    const redisInfo = await redis.info("server");
    const redisVersion = redisInfo.match(/^redis_version:([^\r\n]+)$/mu)?.[1] ?? "unknown";
    const receipt = {
      artifact_kind: "gate-c-c5-unsealed-real-infrastructure-observation",
      source_sha: source,
      evidence_type: "real_infrastructure",
      // This runner does not itself execute the full controlled-failure suite.
      // It is an operational benchmark observation only; the integrated C5
      // workload runner is the sole certification evidence authority.
      status: "NOT_CERTIFICATION_EVIDENCE",
      collected_at: new Date().toISOString(),
      runtime: {
        application: "matchday-api",
        benchmark_owned_routes: false,
        api_origin_sha256: sha256(apiOrigin),
        app_composition: "buildApp",
      },
      environment: {
        postgresql_version: postgresVersion,
        redis_version: redisVersion,
        postgresql_identifier_sha256: sha256(`${databaseUrl}#${schema}`),
        redis_identifier_sha256: sha256(redisUrl),
      },
      operations,
    };
    const out = path.join(root, "artifacts", "qa", "gate-c-c5", source);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "benchmark.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } finally {
    await scoreResource?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await dropTestSchema(databaseUrl, schema).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const receipt = await runC5BenchmarkAndEvidence();
  process.stdout.write(`C5 real Matchday benchmark observation completed for ${receipt.source_sha}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(
      `C5 benchmark FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
