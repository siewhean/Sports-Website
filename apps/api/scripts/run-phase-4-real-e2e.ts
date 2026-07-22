import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import type { ScheduleConstraints } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates } from "@matchday/domain";
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
  competitionId: string;
  organisationId: string;
  divisionId: string;
  slug: string;
  formatRevisionId: string;
  scheduleJobId: string;
  scheduleJobRevision: number;
  scheduleOptionId: string;
  moveTarget: {
    match_id: string;
    match_code: string;
    playing_area_id: string;
    slot_id: string;
    start_epoch_ms: number;
    end_epoch_ms: number;
  };
  organiserCookie: string;
};

type BrowserMoveResult = {
  project: string;
  target: Omit<SeedState["moveTarget"], "match_code">;
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

async function seed(
  sql: Sql,
  phase3: Phase3Runtime,
  phase4: ReliableGateBPhase4Runtime,
  fixtureKey: string,
): Promise<SeedState> {
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
  const competition = await phase3.createCompetition(
    { accountId },
    {
      organisationId,
      name: "Phase 4 Real E2E Cup",
      slug: `phase-4-real-e2e-${fixtureKey}`,
      sportCode: "canoe_polo",
      venue: "Real E2E Arena",
      address: "4 Integration Road",
      countryCode: "SG",
      startsOn: "2027-08-01",
      endsOn: "2027-08-01",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
  );
  const divisionId = randomUUID();
  await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competition.id},'Open',8)`;
  for (let seedNumber = 1; seedNumber <= 8; seedNumber += 1) {
    await sql`INSERT INTO division_entries(id,division_id,name,seed,status)
      VALUES(${randomUUID()},${divisionId},${`Real E2E Team ${seedNumber}`},${seedNumber},'confirmed')`;
  }
  const pack = await sql<{ pack_version: string }[]>`
    SELECT pack_version FROM competition_sport_settings WHERE competition_id=${competition.id}
  `;
  if (!pack[0]) throw new Error("Competition sport settings were not seeded");
  await sql`INSERT INTO division_sport_settings(
    division_id,competition_id,sport_code,pack_version,settings_override,updated_by
  ) VALUES(${divisionId},${competition.id},'canoe_polo',${pack[0].pack_version},'{}'::jsonb,${accountId})`;
  await phase3.replaceCapacity(
    { accountId },
    competition.id,
    {
      revision: 1,
      areas: [
        {
          name: "Court 1",
          slotMinutes: 30,
          availability: [{ date: "2027-08-01", startTime: "08:00", endTime: "18:00" }],
        },
      ],
    },
    randomUUID(),
  );

  const graph = structuredClone(createDefaultFormatTemplates(8)[2]!.graph);
  const document = {
    schema_version: 1 as const,
    graph,
    layout: {
      schema_version: 1 as const,
      stage_positions: graph.stages.map((stage, index) => ({ stage_id: stage.id, x: index * 240, y: 80 })),
    },
  };
  const saved = await phase4.saveFormatRevision(
    { accountId },
    competition.id,
    divisionId,
    {
      draft_id: null,
      expected_revision: null,
      parent_revision_id: null,
      document,
      idempotency_key: `real-format-${randomUUID()}`,
    },
    randomUUID(),
  );
  await phase4.materialiseFormat({ accountId }, saved.draft_id, `real-materialise-${randomUUID()}`, randomUUID());
  await sql`INSERT INTO format_validation_evidence(
    format_revision_id,definition_hash,valid,graph_acyclic,graph_reachable,slots_unambiguous,
    deterministic_match_count,available_match_slots,required_match_slots,recommendation_fits_capacity,validated_by
  ) SELECT id,definition_hash,false,false,false,false,0,0,0,false,${accountId}
    FROM format_revisions WHERE id=${saved.draft_id}`;
  const publicationOracle = await sql<
    {
      materialized: boolean;
      exact: boolean;
      hash_matches: boolean;
      declared_count: number;
      match_count: number;
      source_count: number;
    }[]
  >`
    SELECT graph_materialized_at IS NOT NULL materialized,
      phase4_materialization_is_exact(id) exact,
      graph_materialization_hash=phase4_expected_materialization_hash(id) hash_matches,
      graph_match_count declared_count,
      (SELECT count(*)::int FROM matches WHERE format_revision_id=format_revisions.id) match_count,
      (SELECT count(*)::int FROM format_match_sources WHERE format_revision_id=format_revisions.id) source_count
    FROM format_revisions WHERE id=${saved.draft_id}
  `;
  if (
    !publicationOracle[0]?.materialized ||
    !publicationOracle[0].exact ||
    !publicationOracle[0].hash_matches ||
    publicationOracle[0].declared_count !== publicationOracle[0].match_count ||
    publicationOracle[0].source_count !== publicationOracle[0].match_count * 2
  )
    throw new Error(`Format publication oracle failed: ${JSON.stringify(publicationOracle[0])}`);
  await sql`SELECT phase4_publish_format_revision(${saved.draft_id},${accountId},${randomUUID()})`;

  const revisions = await sql<{ revision: number; capacity_revision: number; area_id: string; window_id: string }[]>`
    SELECT c.revision,c.capacity_revision,pa.id area_id,w.id window_id
    FROM competitions c JOIN playing_areas pa ON pa.competition_id=c.id
    JOIN competition_availability_windows w ON w.playing_area_id=pa.id WHERE c.id=${competition.id}
  `;
  if (!revisions[0]) throw new Error("Capacity revision was not seeded");
  const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
  const constraints: ScheduleConstraints = {
    minimum_rest: ignored({ minutes: 0 }),
    maximum_matches_per_day: ignored({ matches: 8 }),
    preferred_final_time: ignored({
      target_start_epoch_ms: Date.parse("2027-08-01T12:00:00Z"),
      tolerance_minutes: 60,
    }),
    entry_unavailable: ignored({ by_entry_id: {} }),
    official_availability: ignored({ by_official_id: {} }),
    featured_playing_area: ignored({ area_id: revisions[0].area_id, match_ids: [] }),
    avoid_consecutive_matches: ignored({ minutes: 0 }),
    balance_early_matches: ignored({ before_local_time: "09:00" }),
    balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
    keep_division_together: ignored({ maximum_area_count: 1 }),
    preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
  };
  const access = await sql<
    {
      id: string;
      organisation_id: string;
      sport_code: string;
      status: string;
      timezone: string;
      capacity_revision: number;
      revision: number;
    }[]
  >`SELECT id,organisation_id,sport_code,status,timezone,capacity_revision,revision
    FROM competitions WHERE id=${competition.id}`;
  const internal = phase4 as unknown as {
    buildScheduleProblem(
      tx: PostgresJsSql,
      competition: (typeof access)[number],
      objective: "balanced",
      constraints: ScheduleConstraints,
    ): Promise<{
      problem: {
        matches: Array<{ id: string; possibleEntryIds: string[]; dependencyMatchIds: string[] }>;
      };
    }>;
  };
  const preflight = await internal.buildScheduleProblem(
    sql as unknown as PostgresJsSql,
    { ...access[0]!, capacity_revision: Number(access[0]!.capacity_revision) },
    "balanced",
    constraints,
  );
  for (const match of preflight.problem.matches) {
    const authoritative = await sql<{ possible_ids: string[]; dependency_ids: string[] }[]>`
      SELECT ARRAY(SELECT entry_id::text FROM phase4_match_possible_entries(${match.id}) ORDER BY entry_id::text) possible_ids,
        ARRAY(SELECT source_match_id::text FROM match_dependencies WHERE match_id=${match.id} ORDER BY source_match_id::text) dependency_ids
    `;
    const expectedPossible = [...match.possibleEntryIds].sort();
    const expectedDependencies = [...match.dependencyMatchIds].sort();
    if (
      JSON.stringify(authoritative[0]?.possible_ids ?? []) !== JSON.stringify(expectedPossible) ||
      JSON.stringify(authoritative[0]?.dependency_ids ?? []) !== JSON.stringify(expectedDependencies)
    )
      throw new Error(`Schedule preflight mismatch: ${JSON.stringify({ match, authoritative: authoritative[0] })}`);
  }
  const generated = await phase4.generateSchedule(
    { accountId },
    competition.id,
    {
      idempotency_key: `real-schedule-${randomUUID()}`,
      expected_source_revision: revisions[0].revision,
      expected_capacity_revision: Number(revisions[0].capacity_revision),
      objective: "balanced",
      constraints,
    },
    randomUUID(),
  );
  const deadline = Date.now() + 15_000;
  let job = await phase4.readScheduleJob({ accountId }, generated.job.id);
  while (job.status !== "completed" && Date.now() < deadline) {
    if (job.status === "failed" || job.status === "cancelled") throw new Error(`Schedule job ended in ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = await phase4.readScheduleJob({ accountId }, generated.job.id);
  }
  if (job.status !== "completed" || !job.current_best_option_id)
    throw new Error("Redis scheduler did not produce a current-best option");
  const options = await phase4.listScheduleOptions({ accountId }, job.id);
  const selected = options.find((option) => option.id === job.current_best_option_id);
  if (!selected?.assignments[0]) throw new Error("Schedule option has no assignments");
  const editableDocument = structuredClone(document);
  editableDocument.layout.stage_positions[0]!.x += 24;
  const editable = await phase4.saveFormatRevision(
    { accountId },
    competition.id,
    divisionId,
    {
      draft_id: saved.draft_id,
      expected_revision: saved.revision,
      parent_revision_id: saved.draft_id,
      document: editableDocument,
      idempotency_key: `real-editable-format-${randomUUID()}`,
    },
    randomUUID(),
  );
  const editableAfterSave = await phase4.readFormatBuilder({ accountId }, competition.id, divisionId);
  if (editableAfterSave.draft?.draft_id !== editable.draft_id)
    throw new Error(`Editable format was not readable after save: ${JSON.stringify(editableAfterSave)}`);
  const occupied = new Set(selected.assignments.map((assignment) => assignment.slot_id));
  const movableAssignment = selected.assignments.at(-1);
  if (!movableAssignment) throw new Error("Schedule option has no movable assignment");
  const movableMatch = await sql<{ code: string }[]>`SELECT code FROM matches WHERE id=${movableAssignment.match_id}`;
  if (!movableMatch[0]) throw new Error("Schedule option references an unknown movable match");
  const freeIndex = Array.from({ length: 20 }, (_, index) => index + 1).find(
    (index) => !occupied.has(`${revisions[0]!.window_id}:${index}`),
  );
  if (!freeIndex) throw new Error("No free schedule slot was available for the move oracle");
  const startEpochMs = Date.parse("2027-08-01T00:00:00.000Z") + (freeIndex - 1) * 30 * 60_000;

  const sessionId = randomUUID();
  const sessionSecret = randomBytes(32).toString("base64url");
  const now = new Date();
  await sql`INSERT INTO identity_sessions(
    id,account_id,secret_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at
  ) VALUES(
    ${sessionId},${accountId},${hashSessionSecret(sessionSecret)},${now},${now},
    ${new Date(now.getTime() + 30 * 60_000)},${new Date(now.getTime() + 12 * 60 * 60_000)}
  )`;
  const editableBeforeBrowser = await phase4.readFormatBuilder({ accountId }, competition.id, divisionId);
  if (editableBeforeBrowser.draft?.draft_id !== editable.draft_id)
    throw new Error(`Editable format changed before browser launch: ${JSON.stringify(editableBeforeBrowser)}`);
  return {
    apiOrigin,
    webOrigin,
    competitionId: competition.id,
    organisationId,
    divisionId,
    slug: `phase-4-real-e2e-${fixtureKey}`,
    formatRevisionId: editable.draft_id,
    scheduleJobId: job.id,
    scheduleJobRevision: job.revision,
    scheduleOptionId: job.current_best_option_id,
    moveTarget: {
      match_id: movableAssignment.match_id,
      match_code: movableMatch[0].code,
      playing_area_id: revisions[0].area_id,
      slot_id: `${revisions[0].window_id}:${freeIndex}`,
      start_epoch_ms: startEpochMs,
      end_epoch_ms: startEpochMs + 30 * 60_000,
    },
    organiserCookie: `matchday_session=${sessionId}.${sessionSecret}`,
  };
}

async function assertDatabaseOracle(
  sql: Sql,
  state: SeedState,
  browserMove: BrowserMoveResult["target"],
): Promise<void> {
  const rows = await sql<
    {
      setup_count: number;
      template_count: number;
      published_count: number;
      schedule_version: number;
      audit_count: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM setup_drafts WHERE competition_id=${state.competitionId}) setup_count,
      (SELECT count(*)::int FROM format_templates WHERE organisation_id=${state.organisationId}) template_count,
      (SELECT count(*)::int FROM schedule_revisions WHERE competition_id=${state.competitionId} AND status='published') published_count,
      (SELECT schedule_version::int FROM competition_publications WHERE competition_id=${state.competitionId}) schedule_version,
      (SELECT count(*)::int FROM audit_events WHERE target_id=${state.competitionId} OR target_id IN (
        SELECT id::text FROM schedule_revisions WHERE competition_id=${state.competitionId}
      )) audit_count
  `;
  const row = rows[0];
  if (
    !row ||
    row.setup_count !== 1 ||
    row.template_count !== 1 ||
    row.published_count !== 1 ||
    row.schedule_version !== 1
  )
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
    WHERE cp.competition_id=${state.competitionId}
      AND (child.playing_area_id,child.starts_at,child.ends_at)
          IS DISTINCT FROM (parent.playing_area_id,parent.starts_at,parent.ends_at)
  `;
  const changed = moved[0];
  if (
    moved.length !== 1 ||
    !changed ||
    changed.match_id !== browserMove.match_id ||
    changed.playing_area_id !== browserMove.playing_area_id ||
    new Date(changed.starts_at).getTime() !== browserMove.start_epoch_ms ||
    new Date(changed.ends_at).getTime() !== browserMove.end_epoch_ms
  )
    throw new Error(`Published move oracle failed: ${JSON.stringify(moved)}`);
  const projectionRows = await sql<{ projection: unknown }[]>`
    SELECT p.projection FROM competition_publications cp
    JOIN public_competition_projections p ON p.competition_id=cp.competition_id
      AND p.schedule_version=cp.schedule_version AND p.result_version=cp.result_version
    WHERE cp.competition_id=${state.competitionId}
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
    publicMoved.starts_at !== new Date(browserMove.start_epoch_ms).toISOString() ||
    publicMoved.ends_at !== new Date(browserMove.end_epoch_ms).toISOString() ||
    publicArea?.id !== browserMove.playing_area_id
  )
    throw new Error(`Public move projection oracle failed: ${JSON.stringify(publicMoved)}`);
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
  const resultFile = path.join(temp, "browser-moves.ndjson");
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
      optimizer: new DomainScheduleOptimizer({ maxIterationsPerRun: 3 }),
      concurrency: 1,
      processor: { leaseMs: 5_000, cancellationPollMs: 20, maxYieldIntervalMs: 1_000 },
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
      projects[projectName] = await seed(sql, phase3, phase4, `project-${index + 1}`);
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
    const apiProbeState = projects[projectNames[0]]!;
    const apiFormatProbe = await fetch(
      `${apiOrigin}/api/v1/competitions/${apiProbeState.competitionId}/divisions/${apiProbeState.divisionId}/format-builder`,
      { headers: { cookie: apiProbeState.organiserCookie } },
    );
    const apiFormatProbeBody: unknown = await apiFormatProbe.json().catch(() => null);
    const apiDraft =
      apiFormatProbeBody && typeof apiFormatProbeBody === "object" && !Array.isArray(apiFormatProbeBody)
        ? (apiFormatProbeBody as { draft?: { draft_id?: string } | null }).draft
        : undefined;
    if (!apiFormatProbe.ok || apiDraft?.draft_id !== apiProbeState.formatRevisionId) {
      const rows = await sql<{ id: string; revision: number; status: string }[]>`
        SELECT id,revision,status FROM format_revisions
        WHERE competition_id=${apiProbeState.competitionId} AND division_id=${apiProbeState.divisionId}
        ORDER BY revision
      `;
      throw new Error(
        `Production API format probe failed with HTTP ${apiFormatProbe.status}: ${JSON.stringify({ apiFormatProbeBody, rows })}`,
      );
    }

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
    const formatProbe = await fetch(`${webOrigin}/organiser/competitions/${probeState.competitionId}/format`, {
      headers: { cookie: probeState.organiserCookie },
    });
    const formatProbeBody = await formatProbe.text();
    if (!formatProbe.ok || !formatProbeBody.includes('data-testid="phase4-format-designer"'))
      throw new Error(
        `Production format-page probe failed with HTTP ${formatProbe.status}: ${formatProbeBody
          .replaceAll(/<script[\s\S]*?<\/script>/g, " ")
          .replaceAll(/<style[\s\S]*?<\/style>/g, " ")
          .replaceAll(/<[^>]+>/g, " ")
          .replaceAll(/\s+/g, " ")
          .slice(0, 4_000)} API=${JSON.stringify(apiFormatProbeBody).slice(0, 12_000)}`,
      );
    const apiScheduleProbe = await fetch(
      `${apiOrigin}/api/v1/competitions/${probeState.competitionId}/schedule-workspace`,
      { headers: { cookie: probeState.organiserCookie } },
    );
    const apiScheduleProbeBody: unknown = await apiScheduleProbe.json().catch(() => null);
    const apiScheduleJobsProbe = await fetch(
      `${apiOrigin}/api/v1/competitions/${probeState.competitionId}/schedule-jobs`,
      { headers: { cookie: probeState.organiserCookie } },
    );
    const apiScheduleJobsProbeBody: unknown = await apiScheduleJobsProbe.json().catch(() => null);
    if (!apiScheduleJobsProbe.ok || !Array.isArray(apiScheduleJobsProbeBody))
      throw new Error(
        `Production API schedule-jobs probe did not satisfy the web contract: HTTP ${apiScheduleJobsProbe.status} ${JSON.stringify(apiScheduleJobsProbeBody).slice(0, 12_000)}`,
      );
    const scheduleProbe = await fetch(`${webOrigin}/organiser/competitions/${probeState.competitionId}/schedule`, {
      headers: { cookie: probeState.organiserCookie },
    });
    const scheduleProbeBody = await scheduleProbe.text();
    if (!scheduleProbe.ok || !scheduleProbeBody.includes('data-testid="phase4-schedule"'))
      throw new Error(
        `Production schedule-page probe failed with HTTP ${scheduleProbe.status}: ${scheduleProbeBody
          .replaceAll(/<script[\s\S]*?<\/script>/g, " ")
          .replaceAll(/<style[\s\S]*?<\/style>/g, " ")
          .replaceAll(/<[^>]+>/g, " ")
          .replaceAll(/\s+/g, " ")
          .slice(
            0,
            4_000,
          )} API=${JSON.stringify(apiScheduleProbeBody).slice(0, 12_000)} JOBS=${JSON.stringify(apiScheduleJobsProbeBody).slice(0, 12_000)}`,
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
    const moveResults = (await readFile(resultFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BrowserMoveResult);
    const projectsToVerify = process.env.PHASE4_E2E_PROJECT ? [process.env.PHASE4_E2E_PROJECT] : projectNames;
    for (const projectName of projectsToVerify) {
      const state = projects[projectName];
      const browserMove = moveResults.find((result) => result.project === projectName)?.target;
      if (!state || !browserMove) throw new Error(`Browser move result missing for ${projectName}`);
      await assertDatabaseOracle(sql, state, browserMove);
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
