import { describe, expect, it } from "vitest";
import {
  EmailOutboxProcessor,
  EmailOutboxService,
  InMemoryEmailOutboxStore,
  classifyEmailDeliveryError,
  type EmailMessage,
  type EmailProvider,
} from "../src/index.js";

const MESSAGE: EmailMessage = {
  to: "organiser@example.test",
  subject: "Test",
  text: "Test",
  html: "<p>Test</p>",
  template: { id: "test", version: 1 },
  idempotencyKey: "email-1",
  notificationId: "notification-1",
};

function smtpError(responseCode: number): Error & { responseCode: number } {
  return Object.assign(new Error(`SMTP ${responseCode}`), { responseCode });
}

describe("email retry classification", () => {
  it("classifies 4xx and network failures as transient and 5xx as permanent", () => {
    expect(classifyEmailDeliveryError(smtpError(451))).toBe("transient");
    expect(classifyEmailDeliveryError(smtpError(550))).toBe("permanent");
    expect(classifyEmailDeliveryError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBe("transient");
  });
});

describe("EmailOutboxProcessor", () => {
  it("enqueues idempotently, retries transient failures, then records delivery", async () => {
    let currentTime = new Date("2026-07-17T08:00:00.000Z");
    const now = () => new Date(currentTime);
    const store = new InMemoryEmailOutboxStore();
    const service = new EmailOutboxService(store, { createId: () => "outbox-1", now });
    const first = await service.enqueue(MESSAGE);
    const duplicate = await service.enqueue(MESSAGE);
    expect(duplicate.id).toBe(first.id);

    let calls = 0;
    const provider: EmailProvider = {
      async send() {
        calls += 1;
        if (calls === 1) throw smtpError(451);
        return { providerMessageId: "provider-1", accepted: [MESSAGE.to] };
      },
    };
    const processor = new EmailOutboxProcessor(store, provider, {
      now,
      createLeaseToken: () => `lease-${calls + 1}`,
      baseDelayMs: 1_000,
      maxAttempts: 3,
    });

    expect(await processor.processDue()).toEqual({
      claimed: 1,
      delivered: 0,
      retried: 1,
      deadLettered: 0,
    });
    currentTime = new Date(currentTime.getTime() + 1_000);
    expect(await processor.processDue()).toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect((await store.findByIdempotencyKey("email-1"))?.status).toBe("delivered");
  });

  it("dead-letters permanent SMTP failures without retry", async () => {
    const now = () => new Date("2026-07-17T08:00:00.000Z");
    const store = new InMemoryEmailOutboxStore();
    await new EmailOutboxService(store, { createId: () => "outbox-1", now }).enqueue(MESSAGE);
    const provider: EmailProvider = {
      async send() {
        throw smtpError(550);
      },
    };
    const processor = new EmailOutboxProcessor(store, provider, {
      now,
      createLeaseToken: () => "lease-1",
    });

    expect(await processor.processDue()).toMatchObject({ deadLettered: 1, retried: 0 });
    expect(await store.findByIdempotencyKey("email-1")).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      lastFailureClassification: "permanent",
    });
  });

  it("reclaims an item after an abandoned processing lease expires", async () => {
    let currentTime = new Date("2026-07-17T08:00:00.000Z");
    const now = () => new Date(currentTime);
    const store = new InMemoryEmailOutboxStore();
    await new EmailOutboxService(store, { createId: () => "outbox-1", now }).enqueue(MESSAGE);
    await store.claimDue(now().toISOString(), 1, new Date(now().getTime() + 1_000).toISOString(), "lease-1");
    currentTime = new Date(currentTime.getTime() + 1_001);

    const reclaimed = await store.claimDue(
      now().toISOString(),
      1,
      new Date(now().getTime() + 1_000).toISOString(),
      "lease-2",
    );
    expect(reclaimed).toHaveLength(1);
    await expect(store.markDelivered("outbox-1", "lease-1", now().toISOString(), "stale-provider-id")).rejects.toThrow(
      "no longer owned",
    );
  });

  it("dead-letters a provider response that accepts no recipient", async () => {
    const now = () => new Date("2026-07-17T08:00:00.000Z");
    const store = new InMemoryEmailOutboxStore();
    await new EmailOutboxService(store, { createId: () => "outbox-1", now }).enqueue(MESSAGE);
    const provider: EmailProvider = {
      async send() {
        return { providerMessageId: "rejected-1", accepted: [] };
      },
    };
    const processor = new EmailOutboxProcessor(store, provider, {
      now,
      createLeaseToken: () => "lease-1",
    });

    expect(await processor.processDue()).toMatchObject({ deadLettered: 1, delivered: 0 });
    expect(await store.findByIdempotencyKey("email-1")).toMatchObject({
      status: "dead_letter",
      lastFailureClassification: "permanent",
    });
  });
});
