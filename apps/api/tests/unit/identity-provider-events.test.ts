import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IdentityProviderEventVerifier,
  providerEventSigningInput,
  type IdentityProviderRevocationEvent,
} from "../../src/identity-provider-events.js";

const secret = "provider-event-unit-secret-at-least-32-bytes";
const now = new Date("2026-07-17T10:00:00.000Z");

function event(overrides: Partial<IdentityProviderRevocationEvent> = {}): IdentityProviderRevocationEvent {
  return {
    eventId: randomUUID(),
    type: "password_changed",
    issuer: "https://identity.matchday.test",
    subject: "provider-subject",
    providerSessionId: null,
    occurredAt: now.toISOString(),
    ...overrides,
  };
}

function signature(value: IdentityProviderRevocationEvent): string {
  return `sha256=${createHmac("sha256", secret).update(providerEventSigningInput(value)).digest("base64url")}`;
}

describe("IdentityProviderEventVerifier", () => {
  it("authenticates an issuer-bound, fresh canonical event without serializing its secret", () => {
    const verifier = new IdentityProviderEventVerifier(secret, "https://identity.matchday.test", { now: () => now });
    const value = event();
    expect(verifier.verify(value, signature(value))).toEqual(now);
    expect(JSON.stringify(verifier)).not.toContain(secret);
  });

  it("rejects tampering, a different issuer, stale events, and ambiguous revocation targets", () => {
    const verifier = new IdentityProviderEventVerifier(secret, "https://identity.matchday.test", { now: () => now });
    const value = event();
    expect(() => verifier.verify({ ...value, subject: "tampered" }, signature(value))).toThrow("authentication failed");
    expect(() => verifier.verify(event({ issuer: "https://attacker.test" }), signature(event()))).toThrow(
      "authentication failed",
    );
    const stale = event({ occurredAt: new Date(now.getTime() - 5 * 60 * 1_000 - 1).toISOString() });
    expect(() => verifier.verify(stale, signature(stale))).toThrow("authentication failed");
    const ambiguous = event({ type: "session_revoked", providerSessionId: "provider-session" });
    expect(() => verifier.verify(ambiguous, signature(ambiguous))).toThrow("authentication failed");
  });
});
