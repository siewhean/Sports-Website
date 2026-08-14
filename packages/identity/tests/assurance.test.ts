import { describe, expect, it } from "vitest";
import { authenticationAssuranceFromProvider, requireAuthenticationAssurance } from "../src/index.js";

const now = new Date("2026-08-14T00:00:00.000Z");

describe("authentication assurance", () => {
  it("treats absent evidence as single factor", () => {
    expect(authenticationAssuranceFromProvider(undefined)).toMatchObject({
      level: "single_factor",
      mfaPerformed: false,
      phishingResistant: false,
    });
  });

  it("does not treat generic MFA as phishing resistant", () => {
    expect(
      authenticationAssuranceFromProvider({
        methods: ["mfa"],
        acr: null,
        authenticatedAt: now,
        phishingResistant: false,
      }),
    ).toMatchObject({ level: "multi_factor", mfaPerformed: true, phishingResistant: false });
  });

  it("rejects malformed provider-neutral assurance before it can reach persistence", () => {
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: ["x".repeat(65)],
        acr: null,
        authenticatedAt: now,
        phishingResistant: false,
      }),
    ).toThrow();
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: ["mfa"],
        acr: "x".repeat(513),
        authenticatedAt: now,
        phishingResistant: false,
      }),
    ).toThrow();
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: ["mfa"],
        acr: null,
        authenticatedAt: new Date(Number.NaN),
        phishingResistant: false,
      }),
    ).toThrow();
  });

  it("rejects a phishing-resistant flag without standard MFA evidence", () => {
    expect(() =>
      authenticationAssuranceFromProvider({
        methods: ["pwd"],
        acr: null,
        authenticatedAt: now,
        phishingResistant: true,
      }),
    ).toThrow();
  });

  it("keeps policy off backward compatible", () => {
    expect(() =>
      requireAuthenticationAssurance(authenticationAssuranceFromProvider(undefined), { minimum: "off" }, now),
    ).not.toThrow();
  });

  it("checks configured freshness", () => {
    const assurance = authenticationAssuranceFromProvider({
      methods: ["mfa"],
      acr: null,
      authenticatedAt: new Date(now.getTime() - 60_000),
      phishingResistant: false,
    });
    expect(() =>
      requireAuthenticationAssurance(assurance, { minimum: "mfa", maxAuthenticationAgeMs: 120_000 }, now),
    ).not.toThrow();
    expect(() =>
      requireAuthenticationAssurance(assurance, { minimum: "mfa", maxAuthenticationAgeMs: 30_000 }, now),
    ).toThrow();
  });
});
