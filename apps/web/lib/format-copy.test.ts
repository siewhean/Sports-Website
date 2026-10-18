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

  it("assigns ribbons according to ordinal and strategy", () => {
    expect(formatRecommendationRibbon("full_placement", 1)).toEqual({
      label: "Best balance",
      isBest: true,
    });
    expect(formatRecommendationRibbon("compact_knockout", 2)).toEqual({
      label: "Shortest day",
      isBest: false,
    });
    expect(formatRecommendationRibbon("round_robin", 3)).toEqual({
      label: "Most games",
      isBest: false,
    });
    expect(formatRecommendationRibbon("double_elimination", 2)).toEqual({
      label: "Double chance",
      isBest: false,
    });
  });

  it("produces descriptive titles for common format strategies and team counts", () => {
    expect(formatDescriptiveTitle("full_placement", 12)).toBe("2 groups of 6, then semi-finals and full placings");
    expect(formatDescriptiveTitle("championship_focus", 12)).toBe("4 groups of 3, then quarter-finals");
    expect(formatDescriptiveTitle("round_robin")).toBe("One league, everyone plays everyone");
  });

  it("accurately detects format family from various candidate representations", () => {
    expect(detectFormatFamily({ strategy: "full_placement" })).toBe("full_placement");
    expect(detectFormatFamily({ name: "Championship focus" })).toBe("championship_focus");
    expect(detectFormatFamily({ structure: "1 division · compact knockout" })).toBe("compact_knockout");
    expect(detectFormatFamily({ name: "Double elimination" })).toBe("double_elimination");
    expect(detectFormatFamily({ name: "One league, everyone plays everyone" })).toBe("round_robin");
  });

  it("computes fit status and plain-language explanation", () => {
    const fitting = formatFitStatus({
      capacity_status: "fits",
      scheduling_status: "feasible",
      match_count: 38,
      available_match_slots: 84,
      advantage: "Ranks every entry.",
    });
    expect(fitting.fits).toBe(true);
    expect(fitting.badgeLabel).toBe("Fits the venue time");
    expect(fitting.reason).toContain("Leaves 46 slots spare for delays");
    expect(fitting.reason).toContain("Ranks every entry.");
    expect(fitting.fix).toBe("");

    const notFitting = formatFitStatus({
      capacity_status: "requires_changes",
      scheduling_status: "infeasible",
      match_count: 66,
      available_match_slots: 40,
      warning_codes: ["insufficient_capacity"],
    });
    expect(notFitting.fits).toBe(false);
    expect(notFitting.badgeLabel).toBe("Doesn’t fit");
    expect(notFitting.reason).toContain("needs more match slots");
    expect(notFitting.fix).toContain("Add courts");
  });
});
