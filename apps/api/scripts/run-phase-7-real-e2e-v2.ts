import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS } from "@matchday/domain";
import { systemClock, type PostgresJsSql } from "@matchday/identity";
import Redis from "ioredis";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../src/app.js";
import { EntitlementRuntime } from "../src/entitlement-runtime.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { RedisScoringAccessRateLimiter } from "../src/scoring-access-rate-limit.js";
import { testConfig } from "../tests/helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const schema = `test_phase7_e2e_${randomUUID().replaceAll("-", "")}`;
const apiPort = Number(process.env.PHASE7_E2E_API_PORT ?? 4107);
const webPort = Number(process.env.PHASE7_E2E_WEB_PORT ?? 3107);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const scoringPassTtlMs = 2 * 60 * 60_000;
const redisNamespace = `matchday:phase7-e2e:${randomUUID()}:`;
const activeProcesses: ChildProcess[] = [];

function startProcess(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[${name}] ${String(chunk)}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${name}] ${String(chunk)}`));
  activeProcesses.push(child);
  return child;
}

async function runProcess(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => process.stdout.write(`[${name}] ${String(chunk)}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[${name}] ${String(chunk)}`));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with ${code ?? `signal ${signal}`}`));
    });
  });
}

async function waitForHttp(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready at ${url}`, { cause: lastError });
}

async function stopProcesses(): Promise<void> {
  await Promise.all(
    activeProcesses.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.killed) return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            resolve();
          }, 5_000).unref();
        }),
    ),
  );
}

async function seedActiveSportPacks(sql: Sql): Promise<void> {
  for (const [sportId, pack] of Object.entries(SPORT_PACKS)) {
    const hash = phase3DomainAdapter.hash(pack);
    await sql`
      INSERT INTO sport_pack_versions(
        sport_code,version,schema_version,definition,definition_hash,status,revision,activated_at
      ) VALUES(
        ${sportId},${pack.version},${pack.schemaVersion},${sql.json(pack)},${hash},'active',1,now()
      )
      ON CONFLICT (sport_code,version) DO UPDATE SET
        definition=EXCLUDED.definition,
        definition_hash=EXCLUDED.definition_hash,
        schema_version=EXCLUDED.schema_version,
        status='active',
        activated_at=now();
    `;
  }
}

async function main(): Promise<void> {
  const artifactDir = path.join(root, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const statePath = process.env.PHASE7_E2E_STATE_FILE ?? path.join(artifactDir, "phase-7-e2e-state.json");
  const playwrightOutput = path.join(artifactDir, "phase-7-playwright-output");
  await rm(playwrightOutput, { recursive: true, force: true });

  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });

  const sql = postgres(databaseUrl, {
    max: 10,
    onnotice: () => undefined,
    connection: { search_path: schema },
  });
  const db = sql as unknown as PostgresJsSql;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  try {
    if ((await redis.ping()) !== "PONG") throw new Error("Phase 7 real E2E requires a healthy Redis instance");
    await seedActiveSportPacks(sql);

    const accountId = randomUUID();
    const organisationId = randomUUID();
    await sql`
      INSERT INTO accounts(id,primary_email,display_name,email_verified_at)
      VALUES(${accountId},${`phase7-${accountId}@matchday.test`},'Phase 7 Organiser',now());
    `;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO organisations(id,name,slug)
        VALUES(${organisationId},'Phase 7 Organisation',${`phase7-org-${randomUUID().slice(0, 8)}`});
      `;
      await tx`
        INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisationId},${accountId},'owner','active');
      `;
    });

    const identityRuntime = new IdentityApiRuntime(
      new UnavailableIdentityProvider(),
      new PostgresIdentityUnitOfWork(db),
      "phase7-e2e-csrf-secret-at-least-32-chars-long",
      systemClock,
    );
    const accessLimiter = new RedisScoringAccessRateLimiter(
      redis,
      "phase7-e2e-rate-limit-hmac-secret-at-least-32-bytes-long",
      redisNamespace,
    );
    const phase2 = new Phase2Runtime(
      db,
      phase2DomainAdapter,
      () => new Date(),
      accessLimiter,
      "phase7-e2e-fallback-hmac-secret-at-least-32-chars",
    );
    const phase3 = new Phase3Runtime(db, phase3DomainAdapter);
    const entitlementRuntime = new EntitlementRuntime(db);
    const actor = { accountId };
    const competitionSlug = `phase7-volleyball-${randomUUID().slice(0, 8)}`;
    const maliciousName = `Gate D <script>window.__xss_injected_flag=true</script>`;

    const competition = await phase3.createCompetition(
      actor,
      {
        organisationId,
        name: "Phase 7 Volleyball Championship",
        slug: competitionSlug,
        sportCode: "volleyball",
        venue: "Gate D Arena",
        address: "1 Qualification Way",
        countryCode: "SG",
        startsOn: "2026-09-01",
        endsOn: "2026-09-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
      `phase7-e2e-competition-${randomUUID()}`,
    );
    const competitionId = String(competition.id);
    await sql`
      INSERT INTO competition_publications(competition_id)
      VALUES(${competitionId}) ON CONFLICT (competition_id) DO NOTHING;
    `;

    const divisionDefinitions = [
      { name: "Men Open", code: "MEN" },
      { name: "Women Open", code: "WOMEN" },
    ] as const;
    const divisions: Array<{ id: string; name: string; code: string }> = [];

    for (const definition of divisionDefinitions) {
      const created = await phase3.createDivision(
        actor,
        competitionId,
        { name: definition.name, code: definition.code, entryLimit: 8 },
        randomUUID(),
        `phase7-e2e-division-${definition.code.toLowerCase()}-${randomUUID()}`,
      );
      const divisionId = String((created as Record<string, unknown>).id);
      divisions.push({ id: divisionId, ...definition });
      await phase2.replaceEntries(
        actor,
        competitionId,
        divisionId,
        Array.from({ length: 8 }, (_, index) => ({
          name:
            definition.code === "WOMEN" && index === 7
              ? maliciousName
              : `${definition.name} Team ${index + 1}`,
          seed: index + 1,
        })),
        randomUUID(),
      );
    }

    await sql`
      UPDATE division_sport_settings
      SET settings_override=${sql.json({
        bestOf: 1,
        regularTargetPoints: 1,
        decidingTargetPoints: 1,
        winBy: 1,
        pointCap: 1,
      })},revision=revision+1,updated_by=${accountId},updated_at=now()
      WHERE competition_id=${competitionId};
    `;

    await phase2.replaceCapacity(
      actor,
      competitionId,
      [
        {
          name: "Court 1",
          windows: [{ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-02T10:00:00.000Z" }],
        },
        {
          name: "Court 2",
          windows: [{ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-02T10:00:00.000Z" }],
        },
      ],
      randomUUID(),
    );

    const formats: Array<{ id: string; divisionId: string }> = [];
    const schedules: Array<{ id: string; formatId: string; divisionId: string }> = [];
    for (const division of divisions) {
      const format = await phase2.generateFormat(actor, competitionId, division.id, randomUUID());
      formats.push({ id: format.id, divisionId: division.id });
      const schedule = await phase2.generateSchedule(actor, competitionId, format.id, randomUUID());
      schedules.push({ id: schedule.id, formatId: format.id, divisionId: division.id });
    }

    const aggregate = schedules[0];
    const secondary = schedules[1];
    if (!aggregate || !secondary) throw new Error("Phase 7 harness requires two generated schedules");
    await sql.begin(async (tx) => {
      for (const format of formats) {
        await tx`
          INSERT INTO schedule_revision_formats(
            schedule_revision_id,competition_id,division_id,format_revision_id
          ) VALUES(${aggregate.id},${competitionId},${format.divisionId},${format.id})
          ON CONFLICT DO NOTHING;
        `;
      }
      await tx`
        INSERT INTO scheduled_matches(
          schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at
        )
        SELECT ${aggregate.id},match_id,competition_id,playing_area_id,
               starts_at + interval '8 hours',ends_at + interval '8 hours'
        FROM scheduled_matches WHERE schedule_revision_id=${secondary.id};
      `;
    });
    await phase2.publishSchedule(actor, competitionId, aggregate.id, randomUUID());
    await sql`
      UPDATE format_revisions SET status='published',published_at=COALESCE(published_at,now())
      WHERE id=${secondary.formatId} AND status='draft';
    `;

    const [scoreable] = await sql<{ id: string; division_id: string }[]>`
      SELECT m.id,m.division_id
      FROM matches m
      JOIN scheduled_matches sm ON sm.match_id=m.id AND sm.schedule_revision_id=${aggregate.id}
      WHERE m.competition_id=${competitionId}
        AND m.division_id=${divisions[0]!.id}
        AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
      ORDER BY m.ordinal,m.id LIMIT 1;
    `;
    if (!scoreable) throw new Error("Phase 7 harness did not materialise a scoreable match");
    const pass = await phase2.createAccessPass(
      actor,
      competitionId,
      scoreable.id,
      {
        expiresAt: new Date(Date.now() + scoringPassTtlMs).toISOString(),
        role: "scorekeeper",
        idempotencyKey: `phase7-e2e-pass-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!pass.token) throw new Error("Phase 7 harness did not receive a one-time scorekeeper token");

    const fixtureCounts = await sql<
      { division_count: number; entry_count: number; linked_formats: number; scheduled_divisions: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM divisions WHERE competition_id=${competitionId}) AS division_count,
        (SELECT count(*)::int FROM division_entries e JOIN divisions d ON d.id=e.division_id
          WHERE d.competition_id=${competitionId}) AS entry_count,
        (SELECT count(*)::int FROM schedule_revision_formats WHERE schedule_revision_id=${aggregate.id}) AS linked_formats,
        (SELECT count(DISTINCT m.division_id)::int FROM scheduled_matches sm JOIN matches m ON m.id=sm.match_id
          WHERE sm.schedule_revision_id=${aggregate.id}) AS scheduled_divisions;
    `;
    const counts = fixtureCounts[0];
    if (!counts || counts.division_count !== 2 || counts.entry_count !== 16 || counts.linked_formats !== 2 || counts.scheduled_divisions !== 2) {
      throw new Error(`Phase 7 fixture invariant failure: ${JSON.stringify(counts)}`);
    }

    const statePayload = {
      competitionId,
      competitionSlug,
      publicCompetitionPath: `/c/${competitionSlug}`,
      scorekeeperPath: `/score#access=${encodeURIComponent(pass.token)}`,
      scoredMatchId: scoreable.id,
      passToken: pass.token,
      divisionIds: divisions.map((division) => division.id),
      divisionNames: divisions.map((division) => division.name),
      scheduleRevisionId: aggregate.id,
      xssCompetitionPath: `/c/${competitionSlug}`,
      xssMaliciousName: maliciousName,
    };
    await writeFile(statePath, JSON.stringify(statePayload, null, 2), "utf8");

    const config = testConfig({
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      API_ALLOWED_ORIGINS: `${webOrigin},http://localhost:${webPort}`,
    });
    const databaseProbe = async () => {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    };
    app = await buildApp({
      config,
      probes: {
        database: databaseProbe,
        queue: databaseProbe,
        redis: async () => (await redis.ping()) === "PONG",
      },
      identityRuntime,
      phase2Runtime: phase2,
      phase3Runtime: phase3,
      entitlementRuntime,
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    await waitForHttp(`${apiOrigin}/health/live`, "Fastify API");

    const runtimeEnv: NodeJS.ProcessEnv = {
      APP_ENV: "test",
      MATCHDAY_API_BASE_URL: apiOrigin,
      MATCHDAY_PHASE2_DATA_MODE: "api",
      MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE: "true",
      PHASE7_E2E_WEB_BASE_URL: webOrigin,
      PHASE7_E2E_STATE_FILE: statePath,
      SCORING_SESSION_SEAL_KEY: Buffer.alloc(32, 37).toString("base64url"),
    };
    delete runtimeEnv.NEXT_PUBLIC_MATCHDAY_API_BASE_URL;

    await runProcess("production web build", "pnpm", ["--filter", "@matchday/web", "build"], runtimeEnv);
    startProcess(
      "production web",
      "pnpm",
      ["--filter", "@matchday/web", "start", "--hostname", "127.0.0.1", "--port", String(webPort)],
      runtimeEnv,
    );
    await waitForHttp(webOrigin, "Next.js web");

    await runProcess(
      "Phase 7 Playwright",
      "pnpm",
      ["--filter", "@matchday/web", "test:e2e:gate-d"],
      { ...runtimeEnv, PHASE7_E2E_OUTPUT_DIR: playwrightOutput },
    );

    console.log("Phase 7 real browser qualification: PASS");
  } finally {
    await stopProcesses();
    await app?.close().catch(() => undefined);
    const keys = await redis.keys(`${redisNamespace}*`).catch(() => [] as string[]);
    if (keys.length > 0) await redis.unlink(...keys).catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
    await dropTestSchema(databaseUrl, schema).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("Phase 7 real E2E failed:", error);
  process.exitCode = 1;
});
