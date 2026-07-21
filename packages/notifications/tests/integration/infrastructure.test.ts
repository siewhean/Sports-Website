import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "../../../database/src/migrations.js";
import {
  EmailOutboxProcessor,
  EmailTemplateRegistry,
  NoopNotificationRateLimiter,
  NotificationRateLimitError,
  NotificationService,
  PostgresNotificationRepository,
  connectRedisNotificationRateLimiter,
  createEmailOutboxItem,
  createNodemailerSmtpEmailProvider,
} from "../../src/index.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const mailpitApiUrl = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";
const schema = `test_notifications_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../database/migrations");
const accountId = "10000000-0000-4000-a000-000000000001";
let sql!: Sql;
let repository!: PostgresNotificationRepository;

function notificationInput(id: string, idempotencyKey: string) {
  return {
    id,
    accountId,
    type: "critical-downstream-conflict",
    payload: { competitionId: "competition-1" },
    idempotencyKey,
    createdAt: "2026-07-17T08:00:00.000Z",
  };
}

async function mailpitMessageCount(): Promise<number> {
  const response = await fetch(`${mailpitApiUrl}/api/v1/messages`);
  if (!response.ok) throw new Error(`Mailpit API returned ${response.status}`);
  const body = (await response.json()) as { messages_count: number };
  return body.messages_count;
}

describeInfrastructure("notification infrastructure", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 8, connection: { search_path: schema } });
    repository = new PostgresNotificationRepository(sql);
    await sql`
      INSERT INTO accounts (id, primary_email, display_name)
      VALUES (${accountId}, 'organiser@example.test', 'Organiser')
    `;
  });

  afterAll(async () => {
    await sql?.end();
    await dropTestSchema(databaseUrl, schema);
  });

  it("rolls back the in-app row when its email outbox insert fails", async () => {
    const notification = notificationInput("20000000-0000-4000-a000-000000000001", "rollback-1");
    const invalidOutbox = createEmailOutboxItem({
      id: "30000000-0000-4000-a000-000000000001",
      now: notification.createdAt,
      message: {
        notificationId: notification.id,
        to: "",
        template: { id: "test", version: 1 },
        subject: "Test",
        text: "Test",
        html: "<p>Test</p>",
        idempotencyKey: "rollback-email-1",
      },
    });

    await expect(repository.persist({ notification, emailOutbox: invalidOutbox })).rejects.toThrow();
    expect(await repository.findByIdempotencyKey(accountId, "rollback-1")).toBeNull();
  });

  it("uses SKIP LOCKED claims and fences an expired PostgreSQL lease", async () => {
    const notification = await repository.create(
      notificationInput("20000000-0000-4000-a000-000000000002", "lease-notification-1"),
    );
    await repository.enqueue(
      createEmailOutboxItem({
        id: "30000000-0000-4000-a000-000000000002",
        now: "2026-07-17T08:00:00.000Z",
        message: {
          notificationId: notification.id,
          to: "organiser@example.test",
          template: { id: "test", version: 1 },
          subject: "Test",
          text: "Test",
          html: "<p>Test</p>",
          idempotencyKey: "lease-email-1",
        },
      }),
    );

    const now = "2026-07-17T08:01:00.000Z";
    let releaseRowLock!: () => void;
    let reportRowLocked!: () => void;
    const rowLockRelease = new Promise<void>((resolve) => {
      releaseRowLock = resolve;
    });
    const rowLocked = new Promise<void>((resolve) => {
      reportRowLocked = resolve;
    });
    const heldTransaction = sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM notification_email_outbox
        WHERE id = '30000000-0000-4000-a000-000000000002'
        FOR UPDATE
      `;
      reportRowLocked();
      await rowLockRelease;
    });
    await rowLocked;
    try {
      await expect(repository.claimDue(now, 1, "2026-07-17T08:02:00.000Z", "skipped-lease")).resolves.toHaveLength(0);
    } finally {
      releaseRowLock();
      await heldTransaction;
    }

    const [firstClaim, competingClaim] = await Promise.all([
      repository.claimDue(now, 1, "2026-07-17T08:02:00.000Z", "lease-1"),
      repository.claimDue(now, 1, "2026-07-17T08:02:00.000Z", "competing-lease"),
    ]);
    expect(firstClaim.length + competingClaim.length).toBe(1);

    const initialLease = firstClaim.length === 1 ? "lease-1" : "competing-lease";
    const initialItem = firstClaim[0] ?? competingClaim[0];
    expect(initialItem).toBeDefined();
    await repository.markFailed(initialItem!.id, initialLease, "transient", "release", now);
    await repository.claimDue(now, 1, "2026-07-17T08:00:30.000Z", "lease-1");

    const reclaimed = await repository.claimDue(now, 1, "2026-07-17T08:02:00.000Z", "lease-2");
    expect(reclaimed).toHaveLength(1);
    await expect(repository.markDelivered(reclaimed[0]!.id, "lease-1", now, "stale-message")).rejects.toThrow(
      "no longer owned",
    );
    await expect(repository.markDelivered(reclaimed[0]!.id, "lease-2", now, "provider-message")).resolves.toMatchObject(
      { status: "delivered", attempts: 2 },
    );
  });

  it("enforces a distributed Redis notification limit across client connections", async () => {
    const prefix = `test:notifications:${randomUUID()}`;
    const first = await connectRedisNotificationRateLimiter(redisUrl, {
      maximum: 1,
      windowMs: 60_000,
      keyPrefix: prefix,
    });
    const second = await connectRedisNotificationRateLimiter(redisUrl, {
      maximum: 1,
      windowMs: 60_000,
      keyPrefix: prefix,
    });
    try {
      const now = new Date();
      await first.limiter.assertAllowed(accountId, "result-corrected", now);
      await expect(second.limiter.assertAllowed(accountId, "result-corrected", now)).rejects.toBeInstanceOf(
        NotificationRateLimitError,
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("persists email with its in-app row and sends one idempotent message through Mailpit", async () => {
    const clearResponse = await fetch(`${mailpitApiUrl}/api/v1/messages`, { method: "DELETE" });
    if (!clearResponse.ok) throw new Error(`Mailpit clear returned ${clearResponse.status}`);

    let idCounter = 10;
    const createId = () => `40000000-0000-4000-a000-${String(++idCounter).padStart(12, "0")}`;
    const service = new NotificationService(repository, repository, new EmailTemplateRegistry(), {
      createId,
      now: () => new Date("2026-07-17T08:10:00.000Z"),
      rateLimiter: new NoopNotificationRateLimiter(),
    });
    const request = {
      accountId,
      type: "critical-downstream-conflict",
      payload: { competitionId: "competition-mailpit" },
      channels: ["in_app", "email"] as const,
      essential: true,
      idempotencyKey: "mailpit-delivery-1",
      email: {
        to: "organiser@example.test",
        template: { id: "critical-downstream-conflict", version: 1 },
        variables: {
          competitionName: "Mailpit Cup",
          actionUrl: "https://matchday.test/competitions/mailpit-cup",
        },
      },
    };

    const first = await service.publish(request);
    const duplicate = await service.publish(request);
    expect(duplicate).toMatchObject({
      notification: { id: first.notification!.id },
      emailOutboxId: first.emailOutboxId,
    });

    const provider = createNodemailerSmtpEmailProvider({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      from: "Matchday <no-reply@matchday.test>",
    });
    const processor = new EmailOutboxProcessor(repository, provider, {
      now: () => new Date("2026-07-17T08:11:00.000Z"),
      createLeaseToken: randomUUID,
    });
    expect(await processor.processDue()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await processor.processDue()).toMatchObject({ claimed: 0, delivered: 0 });
    expect(await mailpitMessageCount()).toBe(1);

    const persisted = await repository.findByIdempotencyKey(accountId, "mailpit-delivery-1");
    expect(persisted?.id).toBe(first.notification?.id);
  });
});
