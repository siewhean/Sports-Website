import { describe, expect, it } from "vitest";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { fittingV1Recommendations, v1FormatScreenState } from "./phase4-v1-format-picker";

function setupWithRecommendations(): Phase4SetupDocument {
  return {
    values: {
      format_recommendations: {
        recommendations: [
          {
            id: "fits",
            format_revision_id: null,
            format_definition_hash: "a".repeat(64),
            name: "Fits",
            structure: "Groups",
            advantage: "Fits capacity",
            match_count: 12,
            minimum_matches_per_entry: 2,
            guaranteed_matches: 2,
            ranking_coverage: "podium",
            available_match_slots: 12,
            division_formats: [
              {
                division_id: "division-a",
                candidate_division_id: "candidate-a",
                format_revision_id: null,
                format_definition_hash: "b".repeat(64),
                match_count: 12,
                guaranteed_matches: 2,
                ranking_coverage: "podium",
              },
            ],
            capacity_status: "tight",
            scheduling_status: "feasible",
            warning_codes: [],
          },
          {
            id: "over",
            format_revision_id: null,
            format_definition_hash: "c".repeat(64),
            name: "Over capacity",
            structure: "Round robin",
            advantage: "More matches",
            match_count: 13,
            minimum_matches_per_entry: 3,
            guaranteed_matches: 3,
            ranking_coverage: "all_entries",
            available_match_slots: 12,
            division_formats: [
              {
                division_id: "division-a",
                candidate_division_id: "candidate-b",
                format_revision_id: null,
                format_definition_hash: "d".repeat(64),
                match_count: 13,
                guaranteed_matches: 3,
                ranking_coverage: "all_entries",
              },
            ],
            capacity_status: "requires_changes",
            scheduling_status: "infeasible",
            warning_codes: ["CAPACITY_SHORTFALL"],
          },
        ],
        requires_changes: null,
        selected_recommendation_id: null,
        acknowledged_capacity_shortfall: false,
        recommendation_set_hash: "e".repeat(64),
      },
    },
  } as unknown as Phase4SetupDocument;
}

describe("V1 format picker", () => {
  it("shows only a schedulable capacity-fitting recommendation", () => {
    expect(fittingV1Recommendations(setupWithRecommendations()).map((candidate) => candidate.id)).toEqual(["fits"]);
  });

  it("keeps the graph editor behind an explicit advanced action", () => {
    expect(v1FormatScreenState(false, false)).toBe("picker");
    expect(v1FormatScreenState(false, true)).toBe("selected");
    expect(v1FormatScreenState(true, true)).toBe("advanced");
  });
});
