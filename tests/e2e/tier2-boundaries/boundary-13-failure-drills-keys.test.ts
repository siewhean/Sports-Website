import { describe, it, expect } from "vitest";
import { parseScoringFallbackHmacKeyring, loadScoringFallbackHmacKeyring } from "@matchday/config";

describe("Tier 2 - Boundary 13: Failure Drill Injection & Keyring Limits", () => {
  it("B13-T01: scoring fallback keyring accepts up to 7 verificationOnly keys; rejects 8th key", () => {
    const validKey = { version: "v1", secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" };
    const verification7 = Array.from({ length: 7 }, (_, i) => ({
      version: `v_old_${i}`,
      secret: `${i}`.repeat(32) + "0123456789abcdef0123456789abcdef".slice(32),
    }));

    const validKeyring = { primary: validKey, verificationOnly: verification7 };
    expect(() => parseScoringFallbackHmacKeyring(validKeyring)).not.toThrow();

    const verification8 = Array.from({ length: 8 }, (_, i) => ({
      version: `v_old_${i}`,
      secret: `${i}`.repeat(32) + "0123456789abcdef0123456789abcdef".slice(32),
    }));

    const invalidKeyring = { primary: validKey, verificationOnly: verification8 };
    expect(() => parseScoringFallbackHmacKeyring(invalidKeyring)).toThrow();
  });

  it("B13-T02: scoring fallback key secret requires minimum 32 bytes (<32 bytes rejected)", () => {
    const shortSecret = "too_short_secret_under_32_bytes"; // 31 bytes
    expect(Buffer.byteLength(shortSecret, "utf8")).toBeLessThan(32);

    expect(() =>
      parseScoringFallbackHmacKeyring({
        primary: { version: "v1", secret: shortSecret },
        verificationOnly: [],
      }),
    ).toThrow();
  });

  it("B13-T03: loadScoringFallbackHmacKeyring rejects corrupted non-JSON environment variable", () => {
    expect(() =>
      loadScoringFallbackHmacKeyring("valid_legacy_secret_32_bytes_long_123456", "local", {
        SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: "{ broken json...",
      }),
    ).toThrow("SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING must be valid JSON");
  });

  it("B13-T04: keyring rejects duplicate versions or duplicate key material between primary and verification keys", () => {
    const sharedSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const duplicateSecretKeyring = {
      primary: { version: "v2", secret: sharedSecret },
      verificationOnly: [{ version: "v1", secret: sharedSecret }], // Duplicate secret material!
    };

    expect(() => parseScoringFallbackHmacKeyring(duplicateSecretKeyring)).toThrow(
      "Fallback-code HMAC key material must be unique",
    );
  });

  it("B13-T05: deployed rotating keyring in non-local environment rejects maintaining v1 as primary", () => {
    const rotatingV1Keyring = {
      primary: { version: "v1", secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      verificationOnly: [{ version: "v0", secret: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" }],
    };

    expect(() =>
      loadScoringFallbackHmacKeyring("fallback", "production", {
        SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify(rotatingV1Keyring),
      }),
    ).toThrow("A deployed rotating fallback-code keyring must use a new primary version instead of v1");
  });
});
