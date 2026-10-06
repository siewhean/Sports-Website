import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EmailTemplateRegistry,
  InMemoryEmailOutboxStore,
  InMemoryNotificationRateLimiter,
  InMemoryNotificationStore,
  InMemoryNotificationUnitOfWork,
  NotificationService,
} from "@matchday/notifications";
import { buildApp } from "../../src/app.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const WEBHOOK_SECRET = "whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtc3ZpeC1rZXk=";

function signSvix(msgId: string, timestamp: number, body: string, secret: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const toSign = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac("sha256", key).update(toSign, "utf8").digest("base64");
  return `v1,${sig}`;
}

async function createTestApp(options: { webhookSecret?: string } = {}) {
  const emailOutbox = new InMemoryEmailOutboxStore();
  const notifications = new InMemoryNotificationStore(emailOutbox);
  const unitOfWork = new InMemoryNotificationUnitOfWork(notifications, emailOutbox);
  const notificationService = new NotificationService(notifications, unitOfWork, new EmailTemplateRegistry(), {
    createId: () => "notif-1",
    now: () => new Date("2026-10-07T00:00:00.000Z"),
    rateLimiter: new InMemoryNotificationRateLimiter({ maximum: 100, windowMs: 60_000 }),
  });

  const mockIdentity = {
    authenticate: vi.fn(),
    rateLimitAccountId: vi.fn().mockResolvedValue(null),
  } as unknown as IdentityApiRuntime;

  const app = await buildApp({
    config: testConfig({
      ...(options.webhookSecret !== undefined ? { EMAIL_PROVIDER_WEBHOOK_SECRET: options.webhookSecret } : {}),
    }),
    probes: healthyProbes,
    notificationService,
    identityRuntime: mockIdentity,
  });

  return { app, notificationService, emailOutbox, notifications };
}

describe("POST /api/v1/notifications/webhooks/resend", () => {
  const now = Math.floor(Date.now() / 1000);

  it("processes a valid signed delivery event and updates outbox state", async () => {
    const { app, emailOutbox } = await createTestApp({ webhookSecret: WEBHOOK_SECRET });

    // Seed an outbound item with providerMessageId in outbox
    await emailOutbox.enqueue({
      id: "outbox-1",
      message: {
        to: "user@example.test",
        subject: "Welcome",
        text: "Hi",
        html: "<p>Hi</p>",
        idempotencyKey: "email-idem-1",
        notificationId: "notif-1",
        template: { id: "test", version: 1 },
      },
      status: "delivered",
      attempts: 1,
      createdAt: new Date().toISOString(),
      availableAt: new Date().toISOString(),
      lockedUntil: null,
      leaseToken: null,
      deliveredAt: new Date().toISOString(),
      providerMessageId: "resend-msg-100",
      lastError: null,
      lastFailureClassification: null,
    });

    const bodyObj = {
      type: "email.bounced",
      created_at: new Date(now * 1000).toISOString(),
      data: {
        email_id: "resend-msg-100",
        to: ["user@example.test"],
        bounce_type: "hard",
        diagnostic_code: "550 5.1.1 Address rejected",
      },
    };
    const rawBody = JSON.stringify(bodyObj);
    const msgId = "evt_001";
    const signature = signSvix(msgId, now, rawBody, WEBHOOK_SECRET);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": msgId,
        "svix-timestamp": String(now),
        "svix-signature": signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toMatchObject({
      received: true,
      provider_event_id: "evt_001",
      is_duplicate: false,
    });

    const updated = await emailOutbox.findByProviderMessageId("resend-msg-100");
    expect(updated?.status).toBe("dead_letter");
    expect(updated?.lastError).toContain("550");
  });

  it("handles duplicate webhook replay idempotently without state transition", async () => {
    const { app, emailOutbox } = await createTestApp({ webhookSecret: WEBHOOK_SECRET });

    await emailOutbox.enqueue({
      id: "outbox-2",
      message: {
        to: "user@example.test",
        subject: "Verification",
        text: "Hi",
        html: "<p>Hi</p>",
        idempotencyKey: "email-idem-2",
        notificationId: "notif-2",
        template: { id: "test", version: 1 },
      },
      status: "delivered",
      attempts: 1,
      createdAt: new Date().toISOString(),
      availableAt: new Date().toISOString(),
      lockedUntil: null,
      leaseToken: null,
      deliveredAt: new Date().toISOString(),
      providerMessageId: "resend-msg-200",
      lastError: null,
      lastFailureClassification: null,
    });

    const bodyObj = {
      type: "email.delivered",
      created_at: new Date(now * 1000).toISOString(),
      data: {
        email_id: "resend-msg-200",
        to: ["user@example.test"],
      },
    };
    const rawBody = JSON.stringify(bodyObj);
    const msgId = "evt_002";
    const signature = signSvix(msgId, now, rawBody, WEBHOOK_SECRET);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": msgId,
        "svix-timestamp": String(now),
        "svix-signature": signature,
      },
      payload: rawBody,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().is_duplicate).toBe(false);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": msgId,
        "svix-timestamp": String(now),
        "svix-signature": signature,
      },
      payload: rawBody,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().is_duplicate).toBe(true);

    const outboxItem = await emailOutbox.findByProviderMessageId("resend-msg-200");
    expect(outboxItem?.status).toBe("delivered");
  });

  it("rejects missing signature with 401", async () => {
    const { app } = await createTestApp({ webhookSecret: WEBHOOK_SECRET });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "email.delivered" }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects invalid signature with 401", async () => {
    const { app } = await createTestApp({ webhookSecret: WEBHOOK_SECRET });
    const body = JSON.stringify({ type: "email.delivered" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": "evt_test",
        "svix-timestamp": String(now),
        "svix-signature": "v1,badSignatureBase64==",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects expired timestamp with 401 (replay protection)", async () => {
    const { app } = await createTestApp({ webhookSecret: WEBHOOK_SECRET });
    const oldTime = now - 600;
    const body = JSON.stringify({ type: "email.delivered" });
    const sig = signSvix("evt_old", oldTime, body, WEBHOOK_SECRET);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": "evt_old",
        "svix-timestamp": String(oldTime),
        "svix-signature": sig,
      },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });

  it("fails closed with 503 when webhook secret is unconfigured", async () => {
    const { app } = await createTestApp({ webhookSecret: "" });
    const body = JSON.stringify({ type: "email.delivered" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": "evt_any",
        "svix-timestamp": String(now),
        "svix-signature": "v1,any",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(503);
  });
});
