import { describe, expect, it } from "vitest";

import type { CompetitionView, MatchView } from "./phase2";
import { v1PublicationReadiness } from "./v1-publication-readiness";

function match(id: string, status: MatchView["status"]): MatchView {
  return {
    id,
    label: id,
    stage: "Final",
    time: "10:00",
    area: "Court 1",
    home: "Home",
    away: "Away",
    status,
  };
}

function competition(matches: MatchView[], publicationRevision = "Not published"): CompetitionView {
  return {
    id: "competition-1",
    slug: "test-open",
    name: "Test Open",
    sport: "Canoe Polo",
    venue: "Court 1",
    timezone: "Asia/Singapore",
    dateLabel: "15 August 2026",
    publicationRevision,
    publishedAt: "—",
    lastUpdated: "15 Aug, 14:00 SGT",
    division: { id: "division-1", name: "Open", teamCount: 8, matchCount: matches.length },
    teams: [],
    areas: ["Court 1"],
    matches,
    standings: [],
    bracket: [],
    audit: [],
  };
}

describe("v1PublicationReadiness", () => {
  it("keeps an unpublished competition blocked even when fixtures exist", () => {
    expect(v1PublicationReadiness(competition([match("m1", "scheduled"), match("m2", "scheduled")]))).toMatchObject({
      totalMatches: 2,
      finalMatches: 0,
      scheduledMatches: 2,
      schedulePublished: false,
      resultsPublished: false,
      tournamentComplete: false,
      publicAvailable: false,
    });
  });

  it("tracks live and completed match progress after schedule publication", () => {
    expect(
      v1PublicationReadiness(
        competition([match("m1", "final"), match("m2", "live"), match("m3", "scheduled")], "sch_2 · res_1"),
      ),
    ).toEqual({
      totalMatches: 3,
      finalMatches: 1,
      liveMatches: 1,
      scheduledMatches: 1,
      scheduleVersion: 2,
      resultVersion: 1,
      schedulePublished: true,
      resultsPublished: true,
      tournamentComplete: false,
      publicAvailable: true,
    });
  });

  it("marks tournament completion only when every materialised match is final", () => {
    expect(
      v1PublicationReadiness(competition([match("m1", "final"), match("m2", "final")], "sch_3 · res_2")),
    ).toMatchObject({
      finalMatches: 2,
      totalMatches: 2,
      tournamentComplete: true,
      schedulePublished: true,
      resultsPublished: true,
    });
  });

  it("fails closed when an unexpected publication revision label is supplied", () => {
    expect(v1PublicationReadiness(competition([], "published somehow"))).toMatchObject({
      scheduleVersion: 0,
      resultVersion: 0,
      schedulePublished: false,
      resultsPublished: false,
      tournamentComplete: false,
      publicAvailable: false,
    });
  });
});
