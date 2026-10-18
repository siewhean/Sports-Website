import { describe, expect, it } from "vitest";
import { recommendCompetitionFormats } from "@matchday/domain";
import { detectFormatFamily, formatDescriptiveTitle, formatFitStatus, formatRecommendationRibbon } from "./format-copy";

const sports = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const;

describe("Phase 5 format card metrics alignment with domain output", () => {
  it.each(sports)("matches domain metrics across 12-entry fixture for %s", (sportCode) => {
    const result = recommendCompetitionFormats({
      sportCode,
      divisions: [{ id: "div-1", entryCount: 12 }],
      availableMatchSlots: 84,
    });

    expect(result.recommendations.length).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < result.recommendations.length; i++) {
      const candidate = result.recommendations[i]!;
      const family = detectFormatFamily({
        strategy: candidate.strategy,
        name: candidate.label,
      });
      const ribbon = formatRecommendationRibbon(family, i + 1);
      const title = formatDescriptiveTitle(family, 12);
      const fit = formatFitStatus({
        capacity_status: candidate.capacityStatus,
        scheduling_status: candidate.scheduleFeasibility,
        match_count: candidate.matchCount,
        available_match_slots: candidate.availableMatchSlots,
        advantage: candidate.advantage,
        warning_codes: candidate.warningCodes,
      });

      // 1. Matches
      expect(candidate.matchCount).toBeGreaterThan(0);
      expect(candidate.divisions[0]!.matchCount).toBe(candidate.matchCount);

      // 2. Fewest games for a team
      expect(candidate.guaranteedMatches).toBeGreaterThan(0);
      expect(candidate.divisions[0]!.guaranteedMatches).toBe(candidate.guaranteedMatches);

      // 3. Slots used vs available
      expect(candidate.availableMatchSlots).toBe(84);
      expect(candidate.spareMatchSlots).toBe(84 - candidate.matchCount);

      // 4. Ranking coverage
      const rankedAll = candidate.rankingCoverage === "all_entries";
      if (candidate.strategy === "full_placement" || candidate.strategy === "round_robin") {
        expect(rankedAll).toBe(true);
      }

      // 5. Fits venue time
      expect(fit.fits).toBe(true);
      expect(fit.badgeLabel).toBe("Fits the venue time");
      expect(ribbon.label.length).toBeGreaterThan(0);
      expect(title.length).toBeGreaterThan(0);
    }
  });

  it("handles multi-division combined slots used accurately (e.g. Men 12 + Women 8)", () => {
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
  });
});
