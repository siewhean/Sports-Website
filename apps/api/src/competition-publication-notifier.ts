import { randomUUID } from "node:crypto";
import {
  EmailTemplateRegistry,
  NoopNotificationRateLimiter,
  NotificationService,
  PostgresNotificationRepository,
} from "@matchday/notifications";
import type { PostgresJsSql } from "@matchday/identity";
import type { TransactionSql } from "postgres";

export type CompetitionPublicationNotificationInput = Readonly<{
  transaction: PostgresJsSql;
  actorAccountId: string;
  competitionId: string;
  competitionName: string;
  scheduleRevisionId: string;
  scheduleVersion: number;
}>;

export interface CompetitionPublicationNotifier {
  publish(input: CompetitionPublicationNotificationInput): Promise<void>;
}

type Recipient = Readonly<{
  primary_email: string;
  email_verified_at: Date | string | null;
}>;

/** Persists an organiser notification and email outbox in the publication transaction. */
export class TransactionalCompetitionPublicationNotifier implements CompetitionPublicationNotifier {
  constructor(
    private readonly publicOrigin: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(input: CompetitionPublicationNotificationInput): Promise<void> {
    const recipient = (
      await input.transaction.unsafe<Recipient>(
        `SELECT primary_email,email_verified_at
         FROM accounts
         WHERE id=$1 AND status='active' AND deleted_at IS NULL
         FOR SHARE`,
        [input.actorAccountId],
      )
    )[0];
    if (!recipient) return;

    const repository = new PostgresNotificationRepository(input.transaction as unknown as TransactionSql);
    const notificationService = new NotificationService(repository, repository, new EmailTemplateRegistry(), {
      createId: randomUUID,
      now: this.now,
      rateLimiter: new NoopNotificationRateLimiter(),
    });
    const emailEnabled = recipient.email_verified_at !== null;
    await notificationService.publish({
      accountId: input.actorAccountId,
      type: "competition-published",
      payload: {
        competition_id: input.competitionId,
        schedule_revision_id: input.scheduleRevisionId,
        schedule_version: input.scheduleVersion,
      },
      idempotencyKey: `competition-schedule-published:${input.competitionId}:${input.scheduleRevisionId}`,
      channels: emailEnabled ? ["in_app", "email"] : ["in_app"],
      essential: false,
      ...(emailEnabled
        ? {
            email: {
              to: recipient.primary_email,
              template: { id: "competition-published", version: 1 },
              variables: {
                competitionName: input.competitionName,
                actionUrl: new URL(
                  `/organiser/competitions/${encodeURIComponent(input.competitionId)}/schedule`,
                  this.publicOrigin,
                ).toString(),
              },
            },
          }
        : {}),
    });
  }
}
