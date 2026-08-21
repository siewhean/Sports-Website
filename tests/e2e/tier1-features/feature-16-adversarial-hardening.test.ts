import { describe, it, expect } from "vitest";
import { assertOfflineMatchAuthorization } from "@matchday/domain";
import { parseScoringFallbackHmacKeyring } from "@matchday/config";
import { createValidOfflineAuthorization } from "../helpers/fixtures";

describe("Tier 1 - Feature 16: Adversarial Coverage Hardening (Tier 5)", () => {
  it("F16-T01: domain parser rejects malicious SQL injection payloads in UUID fields", () => {
    const maliciousAuth = createValidOfflineAuthorization({
      authorization_id: "11111111-1111-4111-8111-111111111111'; DROP TABLE matches; --",
    });
    expect(() => assertOfflineMatchAuthorization(maliciousAuth)).toThrow(
      "Offline authorization identity, generation, or sequence is invalid",
    );
  });

  it("F16-T02: fallback keyring parser rejects prototype pollution payload in JSON keyring", () => {
    const pollutionPayload = JSON.parse(
      '{"__proto__": {"polluted": true}, "primary": {"version": "v1", "secret": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}',
    );
    const parsed = parseScoringFallbackHmacKeyring(pollutionPayload);
    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(parsed.primary.version).toBe("v1");
  });

  it("F16-T03: offline authorization rejects non-hex or malformed principal IDs", () => {
    const invalidAuth = createValidOfflineAuthorization({
      principal_id: "not-a-valid-64-char-hex-principal-id",
    });
    expect(() => assertOfflineMatchAuthorization(invalidAuth)).toThrow(
      "Offline authorization identity, generation, or sequence is invalid",
    );
  });

  it("F16-T04: domain validator rejects out-of-order sequence values in offline authorization", () => {
    const invalidAuth = createValidOfflineAuthorization({
      last_acknowledged_sequence: 10,
      last_acknowledged_aggregate_version: 5, // Aggregate version < sequence is invalid!
    });
    expect(() => assertOfflineMatchAuthorization(invalidAuth)).toThrow(
      "Offline authorization identity, generation, or sequence is invalid",
    );
  });

  it("F16-T05: domain validator rejects non-integer writer generations", () => {
    const invalidAuth = createValidOfflineAuthorization({
      writer_generation: 1.5,
    });
    expect(() => assertOfflineMatchAuthorization(invalidAuth)).toThrow(
      "Offline authorization identity, generation, or sequence is invalid",
    );
  });
});
