import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  mapResendEventTypeToNeutral,
  parseResendDeliveryEvent,
  verifyWebhookSignature,
} from "../src/delivery-events.js";

const SECRET = "whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtc3ZpeC1rZXk=";
const RAW_SECRET = "test-raw-secret-32-bytes-long-123456";

function signWebhook(msgId: string, timestamp: number, body: string, secret: string): string {
  let key: Buffer;
  if (secret.startsWith("whsec_")) {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } else {
    key = Buffer.from(secret, "utf8");
  }
  const toSign = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac("sha256", key).update(toSign, "utf8").digest("base64");
  return `v1,${sig}`;
}

describe("Email Delivery Webhook Authentication (Resend / Svix)", () => {
  const now = Math.floor(Date.now() / 1000);
  const msgId = "msg_123456789";
  const body = JSON.stringify({
    type: "email.bounced",
    created_at: new Date(now * 1000).toISOString(),
    data: {
      email_id: "email_resend_999",
      to: ["recipient@example.test"],
      bounce_type: "hard",
      diagnostic_code: "550 5.1.1 User unknown",
    },
  });

  it("authenticates valid signed webhook using whsec_ base64 secret", () => {
    const signature = signWebhook(msgId, now, body, SECRET);
    const valid = verifyWebhookSignature({
      rawBody: body,
      msgId,
      timestampHeader: String(now),
      signatureHeader: signature,
      secret: SECRET,
      nowSeconds: now,
    });
    expect(valid).toBe(true);
  });

  it("authenticates valid signed webhook using raw string secret", () => {
    const signature = signWebhook(msgId, now, body, RAW_SECRET);
    const valid = verifyWebhookSignature({
      rawBody: body,
      msgId,
      timestampHeader: String(now),
      signatureHeader: signature,
      secret: RAW_SECRET,
      nowSeconds: now,
    });
    expect(valid).toBe(true);
  });

  it("rejects missing signature", () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId,
        timestampHeader: String(now),
        signatureHeader: undefined,
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects missing msgId or timestampHeader", () => {
    const signature = signWebhook(msgId, now, body, SECRET);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId: undefined,
        timestampHeader: String(now),
        signatureHeader: signature,
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId,
        timestampHeader: undefined,
        signatureHeader: signature,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects invalid signature", () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId,
        timestampHeader: String(now),
        signatureHeader: "v1,invalidBase64Signature==",
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects tampered body", () => {
    const signature = signWebhook(msgId, now, body, SECRET);
    const tampered = body.replace("hard", "soft");
    expect(
      verifyWebhookSignature({
        rawBody: tampered,
        msgId,
        timestampHeader: String(now),
        signatureHeader: signature,
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects expired timestamp (replay prevention)", () => {
    const oldTimestamp = now - 600; // 10 minutes ago, tolerance is 300s
    const signature = signWebhook(msgId, oldTimestamp, body, SECRET);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId,
        timestampHeader: String(oldTimestamp),
        signatureHeader: signature,
        secret: SECRET,
        nowSeconds: now,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it("rejects future timestamp outside tolerance", () => {
    const futureTimestamp = now + 600;
    const signature = signWebhook(msgId, futureTimestamp, body, SECRET);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId,
        timestampHeader: String(futureTimestamp),
        signatureHeader: signature,
        secret: SECRET,
        nowSeconds: now,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it("rejects when secret is missing or empty", () => {
    const signature = signWebhook(msgId, now, body, SECRET);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId,
        timestampHeader: String(now),
        signatureHeader: signature,
        secret: "",
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        msgId,
        timestampHeader: String(now),
        signatureHeader: signature,
        secret: undefined,
      }),
    ).toBe(false);
  });

  it("parses valid Resend bounce delivery event", () => {
    const signature = signWebhook(msgId, now, body, SECRET);
    const parsed = parseResendDeliveryEvent({ msgId, timestamp: String(now), signature }, body, SECRET, now);
    expect(parsed).toEqual({
      provider: "resend",
      providerEventId: msgId,
      providerMessageId: "email_resend_999",
      eventType: "bounced",
      bounceType: "hard",
      bounceSubType: null,
      occurredAt: new Date(now * 1000).toISOString(),
      recipientReference: "recipient@example.test",
      diagnosticCode: "550 5.1.1 User unknown",
    });
  });

  it("maps provider event types neutral boundary correctly", () => {
    expect(mapResendEventTypeToNeutral("email.delivered")).toEqual({
      eventType: "delivered",
      bounceType: null,
    });
    expect(mapResendEventTypeToNeutral("email.bounced")).toEqual({
      eventType: "bounced",
      bounceType: "hard",
    });
    expect(mapResendEventTypeToNeutral("email.complained")).toEqual({
      eventType: "complained",
      bounceType: null,
    });
    expect(mapResendEventTypeToNeutral("email.delivery_delayed")).toEqual({
      eventType: "delivery_delayed",
      bounceType: null,
    });
    expect(mapResendEventTypeToNeutral("email.failed")).toEqual({
      eventType: "delivery_failed",
      bounceType: null,
    });
    expect(mapResendEventTypeToNeutral("email.unknown")).toBeNull();
  });
});
