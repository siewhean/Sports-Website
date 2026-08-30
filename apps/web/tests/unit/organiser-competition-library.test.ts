import { describe, expect, it } from "vitest";
import {
  organiserCompetitionPhase,
  organiserCompetitionPrimaryAction,
  parseOrganiserCompetitionLibrary,
  type OrganiserCompetitionLibraryItem,
} from "@/lib/organiser-competition-library";

const raw = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  organisation_id: "22222222-2222-4222-8222-222222222222",
  organisation_name: "Harbour Sports Club",
  membership_role: "organiser",
  name: "Harbour Open",
  slug: "harbour-open",
  sport_code: "canoe_polo",
  status: "draft",
  starts_on: "2026-09-10",
  ends_on: "2026-09-11",
  timezone: "Asia/Singapore",
  updated_at: "2026-08-31T04:00:00.000Z",
  published: false,
  ...overrides,
});

function parsed(overrides: Record<string, unknown> = {}): OrganiserCompetitionLibraryItem {
  const value = parseOrganiserCompetitionLibrary([raw(overrides)]);
  expect(value).not.toBeNull();
  return value![0]!;
}

describe("organiser competition library", () => {
  it("parses the account-backed library response", () => {
    expect(parseOrganiserCompetitionLibrary([raw()])).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        organisationId: "22222222-2222-4222-8222-222222222222",
        organisationName: "Harbour Sports Club",
        membershipRole: "organiser",
        name: "Harbour Open",
        slug: "harbour-open",
        sportCode: "canoe_polo",
        status: "draft",
        startsOn: "2026-09-10",
        endsOn: "2026-09-11",
        timezone: "Asia/Singapore",
        updatedAt: "2026-08-31T04:00:00.000Z",
        published: false,
      },
    ]);
  });

  it("rejects malformed or duplicate competition records", () => {
    expect(parseOrganiserCompetitionLibrary([raw({ membership_role: "viewer" })])).toBeNull();
    expect(parseOrganiserCompetitionLibrary([raw(), raw()])).toBeNull();
  });

  it("classifies draft, upcoming, live and completed competitions using the competition timezone", () => {
    const now = new Date("2026-09-10T05:00:00.000Z");
    expect(organiserCompetitionPhase(parsed({ status: "draft" }), now)).toBe("draft");
    expect(organiserCompetitionPhase(parsed({ status: "active", starts_on: "2026-09-11" }), now)).toBe("upcoming");
    expect(
      organiserCompetitionPhase(parsed({ status: "active", starts_on: "2026-09-10", ends_on: "2026-09-10" }), now),
    ).toBe("live");
    expect(organiserCompetitionPhase(parsed({ status: "completed" }), now)).toBe("completed");
    expect(organiserCompetitionPhase(parsed({ status: "active", ends_on: "2026-09-09" }), now)).toBe("completed");
  });

  it("sends drafts back into setup and active competitions to their control room", () => {
    expect(organiserCompetitionPrimaryAction(parsed()).href).toBe(
      "/organiser/competitions/11111111-1111-4111-8111-111111111111/setup",
    );
    expect(organiserCompetitionPrimaryAction(parsed({ status: "active" })).href).toBe(
      "/organiser/competitions/11111111-1111-4111-8111-111111111111",
    );
  });
});
