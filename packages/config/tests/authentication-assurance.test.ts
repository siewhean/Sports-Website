import { describe, expect, it } from "vitest";
import { parseAuthenticationAssurancePolicy } from "../src/authentication-assurance.js";

describe("authentication assurance configuration", () => {
  it("defaults to disabled", () => {
    expect(parseAuthenticationAssurancePolicy(undefined, undefined)).toEqual({ minimum: "off" });
  });

  it.each(["off", "mfa", "phishing_resistant"])("accepts %s", (minimum) => {
    expect(parseAuthenticationAssurancePolicy(minimum, undefined)).toEqual({ minimum });
  });

  it("rejects an unknown policy", () => {
    expect(() => parseAuthenticationAssurancePolicy("anything", undefined)).toThrow(
      "Invalid authentication assurance policy",
    );
  });

  it("converts a configured freshness window to milliseconds", () => {
    expect(parseAuthenticationAssurancePolicy("mfa", "300")).toEqual({
      minimum: "mfa",
      maxAuthenticationAgeMs: 300_000,
    });
  });

  it("does not allow freshness to be silently configured while enforcement is off", () => {
    expect(() => parseAuthenticationAssurancePolicy("off", "300")).toThrow(
      "Authentication freshness requires an enabled policy",
    );
  });
});
