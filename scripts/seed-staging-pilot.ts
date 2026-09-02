/**
 * Gate D staging fixture seeder.
 *
 * Core competition/scoring state is created through the existing Phase 3 / Phase 2
 * runtimes so the fixture inherits the current sport-settings, entry, format,
 * materialisation, canonical multi-division scheduling, publication, and scoring-access
 * contracts. Direct SQL is limited to identity/organisation bootstrap and post-seed
 * invariant inspection.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPORT_PACKS } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import {
  DomainScheduleOptimizer,
  PostgresScheduleJobStore,
  ScheduleJobQueue,
  SchedulerRuntime,
} from "@matchday/scheduler";
import type { ScheduleConstraints } from "@matchday/contracts";
import { Redis } from "ioredis";
import postgres from "postgres";
import { phase2DomainAdapter } from "../apps/api/src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../apps/api/src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../apps/api/src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../apps/api/src/phase-3-runtime.js";
import { DeterministicPhase4AiStub } from "../apps/api/src/phase-4-ai-provider.js";
import { ReliableGateBPhase4Runtime } from "../apps/api/src/phase-4-reliable-runtime.js";
import { requireWriterAccessExchange } from "./lib/qa011-access-contract.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.REDIS_URL;
const targetUrl = (process.env.TARGET_URL ?? "http://127.0.0.1:4101").replace(/\/$/, "");
const scoringPassTtlMs = 7 * 24 * 60 * 60_000;

function ignored<T>(value: T) {
  return { mode: "ignored" as const, value };
}

function schedulingConstraints(areaId: string): ScheduleConstraints {
  return {
    minimum_rest: ignored({ minutes: 0 }),
    maximum_matches_per_day: ignored({ matches: 8 }),
    preferred_final_time: ignored({
      target_start_epoch_ms: Date.parse("2026-09-01T12:00:00.000Z"),
      tolerance_minutes: 60,
    }),
    entry_unavailable: ignored({ by_entry_id: {} }),
    official_availability: ignored({ by_official_id: {} }),
    featured_playing_area: ignored({ area_id: areaId, match_ids: [] }),
    avoid_consecutive_matches: ignored({ minutes: 0 }),
    balance_early_matches: ignored({ before_local_time: "09:00" }),
    balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
    keep_division_together: ignored({ maximum_area_count: 1 }),
    preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
  };
}

async function waitForScheduleJob(
  phase4: ReliableGateBPhase4Runtime,
  accountId: string,
  jobId: string,
): Promise<Awaited<ReturnType<ReliableGateBPhase4Runtime["readScheduleJob"]>>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await phase4.readScheduleJob({ accountId }, jobId);
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Canonical Phase 4 schedule job ${jobId} ended in ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for canonical Phase 4 schedule job ${jobId}`);
}

async function deleteOwnedRedisKeys(redis: Redis, queueName: string): Promise<void> {
  const patterns = [`bull:${queueName}`, `bull:${queueName}:*`, `matchday:job-cancellation:bull:${queueName}:*`];
  for (const pattern of patterns) {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  }
}

async function requireApiResponse(url: string, init: RequestInit | undefined, label: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(`Post-seed API verification failed for ${label}: ${url} was unreachable`, { cause: error });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Post-seed API verification failed for ${label}: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`,
    );
  }
  return response;
}

async function assertBenchmarkMatchPristine(sql: postgres.Sql, matchId: string): Promise<void> {
  const [state] = await sql<
    {
      canonical_events: number;
      stream_version: number;
      result_snapshots: number;
      active_writer_lease: boolean;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM canonical_score_events WHERE match_id=${matchId}) AS canonical_events,
      COALESCE((SELECT current_version FROM match_score_streams WHERE match_id=${matchId}),0)::int AS stream_version,
      (SELECT count(*)::int FROM match_result_snapshots WHERE match_id=${matchId}) AS result_snapshots,
      EXISTS(
        SELECT 1 FROM match_writer_leases
        WHERE match_id=${matchId} AND expires_at>clock_timestamp()
      ) AS active_writer_lease;
  `;
  if (
    !state ||
    state.canonical_events !== 0 ||
    state.stream_version !== 0 ||
    state.result_snapshots !== 0 ||
    state.active_writer_lease
  ) {
    throw new Error(`QA-011 benchmark match must be pristine before handoff: ${matchId}`);
  }
}

async function main() {
  if (!redisUrl) throw new Error("REDIS_URL is required for canonical Phase 4 staging schedule generation");
  const parsedRedisUrl = new URL(redisUrl);
  if (parsedRedisUrl.protocol !== "redis:" && parsedRedisUrl.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  const sql = postgres(databaseUrl, { max: 8, onnotice: () => undefined });
  const db = sql as unknown as PostgresJsSql;
  const queueName = `matchday-gate-d-staging-${randomUUID()}`;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const scheduleQueue = new ScheduleJobQueue({ queueName, redisUrl });
  const scheduler = new SchedulerRuntime({
    queueName,
    redisUrl,
    workerId: `gate-d-staging-${randomUUID()}`,
    store: new PostgresScheduleJobStore(sql),
    optimizer: new DomainScheduleOptimizer({ maxIterationsPerRun: 3, workerExecArgv: [] }),
    concurrency: 1,
    processor: { leaseMs: 5_000, cancellationPollMs: 100, maxYieldIntervalMs: 30_000 },
  });
  const accountId = randomUUID();
  const organisationId = randomUUID();
  const competitionSlug = `pilot-vball-${Date.now()}`;
  const actor = { accountId };

  try {
    console.log("════════════════════════════════════════════════════════════");
    console.log(" Gate D staging pilot seeder — runtime-backed fixture");
    console.log(` Database: ${databaseUrl.replace(/:[^:@]+@/, ":***@")}`);
    console.log(` API:      ${targetUrl}`);
    console.log("════════════════════════════════════════════════════════════\n");

    for (const [sportId, pack] of Object.entries(SPORT_PACKS)) {
      const hash = phase3DomainAdapter.hash(pack);
      const active = await sql<
        { version: string; schema_version: number; definition_hash: string; status: "active" }[]
      >`
        SELECT version,schema_version,definition_hash,status
        FROM sport_pack_versions
        WHERE sport_code=${sportId} AND status='active'
        ORDER BY activated_at DESC NULLS LAST,created_at DESC,version DESC;
      `;
      if (active.length > 1) {
        throw new Error(`Sport pack ${sportId} has multiple active versions and cannot be seeded safely`);
      }
      if (active.length === 0) {
        await sql`
          INSERT INTO sport_pack_versions(
            sport_code,version,schema_version,definition,definition_hash,status,revision,activated_at
          ) VALUES(
            ${sportId},${pack.version},${pack.schemaVersion},${sql.json(pack)},${hash},'active',1,now()
          )
          ON CONFLICT (sport_code,version) DO NOTHING;
        `;
      }
      const verifiedRows = await sql<
        { version: string; schema_version: number; definition_hash: string; status: "active" }[]
      >`
        SELECT version,schema_version,definition_hash,status
        FROM sport_pack_versions
        WHERE sport_code=${sportId} AND status='active'
        ORDER BY activated_at DESC NULLS LAST,created_at DESC,version DESC;
      `;
      if (verifiedRows.length !== 1) {
        throw new Error(`Sport pack ${sportId} must have exactly one active version after seed validation`);
      }
      const [verified] = verifiedRows;
      if (
        !verified ||
        verified.version !== pack.version ||
        verified.schema_version !== pack.schemaVersion ||
        verified.definition_hash !== hash
      ) {
        throw new Error(
          `Active sport pack ${sportId} is not compatible with the seeded canonical pack: ${JSON.stringify({
            expected: { version: pack.version, schema_version: pack.schemaVersion, definition_hash: hash },
            actual: verified ?? null,
          })}`,
        );
      }
    }

    await sql`
      INSERT INTO accounts(id,primary_email,display_name,email_verified_at)
      VALUES(${accountId},${`pilot-${accountId}@matchday.test`},'Gate D Pilot Organiser',now());
    `;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO organisations(id,name,slug)
        VALUES(${organisationId},'Gate D National Volleyball League',${`gate-d-nvl-${randomUUID().slice(0, 8)}`});
      `;
      await tx`
        INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
        VALUES(${organisationId},${accountId},'owner','active');
      `;
    });

    const phase3 = new Phase3Runtime(db, phase3DomainAdapter);
    if ((await redis.ping()) !== "PONG") throw new Error("REDIS_URL did not respond to PING");

    const phase2 = new Phase2Runtime(
      db,
      phase2DomainAdapter,
      () => new Date(),
      undefined,
      "gate-d-staging-fallback-hmac-secret-at-least-32-chars",
    );
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
      targetUrl,
    );
    await scheduler.start();

    const competition = await phase3.createCompetition(
      actor,
      {
        organisationId,
        name: "National Volleyball Championship 2026",
        slug: competitionSlug,
        sportCode: "volleyball",
        venue: "Singapore Indoor Stadium",
        address: "2 Stadium Walk",
        countryCode: "SG",
        startsOn: "2026-09-01",
        endsOn: "2026-09-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
      randomUUID(),
      `gate-d-competition-${randomUUID()}`,
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
        `gate-d-division-${definition.code.toLowerCase()}-${randomUUID()}`,
      );
      const divisionId = String((created as Record<string, unknown>).id);
      divisions.push({ id: divisionId, ...definition });

      await phase2.replaceEntries(
        actor,
        competitionId,
        divisionId,
        Array.from({ length: 8 }, (_, index) => ({
          name: `${definition.name} Team ${index + 1}`,
          seed: index + 1,
        })),
        randomUUID(),
      );
    }

    const gateDVolleyballSettings = {
      bestOf: 1,
      regularTargetPoints: 1,
      decidingTargetPoints: 1,
      winBy: 1,
      pointCap: 1,
    };
    await sql`
      UPDATE division_sport_settings
      SET settings_override=${sql.json(gateDVolleyballSettings)},revision=revision+1,
          updated_by=${accountId},updated_at=now()
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
              { date: "2026-09-02", startTime: "00:00", endTime: "10:00" },
            ],
          },
          {
            name: "Court 2",
            slotMinutes: 30,
            availability: [
              { date: "2026-09-01", startTime: "00:00", endTime: "23:30" },
              { date: "2026-09-02", startTime: "00:00", endTime: "10:00" },
            ],
          },
        ],
      },
      randomUUID(),
    );

    const setup = await phase4.createSetupDraft(
      actor,
      competitionId,
      `gate-d-create-setup-${randomUUID()}`,
      randomUUID(),
    );
    let setupDocument = setup.document;
    const saveSetupStep = async <StepId extends "basics" | "capacity" | "settings" | "entries" | "format_preferences">(
      stepId: StepId,
    ) => {
      const value = setupDocument.values[stepId];
      if (!value) throw new Error(`Gate D canonical setup is missing ${stepId}`);
      const saved = await phase4.autosaveSetupDraft(
        actor,
        competitionId,
        {
          expected_revision: setupDocument.revision,
          idempotency_key: `gate-d-setup-${stepId}-${randomUUID()}`,
          transition: { kind: "save_step", step: { step_id: stepId, value } },
        },
        randomUUID(),
      );
      if (saved.outcome !== "saved") throw new Error(`Gate D canonical setup did not save ${stepId}`);
      setupDocument = saved.document;
    };
    await saveSetupStep("basics");
    await saveSetupStep("capacity");
    await saveSetupStep("settings");
    await saveSetupStep("entries");
    await saveSetupStep("format_preferences");
    const recommendations = setupDocument.values.format_recommendations;
    const selectedRecommendation = recommendations?.recommendations[0];
    if (!recommendations || !selectedRecommendation) {
      throw new Error("Gate D canonical setup did not produce a multi-division format recommendation");
    }
    const selected = await phase4.autosaveSetupDraft(
      actor,
      competitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `gate-d-select-format-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: {
            step_id: "format_recommendations",
            value: { ...recommendations, selected_recommendation_id: selectedRecommendation.id },
          },
        },
      },
      randomUUID(),
    );
    if (selected.outcome !== "saved") throw new Error("Gate D canonical setup did not apply the selected format");
    setupDocument = selected.document;
    const formats = setupDocument.values.format_recommendations?.recommendations.find(
      (recommendation) => recommendation.id === selectedRecommendation.id,
    )?.division_formats;
    if (!formats || formats.length !== divisions.length) {
      throw new Error("Gate D canonical setup did not persist formats for both divisions");
    }
    for (const format of formats) {
      if (!format.format_revision_id) throw new Error("Gate D canonical setup produced an unresolved format revision");
      const builder = await phase4.readFormatBuilder(actor, competitionId, format.division_id);
      if (!builder.draft || builder.draft.draft_id !== format.format_revision_id) {
        throw new Error("Gate D canonical recommendation format provenance is unavailable");
      }
      const validation = await phase4.validateFormat(actor, competitionId, format.division_id, builder.draft.document);
      if (!validation.valid) throw new Error("Gate D canonical recommendation format is invalid");
      const saved = await phase4.saveFormatRevision(
        actor,
        competitionId,
        format.division_id,
        {
          draft_id: builder.draft.draft_id,
          expected_revision: builder.draft.revision,
          parent_revision_id: builder.draft.draft_id,
          document: {
            ...builder.draft.document,
            graph: {
              ...builder.draft.document.graph,
              stages: builder.draft.document.graph.stages.map((stage, index) =>
                index === 0 ? { ...stage, label: `${stage.label} — Gate D staging publication` } : stage,
              ),
            },
          },
          idempotency_key: `gate-d-save-format-${format.division_id}-${randomUUID()}`,
        },
        randomUUID(),
      );
      const materialised = await phase4.materialiseFormat(
        actor,
        saved.draft_id,
        `gate-d-materialise-format-${randomUUID()}`,
        randomUUID(),
      );
      if (!materialised.match_count || materialised.match_count <= 0) {
        throw new Error("Gate D canonical setup materialised an empty format");
      }
      await phase4.publishFormat(actor, saved.draft_id, `gate-d-publish-format-${randomUUID()}`, randomUUID());
    }

    const [area] = await sql<{ id: string }[]>`
      SELECT id FROM playing_areas WHERE competition_id=${competitionId} ORDER BY id LIMIT 1;
    `;
    if (!area) throw new Error("Gate D fixture has no playable area for canonical Phase 4 scheduling");
    const [competitionState] = await sql<{ revision: number; capacity_revision: number }[]>`
      SELECT revision::integer,capacity_revision::integer FROM competitions WHERE id=${competitionId};
    `;
    if (!competitionState) throw new Error("Gate D fixture competition disappeared before scheduling");
    const generated = await phase4.generateSchedule(
      actor,
      competitionId,
      {
        idempotency_key: `gate-d-schedule-${randomUUID()}`,
        expected_source_revision: competitionState.revision,
        expected_capacity_revision: competitionState.capacity_revision,
        objective: "balanced",
        constraints: schedulingConstraints(area.id),
      },
      randomUUID(),
    );
    const completedJob = await waitForScheduleJob(phase4, accountId, generated.job.id);
    if (!completedJob.current_best_option_id)
      throw new Error("Canonical Phase 4 schedule job completed without an option");
    const accepted = await phase4.acceptScheduleOption(
      actor,
      generated.job.id,
      completedJob.current_best_option_id,
      { idempotency_key: `gate-d-accept-schedule-${randomUUID()}`, expected_job_revision: completedJob.revision },
      randomUUID(),
    );
    setupDocument = await phase4.resumeSetupDraft(
      actor,
      competitionId,
      `gate-d-resume-schedule-${randomUUID()}`,
      randomUUID(),
    );
    if (!setupDocument.values.schedule_review) {
      throw new Error("Gate D canonical setup is missing the accepted schedule-review reference");
    }
    const scheduleReviewSaved = await phase4.autosaveSetupDraft(
      actor,
      competitionId,
      {
        expected_revision: setupDocument.revision,
        idempotency_key: `gate-d-schedule-review-${randomUUID()}`,
        transition: {
          kind: "save_step",
          step: { step_id: "schedule_review", value: setupDocument.values.schedule_review },
        },
      },
      randomUUID(),
    );
    if (scheduleReviewSaved.outcome !== "saved") {
      throw new Error("Gate D canonical schedule review was not retained before publication");
    }
    const publication = await phase4.publishScheduleRevision(
      actor,
      accepted.id,
      { idempotency_key: `gate-d-publish-schedule-${randomUUID()}`, expected_revision: accepted.revision },
      randomUUID(),
    );
    const aggregate = { id: accepted.id };

    const scoreableRows = await sql<{ match_id: string; division_id: string }[]>`
      SELECT DISTINCT m.id AS match_id,m.division_id
      FROM matches m
      JOIN scheduled_matches sm ON sm.match_id=m.id AND sm.schedule_revision_id=${aggregate.id}
      WHERE m.competition_id=${competitionId}
        AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
      ORDER BY m.division_id,m.id;
    `;
    if (scoreableRows.length < 2) throw new Error("Gate D fixture did not produce enough scoreable matches");
    const scoreableDivisionIds = new Set(scoreableRows.map((row) => row.division_id));
    if (
      scoreableDivisionIds.size !== divisions.length ||
      divisions.some((division) => !scoreableDivisionIds.has(division.id))
    ) {
      throw new Error("Gate D fixture requires a resolved scoreable match in each division");
    }

    const scoreableMatches: Array<{ matchId: string; divisionId: string; rawToken: string }> = [];
    for (const row of scoreableRows) {
      const pass = await phase2.createAccessPass(
        actor,
        competitionId,
        row.match_id,
        {
          expiresAt: new Date(Date.now() + scoringPassTtlMs).toISOString(),
          role: "scorekeeper",
          idempotencyKey: `gate-d-pass-${row.match_id}-${randomUUID()}`,
        },
        randomUUID(),
      );
      if (!pass.token) throw new Error(`Scoring access pass for ${row.match_id} did not return its one-time token`);
      scoreableMatches.push({ matchId: row.match_id, divisionId: row.division_id, rawToken: pass.token });
    }

    const [counts] = await sql<
      {
        divisions: number;
        entries: number;
        scheduled_matches: number;
        linked_formats: number;
        published_schedule: string | null;
        published_formats: number;
        unlinked_matches: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM divisions WHERE competition_id=${competitionId}) AS divisions,
        (SELECT count(*)::int FROM division_entries e JOIN divisions d ON d.id=e.division_id
          WHERE d.competition_id=${competitionId} AND e.status IN ('confirmed','active')) AS entries,
        (SELECT count(*)::int FROM scheduled_matches WHERE schedule_revision_id=${aggregate.id}) AS scheduled_matches,
        (SELECT count(*)::int FROM schedule_revision_formats WHERE schedule_revision_id=${aggregate.id}) AS linked_formats,
        (SELECT published_schedule_revision_id::text FROM competition_publications
          WHERE competition_id=${competitionId}) AS published_schedule,
        (SELECT count(*)::int FROM format_revisions
          WHERE competition_id=${competitionId} AND status='published') AS published_formats,
        (SELECT count(*)::int FROM scheduled_matches scheduled
          JOIN matches m ON m.id=scheduled.match_id
          WHERE scheduled.schedule_revision_id=${aggregate.id}
            AND m.competition_id=${competitionId}
            AND NOT EXISTS (
              SELECT 1 FROM schedule_revision_formats linked
              WHERE linked.schedule_revision_id=scheduled.schedule_revision_id
                AND linked.format_revision_id=m.format_revision_id
            )) AS unlinked_matches;
    `;
    if (
      !counts ||
      counts.divisions !== 2 ||
      counts.entries !== 16 ||
      counts.scheduled_matches < 2 ||
      counts.linked_formats !== 2 ||
      counts.published_schedule !== aggregate.id ||
      counts.published_formats !== 2 ||
      counts.unlinked_matches !== 0
    ) {
      throw new Error(`Post-seed database verification failed: ${JSON.stringify(counts)}`);
    }

    const scheduledByDivision = await sql<{ division_id: string; scheduled_matches: number }[]>`
      SELECT m.division_id,count(*)::int AS scheduled_matches
      FROM scheduled_matches sm
      JOIN matches m ON m.id=sm.match_id
      WHERE sm.schedule_revision_id=${aggregate.id}
      GROUP BY m.division_id
      ORDER BY m.division_id;
    `;
    if (
      scheduledByDivision.length !== divisions.length ||
      divisions.some(
        (division) =>
          !scheduledByDivision.some(
            (scheduled) => scheduled.division_id === division.id && scheduled.scheduled_matches >= 1,
          ),
      )
    ) {
      throw new Error(`Post-seed schedule does not cover both divisions: ${JSON.stringify(scheduledByDivision)}`);
    }

    await requireApiResponse(
      `${targetUrl}/api/v1/public/competitions/${encodeURIComponent(competitionSlug)}/current`,
      undefined,
      "public competition",
    );
    const publicScheduleResponse = await requireApiResponse(
      `${targetUrl}/api/v1/public/competitions/${encodeURIComponent(competitionSlug)}/current`,
      undefined,
      "public multi-division schedule",
    );
    const publicSchedule = (await publicScheduleResponse.json()) as {
      publication?: { schedule_version?: number };
      divisions?: Array<{ division?: { id?: string; name?: string }; schedule?: Array<{ id?: string }> }>;
    };
    if (
      publicSchedule.publication?.schedule_version !== publication.schedule_version ||
      !Array.isArray(publicSchedule.divisions) ||
      divisions.some((division) => {
        const projected = publicSchedule.divisions?.find(
          (candidate) => candidate.division?.id === division.id && candidate.division?.name === division.name,
        );
        return !projected || !projected.schedule?.some((fixture) => typeof fixture.id === "string");
      })
    ) {
      throw new Error("Post-seed public projection did not expose the canonical published fixtures for both divisions");
    }

    // Verify the deployed access exchange with a dedicated pass. The passes in
    // the benchmark handoff remain pristine: they are not exchanged before
    // QA-011 owns their writer lease and mutation stream.
    const exchangeCandidate = scoreableMatches[0]!;
    const verificationPass = await phase2.createAccessPass(
      actor,
      competitionId,
      exchangeCandidate.matchId,
      {
        expiresAt: new Date(Date.now() + scoringPassTtlMs).toISOString(),
        role: "scorekeeper",
        idempotencyKey: `gate-d-verification-pass-${exchangeCandidate.matchId}-${randomUUID()}`,
      },
      randomUUID(),
    );
    if (!verificationPass.token) throw new Error("Scoring verification pass did not return a one-time token");
    let verificationExchange: { sessionId: string; sessionToken: string; generation: number } | undefined;
    try {
      const exchangeResponse = await requireApiResponse(
        `${targetUrl}/api/v1/scoring/access/exchange`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: verificationPass.token,
            expected_match_id: exchangeCandidate.matchId,
            device_id: `seed-verification-${randomUUID()}`,
            device_label: "Gate D staging seed verification",
          }),
        },
        "scoring access exchange",
      );
      if (exchangeResponse.status !== 200) {
        throw new Error(`Post-seed scoring exchange verification returned HTTP ${exchangeResponse.status}`);
      }
      verificationExchange = requireWriterAccessExchange(
        (await exchangeResponse.json()) as Record<string, unknown>,
        exchangeCandidate.matchId,
      );
    } finally {
      await phase2.revokeAccessPass(
        actor,
        competitionId,
        verificationPass.id,
        randomUUID(),
        "Gate D staging seed verification complete",
      );
    }
    if (!verificationExchange) throw new Error("Post-seed scoring exchange verification did not complete");
    for (const match of scoreableMatches) await assertBenchmarkMatchPristine(sql, match.matchId);

    const artifactDir = path.join(root, "artifacts");
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, "staging-pilot-seed.json");
    const secretDirectory = await mkdtemp(path.join(tmpdir(), "matchday-gate-d-scoring-"));
    const scoringSecretFile = path.join(secretDirectory, "scorekeeper-access.json");
    await writeFile(
      scoringSecretFile,
      JSON.stringify({
        issued_at_utc: new Date().toISOString(),
        target_url: targetUrl,
        competition_id: competitionId,
        matches: scoreableMatches.map(({ matchId, rawToken }) => ({ matchId, rawToken })),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const output = {
      generated_at_utc: new Date().toISOString(),
      target_url: targetUrl,
      organisation_id: organisationId,
      competition_id: competitionId,
      competition_slug: competitionSlug,
      schedule_revision_id: aggregate.id,
      schedule_version: publication.schedule_version,
      divisions,
      scoreable_matches: scoreableMatches.map(({ matchId, divisionId }) => ({
        match_id: matchId,
        division_id: divisionId,
      })),
      scoring_secret_handoff: {
        environment_variable: "GATE_D_SCORING_SECRET_FILE",
        contract: "single_use_local_file_deleted_by_qa011_runner",
      },
    };
    await writeFile(artifactPath, JSON.stringify(output, null, 2), "utf8");

    console.log(`✓ Runtime-backed competition: ${competitionId}`);
    console.log(`✓ Published schedule:          ${aggregate.id}`);
    console.log("✓ Divisions / entries:        2 / 16");
    console.log(`✓ Scoreable matches:          ${scoreableMatches.length}`);
    console.log("✓ Deployed API verification:  PASS");
    console.log(`✓ Artifact:                    ${artifactPath}`);
    console.log(
      `✓ Single-use scoring handoff:  export GATE_D_SCORING_SECRET_FILE=${JSON.stringify(scoringSecretFile)}`,
    );
  } finally {
    await scheduler.stop().catch(() => undefined);
    await scheduleQueue.close().catch(() => undefined);
    await deleteOwnedRedisKeys(redis, queueName).catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await sql.end({ timeout: 2 });
  }
}

main().catch((error) => {
  console.error("❌ Gate D staging pilot seeder failed:", error);
  process.exitCode = 1;
});
