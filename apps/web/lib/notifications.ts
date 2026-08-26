export type NotificationCategory = "schedule_update" | "result_conflict" | "match_reminder" | "billing_receipt";

export interface NotificationApiRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface InAppNotification {
  id: string;
  category: NotificationCategory;
  heading: string;
  content: string;
  timestamp: string;
  read: boolean;
}

const categories = new Set<NotificationCategory>([
  "schedule_update",
  "result_conflict",
  "match_reminder",
  "billing_receipt",
]);

export function isNotificationApiRecord(value: unknown): value is NotificationApiRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    Boolean(record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)) &&
    typeof record.createdAt === "string" &&
    (record.readAt === null || typeof record.readAt === "string")
  );
}

export function toInAppNotification(record: NotificationApiRecord): InAppNotification {
  const category = categories.has(record.type as NotificationCategory)
    ? (record.type as NotificationCategory)
    : "schedule_update";
  return {
    id: record.id,
    category,
    heading: typeof record.payload.heading === "string" ? record.payload.heading : record.type,
    content: typeof record.payload.content === "string" ? record.payload.content : "",
    timestamp: record.createdAt,
    read: record.readAt !== null,
  };
}

export function notificationPageItems(value: unknown): InAppNotification[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items.filter(isNotificationApiRecord).map(toInAppNotification) : [];
}
