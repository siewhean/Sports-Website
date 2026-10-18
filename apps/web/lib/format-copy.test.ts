import { describe, expect, it } from "vitest";
import {
  KNOWN_FORMAT_WARNING_CODES,
  detectFormatFamily,
  formatDescriptiveTitle,
  formatFitStatus,
  formatRecommendationRibbon,
  formatWarningCopy,
  formatWarningSentence,
} from "./format-copy";

describe("format-copy", () => {
  it("provides non-empty reason and fix for every known warning code", () => {
    for (const code of KNOWN_FORMAT_WARNING_CODES) {
      const copy = formatWarningCopy(code);
      expect(copy.reason.length).toBeGreaterThan(0);
      expect(copy.fix.length).toBeGreaterThan(0);
      expect(formatWarningSentence(code)).toContain(copy.reason);
      expect(formatWarningSentence(code)).toContain(copy.fix);
    }
  });

  it("handles unknown warning codes with safe fallback", () => {
    const fallback = formatWarningCopy("UNKNOWN_CODE_XYZ");
    expect(fallback.reason).toContain("requires changes");
    expect(fallback.fix.length).toBeGreaterThan(0);
  });

  it("assigns ribbons according to strategy, ordinal and fit status", () => {
    // 1. Fitting balanced card at ordinal 1 gets "Best balance"
    expect(formatRecommendationRibbon("full_placement", 1, true)).toEqual({
      label: "Best balance",
      isBest: true,
    });
    expect(formatRecommendationRibbon("championship_focus", 1, true)).toEqual({
      label: "Best balance",
      isBest: true,
    });

    // 2. Compact knockout at ordinal 1 gets "Shortest day", NEVER "Best balance"
    expect(formatRecommendationRibbon("compact_knockout", 1, true)).toEqual({
      label: "Shortest day",
      isBest: false,
    });

    // 3. A card that does not fit NEVER gets "Best balance"
    expect(formatRecommendationRibbon("full_placement", 1, false)).toEqual({
      label: "Alternative",
      isBest: false,
    });
    expect(formatRecommendationRibbon("compact_knockout", 1, false)).toEqual({
      label: "Shortest day",
      isBest: false,
    });

    // 4. Secondary cards
    expect(formatRecommendationRibbon("compact_knockout", 2, true)).toEqual({
      label: "Shortest day",
      isBest: false,
    });
    expect(formatRecommendationRibbon("round_robin", 3, true)).toEqual({
      label: "Most games",
      isBest: false,
    });
    expect(formatRecommendationRibbon("double_elimination", 2, true)).toEqual({
      label: "Double chance",
      isBest: false,
    });
  });

  it("produces descriptive titles matching groups of 4 domain generation", () => {
    // 8 teams: 2 groups of 4
    expect(formatDescriptiveTitle("full_placement", 8)).toBe("2 groups of 4, then semi-finals and full placings");
    expect(formatDescriptiveTitle("championship_focus", 8)).toBe("2 groups of 4, then semi-finals");

    // 12 teams: 3 groups of 4 (domain builds 3 groups of 4, 24 matches)
    expect(formatDescriptiveTitle("full_placement", 12)).toBe("3 groups of 4, then knockouts and full placings");
    expect(formatDescriptiveTitle("championship_focus", 12)).toBe("3 groups of 4, then knockouts");

    // 16 teams: 4 groups of 4
    expect(formatDescriptiveTitle("full_placement", 16)).toBe("4 groups of 4, then quarter-finals and full placings");
    expect(formatDescriptiveTitle("championship_focus", 16)).toBe("4 groups of 4, then quarter-finals");

    // 24 teams: 6 groups of 4
    expect(formatDescriptiveTitle("full_placement", 24)).toBe("6 groups of 4, then knockouts and full placings");
    expect(formatDescriptiveTitle("championship_focus", 24)).toBe("6 groups of 4, then knockouts");

    expect(formatDescriptiveTitle("round_robin")).toBe("One league, everyone plays everyone");
    expect(formatDescriptiveTitle("compact_knockout")).toBe("Single elimination bracket");
  });

  it("accurately detects format family from various candidate representations", () => {
    expect(detectFormatFamily({ strategy: "full_placement" })).toBe("full_placement");
    expect(detectFormatFamily({ name: "Championship focus" })).toBe("championship_focus");
    expect(detectFormatFamily({ structure: "1 division · compact knockout" })).toBe("compact_knockout");
    expect(detectFormatFamily({ name: "Double elimination" })).toBe("double_elimination");
    expect(detectFormatFamily({ name: "One league, everyone plays everyone" })).toBe("round_robin");
  });

  it("computes fit status, not-checked badge, and plain-language explanation", () => {
    const fitting = formatFitStatus({
      capacity_status: "fits",
      scheduling_status: "feasible",
      match_count: 38,
      available_match_slots: 84,
      advantage: "Ranks every entry.",
    });
    expect(fitting.fits).toBe(true);
    expect(fitting.isUnverified).toBe(false);
    expect(fitting.badgeLabel).toBe("Fits the venue time");
    expect(fitting.reason).toContain("Leaves 46 slots spare for delays");
    expect(fitting.reason).toContain("Ranks every entry.");
    expect(fitting.fix).toBe("");

    const notChecked = formatFitStatus({
      capacity_status: "fits",
      scheduling_status: "not_checked",
      match_count: 24,
      available_match_slots: 84,
      advantage: "Uses fewest slots.",
    });
    expect(notChecked.fits).toBe(true);
    expect(notChecked.isUnverified).toBe(true);
    expect(notChecked.badgeLabel).toBe("Not checked");
    expect(notChecked.reason).toContain("Schedule feasibility has not been checked yet.");

    const notFitting = formatFitStatus({
      capacity_status: "requires_changes",
      scheduling_status: "infeasible",
      match_count: 66,
      available_match_slots: 40,
      warning_codes: ["insufficient_capacity"],
    });
    expect(notFitting.fits).toBe(false);
    expect(notFitting.isUnverified).toBe(false);
    expect(notFitting.badgeLabel).toBe("Doesn’t fit");
    expect(notFitting.reason).toContain("needs more match slots");
    expect(notFitting.fix).toContain("Add courts");
  });
});
