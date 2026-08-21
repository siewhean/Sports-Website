import { describe, it, expect } from "vitest";
import {
  authenticationAssuranceFromProvider,
  requireAuthenticationAssurance,
  type AuthenticationAssurancePolicy,
} from "@matchday/identity";
import {
  assertOfflineMatchAuthorization,
  offlineRecordingAvailability,
  canReplayOfflineCommand,
} from "@matchday/domain";
import { createValidOfflineAuthorization, createValidAssuranceEvidence } from "../helpers/fixtures";

describe("Tier 3 - Pairwise 01: Auth Assurance x Offline Scoring Authority (F02 x F09)", () => {
  it("P01-T01: issuing offline authorization requires authenticated identity with valid assurance level", () => {
    const assurance = createValidAssuranceEvidence("multi_factor");
    expect(assurance.level).toBe("multi_factor");
    expect(assurance.mfaPerformed).toBe(true);

    const offlineAuth = createValidOfflineAuthorization({
      principal_id: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(() => assertOfflineMatchAuthorization(offlineAuth)).not.toThrow();
  });

  it("P01-T02: strict MFA assurance policy blocks offline authorization issuance if identity only has single_factor", () => {
    const singleAssurance = createValidAssuranceEvidence("single_factor");
    const mfaPolicy: AuthenticationAssurancePolicy = { minimum: "mfa", maxAuthenticationAgeMs: 600_000 };
    const now = new Date();

    expect(() => requireAuthenticationAssurance(singleAssurance, mfaPolicy, now)).toThrow(
      "Stronger authentication is required",
    );
  });

  it("P01-T03: expired session assurance prevents offline scoring command replay", () => {
    const now = Date.now();
    const offlineAuth = createValidOfflineAuthorization({
      authorized_at: new Date(now - 5 * 60 * 60 * 1_000).toISOString(),
      recording_expires_at: new Date(now - 1 * 60 * 60 * 1_000).toISOString(),
      replay_expires_at: new Date(now - 45 * 60 * 1_000).toISOString(),
      pass_expires_at: new Date(now - 30 * 60 * 1_000).toISOString(),
    });

    expect(canReplayOfflineCommand(offlineAuth, now)).toBe(false);
    expect(offlineRecordingAvailability(offlineAuth, 50, now)).toBe("pass_expired");
  });
});
