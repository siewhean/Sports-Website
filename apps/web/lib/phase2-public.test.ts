import { describe, expect, it } from "vitest";
import type { PublicCompetitionProjection } from "@matchday/contracts";
import { isPublicCompetitionProjection, publicSportName, publicSportNames } from "./phase2-public";

function projection(sportCode: string): unknown {
  return {
    competition: { id: "competition", name: "Cup", slug: "cup", sport_code: sportCode },
    division: { id: "division" },
    publication: { schedule_version: 1, result_version: 0 },
    schedule: [],
    results: [],
    last_updated_at: "2027-01-01T00:00:00.000Z",
  };
}

describe("public competition sport projection", () => {
  it.each(Object.entries(publicSportNames))("parses and renders %s as %s", (sportCode, sportName) => {
    const value = projection(sportCode);
    expect(isPublicCompetitionProjection(value)).toBe(true);
    expect(publicSportName(sportCode as PublicCompetitionProjection["competition"]["sport_code"])).toBe(sportName);
  });

  it("rejects unsupported public sport codes", () => {
    expect(isPublicCompetitionProjection(projection("unsupported_sport"))).toBe(false);
  });
});
