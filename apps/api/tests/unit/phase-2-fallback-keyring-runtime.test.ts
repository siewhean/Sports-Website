import { describe, expect, it } from "vitest";
import type { ScoringFallbackHmacKeyring } from "@matchday/config";
import {
  fallbackCodeCandidates,
  fallbackCodeHashHex,
  selectFallbackCodeKey,
} from "../../src/phase-2-fallback-keyring-runtime.js";

const keyring: ScoringFallbackHmacKeyring = {
  primary: { version: "v2", secret: "current-fallback-code-key-material-32-bytes-minimum" },
  verificationOnly: [{ version: "v1", secret: "previous-fallback-code-key-material-32-bytes-minimum" }],
};

describe("fallback-code HMAC overlap resolution", () => {
  it("derives distinct retained hashes for each configured key", () => {
    const candidates = fallbackCodeCandidates("123456789012", keyring);
    expect(candidates.map(({ key }) => key.version)).toEqual(["v2", "v1"]);
    expect(new Set(candidates.map(({ hashHex }) => hashHex)).size).toBe(2);
    expect(candidates[0]!.hashHex).toBe(fallbackCodeHashHex("123456789012", keyring.primary.secret));
  });

  it("selects a verification-only key when its retained hash matches", () => {
    const candidates = fallbackCodeCandidates("123456789012", keyring);
    expect(selectFallbackCodeKey(candidates, [candidates[1]!.hashHex], keyring.primary).version).toBe("v1");
  });

  it("uses the primary key for an unknown code so the ordinary invalid-attempt path runs once", () => {
    const candidates = fallbackCodeCandidates("123456789012", keyring);
    expect(selectFallbackCodeKey(candidates, [], keyring.primary)).toBe(keyring.primary);
  });

  it("fails closed if one plaintext code resolves to retained hashes under multiple versions", () => {
    const candidates = fallbackCodeCandidates("123456789012", keyring);
    expect(() =>
      selectFallbackCodeKey(candidates, [candidates[0]!.hashHex, candidates[1]!.hashHex], keyring.primary),
    ).toThrow(/ambiguous across configured HMAC key versions/i);
  });

  it("fails closed if the database reports a hash outside the configured keyring", () => {
    const candidates = fallbackCodeCandidates("123456789012", keyring);
    expect(() => selectFallbackCodeKey(candidates, ["0".repeat(64)], keyring.primary)).toThrow(
      /unknown retained hash/i,
    );
  });
});
