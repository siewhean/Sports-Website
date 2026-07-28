import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicCompetitionProjection, PublicDivisionProjection } from "@matchday/contracts";
import { PublicCompetition } from "@/components/phase2/PublicCompetition";
import { toCompetitionView } from "./phase2-public.server";

function division(id: string, name: string, team: string, matchId: string, startsAt: string): PublicDivisionProjection {
  return {
    division: { id, name },
    schedule: [
      {
        id: matchId,
        code: `${name}-1`,
        stage: "group",
        home: { id: `${id}-home`, name: `${team} Home` },
        away: { id: `${id}-away`, name: `${team} Away` },
        starts_at: startsAt,
        ends_at: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
        area: { id: `${id}-area`, name: `${name} Court` },
      },
    ],
    results: [],
    standings: {
      standings: [
        {
          rank: 1,
          entryName: `${team} Home`,
          played: 1,
          won: 1,
          drawn: 0,
          lost: 0,
          goalDifference: 1,
          points: 3,
        },
      ],
    },
    bracket: { bracket: { matches: [{ matchId, stage: "final" }] }, conflicts: [] },
  };
}

describe("public competition server adapter", () => {
  it("keeps every division package isolated while retaining the first-package compatibility view", () => {
    const open = division("open", "Open", "Open Team", "open-match", "2027-01-01T01:00:00.000Z");
    const women = division("women", "Women", "Women Team", "women-match", "2027-01-01T02:00:00.000Z");
    const projection: PublicCompetitionProjection = {
      competition: {
        id: "competition",
        name: "Cup",
        slug: "cup",
        sport_code: "canoe_polo",
        timezone: "Asia/Singapore",
        starts_on: "2027-01-01",
        ends_on: "2027-01-01",
        status: "active",
      },
      divisions: [open, women],
      division: open.division,
      publication: { schedule_version: 1, result_version: 2 },
      schedule: open.schedule,
      results: open.results,
      standings: open.standings,
      bracket: open.bracket,
      last_updated_at: "2027-01-01T00:00:00.000Z",
    };

    const view = toCompetitionView(projection);

    expect(view.division.id).toBe("open");
    expect(view.matches.map((match) => match.id)).toEqual(["open-match"]);
    expect(view.publicDivisions).toHaveLength(2);
    expect(view.publicDivisions?.[0]).toMatchObject({
      division: { id: "open" },
      teams: ["Open Team Home", "Open Team Away"],
      matches: [{ id: "open-match" }],
      standings: [{ team: "Open Team Home" }],
    });
    expect(view.publicDivisions?.[1]).toMatchObject({
      division: { id: "women" },
      teams: ["Women Team Home", "Women Team Away"],
      matches: [{ id: "women-match" }],
      standings: [{ team: "Women Team Home" }],
    });
    expect(JSON.stringify(view.publicDivisions?.[0])).not.toContain("Women Team");
    expect(JSON.stringify(view.publicDivisions?.[1])).not.toContain("Open Team");

    const markup = renderToStaticMarkup(createElement(PublicCompetition, { competition: view }));
    expect(markup).toContain('id="results-open"');
    expect(markup).toContain('id="results-women"');
    expect(markup).toContain('id="table-open"');
    expect(markup).toContain('id="table-women"');
    expect(markup).toContain('aria-labelledby="public-result-title-open"');
    expect(markup).toContain('aria-labelledby="public-result-title-women"');
    expect(markup).toContain('data-division-id="open"');
    expect(markup).toContain('data-division-id="women"');
    const ids = [...markup.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
