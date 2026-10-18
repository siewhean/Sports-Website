import type { Phase4SetupDocument, Phase4SetupRecommendation } from "@matchday/contracts";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { V1FormatPicker } from "../../components/phase4/format/V1FormatPicker";

function mockRecommendation(overrides: Partial<Phase4SetupRecommendation>): Phase4SetupRecommendation {
  return {
    id: "rec-1",
    format_revision_id: null,
    format_definition_hash: "a".repeat(64),
    name: "Full placement",
    structure: "2 divisions · full placement",
    advantage: "Ranks every entry.",
    match_count: 56,
    minimum_matches_per_entry: 6,
    guaranteed_matches: 6,
    ranking_coverage: "all_entries",
    available_match_slots: 84,
    division_formats: [
      {
        division_id: "div-men",
        candidate_division_id: "cdiv-1",
        format_revision_id: null,
        format_definition_hash: "b".repeat(64),
        match_count: 38,
        guaranteed_matches: 6,
        ranking_coverage: "all_entries",
      },
      {
        division_id: "div-women",
        candidate_division_id: "cdiv-2",
        format_revision_id: null,
        format_definition_hash: "c".repeat(64),
        match_count: 18,
        guaranteed_matches: 4,
        ranking_coverage: "all_entries",
      },
    ],
    capacity_status: "fits",
    scheduling_status: "feasible",
    warning_codes: [],
    ...overrides,
  };
}

describe("Phase 5 format recommendation cards rendering", () => {
  const divisions = [
    { id: "div-men", name: "Men’s Open", entryCount: 12 },
    { id: "div-women", name: "Women’s Open", entryCount: 8 },
  ];

  const recommendations = [
    mockRecommendation({
      id: "rec-1",
      name: "Full placement",
      match_count: 56,
      advantage: "Knockouts fit on Sunday’s two pitches.",
    }),
    mockRecommendation({
      id: "rec-2",
      name: "Championship focus",
      structure: "2 divisions · championship focus",
      match_count: 46,
      guaranteed_matches: 4,
      ranking_coverage: "champion",
      advantage: "Finishes Saturday by 15:30.",
      division_formats: [
        {
          division_id: "div-men",
          candidate_division_id: "cdiv-3",
          format_revision_id: null,
          format_definition_hash: "d".repeat(64),
          match_count: 28,
          guaranteed_matches: 4,
          ranking_coverage: "champion",
        },
        {
          division_id: "div-women",
          candidate_division_id: "cdiv-4",
          format_revision_id: null,
          format_definition_hash: "e".repeat(64),
          match_count: 18,
          guaranteed_matches: 3,
          ranking_coverage: "champion",
        },
      ],
    }),
    mockRecommendation({
      id: "rec-3",
      name: "Round robin",
      structure: "2 divisions · round robin",
      match_count: 84,
      guaranteed_matches: 11,
      capacity_status: "requires_changes",
      scheduling_status: "infeasible",
      warning_codes: ["SCHEDULE_DAILY_LIMIT"],
      division_formats: [
        {
          division_id: "div-men",
          candidate_division_id: "cdiv-5",
          format_revision_id: null,
          format_definition_hash: "f".repeat(64),
          match_count: 66,
          guaranteed_matches: 11,
          ranking_coverage: "all_entries",
        },
        {
          division_id: "div-women",
          candidate_division_id: "cdiv-6",
          format_revision_id: null,
          format_definition_hash: "g".repeat(64),
          match_count: 18,
          guaranteed_matches: 7,
          ranking_coverage: "all_entries",
        },
      ],
    }),
  ];

  const setupDoc = {
    competition_id: "comp-1",
    values: {
      format_recommendations: {
        recommendations: [recommendations[0], recommendations[1]],
        requires_changes: recommendations[2],
        selected_recommendation_id: "rec-1",
        acknowledged_capacity_shortfall: false,
        recommendation_set_hash: "hash-123",
      },
    },
  } as unknown as Phase4SetupDocument;

  it("renders 3 format cards with ribbons, titles, previews, metrics, badges and actions", () => {
    const html = renderToString(
      <V1FormatPicker
        competitionId="comp-1"
        isRedesignP5CardsEnabled={true}
        initialDocument={setupDoc}
        divisions={divisions}
        initialDivisionId="div-men"
      />,
    );

    // 1. Header with active division and venue capacity context
    expect(html).toContain("Format for Men’s Open");
    expect(html).toContain(
      "12 teams. Here are three ways to run it, checked against your venue time (84 match slots, with Women’s Open already using 18).",
    );

    // 2. Multi-division segmented control
    expect(html).toContain("Men’s Open · 12");
    expect(html).toContain("Women’s Open · 8");

    // 3. Strategy ribbons
    expect(html).toContain("Best balance");
    expect(html).toContain("Shortest day");
    expect(html).toContain("Most games");

    // 4. Descriptive titles matching groups of 4 domain generation
    expect(html).toContain("3 groups of 4, then knockouts and full placings");
    expect(html).toContain("3 groups of 4, then knockouts");
    expect(html).toContain("One league, everyone plays everyone");

    // 5. SVG previews
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');

    // 6. Metrics
    expect(html).toContain("Matches");
    expect(html).toContain("Fewest games for a team");
    expect(html).toContain("Slots used (both divisions)");
    expect(html).toContain("Every team ranked");
    expect(html).toContain("56 / 84");
    expect(html).toContain("46 / 84");
    expect(html).toContain("84 / 84");

    // 7. Fit badges
    expect(html).toContain("Fits the venue time");
    expect(html).toContain("Doesn’t fit");

    // 8. Plain-language reasons & fixes
    expect(html).toContain("Leaves 28 slots spare for delays");
    expect(html).toContain("Teams would play more matches in a day than your daily limit allows.");

    // 9. Buttons & division-specific customise links
    expect(html).toContain("Current format");
    expect(html).toContain("Use this format");
    expect(html).toContain("Customise");
    expect(html).toContain("format?division=div-men&amp;mode=editor");

    // 10. Bottom sheet
    expect(html).toContain("Something else in mind?");
    expect(html).toContain("Design your own");
  });

  it("retains legacy layout when isRedesignP5CardsEnabled is false", () => {
    const html = renderToString(
      <V1FormatPicker
        competitionId="comp-1"
        isRedesignP5CardsEnabled={false}
        initialDocument={setupDoc}
        divisions={divisions}
      />,
    );

    expect(html).not.toContain("Best balance");
    expect(html).not.toContain("Something else in mind?");
    expect(html).toContain('data-testid="v1-format-picker"');
  });
});
