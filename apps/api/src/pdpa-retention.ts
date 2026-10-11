import type { RetentionPolicy } from "@matchday/config/retention";
import type { PostgresJsSql } from "@matchday/identity";

/** Stable advisory-lock key ("PDPA" in ASCII) so only one API instance purges at a time. */
const purgeAdvisoryLockKey = 0x50445041;
/** Upper bound on batches per category per run; the next scheduled run continues the backlog. */
const maxBatchesPerCategory = 20;
const initialDelayMs = 60_000;

export type PurgeCategory =
  | "sessions"
  | "recovery_requests"
  | "provider_events"
  | "scoring_access_attempts"
  | "notifications"
  | "email_delivery_events"
  | "billing_webhook_receipts"
  | "anonymous_casual_games";

export type PurgeReport = { lockAcquired: false } | { lockAcquired: true; deleted: Record<PurgeCategory, number> };

export type RetentionLogger = {
  info(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
};

type Dependencies = {
  sql: PostgresJsSql;
  policy: RetentionPolicy;
  now?: () => Date;
  /**
   * Casual-game helper (purgeExpiredCasualGames). When omitted, a built-in batch deletes unclaimed
   * casual games (owner_account_id IS NULL) past the retention window, so the published schedule holds.
   */
  purgeAnonymousCasualGames?: (olderThan: Date) => Promise<number>;
};

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

type Batch = { category: PurgeCategory; sql: string; cutoff: (policy: RetentionPolicy, now: Date) => Date };

/**
 * Every statement is a batch-limited, cutoff-based DELETE, so reruns are idempotent. audit_events is
 * deliberately absent: it is append-only and never purged.
 */
const batches: readonly Batch[] = [
  {
    category: "sessions",
    sql: `WITH doomed AS (
            SELECT id FROM identity_sessions
            WHERE idle_expires_at < $1 OR absolute_expires_at < $1 OR revoked_at < $1
            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM identity_sessions s USING doomed d WHERE s.id = d.id RETURNING s.id`,
    cutoff: (policy, now) => daysBefore(now, policy.sessionDays),
  },
  {
    category: "recovery_requests",
    sql: `WITH doomed AS (
            SELECT id FROM identity_recovery_requests WHERE expires_at < $1
            ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM identity_recovery_requests r USING doomed d WHERE r.id = d.id RETURNING r.id`,
    cutoff: (policy, now) => daysBefore(now, policy.sessionDays),
  },
  {
    category: "provider_events",
    sql: `WITH doomed AS (
            SELECT event_id FROM identity_provider_events WHERE received_at < $1
            ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM identity_provider_events e USING doomed d WHERE e.event_id = d.event_id RETURNING e.event_id`,
    cutoff: (policy, now) => daysBefore(now, policy.providerEventDays),
  },
  {
    category: "scoring_access_attempts",
    // Only rows whose rate-limit window has already closed; the 0068 trigger enforces the same rule
    // (plus a 7-day floor) so a bug here can never delete live rate-limit evidence.
    sql: `WITH doomed AS (
            SELECT id FROM scoring_access_attempts
            WHERE attempted_at < $1 AND rate_limit_state_expires_at < now()
            ORDER BY attempted_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM scoring_access_attempts a USING doomed d WHERE a.id = d.id RETURNING a.id`,
    cutoff: (policy, now) => daysBefore(now, policy.scoringAttemptDays),
  },
  {
    // Cascades to notification_email_outbox (recipient address, rendered body).
    category: "notifications",
    sql: `WITH doomed AS (
            SELECT id FROM notifications WHERE created_at < $1
            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM notifications n USING doomed d WHERE n.id = d.id RETURNING n.id`,
    cutoff: (policy, now) => daysBefore(now, policy.notificationDays),
  },
  {
    category: "email_delivery_events",
    sql: `WITH doomed AS (
            SELECT id FROM notification_email_delivery_events WHERE received_at < $1
            ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM notification_email_delivery_events e USING doomed d WHERE e.id = d.id RETURNING e.id`,
    cutoff: (policy, now) => daysBefore(now, policy.notificationDays),
  },
  {
    // Rows are removed whole; the organisation's subscription and entitlement state is kept.
    category: "billing_webhook_receipts",
    sql: `WITH doomed AS (
            SELECT id FROM billing_webhook_receipts WHERE created_at < $1
            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM billing_webhook_receipts r USING doomed d WHERE r.id = d.id RETURNING r.id`,
    cutoff: (policy, now) => daysBefore(now, policy.billingReceiptDays),
  },
];

const unclaimedCasualGamesBatch: Batch = {
  category: "anonymous_casual_games",
  sql: `WITH doomed AS (
          SELECT id FROM casual_games WHERE owner_account_id IS NULL AND created_at < $1
          ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        DELETE FROM casual_games g USING doomed d WHERE g.id = d.id RETURNING g.id`,
  cutoff: (policy, now) => daysBefore(now, policy.anonymousCasualGameDays),
};

export class PdpaRetentionJob {
  readonly #deps: Dependencies;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<unknown> = Promise.resolve();
  #stopped = false;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  /** One purge pass. Returns `{ lockAcquired: false }` when another instance holds the lock. */
  async runOnce(): Promise<PurgeReport> {
    const { sql, policy } = this.#deps;
    if (!sql.begin) throw new Error("PDPA retention requires a transaction-capable PostgreSQL client.");
    const now = (this.#deps.now ?? (() => new Date()))();
    const deleted = Object.fromEntries(
      [...batches.map((batch) => batch.category), "anonymous_casual_games" as const].map((category) => [category, 0]),
    ) as Record<PurgeCategory, number>;

    const acquired = await sql.begin(async (tx) => {
      const [lock] = await tx.unsafe<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS locked`, [
        purgeAdvisoryLockKey,
      ]);
      if (!lock?.locked) return false;
      // Transaction-local opt-in required by the scoring_access_attempts retention guard (0068).
      await tx.unsafe(`SELECT set_config('matchday.pdpa_purge', 'on', true)`);
      const activeBatches = this.#deps.purgeAnonymousCasualGames ? batches : [...batches, unclaimedCasualGamesBatch];
      for (const batch of activeBatches) {
        const cutoff = batch.cutoff(policy, now);
        for (let round = 0; round < maxBatchesPerCategory; round += 1) {
          const rows = await tx.unsafe<unknown>(batch.sql, [cutoff, policy.batchSize]);
          deleted[batch.category] += rows.length;
          if (rows.length < policy.batchSize) break;
        }
      }
      return true;
    });
    if (!acquired) return { lockAcquired: false };

    if (this.#deps.purgeAnonymousCasualGames) {
      deleted.anonymous_casual_games = await this.#deps.purgeAnonymousCasualGames(
        daysBefore(now, policy.anonymousCasualGameDays),
      );
    }
    return { lockAcquired: true, deleted };
  }

  start(logger: RetentionLogger): void {
    if (!this.#deps.policy.enabled || this.#timer) return;
    this.#stopped = false;
    const tick = () => {
      if (this.#stopped) return;
      this.#inFlight = this.runOnce()
        .then((report) => {
          if (report.lockAcquired) logger.info({ pdpa_purge: report.deleted }, "pdpa retention purge completed");
        })
        .catch((error: unknown) => logger.error({ err: error }, "pdpa retention purge failed"));
    };
    const intervalMs = this.#deps.policy.intervalMinutes * 60_000;
    const first = setTimeout(() => {
      tick();
      this.#timer = setInterval(tick, intervalMs);
      this.#timer.unref();
    }, initialDelayMs);
    first.unref();
    this.#timer = first;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight;
  }
}
