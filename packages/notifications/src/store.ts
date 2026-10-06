import type { NotificationPage, NotificationPreference, NotificationRecord } from "./types.js";

export type CreateNotificationInput = Omit<NotificationRecord, "readAt">;

export interface NotificationStore {
  findByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<NotificationRecord | null>;
  create(input: CreateNotificationInput): Promise<NotificationRecord>;
  list(accountId: string, limit?: number): Promise<NotificationPage>;
  markRead(accountId: string, notificationId: string, readAt: string): Promise<NotificationRecord | null>;
  markAllRead(accountId: string, readAt: string): Promise<number>;
  getPreference(accountId: string, notificationType: string): Promise<NotificationPreference | null>;
  setPreference(preference: NotificationPreference): Promise<NotificationPreference>;
  recordDeliveryEvent?(
    input: import("./types.js").RecordEmailDeliveryEventInput,
  ): Promise<import("./types.js").RecordEmailDeliveryEventResult>;
}

function cloneRecord(record: NotificationRecord): NotificationRecord {
  return { ...record, payload: structuredClone(record.payload) };
}

export class InMemoryNotificationStore implements NotificationStore {
  readonly #notifications = new Map<string, NotificationRecord>();
  readonly #idempotencyIndex = new Map<string, string>();
  readonly #preferences = new Map<string, NotificationPreference>();

  async findByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<NotificationRecord | null> {
    const id = this.#idempotencyIndex.get(`${accountId}:${idempotencyKey}`);
    const record = id === undefined ? undefined : this.#notifications.get(id);
    return record === undefined ? null : cloneRecord(record);
  }

  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const indexKey = `${input.accountId}:${input.idempotencyKey}`;
    const existingId = this.#idempotencyIndex.get(indexKey);
    if (existingId !== undefined) {
      const existing = this.#notifications.get(existingId);
      if (existing !== undefined) return cloneRecord(existing);
    }

    const record: NotificationRecord = { ...input, payload: structuredClone(input.payload), readAt: null };
    this.#notifications.set(record.id, record);
    this.#idempotencyIndex.set(indexKey, record.id);
    return cloneRecord(record);
  }

  async list(accountId: string, limit = 50): Promise<NotificationPage> {
    const all = [...this.#notifications.values()]
      .filter((notification) => notification.accountId === accountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return {
      items: all.slice(0, Math.max(0, limit)).map(cloneRecord),
      unreadCount: all.filter((notification) => notification.readAt === null).length,
    };
  }

  async markRead(accountId: string, notificationId: string, readAt: string): Promise<NotificationRecord | null> {
    const current = this.#notifications.get(notificationId);
    if (current === undefined || current.accountId !== accountId) return null;
    if (current.readAt !== null) return cloneRecord(current);

    const updated = { ...current, readAt };
    this.#notifications.set(notificationId, updated);
    return cloneRecord(updated);
  }

  async markAllRead(accountId: string, readAt: string): Promise<number> {
    let updatedCount = 0;
    for (const [id, current] of this.#notifications) {
      if (current.accountId === accountId && current.readAt === null) {
        this.#notifications.set(id, { ...current, readAt });
        updatedCount += 1;
      }
    }
    return updatedCount;
  }

  async getPreference(accountId: string, notificationType: string): Promise<NotificationPreference | null> {
    const preference = this.#preferences.get(`${accountId}:${notificationType}`);
    return preference === undefined ? null : { ...preference };
  }

  async setPreference(preference: NotificationPreference): Promise<NotificationPreference> {
    const stored = { ...preference };
    this.#preferences.set(`${preference.accountId}:${preference.notificationType}`, stored);
    return { ...stored };
  }

  readonly #emailOutbox: import("./outbox.js").EmailOutboxStore | undefined;

  constructor(emailOutbox?: import("./outbox.js").EmailOutboxStore) {
    this.#emailOutbox = emailOutbox;
  }

  readonly #deliveryEvents = new Map<string, import("./types.js").EmailDeliveryEvent>();

  async recordDeliveryEvent(
    input: import("./types.js").RecordEmailDeliveryEventInput,
  ): Promise<import("./types.js").RecordEmailDeliveryEventResult> {
    const key = `${input.provider}:${input.providerEventId}`;
    const existing = this.#deliveryEvents.get(key);
    if (existing !== undefined) {
      return { event: { ...existing }, isDuplicate: true, outboxItem: null };
    }

    let outboxItem: { id: string; status: string; previousStatus: string } | null = null;
    let outboxId: string | null = null;

    if (this.#emailOutbox) {
      const existingOutbox = await this.#emailOutbox.findByProviderMessageId(input.providerMessageId);
      if (existingOutbox) {
        outboxId = existingOutbox.id;
        const previousStatus = existingOutbox.status;
        let newStatus = previousStatus;
        let updateError: string | null = null;
        let updateClassification: import("./email.js").DeliveryFailureClassification | null = null;

        if (input.eventType === "bounced") {
          if (input.bounceType === "hard" || !input.bounceType || input.bounceType === "general") {
            newStatus = "dead_letter";
            updateError = input.diagnosticCode ?? "Email delivery hard bounced by recipient mail server";
            updateClassification = "permanent";
          } else {
            updateError = input.diagnosticCode ?? "Email delivery soft bounced";
            updateClassification = "transient";
          }
        } else if (input.eventType === "delivery_failed") {
          newStatus = "dead_letter";
          updateError = input.diagnosticCode ?? "Email delivery failed";
          updateClassification = "permanent";
        } else if (input.eventType === "complained") {
          updateError = "Spam complaint recorded for recipient";
        }

        if (newStatus !== previousStatus || updateError !== null) {
          const updated = await this.#emailOutbox.updateStatusByProviderMessageId(
            input.providerMessageId,
            newStatus,
            updateError,
            updateClassification,
          );
          if (updated) {
            outboxItem = {
              id: existingOutbox.id,
              status: updated.status,
              previousStatus,
            };
          }
        }
      }
    }

    const event: import("./types.js").EmailDeliveryEvent = {
      id: `evt-${this.#deliveryEvents.size + 1}`,
      provider: input.provider,
      providerEventId: input.providerEventId,
      providerMessageId: input.providerMessageId,
      outboxId,
      eventType: input.eventType,
      bounceType: input.bounceType ?? null,
      bounceSubType: input.bounceSubType ?? null,
      occurredAt: input.occurredAt,
      receivedAt: new Date().toISOString(),
      recipientReference: input.recipientReference ?? null,
      diagnosticCode: input.diagnosticCode ?? null,
    };
    this.#deliveryEvents.set(key, event);
    return { event: { ...event }, isDuplicate: false, outboxItem };
  }
}
