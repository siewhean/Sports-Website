import { randomUUID } from "node:crypto";
import {
  EmailTemplateRegistry,
  NoopNotificationRateLimiter,
  NotificationService,
  PostgresNotificationRepository,
} from "@matchday/notifications";
import type { PostgresJsSql } from "@matchday/identity";
import type { TransactionSql } from "postgres";

/**
 * Track R2.7 competition-day notifications. Both kinds are written through the NotificationService
 * into the notifications table and the transactional email outbox (delivered by the worker's
 * EmailOutboxPollingWorker), so they honour per-account preferences:
 * - `result-published` (preference type `result-published`) when a match result is finalised or
 *   corrected, inside the result publication transaction;
 * - `match_reminder` (preference category `match_reminder`) ahead of each published match start,
 *   from the MatchReminderSweeper.
 * Recipients are the competition's active organisers/owners plus accounts holding an active
 * official grant for the competition or the match. Entries have no account link, so teams are
 * reached through the public site rather than email.
 */

let actionOrigin = "http://localhost:3000";

/** Called once at startup with the validated MATCHDAY_PUBLIC_ORIGIN so email links are absolute. */
export function configureMatchNotificationOrigin(origin: string | undefined): void {
  if (origin) actionOrigin = origin;
}

const actionUrl = (competitionId: string, path: string) =>
  new URL(`/organiser/competitions/${encodeURIComponent(competitionId)}/${path}`, actionOrigin).toString();

type Recipient = Readonly<{ id: string; primary_email: string; email_verified_at: Date | string | null }>;

async function recipients(tx: PostgresJsSql, competitionId: string, matchId: string): Promise<readonly Recipient[]> {
  return tx.unsafe<Recipient>(
    `SELECT account.id,account.primary_email,account.email_verified_at
     FROM accounts account
     WHERE account.status='active' AND account.deleted_at IS NULL
       AND account.id IN (
         SELECT membership.account_id
         FROM organisation_memberships membership
         JOIN competitions competition ON competition.organisation_id=membership.organisation_id
         WHERE competition.id=$1 AND membership.status='active' AND membership.role IN ('owner','organiser')
         UNION
         SELECT grant_row.account_id
         FROM official_grants grant_row
         WHERE grant_row.revoked_at IS NULL
           AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now())
           AND ((grant_row.resource_type='competition' AND grant_row.resource_id=$1::text)
             OR (grant_row.resource_type='match' AND grant_row.resource_id=$2::text))
       )
     ORDER BY account.id`,
    [competitionId, matchId],
  );
}

function service(tx: PostgresJsSql, now: () => Date) {
  const repository = new PostgresNotificationRepository(tx as unknown as TransactionSql);
  return new NotificationService(repository, repository, new EmailTemplateRegistry(), {
    createId: randomUUID,
    now,
    rateLimiter: new NoopNotificationRateLimiter(),
  });
}

export async function enqueueResultPublishedNotifications(
  tx: PostgresJsSql,
  input: {
    competitionId: string;
    matchId: string;
    resultVersion: number;
    homeScore: number;
    awayScore: number;
    walkover: boolean;
  },
  now: () => Date = () => new Date(),
): Promise<number> {
  const context = (
    await tx.unsafe<{ competition_name: string; match_code: string; home: string | null; away: string | null }>(
      `SELECT competition.name competition_name,match.code match_code,home.name home,away.name away
       FROM matches match
       JOIN competitions competition ON competition.id=match.competition_id
       LEFT JOIN division_entries home ON home.id=match.home_entry_id
       LEFT JOIN division_entries away ON away.id=match.away_entry_id
       WHERE match.id=$1`,
      [input.matchId],
    )
  )[0];
  if (!context) return 0;
  const score = `${context.home ?? "Home"} ${input.homeScore}–${input.awayScore} ${context.away ?? "Away"}`;
  const scoreSummary = input.walkover ? `W/O (Forfeit score: ${score})` : score;
  const notifications = service(tx, now);
  let queued = 0;
  for (const recipient of await recipients(tx, input.competitionId, input.matchId)) {
    const emailEnabled = recipient.email_verified_at !== null;
    const result = await notifications.publish({
      accountId: recipient.id,
      type: "result-published",
      payload: {
        competition_id: input.competitionId,
        match_id: input.matchId,
        result_version: input.resultVersion,
        home_score: input.homeScore,
        away_score: input.awayScore,
        walkover: input.walkover,
      },
      idempotencyKey: `result-published:${input.matchId}:${input.resultVersion}`,
      channels: emailEnabled ? ["in_app", "email"] : ["in_app"],
      essential: false,
      ...(emailEnabled
        ? {
            email: {
              to: recipient.primary_email,
              template: { id: "result-published", version: 1 },
              variables: {
                competitionName: context.competition_name,
                matchCode: context.match_code,
                scoreSummary,
                actionUrl: actionUrl(input.competitionId, "results"),
              },
            },
          }
        : {}),
    });
    if (result.notification) queued += 1;
  }
  return queued;
}

export type MatchReminderSettings = Readonly<{ enabled: boolean; intervalMs: number; leadMinutes: number }>;

type ReminderLogger = { info(details: object, message: string): void; error(details: object, message: string): void };

/**
 * Enqueues `match_reminder` notifications for matches in each competition's published schedule
 * that start within the lead window. Each competition is handled in its own transaction under a
 * pg_try_advisory_xact_lock, and the per-account idempotency key includes the scheduled start, so
 * concurrent API instances and repeated ticks never duplicate a reminder, while a delayed match
 * gets a fresh reminder for its new time.
 */
export class MatchReminderSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly sql: PostgresJsSql,
    private readonly settings: MatchReminderSettings,
    private readonly logger: ReminderLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    try {
      const queued = await this.sweep();
      if (queued > 0) this.logger.info({ queued }, "match reminders queued");
    } catch (error) {
      this.logger.error({ err: error }, "match reminder sweep failed");
    }
  }

  sweep(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.runSweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSweep(): Promise<number> {
    const now = this.now();
    const until = new Date(now.getTime() + this.settings.leadMinutes * 60_000);
    const competitions = await this.sql.unsafe<{ competition_id: string }>(
      `SELECT DISTINCT scheduled.competition_id
       FROM competition_publications publication
       JOIN scheduled_matches scheduled ON scheduled.schedule_revision_id=publication.published_schedule_revision_id
       JOIN matches match ON match.id=scheduled.match_id
       WHERE scheduled.starts_at>$1 AND scheduled.starts_at<=$2 AND match.state IN ('pending','ready')`,
      [now, until],
    );
    let queued = 0;
    for (const { competition_id: competitionId } of competitions) {
      if (!this.sql.begin) throw new Error("Match reminders require a transaction-capable PostgreSQL client");
      queued += await this.sql.begin(async (tx) => {
        const transaction = tx as unknown as PostgresJsSql;
        const locked = (
          await transaction.unsafe<{ locked: boolean }>(
            `SELECT pg_try_advisory_xact_lock(hashtext('match-reminder:' || $1::text)) locked`,
            [competitionId],
          )
        )[0]?.locked;
        if (!locked) return 0;
        const due = await transaction.unsafe<{
          match_id: string;
          match_code: string;
          starts_at: Date | string;
          court_name: string;
          competition_name: string;
          timezone: string;
        }>(
          `SELECT match.id match_id,match.code match_code,scheduled.starts_at,area.name court_name,
             competition.name competition_name,competition.timezone
           FROM competition_publications publication
           JOIN competitions competition ON competition.id=publication.competition_id
           JOIN scheduled_matches scheduled ON scheduled.schedule_revision_id=publication.published_schedule_revision_id
           JOIN matches match ON match.id=scheduled.match_id
           JOIN playing_areas area ON area.id=scheduled.playing_area_id
           WHERE publication.competition_id=$1 AND scheduled.starts_at>$2 AND scheduled.starts_at<=$3
             AND match.state IN ('pending','ready')
           ORDER BY scheduled.starts_at,match.id`,
          [competitionId, now, until],
        );
        const notifications = service(transaction, this.now);
        let count = 0;
        for (const match of due) {
          const startsAt = new Date(match.starts_at);
          const startsAtLabel = new Intl.DateTimeFormat("en-SG", {
            timeZone: match.timezone,
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(startsAt);
          for (const recipient of await recipients(transaction, competitionId, match.match_id)) {
            const emailEnabled = recipient.email_verified_at !== null;
            const result = await notifications.publish({
              accountId: recipient.id,
              type: "match_reminder",
              payload: { competition_id: competitionId, match_id: match.match_id, starts_at: startsAt.toISOString() },
              idempotencyKey: `match-reminder:${match.match_id}:${startsAt.getTime()}`,
              channels: emailEnabled ? ["in_app", "email"] : ["in_app"],
              essential: false,
              ...(emailEnabled
                ? {
                    email: {
                      to: recipient.primary_email,
                      template: { id: "match-reminder", version: 1 },
                      variables: {
                        competitionName: match.competition_name,
                        matchCode: match.match_code,
                        startsAt: startsAtLabel,
                        courtName: match.court_name,
                        actionUrl: actionUrl(competitionId, `schedule?match=${encodeURIComponent(match.match_id)}`),
                      },
                    },
                  }
                : {}),
            });
            if (result.notification) count += 1;
          }
        }
        return count;
      });
    }
    return queued;
  }
}
