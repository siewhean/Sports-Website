import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { parseScoringFallbackHmacKeyring } from "@matchday/config";
import { createValidFallbackKeyring } from "../helpers/fixtures";

describe("Tier 3 - Pairwise 04: HMAC Key Rotation x Offline Access Passes (F13 x F09)", () => {
  const keyring = parseScoringFallbackHmacKeyring(createValidFallbackKeyring());

  function generatePassSignature(passId: string, secret: string): string {
    return createHmac("sha256", secret).update(passId).digest("hex");
  }

  function verifyPassSignature(passId: string, signature: string, ring: typeof keyring): boolean {
    // 1. Try primary key
    const primarySig = generatePassSignature(passId, ring.primary.secret);
    if (primarySig === signature) return true;

    // 2. Try verificationOnly keys
    for (const key of ring.verificationOnly) {
      const vSig = generatePassSignature(passId, key.secret);
      if (vSig === signature) return true;
    }

    return false;
  }

  it("P04-T01: access pass signed with current primary key is verified successfully", () => {
    const passId = "pass-12345-primary";
    const sig = generatePassSignature(passId, keyring.primary.secret);

    expect(verifyPassSignature(passId, sig, keyring)).toBe(true);
  });

  it("P04-T02: access pass signed with previous legacy key (in verificationOnly) is verified successfully", () => {
    const passId = "pass-67890-legacy";
    const legacyKey = keyring.verificationOnly[0]!;
    const sig = generatePassSignature(passId, legacyKey.secret);

    expect(verifyPassSignature(passId, sig, keyring)).toBe(true);
  });

  it("P04-T03: access pass signed with completely unknown or retired key is rejected", () => {
    const passId = "pass-99999-unknown";
    const unknownSecret = "9999999999999999999999999999999999999999999999999999999999999999";
    const sig = generatePassSignature(passId, unknownSecret);

    expect(verifyPassSignature(passId, sig, keyring)).toBe(false);
  });
});
