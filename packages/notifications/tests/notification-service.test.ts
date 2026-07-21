import { describe, expect, it } from "vitest";
import {
  EmailTemplateRegistry,
  InMemoryEmailOutboxStore,
  InMemoryNotificationUnitOfWork,
  InMemoryNotificationRateLimiter,
  InMemoryNotificationStore,
  NotificationRateLimitError,
  NotificationService,
  NoopNotificationRateLimiter,
  type PublishNotificationInput,
} from "../src/index.js";

const NOW = new Date("2026-07-17T08:00:00.000Z");

function createHarness(rateLimit?: { maximum: number; windowMs: number }) {
  let nextId = 0;
  const createId = () => `id-${++nextId}`;
  const now = () => new Date(NOW);
  const notifications = new InMemoryNotificationStore();
  const emailOutbox = new InMemoryEmailOutboxStore();
  const unitOfWork = new InMemoryNotificationUnitOfWork(notifications, emailOutbox);
  const service = new NotificationService(notifications, unitOfWork, new EmailTemplateRegistry(), {
    createId,
    now,
    rateLimiter:
      rateLimit === undefined ? new NoopNotificationRateLimiter() : new InMemoryNotificationRateLimiter(rateLimit),
  });
  return { service, notifications, emailOutbox };
}

function emailNotification(overrides: Partial<PublishNotificationInput> = {}): PublishNotificationInput {
  return {
    accountId: "account-1",
    type: "critical-downstream-conflict",
    payload: { competitionId: "competition-1" },
    channels: ["in_app", "email"],
    essential: false,
    idempotencyKey: "conflict-1",
    email: {
      to: "organiser@example.test",
      template: { id: "critical-downstream-conflict", version: 1 },
      variables: {
        competitionName: "Friday League",
        actionUrl: "https://matchday.test/competitions/competition-1",
      },
    },
    ...overrides,
  };
}

function inAppNotification(idempotencyKey: string): PublishNotificationInput {
  return {
    accountId: "account-1",
    type: "critical-downstream-conflict",
    payload: { competitionId: "competition-1" },
    channels: ["in_app"],
    essential: false,
    idempotencyKey,
  };
}

describe("NotificationService", () => {
  it("persists an in-app representation before queueing every email", async () => {
    const { service, notifications, emailOutbox } = createHarness();
    await service.updatePreference({
      accountId: "account-1",
      notificationType: "critical-downstream-conflict",
      inAppEnabled: false,
      emailEnabled: true,
    });

    const result = await service.publish(emailNotification());

    expect(result.notification).toMatchObject({ accountId: "account-1", readAt: null });
    expect(result.emailOutboxId).not.toBeNull();
    const queued = await emailOutbox.findByIdempotencyKey("notification-email:account-1:conflict-1");
    expect(queued?.message.notificationId).toBe(result.notification?.id);
    expect((await notifications.list("account-1")).items).toHaveLength(1);
  });

  it("respects non-essential email opt-out while retaining enabled in-app delivery", async () => {
    const { service } = createHarness();
    await service.updatePreference({
      accountId: "account-1",
      notificationType: "critical-downstream-conflict",
      inAppEnabled: true,
      emailEnabled: false,
    });

    const result = await service.publish(emailNotification());

    expect(result.notification).not.toBeNull();
    expect(result.emailOutboxId).toBeNull();
    expect(result.suppressedChannels).toEqual(["email"]);
  });

  it("suppresses a non-essential notification when both preferences are disabled", async () => {
    const { service } = createHarness();
    await service.updatePreference({
      accountId: "account-1",
      notificationType: "critical-downstream-conflict",
      inAppEnabled: false,
      emailEnabled: false,
    });

    const result = await service.publish(emailNotification());

    expect(result).toEqual({
      notification: null,
      emailOutboxId: null,
      suppressedChannels: ["in_app", "email"],
    });
  });

  it("delivers essential email despite non-essential opt-out and still creates in-app state", async () => {
    const { service } = createHarness();
    await service.updatePreference({
      accountId: "account-1",
      notificationType: "critical-downstream-conflict",
      inAppEnabled: false,
      emailEnabled: false,
    });

    const result = await service.publish(emailNotification({ essential: true }));

    expect(result.notification).not.toBeNull();
    expect(result.emailOutboxId).not.toBeNull();
    expect(result.suppressedChannels).toEqual([]);
  });

  it("deduplicates both the notification and email outbox by idempotency key", async () => {
    const { service, emailOutbox } = createHarness();

    const first = await service.publish(emailNotification());
    const second = await service.publish(emailNotification());

    expect(second.notification?.id).toBe(first.notification?.id);
    expect(second.emailOutboxId).toBe(first.emailOutboxId);
    expect(await emailOutbox.findByIdempotencyKey("notification-email:account-1:conflict-1")).not.toBeNull();
    expect((await service.list("account-1")).items).toHaveLength(1);
  });

  it("scopes read operations by account and supports idempotent read-all", async () => {
    const { service } = createHarness();
    const first = await service.publish(inAppNotification("one"));
    await service.publish(inAppNotification("two"));

    expect(await service.markRead("another-account", first.notification?.id ?? "")).toBeNull();
    expect(await service.markAllRead("account-1")).toBe(2);
    expect(await service.markAllRead("account-1")).toBe(0);
    expect((await service.list("account-1")).unreadCount).toBe(0);
  });

  it("rate limits new notification storms without blocking an idempotent replay", async () => {
    const { service } = createHarness({ maximum: 1, windowMs: 60_000 });
    const first = inAppNotification("conflict-1");
    await service.publish(first);
    await expect(service.publish(first)).resolves.toMatchObject({ notification: { id: "id-1" } });

    await expect(service.publish({ ...first, idempotencyKey: "different-event" })).rejects.toBeInstanceOf(
      NotificationRateLimitError,
    );
  });

  it("rejects multi-recipient email fan-out before persisting anything", async () => {
    const { service } = createHarness();
    await expect(
      service.publish(
        emailNotification({
          email: {
            ...emailNotification().email!,
            to: "first@example.test, second@example.test",
          },
        }),
      ),
    ).rejects.toThrow("exactly one mailbox");
    expect((await service.list("account-1")).items).toHaveLength(0);
  });
});
