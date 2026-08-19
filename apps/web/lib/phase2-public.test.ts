import { describe, expect, it } from "vitest";
import type { PublicCompetitionProjection, PublicCompetitionSummary } from "@matchday/contracts";
import {
  isPublicCompetitionListing,
  isPublicCompetitionProjection,
  publicSportName,
  publicSportNames,
} from "./phase2-public";

function projection(sportCode: string): unknown {
  const division = {
    division: { id: "division", name: "Open" },
    schedule: [],
    results: [],
    standings: null,
    bracket: null,
  };
  return {
    competition: { id: "competition", name: "Cup", slug: "cup", sport_code: sportCode },
    divisions: [division],
    division: division.division,
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

  it("rejects missing, empty, or malformed division packages", () => {
    const missing = projection("canoe_polo") as Record<string, unknown>;
    delete missing.divisions;
    expect(isPublicCompetitionProjection(missing)).toBe(false);

    const canonical = projection("canoe_polo") as Record<string, unknown>;
    expect(isPublicCompetitionProjection({ ...canonical, divisions: [] })).toBe(false);
    expect(
      isPublicCompetitionProjection({
        ...canonical,
        divisions: [{ division: { id: "division", name: "Open" }, schedule: [], results: [] }],
      }),
    ).toBe(false);
  });
});

function summary(overrides: Partial<PublicCompetitionSummary> = {}): PublicCompetitionSummary {
  return {
    id: "competition",
    name: "Cup",
    slug: "cup",
    sport_code: "canoe_polo",
    timezone: "Asia/Singapore",
    starts_on: "2027-01-01",
    ends_on: "2027-01-01",
    status: "active",
    ...overrides,
  };
}

describe("public competition listing", () => {
  it("accepts an empty listing", () => {
    expect(isPublicCompetitionListing({ competitions: [] })).toBe(true);
  });

  it("accepts a listing of well-formed summaries", () => {
    expect(isPublicCompetitionListing({ competitions: [summary(), summary({ id: "other", slug: "other" })] })).toBe(
      true,
    );
  });

  it("rejects a summary with an unsupported sport code", () => {
    expect(isPublicCompetitionListing({ competitions: [summary({ sport_code: "unsupported_sport" as never })] })).toBe(
      false,
    );
  });

  it("rejects a payload that is not a listing shape", () => {
    expect(isPublicCompetitionListing(null)).toBe(false);
    expect(isPublicCompetitionListing({})).toBe(false);
    expect(isPublicCompetitionListing({ competitions: "not-an-array" })).toBe(false);
    expect(isPublicCompetitionListing({ competitions: [{ id: "only-an-id" }] })).toBe(false);
  });
});
