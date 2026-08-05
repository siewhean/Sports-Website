import { afterEach, describe, expect, it, vi } from "vitest";
import { readScoringPrincipalCookie, retainScoringPrincipalCookie } from "./offline-scoring-principal";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offline scoring principal marker", () => {
  it("accepts only the exact opaque principal marker", () => {
    const principal = "a".repeat(64);
    expect(readScoringPrincipalCookie(`other=1; matchday_scoring_principal=${principal}`)).toBe(principal);
    expect(readScoringPrincipalCookie("matchday_scoring_principal=old-principal")).toBeNull();
    expect(readScoringPrincipalCookie("other=1")).toBeNull();
  });

  it("fails closed when the principal cookie contains malformed percent encoding", () => {
    expect(readScoringPrincipalCookie("matchday_scoring_principal=%E0%A4%A")).toBeNull();
    expect(readScoringPrincipalCookie("other=1; matchday_scoring_principal=%")).toBeNull();
  });

  it("retains the principal binding after authority expiry for terminal queue recovery", () => {
    const principal = "b".repeat(64);
    const documentStub = { cookie: "" };
    vi.stubGlobal("document", documentStub);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-29T00:00:00.000Z"));

    expect(() => retainScoringPrincipalCookie(principal, "2026-07-28T04:15:00.000Z")).not.toThrow();
    expect(documentStub.cookie).toContain(`matchday_scoring_principal=${principal}`);
    expect(documentStub.cookie).toContain("Expires=Thu, 02 Sep 2027 00:00:00 GMT");
  });
});
