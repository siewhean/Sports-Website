import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { DoubleEliminationBracket } from "@/components/phase2/DoubleEliminationBracket";

describe("DoubleEliminationBracket component", () => {
  it("renders upper bracket, lower bracket, and grand finals sections correctly", () => {
    const matches = [
      {
        id: "m-upper-1",
        round: "Upper Round 1",
        fixture: "Team A · Team B",
        score: "21–18",
        state: "Final",
        stageKind: "upper" as const,
      },
      {
        id: "m-lower-1",
        round: "Lower Round 1",
        fixture: "Team B · Team C",
        score: "21–19",
        state: "Final",
        stageKind: "lower" as const,
      },
      {
        id: "m-grand-final-1",
        round: "Grand Final 1",
        fixture: "Team A · Team B",
        score: "18–21",
        state: "Final",
        stageKind: "grand_final" as const,
      },
      {
        id: "m-grand-final-reset",
        round: "Grand Final Reset",
        fixture: "Team A · Team B",
        score: "21–17",
        state: "Final",
        stageKind: "reset_final" as const,
      },
    ];

    const html = renderToString(
      React.createElement(DoubleEliminationBracket, {
        matches,
        divisionName: "Open Division",
      }),
    );

    expect(html).toContain("Upper Bracket");
    expect(html).toContain("Lower Bracket");
    expect(html).toContain("Grand Finals");
    expect(html).toContain("Upper Round 1");
    expect(html).toContain("Lower Round 1");
    expect(html).toContain("Grand Final 1");
    expect(html).toContain("Grand Final Reset");
    expect(html).toContain("Team A · Team B");
    expect(html).toContain("21–18");
  });
});
