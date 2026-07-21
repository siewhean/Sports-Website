import { describe, expect, it } from "vitest";
import { competitionIdFromFormatReferer } from "./phase4-template-context";

const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";

describe("Phase 4 format-template competition context", () => {
  it("accepts the exact same-origin format workspace", () => {
    expect(
      competitionIdFromFormatReferer(
        `https://app.matchday.test/organiser/competitions/${competitionId}/format`,
        "https://app.matchday.test",
      ),
    ).toBe(competitionId);
    expect(
      competitionIdFromFormatReferer(
        `https://app.matchday.test/organiser/competitions/${competitionId}/format?division=open`,
        "https://app.matchday.test",
      ),
    ).toBe(competitionId);
  });

  it("rejects cross-origin, malformed, and unrelated referers", () => {
    expect(
      competitionIdFromFormatReferer(
        `https://evil.test/organiser/competitions/${competitionId}/format`,
        "https://app.matchday.test",
      ),
    ).toBeNull();
    expect(
      competitionIdFromFormatReferer(
        "https://app.matchday.test/organiser/competitions/not-a-uuid/format",
        "https://app.matchday.test",
      ),
    ).toBeNull();
    expect(
      competitionIdFromFormatReferer(
        `https://app.matchday.test/organiser/competitions/${competitionId}/schedule`,
        "https://app.matchday.test",
      ),
    ).toBeNull();
    expect(competitionIdFromFormatReferer(null, "https://app.matchday.test")).toBeNull();
  });
});
