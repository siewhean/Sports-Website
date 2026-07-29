import { describe, expect, it } from "vitest";
import { readScoringPrincipalCookie } from "./offline-scoring-principal";

describe("offline scoring principal marker", () => {
  it("accepts only the exact opaque principal marker", () => {
    const principal = "a".repeat(64);
    expect(readScoringPrincipalCookie(`other=1; matchday_scoring_principal=${principal}`)).toBe(principal);
    expect(readScoringPrincipalCookie("matchday_scoring_principal=old-principal")).toBeNull();
    expect(readScoringPrincipalCookie("other=1")).toBeNull();
  });
});
