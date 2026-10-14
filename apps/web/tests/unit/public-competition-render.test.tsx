import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { CompetitionView, PublicDivisionView, StandingView } from "@/lib/phase2";
import { bracketModel } from "@/lib/public-competition-model";
import { PublicBracket } from "@/components/phase2/PublicBracket";
import { PublicCompetitionApp, TablePanel } from "@/components/phase2/PublicCompetitionApp";
import { PublicMatchLive } from "@/components/phase2/PublicMatchLive";

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

function standingRows(groups: readonly [string, string] | null): StandingView[] {
  const base = (position: number, team: string, points: number) => ({
    position,
    team,
    played: 1,
    won: points > 0 ? 1 : 0,
    drawn: 0,
    lost: points > 0 ? 0 : 1,
    difference: points > 0 ? 2 : -2,
    points,
  });
  if (!groups) return [base(1, "Alpha", 3), base(2, "Charlie", 3), base(3, "Bravo", 0), base(4, "Delta", 0)];
  const [first, second] = groups.map((id) => ({ id, label: `Group ${id}` })) as [
    { id: string; label: string },
    { id: string; label: string },
  ];
  return [
    { ...base(1, "Alpha", 3), group: first },
    { ...base(2, "Bravo", 0), group: first },
    { ...base(1, "Charlie", 3), group: second },
    { ...base(2, "Delta", 0), group: second },
  ];
}

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

  it("shows a W/O badge next to the walkover winner and the forfeit score in the match detail", () => {
    const walkover = {
      id: "m9",
      label: "Match 9",
      stage: "Group A",
      time: "08:00",
      area: "Court 1",
      home: "Alpha",
      away: "Bravo",
      status: "final",
      homeScore: 25,
      awayScore: 0,
      walkover: { winner: "away" },
      startsAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:05:00Z",
    } as const;
    const division = { ...open, matches: [...open.matches, walkover] } as unknown as PublicDivisionView;
    const withWalkover = {
      ...competition,
      publicDivisions: [division],
      matches: division.matches,
    } as CompetitionView;
    const html = renderToString(
      <PublicCompetitionApp competition={withWalkover} liveUpdates={false} renderedAt="2026-09-19T01:30:00Z" />,
    );
    expect(html).toContain("data-walkover");
    expect(html).toContain(">W/O</abbr>");
    expect(html).toContain('title="Walkover"');
    expect(html).toContain("Bravo won by walkover");
    expect(html).not.toContain("Alpha won by walkover");

    const detail = renderToString(
      <PublicMatchLive competition={withWalkover} matchId="m9" liveUpdates={false} renderedAt="2026-09-19T01:30:00Z" />,
    );
    expect(detail).toContain("W/O (Forfeit score: 25–0)");
    expect(detail).toContain("Bravo won by walkover");
  });

  it("renders one standings table for a single-group division", () => {
    const division = { ...open, standings: standingRows(null) } as unknown as PublicDivisionView;
    const html = renderToString(<TablePanel competition={competition} division={division} followed={null} />);
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).not.toContain("data-standings-group");
  });

  it("renders one captioned table per group when the division has several groups", () => {
    const division = { ...open, standings: standingRows(["G1", "G2"]) } as unknown as PublicDivisionView;
    const html = renderToString(<TablePanel competition={competition} division={division} followed={null} />);
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html.match(/<caption/g)).toHaveLength(2);
    expect(html).toContain("Open · Group G1 standings");
    expect(html).toContain("Open · Group G2 standings");
    expect(html).toMatch(/<h3 id="standings-group-G1">Group G1<\/h3>/);
    expect(html).toMatch(/<h3 id="standings-group-G2">Group G2<\/h3>/);
    expect(html.indexOf("Bravo")).toBeLessThan(html.indexOf("Group G2</h3>"));
    expect(html.indexOf("Charlie")).toBeGreaterThan(html.indexOf("Group G2</h3>"));
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
