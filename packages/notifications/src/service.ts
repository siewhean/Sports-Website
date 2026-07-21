import { createEmailOutboxItem } from "./outbox.js";
import { requireSingleEmailMailbox } from "./email.js";
import type { NotificationRateLimiter } from "./rate-limit.js";
import type { NotificationStore } from "./store.js";
import { EmailTemplateRegistry } from "./templates.js";
import type {
  NotificationPage,
  NotificationPreference,
  NotificationRecord,
  PublishNotificationInput,
  PublishNotificationResult,
} from "./types.js";
import type { NotificationUnitOfWork } from "./unit-of-work.js";

function requireNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} is required`);
}

export type NotificationServiceOptions = {
  createId: () => string;
  now: () => Date;
  rateLimiter: NotificationRateLimiter;
};

export class NotificationService {
  constructor(
    private readonly store: NotificationStore,
    private readonly unitOfWork: NotificationUnitOfWork,
    private readonly templates: EmailTemplateRegistry,
    private readonly options: NotificationServiceOptions,
  ) {}

  async publish(input: PublishNotificationInput): Promise<PublishNotificationResult> {
    requireNonEmpty(input.accountId, "Account ID");
    requireNonEmpty(input.type, "Notification type");
    requireNonEmpty(input.idempotencyKey, "Idempotency key");

    const wantsEmail = input.channels.includes("email");
    if (wantsEmail && input.email === undefined) {
      throw new Error("Email delivery requires an email recipient and template");
    }

    const existing = await this.store.findByIdempotencyKey(input.accountId, input.idempotencyKey);
    const preference = await this.getPreference(input.accountId, input.type);
    const shouldEmail = wantsEmail && (input.essential || preference.emailEnabled);
    const shouldStoreInApp = (input.channels.includes("in_app") && preference.inAppEnabled) || shouldEmail;
    const suppressedChannels = input.channels.filter(
      (channel) => (channel === "email" && !shouldEmail) || (channel === "in_app" && !shouldStoreInApp),
    );

    if (!shouldStoreInApp) {
      return { notification: null, emailOutboxId: null, suppressedChannels };
    }

    if (existing === null) {
      await this.options.rateLimiter.assertAllowed(input.accountId, input.type, this.options.now());
    }

    const now = this.options.now().toISOString();
    const notificationId = existing?.id ?? this.options.createId();
    const emailOutbox =
      shouldEmail && input.email !== undefined
        ? createEmailOutboxItem({
            id: this.options.createId(),
            now,
            message: {
              ...this.templates.render(input.email.template, input.email.variables),
              to: requireSingleEmailMailbox(input.email.to),
              idempotencyKey: `notification-email:${input.accountId}:${input.idempotencyKey}`,
              notificationId,
            },
          })
        : null;
    const persisted = await this.unitOfWork.persist({
      notification: {
        id: notificationId,
        accountId: input.accountId,
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        createdAt: existing?.createdAt ?? now,
      },
      emailOutbox,
    });

    return {
      notification: persisted.notification,
      emailOutboxId: persisted.emailOutbox?.id ?? null,
      suppressedChannels,
    };
  }

  async list(accountId: string, limit?: number): Promise<NotificationPage> {
    return limit === undefined ? this.store.list(accountId) : this.store.list(accountId, limit);
  }

  async markRead(accountId: string, notificationId: string): Promise<NotificationRecord | null> {
    return this.store.markRead(accountId, notificationId, this.options.now().toISOString());
  }

  async markAllRead(accountId: string): Promise<number> {
    return this.store.markAllRead(accountId, this.options.now().toISOString());
  }

  async getPreference(accountId: string, notificationType: string): Promise<NotificationPreference> {
    const stored = await this.store.getPreference(accountId, notificationType);
    return (
      stored ?? {
        accountId,
        notificationType,
        inAppEnabled: true,
        emailEnabled: true,
        updatedAt: this.options.now().toISOString(),
      }
    );
  }

  async updatePreference(input: {
    accountId: string;
    notificationType: string;
    inAppEnabled: boolean;
    emailEnabled: boolean;
  }): Promise<NotificationPreference> {
    requireNonEmpty(input.accountId, "Account ID");
    requireNonEmpty(input.notificationType, "Notification type");
    return this.store.setPreference({ ...input, updatedAt: this.options.now().toISOString() });
  }
}
