import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailBounceType, EmailDeliveryEventType, RecordEmailDeliveryEventInput } from "./types.js";

export type ResendWebhookHeaders = {
  id?: string;
  timestamp?: string;
  signature?: string;
};

export type ResendWebhookPayload = {
  type: string;
  created_at: string;
  data: {
    email_id?: string;
    id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    bounce_type?: string;
    bounce_sub_type?: string;
    reject_reason?: string;
    error?: string;
    message?: string;
    diagnostic_code?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/**
 * Verifies standard webhook signatures (Svix / HMAC-SHA256 signature scheme).
 * Supports both Svix format: `whsec_<base64>` and raw text secret.
 * Signature header contains signatures with format `v1,<base64>` or `v1=<base64>`.
 */
export function verifyWebhookSignature(input: {
  rawBody: string;
  msgId: string | undefined;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  secret: string | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const {
    rawBody,
    msgId,
    timestampHeader,
    signatureHeader,
    secret,
    toleranceSeconds = 300,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = input;

  if (
    !msgId ||
    !timestampHeader ||
    !signatureHeader ||
    !secret ||
    secret.trim() === "" ||
    typeof rawBody !== "string"
  ) {
    return false;
  }

  // Parse timestamp (can be integer Unix epoch in seconds)
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (Number.isNaN(timestamp) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return false;
  }

  // Check timestamp drift / replay tolerance
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }

  // Extract secret key buffer (handle whsec_ prefix if present, otherwise utf8 buffer)
  let keyBuffer: Buffer;
  if (secret.startsWith("whsec_")) {
    const rawKey = secret.slice("whsec_".length);
    try {
      keyBuffer = Buffer.from(rawKey, "base64");
    } catch {
      return false;
    }
  } else {
    keyBuffer = Buffer.from(secret, "utf8");
  }

  if (keyBuffer.length === 0) {
    return false;
  }

  // Compute expected HMAC-SHA256 on `${msgId}.${timestamp}.${rawBody}`
  const toSign = `${msgId}.${timestamp}.${rawBody}`;
  const expectedSignatureBuffer = createHmac("sha256", keyBuffer).update(toSign, "utf8").digest();

  // Signature header may contain multiple space-separated or comma-separated signatures:
  // e.g. "v1,g0hM9SvLF..." or "v1=g0hM9SvLF..."
  const signatureTokens = signatureHeader.split(/[,\s]+/);
  for (let token of signatureTokens) {
    token = token.trim();
    if (!token) continue;

    let candidateBase64 = token;
    if (token.startsWith("v1=")) {
      candidateBase64 = token.slice(3);
    } else if (token === "v1" && signatureTokens.length > 1) {
      continue;
    }

    try {
      const candidateBuffer = Buffer.from(candidateBase64, "base64");
      if (
        candidateBuffer.length === expectedSignatureBuffer.length &&
        timingSafeEqual(candidateBuffer, expectedSignatureBuffer)
      ) {
        return true;
      }
    } catch {
      // Ignore malformed token and check next
    }
  }

  return false;
}

export function mapResendEventTypeToNeutral(resendType: string): {
  eventType: EmailDeliveryEventType;
  bounceType: EmailBounceType | null;
} | null {
  switch (resendType) {
    case "email.delivered":
      return { eventType: "delivered", bounceType: null };
    case "email.bounced":
      return { eventType: "bounced", bounceType: "hard" };
    case "email.complained":
      return { eventType: "complained", bounceType: null };
    case "email.delivery_delayed":
      return { eventType: "delivery_delayed", bounceType: null };
    case "email.failed":
      return { eventType: "delivery_failed", bounceType: null };
    default:
      return null;
  }
}

export function parseResendDeliveryEvent(
  headers: {
    msgId?: string;
    timestamp?: string;
    signature?: string;
  },
  rawBody: string,
  secret: string | undefined,
  nowSeconds?: number,
): RecordEmailDeliveryEventInput {
  const verified = verifyWebhookSignature({
    rawBody,
    msgId: headers.msgId,
    timestampHeader: headers.timestamp,
    signatureHeader: headers.signature,
    secret,
    ...(nowSeconds !== undefined ? { nowSeconds } : {}),
  });

  if (!verified) {
    throw new Error("Webhook signature verification failed");
  }

  let parsed: ResendWebhookPayload;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid webhook JSON payload");
  }

  if (!parsed || typeof parsed !== "object" || !parsed.type || !parsed.data) {
    throw new Error("Malformed webhook payload structure");
  }

  const mapping = mapResendEventTypeToNeutral(parsed.type);
  if (!mapping) {
    throw new Error(`Unsupported provider event type: ${parsed.type}`);
  }

  const providerMessageId = parsed.data.email_id ?? parsed.data.id ?? headers.msgId;

  if (!providerMessageId || typeof providerMessageId !== "string") {
    throw new Error("Missing provider message id in event payload");
  }

  const occurredAt =
    typeof parsed.created_at === "string" && !Number.isNaN(Date.parse(parsed.created_at))
      ? new Date(parsed.created_at).toISOString()
      : new Date().toISOString();

  let bounceType: EmailBounceType | null = mapping.bounceType;
  if (parsed.data.bounce_type === "soft") {
    bounceType = "soft";
  } else if (parsed.data.bounce_type === "hard") {
    bounceType = "hard";
  }

  const bounceSubType = typeof parsed.data.bounce_sub_type === "string" ? parsed.data.bounce_sub_type : null;

  const diagnosticCode =
    typeof parsed.data.diagnostic_code === "string"
      ? parsed.data.diagnostic_code
      : typeof parsed.data.reject_reason === "string"
        ? parsed.data.reject_reason
        : typeof parsed.data.error === "string"
          ? parsed.data.error
          : null;

  let recipientReference: string | null = null;
  if (Array.isArray(parsed.data.to) && typeof parsed.data.to[0] === "string") {
    recipientReference = parsed.data.to[0];
  } else if (typeof parsed.data.to === "string") {
    recipientReference = parsed.data.to;
  }

  return {
    provider: "resend",
    providerEventId: headers.msgId!,
    providerMessageId,
    eventType: mapping.eventType,
    bounceType,
    bounceSubType,
    occurredAt,
    recipientReference,
    diagnosticCode,
  };
}
