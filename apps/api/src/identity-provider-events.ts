import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "@matchday/identity";

const SIGNATURE_PATTERN = /^sha256=([A-Za-z0-9_-]{43})$/;
const SAFE_IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const MAX_EVENT_AGE_MS = 5 * 60 * 1_000;

export type IdentityProviderRevocationEvent = {
  eventId: string;
  type: "password_changed" | "session_revoked";
  issuer: string;
  subject: string | null;
  providerSessionId: string | null;
  occurredAt: string;
};

function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function providerEventSigningInput(event: IdentityProviderRevocationEvent): string {
  return [
    "matchday-provider-event-v1",
    event.eventId,
    event.type,
    event.issuer,
    event.subject ?? "",
    event.providerSessionId ?? "",
    event.occurredAt,
  ]
    .map(field)
    .join("|");
}

function validIdentifier(value: string | null, maxLength: number): boolean {
  return value === null || (value.length > 0 && value.length <= maxLength && SAFE_IDENTIFIER_PATTERN.test(value));
}

export class IdentityProviderEventVerifier {
  readonly #clock: Clock;
  readonly #expectedIssuer: string;
  readonly #secret: Buffer;

  constructor(secret: string, expectedIssuer: string, clock: Clock) {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Identity provider event HMAC secret must be at least 32 bytes.");
    }
    this.#secret = Buffer.from(secret, "utf8");
    this.#expectedIssuer = expectedIssuer;
    this.#clock = clock;
  }

  verify(event: IdentityProviderRevocationEvent, suppliedSignature: string): Date {
    if (event.issuer !== this.#expectedIssuer) throw new Error("Provider event authentication failed.");
    const passwordChange = event.type === "password_changed" && event.subject && !event.providerSessionId;
    const sessionRevocation =
      event.type === "session_revoked" && Boolean(event.subject) !== Boolean(event.providerSessionId);
    if (
      (!passwordChange && !sessionRevocation) ||
      !validIdentifier(event.subject, 512) ||
      !validIdentifier(event.providerSessionId, 512)
    ) {
      throw new Error("Provider event authentication failed.");
    }
    const occurredAt = new Date(event.occurredAt);
    const age = Math.abs(this.#clock.now().getTime() - occurredAt.getTime());
    if (!Number.isFinite(occurredAt.getTime()) || age > MAX_EVENT_AGE_MS) {
      throw new Error("Provider event authentication failed.");
    }
    const match = SIGNATURE_PATTERN.exec(suppliedSignature);
    if (!match?.[1]) throw new Error("Provider event authentication failed.");
    const expected = createHmac("sha256", this.#secret).update(providerEventSigningInput(event), "utf8").digest();
    const actual = Buffer.from(match[1], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Provider event authentication failed.");
    }
    return occurredAt;
  }
}
