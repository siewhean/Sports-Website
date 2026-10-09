import {
  AUTO_COMPLETABLE_COMPETITION_STATUSES,
  DEFAULT_COMPETITION_AUTO_COMPLETE_GRACE_MS,
  DEFAULT_LIVE_MATCH_STALE_AFTER_MS,
  HOUR_MS,
  isCompetitionScheduleElapsed,
  liveMatchStaleCutoff,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";

/** The public projection writer the sweeper reuses (Phase2Runtime in production). */
export type CompetitionLifecycleProjectionWriter = {
  liveMatchStaleAfterMs: number;
  writePublicProjection(
    tx: PostgresJsSql,
    competitionId: string,
    scheduleVersion: number,
    resultVersion: number,
  ): Promise<void>;
};

export type CompetitionLifecycleLogger = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

export type CompetitionLifecycleSettings = Readonly<{
  enabled: boolean;
  /** Time after the final competition day ends (competition timezone) before auto-completion. */
  completionGraceMs: number;
  /** Time without scoring activity after which a live match is withheld from the public live view. */
  liveMatchStaleAfterMs: number;
  /** Sweep cadence. */
  intervalMs: number;
  /** Upper bound of competitions handled per category per sweep. */
  batchSize: number;
}>;

export type CompetitionLifecycleSweepResult = {
  completed: string[];
  refreshed: string[];
  skipped: string[];
  failed: string[];
};

const SWEEP_LOCK_PREFIX = "matchday:competition-lifecycle:";
const SYSTEM_REQUEST_PREFIX = "system:competition-lifecycle";

function positiveNumber(raw: string | undefined, fallback: number, label: string, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be a positive number no greater than ${max}`);
  }
  return value;
}

/**
 * MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_ENABLED (default on; "0"/"false" disables),
 * MATCHDAY_COMPETITION_AUTO_COMPLETE_GRACE_HOURS (default 24),
 * MATCHDAY_LIVE_MATCH_STALE_AFTER_HOURS (default 6),
 * MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_INTERVAL_SECONDS (default 300).
 */
export function competitionLifecycleSettingsFromEnv(env: NodeJS.ProcessEnv): CompetitionLifecycleSettings {
  const enabledRaw = env.MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_ENABLED?.trim().toLowerCase();
  if (enabledRaw !== undefined && enabledRaw !== "" && !["0", "1", "true", "false"].includes(enabledRaw)) {
    throw new Error("MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_ENABLED must be one of 0, 1, true, false");
  }
  return {
    enabled: enabledRaw !== "0" && enabledRaw !== "false",
    completionGraceMs: Math.round(
      positiveNumber(
        env.MATCHDAY_COMPETITION_AUTO_COMPLETE_GRACE_HOURS,
        DEFAULT_COMPETITION_AUTO_COMPLETE_GRACE_MS / HOUR_MS,
        "MATCHDAY_COMPETITION_AUTO_COMPLETE_GRACE_HOURS",
        24 * 30,
      ) * HOUR_MS,
    ),
    liveMatchStaleAfterMs: Math.round(
      positiveNumber(
        env.MATCHDAY_LIVE_MATCH_STALE_AFTER_HOURS,
        DEFAULT_LIVE_MATCH_STALE_AFTER_MS / HOUR_MS,
        "MATCHDAY_LIVE_MATCH_STALE_AFTER_HOURS",
        24 * 7,
      ) * HOUR_MS,
    ),
    intervalMs: Math.round(
      positiveNumber(
        env.MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_INTERVAL_SECONDS,
        300,
        "MATCHDAY_COMPETITION_LIFECYCLE_SWEEP_INTERVAL_SECONDS",
        24 * 60 * 60,
      ) * 1_000,
    ),
    batchSize: 50,
  };
}

function isoDate(value: Date | string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Competition end date is invalid");
  // postgres.js materialises DATE columns as UTC midnight.
  return parsed.toISOString().slice(0, 10);
}

/**
 * Keeps competition and live-match lifecycle truthful after the event:
 *
 * - Competitions whose final day (in their own timezone) ended more than the
 *   grace period ago move active|live -> completed, with an audit event and a
 *   regenerated public projection. Unfinished matches are never finalised.
 * - Public projections that still show an abandoned in-progress match as live
 *   are regenerated so spectators stop seeing "LIVE NOW". The match stays
 *   in progress, recoverable by the organiser.
 *
 * Every unit of work is its own transaction guarded by a per-competition
 * pg_try_advisory_xact_lock and re-checked under row locks, so concurrent API
 * instances skip rather than duplicate work and re-runs are no-ops.
 */
export class CompetitionLifecycleSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<CompetitionLifecycleSweepResult> | null = null;

  constructor(
    private readonly sql: PostgresJsSql,
    private readonly projectionWriter: CompetitionLifecycleProjectionWriter,
    private readonly settings: CompetitionLifecycleSettings,
    private readonly logger: CompetitionLifecycleLogger,
    private readonly now: () => Date = () => new Date(),
  ) {
    // One stale cut-off for every projection writer in this process.
    projectionWriter.liveMatchStaleAfterMs = settings.liveMatchStaleAfterMs;
  }

  start(): void {
    if (!this.settings.enabled || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.settings.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    try {
      const result = await this.sweep();
      if (result.completed.length || result.refreshed.length || result.failed.length) {
        this.logger.info({ ...result }, "competition lifecycle sweep finished");
      }
    } catch (error) {
      this.logger.error({ err: error }, "competition lifecycle sweep failed");
    }
  }

  sweep(): Promise<CompetitionLifecycleSweepResult> {
    if (this.running) return this.running;
    this.running = this.runSweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSweep(): Promise<CompetitionLifecycleSweepResult> {
    const result: CompetitionLifecycleSweepResult = { completed: [], refreshed: [], skipped: [], failed: [] };
    const now = this.now();

    for (const candidate of await this.completionCandidates(now)) {
      let elapsed: boolean;
      try {
        elapsed = isCompetitionScheduleElapsed({
          endsOn: isoDate(candidate.ends_on),
          timeZone: candidate.timezone,
          now,
          graceMs: this.settings.completionGraceMs,
        });
      } catch (error) {
        this.logger.warn({ err: error, competition_id: candidate.id }, "competition end could not be resolved");
        result.failed.push(candidate.id);
        continue;
      }
      if (!elapsed) continue;
      await this.attempt(candidate.id, result, () => this.completeCompetition(candidate.id, now), "completed");
    }

    const completed = new Set(result.completed);
    for (const competitionId of await this.staleLiveCandidates(now)) {
      if (completed.has(competitionId)) continue;
      await this.attempt(competitionId, result, () => this.refreshStaleLive(competitionId, now), "refreshed");
    }
    return result;
  }

  private async attempt(
    competitionId: string,
    result: CompetitionLifecycleSweepResult,
    operation: () => Promise<"done" | "skipped">,
    bucket: "completed" | "refreshed",
  ): Promise<void> {
    try {
      const outcome = await operation();
      result[outcome === "done" ? bucket : "skipped"].push(competitionId);
    } catch (error) {
      // One bad competition must not block the rest of the sweep.
      this.logger.error({ err: error, competition_id: competitionId }, `competition lifecycle ${bucket} failed`);
      result.failed.push(competitionId);
    }
  }

  private completionCandidates(now: Date) {
    // Coarse, timezone-free pre-filter: a competition cannot have ended before
    // its ends_on date has started in UTC-14. The exact timezone boundary is
    // decided in TypeScript (and re-checked by the database guard).
    return this.sql.unsafe<{ id: string; ends_on: Date | string; timezone: string }>(
      `SELECT id, ends_on, timezone
       FROM competitions
       WHERE status = ANY($1::text[])
         AND ends_on <= ($2::timestamptz AT TIME ZONE 'UTC')::date
       ORDER BY ends_on, id
       LIMIT $3`,
      [[...AUTO_COMPLETABLE_COMPETITION_STATUSES], now, this.settings.batchSize],
    );
  }

  private async staleLiveCandidates(now: Date): Promise<string[]> {
    // A projection still shows a match live iff it was generated before that
    // match crossed the stale cut-off. Once regenerated, generated_at passes the
    // threshold and the competition is not selected again.
    const rows = await this.sql.unsafe<{ competition_id: string }>(
      `SELECT DISTINCT match.competition_id
       FROM matches match
       JOIN match_score_streams stream ON stream.match_id = match.id
       JOIN competitions competition ON competition.id = match.competition_id
       JOIN competition_publications publication ON publication.competition_id = match.competition_id
       JOIN public_competition_projections projection
         ON projection.competition_id = match.competition_id
        AND projection.schedule_version = publication.schedule_version
        AND projection.result_version = publication.result_version
       WHERE match.state = 'in_progress'
         AND competition.status NOT IN ('draft', 'archived')
         AND stream.updated_at <= $1
         AND projection.generated_at < stream.updated_at + ($2::bigint * interval '1 millisecond')
       ORDER BY match.competition_id
       LIMIT $3`,
      [
        liveMatchStaleCutoff(now, this.settings.liveMatchStaleAfterMs),
        this.settings.liveMatchStaleAfterMs,
        this.settings.batchSize,
      ],
    );
    return rows.map((row) => row.competition_id);
  }

  private async transaction<T>(operation: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    if (!this.sql.begin)
      throw new Error("Competition lifecycle sweeps require a transaction-capable PostgreSQL client.");
    return this.sql.begin(operation);
  }

  private async tryLock(tx: PostgresJsSql, competitionId: string): Promise<boolean> {
    const rows = await tx.unsafe<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
      [`${SWEEP_LOCK_PREFIX}${competitionId}`],
    );
    return rows[0]?.locked === true;
  }

  private completeCompetition(competitionId: string, now: Date): Promise<"done" | "skipped"> {
    return this.transaction(async (tx) => {
      if (!(await this.tryLock(tx, competitionId))) return "skipped";
      const current = (
        await tx.unsafe<{
          id: string;
          organisation_id: string;
          status: string;
          revision: number;
          ends_on: Date | string;
          timezone: string;
        }>(
          `SELECT id, organisation_id, status, revision, ends_on, timezone
           FROM competitions WHERE id=$1 FOR UPDATE`,
          [competitionId],
        )
      )[0];
      if (
        !current ||
        !(AUTO_COMPLETABLE_COMPETITION_STATUSES as readonly string[]).includes(current.status) ||
        !isCompetitionScheduleElapsed({
          endsOn: isoDate(current.ends_on),
          timeZone: current.timezone,
          now,
          graceMs: this.settings.completionGraceMs,
        })
      ) {
        return "skipped";
      }

      // Transaction-local: lets the completion guard accept a competition whose
      // dates are over even though a match was abandoned unfinished.
      await tx.unsafe(`SELECT set_config('matchday.competition_schedule_elapsed','on',true)`);
      const updated = (
        await tx.unsafe<{ id: string; status: string; revision: number }>(
          `UPDATE competitions SET status='completed', revision=revision+1, updated_at=$2
           WHERE id=$1 AND status=$3
           RETURNING id, status, revision`,
          [competitionId, now, current.status],
        )
      )[0];
      await tx.unsafe(`SELECT set_config('matchday.competition_schedule_elapsed','off',true)`);
      if (updated?.status !== "completed") {
        this.logger.warn(
          { competition_id: competitionId, status: updated?.status ?? current.status },
          "competition completion was refused by the lifecycle guard",
        );
        throw new Error("Competition completion was refused by the database lifecycle guard");
      }

      const unfinished = await tx.unsafe<{ id: string; state: string }>(
        `SELECT id, state FROM matches
         WHERE competition_id=$1 AND state NOT IN ('final','corrected')
         ORDER BY id`,
        [competitionId],
      );
      const requestId = `${SYSTEM_REQUEST_PREFIX}:${competitionId}:completed`;
      const action = "competition.transitioned";
      await tx.unsafe(
        `INSERT INTO audit_events (
           occurred_at, request_id, actor_account_id, actor_type, organisation_id, action,
           target_type, target_id, reason, before_state, after_state, metadata
         ) VALUES ($1,$2,NULL,'system',$3,$4,'competition',$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
        [
          now,
          requestId,
          current.organisation_id,
          action,
          competitionId,
          "Competition schedule elapsed",
          { status: current.status, revision: current.revision },
          updated,
          {
            trigger: "schedule_elapsed",
            ends_on: isoDate(current.ends_on),
            timezone: current.timezone,
            grace_ms: this.settings.completionGraceMs,
            unfinished_matches: unfinished.map((match) => ({ id: match.id, state: match.state })),
          },
        ],
      );
      await tx.unsafe(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, idempotency_key, created_at, available_at)
         VALUES ('competition',$1,$2,$3::jsonb,$4,$5,$5)
         ON CONFLICT DO NOTHING`,
        [competitionId, action, { target_id: competitionId }, `${requestId}:${action}:${competitionId}`, now],
      );
      await this.regenerateProjection(tx, competitionId, now);
      return "done";
    });
  }

  private refreshStaleLive(competitionId: string, now: Date): Promise<"done" | "skipped"> {
    return this.transaction(async (tx) => {
      if (!(await this.tryLock(tx, competitionId))) return "skipped";
      return (await this.regenerateProjection(tx, competitionId, now)) ? "done" : "skipped";
    });
  }

  private async regenerateProjection(tx: PostgresJsSql, competitionId: string, now: Date): Promise<boolean> {
    // Same lock order and publication touch as live scoring, so the regenerated
    // row serialises with concurrent score writes.
    const publication = (
      await tx.unsafe<{ schedule_version: number; result_version: number }>(
        `SELECT publication.schedule_version, publication.result_version
         FROM competition_publications publication
         JOIN competitions competition ON competition.id = publication.competition_id
         WHERE publication.competition_id=$1 AND competition.status NOT IN ('draft','archived')
         FOR UPDATE OF publication`,
        [competitionId],
      )
    )[0];
    if (!publication || (publication.schedule_version === 0 && publication.result_version === 0)) return false;
    await tx.unsafe(`UPDATE competition_publications SET updated_at=GREATEST(updated_at,$2) WHERE competition_id=$1`, [
      competitionId,
      now,
    ]);
    await this.projectionWriter.writePublicProjection(
      tx,
      competitionId,
      publication.schedule_version,
      publication.result_version,
    );
    return true;
  }
}
