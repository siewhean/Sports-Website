import type { Phase4SetupDocument, Phase4SetupRecommendation } from "@matchday/contracts";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecommendationStep } from "../../components/phase4/setup/AssistedSetupJourneyView";

function recommendation(overrides: Partial<Phase4SetupRecommendation>): Phase4SetupRecommendation {
  return {
    id: "rec-1",
    format_revision_id: null,
    format_definition_hash: "a".repeat(64),
    name: "Compact knockout",
    structure: "1 division · compact knockout",
    advantage: "Uses the fewest match slots.",
    match_count: 7,
    minimum_matches_per_entry: 1,
    guaranteed_matches: 1,
    ranking_coverage: "champion",
    available_match_slots: 12,
    division_formats: [],
    capacity_status: "fits",
    scheduling_status: "feasible",
    warning_codes: [],
    ...overrides,
  };
}

function render(recommendations: Phase4SetupRecommendation[], requiresChanges: Phase4SetupRecommendation | null) {
  const setup = {
    competition_id: "10000000-0000-4000-8000-000000000001",
    values: {
      format_recommendations: {
        recommendations,
        requires_changes: requiresChanges,
        selected_recommendation_id: null,
        acknowledged_capacity_shortfall: false,
        recommendation_set_hash: "b".repeat(64),
      },
    },
  } as unknown as Phase4SetupDocument;
  return renderToString(<RecommendationStep setup={setup} disabled={false} onSelect={() => undefined} />);
}

describe("format suggestion capacity badge (ADR 0008 §3)", () => {
  it("shows slots required vs available on an over-capacity format instead of hiding it", () => {
    const html = render(
      [recommendation({})],
      recommendation({
        id: "rec-2",
        name: "Full placement",
        match_count: 20,
        available_match_slots: 12,
        capacity_status: "requires_changes",
        scheduling_status: "infeasible",
        warning_codes: ["CAPACITY_SHORTFALL"],
      }),
    );
    expect(html).toContain("Full placement");
    expect(html).toContain("Requires more courts or extended hours (20 slots required vs 12 slots available)");
    expect(html.match(/data-capacity-badge/g)).toHaveLength(1);
  });

  it("shows no badge when every format fits", () => {
    expect(render([recommendation({})], null)).not.toContain("data-capacity-badge");
  });
});
