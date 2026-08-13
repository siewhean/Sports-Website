import { describe, expect, it } from "vitest";
import { IdentityError } from "@matchday/identity";
import { readOidcAssurance } from "../../src/oidc-assurance.js";

const claim = "https://matchday.example/claims/phishing-resistant";
const now = new Date("2026-08-14T00:00:00.000Z");

describe("OIDC assurance claims", () => {
  it("keeps generic MFA distinct from phishing-resistant authentication", () => {
    expect(readOidcAssurance({ amr: ["pwd", "mfa"] }, claim, now)).toMatchObject({
      methods: ["pwd", "mfa"],
      phishingResistant: false,
    });
  });

  it("accepts the configured strong factor signal only together with MFA", () => {
    expect(readOidcAssurance({ amr: ["mfa"], [claim]: true }, claim, now).phishingResistant).toBe(true);
    expect(() => readOidcAssurance({ amr: ["pwd"], [claim]: true }, claim, now)).toThrow(IdentityError);
  });

  it.each([
    { amr: "mfa" },
    { amr: [1] },
    { acr: 42 },
    { auth_time: "now" },
    { [claim]: "true" },
  ])("rejects malformed assurance evidence %#", (claims) => {
    expect(() => readOidcAssurance(claims, claim, now)).toThrow(IdentityError);
  });

  it("normalizes auth_time from the verified ID token", () => {
    const authenticatedAt = new Date(now.getTime() - 60_000);
    const result = readOidcAssurance({ amr: ["mfa"], auth_time: authenticatedAt.getTime() / 1_000 }, claim, now);
    expect(result.authenticatedAt?.toISOString()).toBe(authenticatedAt.toISOString());
  });

  it("rejects implausibly future authentication times", () => {
    expect(() => readOidcAssurance({ auth_time: now.getTime() / 1_000 + 601 }, claim, now)).toThrow(IdentityError);
  });
});
