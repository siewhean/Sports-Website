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
}
