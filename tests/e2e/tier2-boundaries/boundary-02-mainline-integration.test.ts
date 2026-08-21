import { describe, it, expect } from "vitest";
import {
  authenticationAssuranceFromProvider,
  requireAuthenticationAssurance,
  type AuthenticationAssurancePolicy,
} from "@matchday/identity";

describe("Tier 2 - Boundary 02: Mainline Integration & Session Limits", () => {
  it("B02-T01: authenticationAssuranceFromProvider rejects more than 16 methods in evidence array", () => {
    const tooManyMethods = Array.from({ length: 17 }, (_, i) => `method_${i}`);
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: tooManyMethods,
        acr: null,
        authenticatedAt: new Date(),
        phishingResistant: false,
      }),
    ).toThrow("Authentication assurance evidence is invalid");
  });

  it("B02-T02: authenticationAssuranceFromProvider rejects control characters and non-printable bytes in method names", () => {
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: ["pwd\u0000injected"],
        acr: null,
        authenticatedAt: new Date(),
        phishingResistant: false,
      }),
    ).toThrow("Authentication assurance evidence is invalid");
  });

  it("B02-T03: authenticationAssuranceFromProvider rejects ACR string exceeding 512 characters", () => {
    const excessiveAcr = "https://schemas.matchday.com/" + "a".repeat(500);
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: ["pwd"],
        acr: excessiveAcr,
        authenticatedAt: new Date(),
        phishingResistant: false,
      }),
    ).toThrow("Authentication assurance evidence is invalid");
  });

  it("B02-T04: requireAuthenticationAssurance rejects negative maxAuthenticationAgeMs", () => {
    const now = new Date();
    const futureAuth = new Date(now.getTime() + 60_000); // 1 minute in the future
    const assurance = authenticationAssuranceFromProvider({
      methods: ["pwd", "mfa"],
      acr: null,
      authenticatedAt: futureAuth,
      phishingResistant: false,
    });
    const policy: AuthenticationAssurancePolicy = { minimum: "mfa", maxAuthenticationAgeMs: 300_000 };

    expect(() => requireAuthenticationAssurance(assurance, policy, now)).toThrow("Recent authentication is required");
  });

  it("B02-T05: authenticationAssuranceFromProvider rejects phishingResistant=true without mfa in normalized methods", () => {
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: ["pwd"], // Missing "mfa" method
        acr: null,
        authenticatedAt: new Date(),
        phishingResistant: true,
      }),
    ).toThrow("Authentication assurance evidence is inconsistent");
  });
});
