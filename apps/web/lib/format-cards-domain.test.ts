import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { recommendCompetitionFormats } from "@matchday/domain";
import type { Phase4SetupDocument } from "@matchday/contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { V1FormatPicker } from "../components/phase4/format/V1FormatPicker";
import { detectFormatFamily, formatDescriptiveTitle, formatFitStatus, formatRecommendationRibbon } from "./format-copy";

const sports = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const;

function toSetupDocument(result: ReturnType<typeof recommendCompetitionFormats>): Phase4SetupDocument {
  return {
    competition_id: "comp-domain-test",
    values: {
      format_recommendations: {
        recommendations: result.recommendations.map((r, i) => ({
          id: `rec-${i}`,
          format_revision_id: null,
          format_definition_hash: "0".repeat(64),
          name: r.label,
          structure: `${r.divisions.length} divisions · ${r.strategy}`,
          advantage: r.advantage,
          match_count: r.matchCount,
          minimum_matches_per_entry: r.guaranteedMatches,
          guaranteed_matches: r.guaranteedMatches,
          ranking_coverage: r.rankingCoverage,
          available_match_slots: r.availableMatchSlots,
          division_formats: r.divisions.map((d, dIdx) => ({
            division_id: d.divisionId,
            candidate_division_id: `cdiv-${dIdx}`,
            format_revision_id: null,
            format_definition_hash: "1".repeat(64),
            match_count: d.matchCount,
            guaranteed_matches: d.guaranteedMatches,
            ranking_coverage: r.rankingCoverage,
          })),
          capacity_status: r.capacityStatus,
          scheduling_status: r.scheduleFeasibility,
          warning_codes: r.warningCodes,
        })),
        requires_changes: null,
        selected_recommendation_id: null,
        acknowledged_capacity_shortfall: false,
        recommendation_set_hash: "hash-domain",
      },
    },
  } as unknown as Phase4SetupDocument;
}

describe("Phase 5 format card metrics alignment with domain output", () => {
  it.each(sports)("renders cards whose numbers equal domain output across 12-entry fixture for %s", (sportCode) => {
    const result = recommendCompetitionFormats({
      sportCode,
      divisions: [{ id: "div-1", entryCount: 12 }],
      availableMatchSlots: 84,
    });

    expect(result.recommendations.length).toBeGreaterThanOrEqual(1);

    const setupDoc = toSetupDocument(result);
    const html = renderToString(
      React.createElement(V1FormatPicker, {
        competitionId: "comp-domain-test",
        isRedesignP5CardsEnabled: true,
        initialDocument: setupDoc,
        divisions: [{ id: "div-1", name: "Division 1", entryCount: 12 }],
        initialDivisionId: "div-1",
      }),
    );

    for (let i = 0; i < result.recommendations.length; i++) {
      const candidate = result.recommendations[i]!;
      const divisionFormat = candidate.divisions[0]!;
      const family = detectFormatFamily({
        strategy: candidate.strategy,
        name: candidate.label,
      });
      const fit = formatFitStatus({
        capacity_status: candidate.capacityStatus,
        scheduling_status: candidate.scheduleFeasibility,
        match_count: candidate.matchCount,
        available_match_slots: candidate.availableMatchSlots,
        advantage: candidate.advantage,
        warning_codes: candidate.warningCodes,
      });
      const ribbon = formatRecommendationRibbon(family, i + 1, fit.fits);
      const title = formatDescriptiveTitle(family, 12);

      // Verify rendered card numbers equal domain output
      expect(html).toContain(`<dd>${divisionFormat.matchCount}</dd>`);
      expect(html).toContain(`<dd>${divisionFormat.guaranteedMatches}</dd>`);
      expect(html).toContain(`<dd>${candidate.matchCount} / ${candidate.availableMatchSlots}</dd>`);
      expect(html).toContain(`<dd>${candidate.rankingCoverage === "all_entries" ? "Yes" : "No"}</dd>`);

      // Verify ribbon, title and fit badge rendered
      expect(html).toContain(ribbon.label);
      expect(html).toContain(title);
      expect(html).toContain(fit.badgeLabel);
    }
  });

  it("handles multi-division combined slots used accurately in rendered cards (e.g. Men 12 + Women 8)", () => {
    const result = recommendCompetitionFormats({
      sportCode: "canoe_polo",
      divisions: [
        { id: "div-men", entryCount: 12 },
        { id: "div-women", entryCount: 8 },
      ],
      availableMatchSlots: 84,
      priority: "participation",
    });

    const fullPlacement = result.recommendations.find((r) => r.strategy === "full_placement");
    expect(fullPlacement).toBeDefined();
    if (!fullPlacement) return;

    const menDiv = fullPlacement.divisions.find((d) => d.divisionId === "div-men")!;
    const womenDiv = fullPlacement.divisions.find((d) => d.divisionId === "div-women")!;

    expect(fullPlacement.matchCount).toBe(menDiv.matchCount + womenDiv.matchCount);
    expect(fullPlacement.guaranteedMatches).toBe(Math.min(menDiv.guaranteedMatches, womenDiv.guaranteedMatches));
    expect(fullPlacement.availableMatchSlots).toBe(84);

    const setupDoc = toSetupDocument(result);
    const divisions = [
      { id: "div-men", name: "Men’s Open", entryCount: 12 },
      { id: "div-women", name: "Women’s Open", entryCount: 8 },
    ];

    // Render with Men active
    const htmlMen = renderToString(
      React.createElement(V1FormatPicker, {
        competitionId: "comp-domain-test",
        isRedesignP5CardsEnabled: true,
        initialDocument: setupDoc,
        divisions,
        initialDivisionId: "div-men",
      }),
    );
    expect(htmlMen).toContain(`<dd>${menDiv.matchCount}</dd>`);
    expect(htmlMen).toContain(`<dd>${menDiv.guaranteedMatches}</dd>`);
    expect(htmlMen).toContain(`<dd>${fullPlacement.matchCount} / 84</dd>`);

    // Render with Women active
    const htmlWomen = renderToString(
      React.createElement(V1FormatPicker, {
        competitionId: "comp-domain-test",
        isRedesignP5CardsEnabled: true,
        initialDocument: setupDoc,
        divisions,
        initialDivisionId: "div-women",
      }),
    );
    expect(htmlWomen).toContain(`<dd>${womenDiv.matchCount}</dd>`);
    expect(htmlWomen).toContain(`<dd>${womenDiv.guaranteedMatches}</dd>`);
    expect(htmlWomen).toContain(`<dd>${fullPlacement.matchCount} / 84</dd>`);
  });
});
