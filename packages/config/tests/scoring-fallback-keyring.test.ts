import { describe, expect, it } from "vitest";
import { loadScoringFallbackHmacKeyring } from "../src/scoring-fallback-keyring.js";

const legacy = "legacy-fallback-code-key-material-32-bytes-minimum";
const previous = "previous-fallback-code-key-material-32-bytes-minimum";
const current = "current-fallback-code-key-material-32-bytes-minimum";

describe("scoring fallback-code HMAC keyring", () => {
  it("preserves an unconfigured deployment as a single v1 primary", () => {
    expect(loadScoringFallbackHmacKeyring(legacy, "production", {})).toEqual({
      primary: { version: "v1", secret: legacy },
      verificationOnly: [],
    });
  });

  it("loads a new primary with the prior key retained for overlap verification", () => {
    const keyring = loadScoringFallbackHmacKeyring(legacy, "production", {
      SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify({
        primary: { version: "v2", secret: current },
        verificationOnly: [{ version: "v1", secret: previous }],
      }),
    });
    expect(keyring.primary.version).toBe("v2");
    expect(keyring.verificationOnly.map((key) => key.version)).toEqual(["v1"]);
  });

  it("rejects duplicate versions and duplicate key material", () => {
    expect(() =>
      loadScoringFallbackHmacKeyring(legacy, "production", {
        SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify({
          primary: { version: "v2", secret: current },
          verificationOnly: [{ version: "v2", secret: previous }],
        }),
      }),
    ).toThrow(/unique verification-only keys/i);
    expect(() =>
      loadScoringFallbackHmacKeyring(legacy, "production", {
        SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify({
          primary: { version: "v2", secret: current },
          verificationOnly: [{ version: "v1", secret: current }],
        }),
      }),
    ).toThrow(/unique verification-only keys/i);
  });

  it("rejects a deployed overlap that still names the primary v1", () => {
    expect(() =>
      loadScoringFallbackHmacKeyring(legacy, "staging", {
        SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify({
          primary: { version: "v1", secret: current },
          verificationOnly: [{ version: "legacy", secret: previous }],
        }),
      }),
    ).toThrow(/new primary version instead of v1/i);
  });
});
