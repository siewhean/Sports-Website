import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authenticationAssuranceFromProvider,
  requireAuthenticationAssurance,
  type AuthenticationAssurancePolicy,
} from "@matchday/identity";
import { ErrorCode } from "@matchday/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 02: Mainline Integration Line Preservation", () => {
  it("F02-T01: V2 repository layer contains all required domain repositories", () => {
    const reposDir = path.join(rootDir, "apps/api/src/repositories");
    expect(existsSync(reposDir)).toBe(true);
    const files = readdirSync(reposDir);
    expect(files).toContain("competition.repository.ts");
    expect(files).toContain("division.repository.ts");
    expect(files).toContain("format.repository.ts");
    expect(files).toContain("identity.repository.ts");
    expect(files).toContain("organisation.repository.ts");
    expect(files).toContain("schedule.repository.ts");
    expect(files).toContain("scoring.repository.ts");
    expect(files).toContain("setup.repository.ts");
    expect(files).toContain("types.ts");
  });

  it("F02-T02: ErrorCode contract is strictly typed and exports canonical keys", () => {
    expect(ErrorCode.AUTHENTICATION_REQUIRED).toBe("AUTHENTICATION_REQUIRED");
    expect(ErrorCode.STEP_UP_REQUIRED).toBe("STEP_UP_REQUIRED");
    expect(ErrorCode.CSRF_INVALID).toBe("CSRF_INVALID");
    expect(ErrorCode.REPAIR_CASE_NOT_FOUND).toBe("REPAIR_CASE_NOT_FOUND");
    expect(ErrorCode.REPAIR_REVISION_IMMUTABLE).toBe("REPAIR_REVISION_IMMUTABLE");
  });

  it("F02-T03: identity assurance evaluates single_factor, multi_factor, and phishing_resistant tiers", () => {
    const single = authenticationAssuranceFromProvider({
      methods: ["pwd"],
      acr: null,
      authenticatedAt: new Date(),
      phishingResistant: false,
    });
    expect(single.level).toBe("single_factor");
    expect(single.mfaPerformed).toBe(false);

    const mfa = authenticationAssuranceFromProvider({
      methods: ["pwd", "mfa"],
      acr: "https://schemas.matchday.com/assurance/mfa",
      authenticatedAt: new Date(),
      phishingResistant: false,
    });
    expect(mfa.level).toBe("multi_factor");
    expect(mfa.mfaPerformed).toBe(true);

    const phishing = authenticationAssuranceFromProvider({
      methods: ["pwd", "mfa", "webauthn"],
      acr: "https://schemas.matchday.com/assurance/mfa-phishing-resistant",
      authenticatedAt: new Date(),
      phishingResistant: true,
    });
    expect(phishing.level).toBe("phishing_resistant");
    expect(phishing.phishingResistant).toBe(true);
  });

  it("F02-T04: requireAuthenticationAssurance enforces MFA and freshness policies correctly", () => {
    const now = new Date();
    const policyMfa: AuthenticationAssurancePolicy = { minimum: "mfa", maxAuthenticationAgeMs: 300_000 };

    const singleAssurance = authenticationAssuranceFromProvider({
      methods: ["pwd"],
      acr: null,
      authenticatedAt: now,
      phishingResistant: false,
    });

    expect(() => requireAuthenticationAssurance(singleAssurance, policyMfa, now)).toThrow(
      "Stronger authentication is required",
    );

    const mfaAssurance = authenticationAssuranceFromProvider({
      methods: ["pwd", "mfa"],
      acr: null,
      authenticatedAt: now,
      phishingResistant: false,
    });

    expect(() => requireAuthenticationAssurance(mfaAssurance, policyMfa, now)).not.toThrow();

    // Expired authentication age check
    const staleMfaAssurance = authenticationAssuranceFromProvider({
      methods: ["pwd", "mfa"],
      acr: null,
      authenticatedAt: new Date(now.getTime() - 400_000), // 400s > 300s max
      phishingResistant: false,
    });

    expect(() => requireAuthenticationAssurance(staleMfaAssurance, policyMfa, now)).toThrow(
      "Recent authentication is required",
    );
  });

  it("F02-T05: Scheduler unseeded schedule and graph shape migrations 0032-0034 exist in database migrations", () => {
    const migrationsDir = path.join(rootDir, "packages/database/migrations");
    const files = readdirSync(migrationsDir);
    expect(files.some((f) => f.startsWith("0032_v1_unseeded_schedule_source_mapping"))).toBe(true);
    expect(files.some((f) => f.startsWith("0033_v1_unseeded_schedule_graph_shape_fix"))).toBe(true);
    expect(files.some((f) => f.startsWith("0034_v1_materialize_direct_entry_sources"))).toBe(true);
    expect(files.some((f) => f.startsWith("0035_identity_authentication_assurance"))).toBe(true);
  });
});
