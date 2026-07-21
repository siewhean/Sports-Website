import type { Sql, TransactionSql } from "postgres";
import type { DeliveryFailureClassification } from "./email.js";
import { StaleEmailOutboxLeaseError, type EmailOutboxItem, type EmailOutboxStore } from "./outbox.js";
import type { CreateNotificationInput, NotificationStore } from "./store.js";
import type {
  PersistNotificationDeliveryInput,
  PersistNotificationDeliveryResult,
  NotificationUnitOfWork,
} from "./unit-of-work.js";
import type { NotificationPage, NotificationPreference, NotificationRecord } from "./types.js";

type Timestamp = Date | string;

type NotificationRow = {
  id: string;
  account_id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  created_at: Timestamp;
  read_at: Timestamp | null;
};

type PreferenceRow = {
  account_id: string;
  notification_type: string;
  in_app_enabled: boolean;
  email_enabled: boolean;
  updated_at: Timestamp;
};

type EmailOutboxRow = {
  id: string;
  notification_id: string;
  to_address: string;
  template_id: string;
  template_version: number;
  subject: string;
  text_body: string;
  html_body: string;
  idempotency_key: string;
  status: EmailOutboxItem["status"];
  attempts: number;
  created_at: Timestamp;
  available_at: Timestamp;
  locked_until: Timestamp | null;
  lease_token: string | null;
  delivered_at: Timestamp | null;
  provider_message_id: string | null;
  last_error: string | null;
  last_failure_classification: DeliveryFailureClassification | null;
};

function iso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    payload: structuredClone(row.payload),
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at),
    readAt: row.read_at === null ? null : iso(row.read_at),
  };
}

function mapPreference(row: PreferenceRow): NotificationPreference {
  return {
    accountId: row.account_id,
    notificationType: row.notification_type,
    inAppEnabled: row.in_app_enabled,
    emailEnabled: row.email_enabled,
    updatedAt: iso(row.updated_at),
  };
}

function mapEmailOutbox(row: EmailOutboxRow): EmailOutboxItem {
  return {
    id: row.id,
    message: {
      notificationId: row.notification_id,
      to: row.to_address,
      template: { id: row.template_id, version: row.template_version },
      subject: row.subject,
      text: row.text_body,
      html: row.html_body,
      idempotencyKey: row.idempotency_key,
    },
    status: row.status,
    attempts: row.attempts,
    createdAt: iso(row.created_at),
    availableAt: iso(row.available_at),
    lockedUntil: row.locked_until === null ? null : iso(row.locked_until),
    leaseToken: row.lease_token,
    deliveredAt: row.delivered_at === null ? null : iso(row.delivered_at),
    providerMessageId: row.provider_message_id,
    lastError: row.last_error,
    lastFailureClassification: row.last_failure_classification,
  };
}

async function upsertNotification(
  sql: Sql | TransactionSql,
  input: CreateNotificationInput,
): Promise<NotificationRecord> {
  const rows = await sql<NotificationRow[]>`
    INSERT INTO notifications (
      id, account_id, type, payload, idempotency_key, created_at
    ) VALUES (
      ${input.id}, ${input.accountId}, ${input.type}, ${JSON.stringify(input.payload)}::jsonb,
      ${input.idempotencyKey}, ${input.createdAt}
    )
    ON CONFLICT (account_id, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING id, account_id, type, payload, idempotency_key, created_at, read_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("PostgreSQL did not return the persisted notification");
  return mapNotification(row);
}

async function upsertOutbox(
  sql: Sql | TransactionSql,
  item: EmailOutboxItem,
  notificationId: string,
): Promise<EmailOutboxItem> {
  const rows = await sql<EmailOutboxRow[]>`
    INSERT INTO notification_email_outbox (
      id, notification_id, to_address, template_id, template_version, subject, text_body, html_body,
      idempotency_key, status, attempts, created_at, available_at, locked_until, lease_token,
      delivered_at, provider_message_id, last_error, last_failure_classification
    ) VALUES (
      ${item.id}, ${notificationId}, ${item.message.to}, ${item.message.template.id},
      ${item.message.template.version}, ${item.message.subject}, ${item.message.text}, ${item.message.html},
      ${item.message.idempotencyKey}, ${item.status}, ${item.attempts}, ${item.createdAt},
      ${item.availableAt}, ${item.lockedUntil}, ${item.leaseToken}, ${item.deliveredAt},
      ${item.providerMessageId}, ${item.lastError}, ${item.lastFailureClassification}
    )
    ON CONFLICT (idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("PostgreSQL did not return the persisted email outbox item");
  return mapEmailOutbox(row);
}

export class PostgresNotificationRepository implements NotificationStore, NotificationUnitOfWork, EmailOutboxStore {
  constructor(private readonly sql: Sql) {}

  async persist(input: PersistNotificationDeliveryInput): Promise<PersistNotificationDeliveryResult> {
    return this.sql.begin(async (transaction) => {
      const notification = await upsertNotification(transaction, input.notification);
      const emailOutbox =
        input.emailOutbox === null ? null : await upsertOutbox(transaction, input.emailOutbox, notification.id);
      return { notification, emailOutbox };
    });
  }

  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    return upsertNotification(this.sql, input);
  }

  async list(accountId: string, limit = 50): Promise<NotificationPage> {
    const rows = await this.sql<NotificationRow[]>`
      SELECT id, account_id, type, payload, idempotency_key, created_at, read_at
      FROM notifications
      WHERE account_id = ${accountId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${Math.max(0, limit)}
    `;
    const counts = await this.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM notifications
      WHERE account_id = ${accountId} AND read_at IS NULL
    `;
    return {
      items: rows.map(mapNotification),
      unreadCount: Number(counts[0]?.count ?? 0),
    };
  }

  async markRead(accountId: string, notificationId: string, readAt: string): Promise<NotificationRecord | null> {
    const rows = await this.sql<NotificationRow[]>`
      UPDATE notifications
      SET read_at = COALESCE(read_at, ${readAt})
      WHERE id = ${notificationId} AND account_id = ${accountId}
      RETURNING id, account_id, type, payload, idempotency_key, created_at, read_at
    `;
    return rows[0] === undefined ? null : mapNotification(rows[0]);
  }

  async markAllRead(accountId: string, readAt: string): Promise<number> {
    const result = await this.sql`
      UPDATE notifications SET read_at = ${readAt}
      WHERE account_id = ${accountId} AND read_at IS NULL
    `;
    return result.count;
  }

  async getPreference(accountId: string, notificationType: string): Promise<NotificationPreference | null> {
    const rows = await this.sql<PreferenceRow[]>`
      SELECT account_id, notification_type, in_app_enabled, email_enabled, updated_at
      FROM notification_preferences
      WHERE account_id = ${accountId} AND notification_type = ${notificationType}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : mapPreference(rows[0]);
  }

  async setPreference(preference: NotificationPreference): Promise<NotificationPreference> {
    const rows = await this.sql<PreferenceRow[]>`
      INSERT INTO notification_preferences (
        account_id, notification_type, in_app_enabled, email_enabled, updated_at
      ) VALUES (
        ${preference.accountId}, ${preference.notificationType}, ${preference.inAppEnabled},
        ${preference.emailEnabled}, ${preference.updatedAt}
      )
      ON CONFLICT (account_id, notification_type)
      DO UPDATE SET
        in_app_enabled = EXCLUDED.in_app_enabled,
        email_enabled = EXCLUDED.email_enabled,
        updated_at = EXCLUDED.updated_at
      RETURNING account_id, notification_type, in_app_enabled, email_enabled, updated_at
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("PostgreSQL did not return the notification preference");
    return mapPreference(row);
  }

  async enqueue(item: EmailOutboxItem): Promise<EmailOutboxItem> {
    return upsertOutbox(this.sql, item, item.message.notificationId);
  }

  async findByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<NotificationRecord | null>;
  async findByIdempotencyKey(idempotencyKey: string): Promise<EmailOutboxItem | null>;
  async findByIdempotencyKey(
    accountIdOrIdempotencyKey: string,
    notificationIdempotencyKey?: string,
  ): Promise<NotificationRecord | EmailOutboxItem | null> {
    if (notificationIdempotencyKey !== undefined) {
      const rows = await this.sql<NotificationRow[]>`
        SELECT id, account_id, type, payload, idempotency_key, created_at, read_at
        FROM notifications
        WHERE account_id = ${accountIdOrIdempotencyKey}
          AND idempotency_key = ${notificationIdempotencyKey}
        LIMIT 1
      `;
      return rows[0] === undefined ? null : mapNotification(rows[0]);
    }
    const rows = await this.sql<EmailOutboxRow[]>`
      SELECT * FROM notification_email_outbox
      WHERE idempotency_key = ${accountIdOrIdempotencyKey}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : mapEmailOutbox(rows[0]);
  }

  async claimDue(
    now: string,
    limit: number,
    lockedUntil: string,
    leaseToken: string,
  ): Promise<readonly EmailOutboxItem[]> {
    const rows = await this.sql<EmailOutboxRow[]>`
      WITH candidates AS (
        SELECT id
        FROM notification_email_outbox
        WHERE available_at <= ${now}
          AND (status = 'pending' OR (status = 'processing' AND locked_until <= ${now}))
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${Math.max(0, limit)}
      )
      UPDATE notification_email_outbox AS outbox
      SET status = 'processing', locked_until = ${lockedUntil}, lease_token = ${leaseToken}
      FROM candidates
      WHERE outbox.id = candidates.id
      RETURNING outbox.*
    `;
    return rows.map(mapEmailOutbox);
  }

  async markDelivered(
    id: string,
    leaseToken: string,
    deliveredAt: string,
    providerMessageId: string,
  ): Promise<EmailOutboxItem> {
    const rows = await this.sql<EmailOutboxRow[]>`
      UPDATE notification_email_outbox
      SET status = 'delivered', attempts = attempts + 1, locked_until = NULL, lease_token = NULL,
          delivered_at = ${deliveredAt}, provider_message_id = ${providerMessageId},
          last_error = NULL, last_failure_classification = NULL
      WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      RETURNING *
    `;
    const row = rows[0];
    if (row === undefined) throw new StaleEmailOutboxLeaseError(id);
    return mapEmailOutbox(row);
  }

  async markFailed(
    id: string,
    leaseToken: string,
    classification: DeliveryFailureClassification,
    message: string,
    availableAt: string | null,
  ): Promise<EmailOutboxItem> {
    const rows = await this.sql<EmailOutboxRow[]>`
      UPDATE notification_email_outbox
      SET status = ${availableAt === null ? "dead_letter" : "pending"}, attempts = attempts + 1,
          available_at = COALESCE(${availableAt}, available_at), locked_until = NULL, lease_token = NULL,
          last_error = ${message}, last_failure_classification = ${classification}
      WHERE id = ${id} AND status = 'processing' AND lease_token = ${leaseToken}
      RETURNING *
    `;
    const row = rows[0];
    if (row === undefined) throw new StaleEmailOutboxLeaseError(id);
    return mapEmailOutbox(row);
  }
}
