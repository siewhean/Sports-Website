export type NotificationChannel = "in_app" | "email";

export type NotificationPreference = {
  accountId: string;
  notificationType: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  updatedAt: string;
};

export type NotificationRecord = {
  id: string;
  accountId: string;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  createdAt: string;
  readAt: string | null;
};

export type NotificationPage = {
  items: readonly NotificationRecord[];
  unreadCount: number;
};

export type EmailTemplateReference = {
  id: string;
  version: number;
};

export type RenderedEmail = {
  template: EmailTemplateReference;
  subject: string;
  text: string;
  html: string;
};

export type EmailMessage = RenderedEmail & {
  to: string;
  idempotencyKey: string;
  notificationId: string;
};

export type PublishNotificationInput = {
  accountId: string;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  channels: readonly NotificationChannel[];
  essential: boolean;
  idempotencyKey: string;
  email?: {
    to: string;
    template: EmailTemplateReference;
    variables: Readonly<Record<string, string>>;
  };
};

export type PublishNotificationResult = {
  notification: NotificationRecord | null;
  emailOutboxId: string | null;
  suppressedChannels: readonly NotificationChannel[];
};

export type EmailDeliveryEventType = "delivered" | "bounced" | "complained" | "delivery_delayed" | "delivery_failed";

export type EmailBounceType = "hard" | "soft" | "general";

export type EmailDeliveryEvent = {
  id: string;
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  outboxId: string | null;
  eventType: EmailDeliveryEventType;
  bounceType: EmailBounceType | null;
  bounceSubType: string | null;
  occurredAt: string;
  receivedAt: string;
  recipientReference: string | null;
  diagnosticCode: string | null;
};

export type RecordEmailDeliveryEventInput = {
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  eventType: EmailDeliveryEventType;
  bounceType?: EmailBounceType | null;
  bounceSubType?: string | null;
  occurredAt: string;
  recipientReference?: string | null;
  diagnosticCode?: string | null;
};

export type RecordEmailDeliveryEventResult = {
  event: EmailDeliveryEvent;
  isDuplicate: boolean;
  outboxItem: {
    id: string;
    status: string;
    previousStatus: string;
  } | null;
};
