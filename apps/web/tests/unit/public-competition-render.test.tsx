import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { CompetitionView, PublicDivisionView } from "@/lib/phase2";
import { bracketModel } from "@/lib/public-competition-model";
import { PublicBracket } from "@/components/phase2/PublicBracket";
import { PublicCompetitionApp } from "@/components/phase2/PublicCompetitionApp";

const open = {
  division: { id: "open", name: "Open", teamCount: 4, matchCount: 3 },
  teams: ["Alpha", "Bravo", "Charlie", "Delta"],
  areas: ["Court 1", "Court 2"],
  matches: [
    {
      id: "m1",
      label: "Match 1",
      stage: "Group A",
      time: "09:00",
      area: "Court 1",
      home: "Alpha",
      away: "Bravo",
      status: "live",
      homeScore: 1,
      awayScore: 0,
      currentSegment: 2,
      segments: [
        { number: 1, home: 25, away: 20 },
        { number: 2, home: 10, away: 12 },
      ],
      startsAt: "2026-09-19T01:00:00Z",
    },
    {
      id: "m2",
      label: "Match 2",
      stage: "Group A",
      time: "09:00",
      area: "Court 2",
      home: "Charlie",
      away: "Delta",
      status: "live",
      homeScore: 0,
      awayScore: 0,
      startsAt: "2026-09-19T01:00:00Z",
    },
    {
      id: "m3",
      label: "Match 3",
      stage: "Final",
      time: "10:00",
      area: "Court 1",
      home: "TBD",
      away: "TBD",
      status: "scheduled",
      startsAt: "2026-09-20T02:00:00Z",
    },
  ],
  standings: [],
  bracket: [
    { id: "m1", round: "Group A · Round 1", fixture: "Alpha · Bravo", score: "1–0", state: "Final" },
    { id: "m3", round: "Final", fixture: "TBD · TBD", score: "–", state: "TBD" },
  ],
} as unknown as PublicDivisionView;

const competition = {
  id: "c1",
  slug: "open-2026",
  name: "Open 2026",
  sportCode: "volleyball",
  sport: "Volleyball",
  venue: "Hall",
  timezone: "Asia/Singapore",
  dateLabel: "19–20 September 2026",
  status: "live",
  startsOn: "2026-09-19",
  endsOn: "2026-09-20",
  publicationRevision: "r1",
  publishedAt: "2026-09-18T00:00:00Z",
  lastUpdated: "19 Sep 09:10",
  division: open.division,
  publicDivisions: [open],
  teams: open.teams,
  areas: open.areas,
  matches: open.matches,
  standings: [],
  bracket: open.bracket,
  audit: [],
} as unknown as CompetitionView;

describe("spectator page render", () => {
  it("renders tabs, every live match once, and no duplicate match lists", () => {
    const html = renderToString(
      <PublicCompetitionApp competition={competition} liveUpdates={false} renderedAt="2026-09-19T01:30:00Z" />,
    );
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Live now");
    expect(html.match(/data-match-id="m1"/g)).toHaveLength(1);
    expect(html.match(/data-match-id="m2"/g)).toHaveLength(1);
    expect(html).toContain("Set 2");
    expect(html).toContain("25–20 · 10–12");
    expect(html).toContain('aria-live="polite"');
  });

  it("drops LIVE badges once the competition is completed", () => {
    const html = renderToString(
      <PublicCompetitionApp
        competition={{ ...competition, status: "completed" } as CompetitionView}
        liveUpdates
        renderedAt="2026-09-25T01:30:00Z"
      />,
    );
    expect(html).not.toContain("Live now");
    expect(html).not.toContain('data-tone="live"');
    expect(html).toContain("Updated 19 Sep 09:10");
  });

  it("renders the knockout bracket as nested lists without group rows", () => {
    const html = renderToString(
      <PublicBracket model={bracketModel(open.bracket)} division={open} slug="open-2026" followed={null} />,
    );
    expect(html).toContain("<ol");
    expect(html).toContain("Final");
    expect(html).not.toContain("Group A");
    expect(html).toContain("To be decided");
    expect(html).toContain('href="/competitions/open-2026/matches/m3"');
  });
});
