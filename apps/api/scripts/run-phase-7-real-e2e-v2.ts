import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS } from "@matchday/domain";
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
import { EntitlementRuntime } from "../src/entitlement-runtime.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { DeterministicPhase4AiStub } from "../src/phase-4-ai-provider.js";
import { ReliableGateBPhase4Runtime } from "../src/phase-4-reliable-runtime.js";
import type { Phase4Runtime } from "../src/phase-4-runtime.js";
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

async function deleteOwnedScheduleQueueKeys(redis: Redis, queueName: string): Promise<void> {
  const patterns = [`bull:${queueName}`, `bull:${queueName}:*`, `matchday:job-cancellation:bull:${queueName}:*`];
  for (const pattern of patterns) {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) await redis.unlink(...keys);
    } while (cursor !== "0");
  }
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

async function waitForCompletedScheduleJob(target: Phase4Runtime, accountId: string, jobId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await target.readScheduleJob({ accountId }, jobId);
    if (job.status === "completed") return;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Phase 7 canonical scheduler ended in ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Phase 7 Redis-backed canonical schedule worker");
}

async function publishCanonicalMultiDivisionSchedule({
  sql,
  phase4,
  scheduler,
  accountId,
  competitionId,
}: {
  sql: Sql;
  phase4: ReliableGateBPhase4Runtime;
  scheduler: SchedulerRuntime;
  accountId: string;
  competitionId: string;
}): Promise<{ scheduleRevisionId: string; scheduleVersion: number }> {
  const actor = { accountId };
  const created = await phase4.createSetupDraft(actor, competitionId, `phase7-setup-${randomUUID()}`, randomUUID());
  let document = created.document;

  const saveCurrentStep = async (stepId: "basics" | "capacity" | "settings" | "entries" | "format_preferences") => {
    const steps = {
      basics: () => document.values.basics && { step_id: "basics" as const, value: document.values.basics },
      capacity: () => document.values.capacity && { step_id: "capacity" as const, value: document.values.capacity },
      settings: () => document.values.settings && { step_id: "settings" as const, value: document.values.settings },
      entries: () => document.values.entries && { step_id: "entries" as const, value: document.values.entries },
      format_preferences: () =>
        document.values.format_preferences && {
          step_id: "format_preferences" as const,
          value: document.values.format_preferences,
        },
    };
    const step = steps[stepId]();
    if (!step) throw new Error(`Phase 7 canonical setup is missing ${stepId}`);
    const saved = await phase4.autosaveSetupDraft(
      actor,
      competitionId,
      {
        expected_revision: document.revision,
        idempotency_key: `phase7-${stepId}-${randomUUID()}`,
        transition: { kind: "save_step", step },
      },
      randomUUID(),
    );
    if (saved.outcome !== "saved") throw new Error(`Phase 7 canonical setup did not save ${stepId}`);
    document = saved.document;
  };

  for (const step of ["basics", "capacity", "settings", "entries", "format_preferences"] as const) {
    await saveCurrentStep(step);
  }
  const recommendationEvidence = document.values.format_recommendations;
  const selected = recommendationEvidence?.recommendations.find((item) => item.capacity_status !== "requires_changes");
  if (!recommendationEvidence || !selected || selected.division_formats.length !== 2) {
    throw new Error("Phase 7 canonical setup did not produce a feasible two-division recommendation");
  }
  const recommendationSaved = await phase4.autosaveSetupDraft(
    actor,
    competitionId,
    {
      expected_revision: document.revision,
      idempotency_key: `phase7-recommendation-${randomUUID()}`,
      transition: {
        kind: "save_step",
        step: {
          step_id: "format_recommendations",
          value: { ...recommendationEvidence, selected_recommendation_id: selected.id },
        },
      },
    },
    randomUUID(),
  );
  if (recommendationSaved.outcome !== "saved") throw new Error("Phase 7 canonical recommendation selection failed");
  document = recommendationSaved.document;
  const selectedRecommendation = document.values.format_recommendations?.recommendations.find(
    (item) => item.id === selected.id,
  );
  if (!selectedRecommendation) throw new Error("Phase 7 canonical recommendation selection was not retained");

  for (const divisionFormat of selectedRecommendation.division_formats) {
    if (!divisionFormat.format_revision_id) throw new Error("Phase 7 recommendation has no persisted format revision");
    const builder = await phase4.readFormatBuilder(actor, competitionId, divisionFormat.division_id);
    if (!builder.draft || builder.draft.draft_id !== divisionFormat.format_revision_id) {
      throw new Error("Phase 7 canonical recommendation format provenance is unavailable");
    }
    const validation = await phase4.validateFormat(
      actor,
      competitionId,
      divisionFormat.division_id,
      builder.draft.document,
    );
    if (!validation.valid) throw new Error("Phase 7 canonical recommendation format is invalid");
    const editedDocument = {
      ...builder.draft.document,
      graph: {
        ...builder.draft.document.graph,
        stages: builder.draft.document.graph.stages.map((stage, index) =>
          index === 0 ? { ...stage, label: `${stage.label} — Gate D canonical publication` } : stage,
        ),
      },
    };
    const [latest] = await sql<{ id: string; revision: number; status: string }[]>`
      SELECT id,revision,status FROM format_revisions
      WHERE division_id=${divisionFormat.division_id}
      ORDER BY revision DESC LIMIT 1
    `;
    if (!latest || latest.id !== builder.draft.draft_id || latest.revision !== builder.draft.revision) {
      throw new Error(
        `Phase 7 canonical format draft is stale: ${JSON.stringify({ latest, draft: builder.draft.draft_id })}`,
      );
    }
    const saved = await phase4.saveFormatRevision(
      actor,
      competitionId,
      divisionFormat.division_id,
      {
        draft_id: builder.draft.draft_id,
        expected_revision: builder.draft.revision,
        parent_revision_id: builder.draft.draft_id,
        document: editedDocument,
        idempotency_key: `phase7-save-format-${divisionFormat.division_id}-${randomUUID()}`,
      },
      randomUUID(),
    );
    const materialised = await phase4.materialiseFormat(
      actor,
      saved.draft_id,
      `phase7-materialise-${saved.draft_id}`,
      randomUUID(),
    );
    if (!materialised.match_count || materialised.match_count <= 0) {
      throw new Error("Phase 7 canonical format materialisation produced no matches");
    }
    await phase4.publishFormat(actor, saved.draft_id, `phase7-publish-format-${saved.draft_id}`, randomUUID());
  }

  const [competition] = await sql<{ revision: number; capacity_revision: number; area_id: string }[]>`
    SELECT c.revision,c.capacity_revision,a.id AS area_id
    FROM competitions c JOIN playing_areas a ON a.competition_id=c.id
    WHERE c.id=${competitionId} ORDER BY a.name LIMIT 1
  `;
  if (!competition) throw new Error("Phase 7 canonical schedule requires a playing area");
  const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
  const generated = await phase4.generateSchedule(
    actor,
    competitionId,
    {
      idempotency_key: `phase7-generate-schedule-${randomUUID()}`,
      expected_source_revision: competition.revision,
      expected_capacity_revision: Number(competition.capacity_revision),
      objective: "balanced",
      constraints: {
        minimum_rest: ignored({ minutes: 0 }),
        maximum_matches_per_day: ignored({ matches: 8 }),
        preferred_final_time: ignored({
          target_start_epoch_ms: Date.parse("2026-09-01T12:00:00Z"),
          tolerance_minutes: 60,
        }),
        entry_unavailable: ignored({ by_entry_id: {} }),
        official_availability: ignored({ by_official_id: {} }),
        featured_playing_area: ignored({ area_id: competition.area_id, match_ids: [] }),
        avoid_consecutive_matches: ignored({ minutes: 0 }),
        balance_early_matches: ignored({ before_local_time: "09:00" }),
        balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
        keep_division_together: ignored({ maximum_area_count: 2 }),
        preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
      },
    },
    randomUUID(),
  );
  await scheduler.start();
  await waitForCompletedScheduleJob(phase4, accountId, generated.job.id);
  const completed = await phase4.readScheduleJob(actor, generated.job.id);
  if (!completed.current_best_option_id) throw new Error("Phase 7 canonical scheduler returned no schedule option");
  const accepted = await phase4.acceptScheduleOption(
    actor,
    generated.job.id,
    completed.current_best_option_id,
    { idempotency_key: `phase7-accept-schedule-${randomUUID()}`, expected_job_revision: completed.revision },
    randomUUID(),
  );
  document = await phase4.resumeSetupDraft(
    actor,
    competitionId,
    `phase7-resume-schedule-${randomUUID()}`,
    randomUUID(),
  );
  if (!document.values.schedule_review) throw new Error("Phase 7 canonical schedule review reference is missing");
  const scheduleSaved = await phase4.autosaveSetupDraft(
    actor,
    competitionId,
    {
      expected_revision: document.revision,
      idempotency_key: `phase7-schedule-review-${randomUUID()}`,
      transition: { kind: "save_step", step: { step_id: "schedule_review", value: document.values.schedule_review } },
    },
    randomUUID(),
  );
  if (scheduleSaved.outcome !== "saved") throw new Error("Phase 7 canonical schedule review was not retained");
  const published = await phase4.publishScheduleRevision(
    actor,
    accepted.id,
    { idempotency_key: `phase7-publish-schedule-${randomUUID()}`, expected_revision: accepted.revision },
    randomUUID(),
  );
  return { scheduleRevisionId: accepted.id, scheduleVersion: published.schedule_version };
}

async function main(): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "matchday-phase7-e2e-"));
  // The browser state includes a short-lived scoring bearer credential. Keep it in a
  // harness-owned temporary directory; callers must not redirect it into a retained artifact.
  const statePath = path.join(temporaryDirectory, "state.json");
  const playwrightOutput = path.join(temporaryDirectory, "playwright-output");
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
  let scheduleQueue: ScheduleJobQueue | undefined;
  let scheduler: SchedulerRuntime | undefined;
  let scheduleQueueName: string | undefined;

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
    const sessionId = randomUUID();
    const sessionSecret = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const sessionNow = new Date();
    await sql`
      INSERT INTO identity_sessions(id,account_id,secret_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES(
        ${sessionId},${accountId},${hashSessionSecret(sessionSecret)},${sessionNow},${sessionNow},
        ${new Date(sessionNow.getTime() + 30 * 60_000)},${new Date(sessionNow.getTime() + 12 * 60 * 60_000)}
      )
    `;

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
    const queueName = `matchday-phase7-e2e-${randomUUID()}`;
    scheduleQueueName = queueName;
    scheduleQueue = new ScheduleJobQueue({ queueName, redisUrl });
    scheduler = new SchedulerRuntime({
      queueName,
      redisUrl,
      workerId: `phase7-e2e-${randomUUID()}`,
      store: new PostgresScheduleJobStore(sql),
      optimizer: new DomainScheduleOptimizer({ maxIterationsPerRun: 3, workerExecArgv: [] }),
      concurrency: 1,
      processor: { leaseMs: 35_000, cancellationPollMs: 250, maxYieldIntervalMs: 30_000 },
    });
    const phase4 = new ReliableGateBPhase4Runtime(
      db,
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
      phase2,
    );
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
          name: definition.code === "WOMEN" && index === 7 ? maliciousName : `${definition.name} Team ${index + 1}`,
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

    await phase3.replaceCapacity(
      actor,
      competitionId,
      {
        revision: 1,
        areas: [
          {
            name: "Court 1",
            slotMinutes: 30,
            availability: [
              { date: "2026-09-01", startTime: "00:00", endTime: "23:30" },
              { date: "2026-09-02", startTime: "00:00", endTime: "23:30" },
            ],
          },
          {
            name: "Court 2",
            slotMinutes: 30,
            availability: [
              { date: "2026-09-01", startTime: "00:00", endTime: "23:30" },
              { date: "2026-09-02", startTime: "00:00", endTime: "23:30" },
            ],
          },
        ],
      },
      randomUUID(),
    );

    const publication = await publishCanonicalMultiDivisionSchedule({
      sql,
      phase4,
      scheduler,
      accountId,
      competitionId,
    });

    const scoreableMatches = await sql<
      { id: string; division_id: string; code: string; home_name: string; away_name: string }[]
    >`
      SELECT DISTINCT ON (m.division_id) m.id,m.division_id,m.code,home.name AS home_name,away.name AS away_name
      FROM matches m
      JOIN scheduled_matches sm ON sm.match_id=m.id AND sm.schedule_revision_id=${publication.scheduleRevisionId}
      JOIN division_entries home ON home.id=m.home_entry_id
      JOIN division_entries away ON away.id=m.away_entry_id
      WHERE m.competition_id=${competitionId}
        AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
      ORDER BY m.division_id,m.ordinal,m.id;
    `;
    const scoreable = scoreableMatches.find((match) => match.division_id === divisions[0]?.id);
    if (!scoreable) throw new Error("Phase 7 harness did not materialise a scoreable match");
    if (scoreableMatches.length !== 2) throw new Error("Phase 7 harness requires one resolved match in each division");
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
        (SELECT count(*)::int FROM schedule_revision_formats WHERE schedule_revision_id=${publication.scheduleRevisionId}) AS linked_formats,
        (SELECT count(DISTINCT m.division_id)::int FROM scheduled_matches sm JOIN matches m ON m.id=sm.match_id
          WHERE sm.schedule_revision_id=${publication.scheduleRevisionId}) AS scheduled_divisions;
    `;
    const counts = fixtureCounts[0];
    if (
      !counts ||
      counts.division_count !== 2 ||
      counts.entry_count !== 16 ||
      counts.linked_formats !== 2 ||
      counts.scheduled_divisions !== 2
    ) {
      throw new Error(`Phase 7 fixture invariant failure: ${JSON.stringify(counts)}`);
    }
    const [publicationInvariant] = await sql<
      {
        published_schedule_id: string | null;
        schedule_status: string | null;
        schedule_version: number | null;
        scheduled_match_count: number;
        materialised_match_count: number;
        published_format_count: number;
        accepted_ancestor_id: string | null;
      }[]
    >`
      SELECT
        cp.published_schedule_revision_id::text AS published_schedule_id,
        sr.status AS schedule_status,
        cp.schedule_version AS schedule_version,
        (SELECT count(*)::int FROM scheduled_matches WHERE schedule_revision_id=${publication.scheduleRevisionId}) AS scheduled_match_count,
        (SELECT count(*)::int FROM matches WHERE competition_id=${competitionId}) AS materialised_match_count,
        (SELECT count(*)::int FROM format_revisions WHERE competition_id=${competitionId} AND status='published') AS published_format_count,
        phase4_schedule_revision_accepted_ancestor(${publication.scheduleRevisionId})::text AS accepted_ancestor_id
      FROM competition_publications cp
      JOIN schedule_revisions sr ON sr.id=cp.published_schedule_revision_id
      WHERE cp.competition_id=${competitionId}
    `;
    if (
      !publicationInvariant ||
      publicationInvariant.published_schedule_id !== publication.scheduleRevisionId ||
      publicationInvariant.schedule_status !== "published" ||
      publicationInvariant.schedule_version !== publication.scheduleVersion ||
      publicationInvariant.scheduled_match_count !== publicationInvariant.materialised_match_count ||
      publicationInvariant.published_format_count !== 2 ||
      publicationInvariant.accepted_ancestor_id !== publication.scheduleRevisionId
    ) {
      throw new Error(`Phase 7 canonical publication invariant failure: ${JSON.stringify(publicationInvariant)}`);
    }

    const statePayload = {
      apiOrigin,
      competitionId,
      competitionSlug,
      publicCompetitionPath: `/competitions/${competitionSlug}`,
      scorekeeperPath: `/score#access=${encodeURIComponent(pass.token)}`,
      scoredMatchId: scoreable.id,
      passToken: pass.token,
      divisionIds: divisions.map((division) => division.id),
      divisionNames: divisions.map((division) => division.name),
      divisionFixtures: divisions.map((division) => {
        const match = scoreableMatches.find((candidate) => candidate.division_id === division.id);
        if (!match) throw new Error(`Phase 7 state is missing a fixture for ${division.name}`);
        return {
          divisionId: division.id,
          divisionName: division.name,
          matchId: match.id,
          matchCode: match.code,
          homeName: match.home_name,
          awayName: match.away_name,
        };
      }),
      scheduleRevisionId: publication.scheduleRevisionId,
      scheduleVersion: publication.scheduleVersion,
      organiserCookie: `matchday_session=${sessionId}.${sessionSecret}`,
      xssCompetitionPath: `/competitions/${competitionSlug}`,
      xssMaliciousName: maliciousName,
    };
    await writeFile(statePath, JSON.stringify(statePayload, null, 2), { encoding: "utf8", mode: 0o600 });

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
      phase4Runtime: phase4,
      gateCC4PublicTruthRuntime: phase4.gateCC4PublicTruth,
      entitlementRuntime,
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    await waitForHttp(`${apiOrigin}/health/live`, "Fastify API");
    const publicProjectionResponse = await fetch(
      `${apiOrigin}/api/v1/public/competitions/${encodeURIComponent(competitionSlug)}/current`,
      { headers: { accept: "application/json" } },
    );
    if (!publicProjectionResponse.ok) {
      throw new Error(
        `Phase 7 public projection is unavailable before browser qualification (HTTP ${publicProjectionResponse.status})`,
      );
    }
    const scheduleHeader = publicProjectionResponse.headers.get("x-matchday-schedule-version");
    if (scheduleHeader !== String(publication.scheduleVersion)) {
      throw new Error(
        `Phase 7 public projection schedule version mismatch before browser qualification: ${scheduleHeader}`,
      );
    }

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

    await runProcess("Phase 7 Playwright", "pnpm", ["--filter", "@matchday/web", "test:e2e:gate-d"], {
      ...runtimeEnv,
      PHASE7_E2E_OUTPUT_DIR: playwrightOutput,
    });

    console.log("Phase 7 real browser qualification: PASS");
  } finally {
    await stopProcesses();
    await app?.close().catch(() => undefined);
    await scheduler?.stop().catch(() => undefined);
    await scheduleQueue?.close().catch(() => undefined);
    if (scheduleQueueName) await deleteOwnedScheduleQueueKeys(redis, scheduleQueueName).catch(() => undefined);
    const keys = await redis.keys(`${redisNamespace}*`).catch(() => [] as string[]);
    if (keys.length > 0) await redis.unlink(...keys).catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
    await dropTestSchema(databaseUrl, schema).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("Phase 7 real E2E failed:", error);
  process.exitCode = 1;
});
