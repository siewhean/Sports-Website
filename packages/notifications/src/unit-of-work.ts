import type { EmailOutboxItem, EmailOutboxStore } from "./outbox.js";
import type { CreateNotificationInput, NotificationStore } from "./store.js";
import type { NotificationRecord } from "./types.js";

export type PersistNotificationDeliveryInput = {
  notification: CreateNotificationInput;
  emailOutbox: EmailOutboxItem | null;
};

export type PersistNotificationDeliveryResult = {
  notification: NotificationRecord;
  emailOutbox: EmailOutboxItem | null;
};

export interface NotificationUnitOfWork {
  persist(input: PersistNotificationDeliveryInput): Promise<PersistNotificationDeliveryResult>;
}

export class InMemoryNotificationUnitOfWork implements NotificationUnitOfWork {
  constructor(
    private readonly notifications: NotificationStore,
    private readonly emailOutbox: EmailOutboxStore,
  ) {}

  async persist(input: PersistNotificationDeliveryInput): Promise<PersistNotificationDeliveryResult> {
    const notification = await this.notifications.create(input.notification);
    if (input.emailOutbox === null) return { notification, emailOutbox: null };

    const emailOutbox = await this.emailOutbox.enqueue({
      ...input.emailOutbox,
      message: { ...input.emailOutbox.message, notificationId: notification.id },
    });
    return { notification, emailOutbox };
  }
}
