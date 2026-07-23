import { describe, expect, it } from "vitest";
import {
  assertNoWcagAAViolations,
  wcagAAViolations,
  type AxeViolationLike,
} from "../helpers/accessibility-gate";

function violation(overrides: Partial<AxeViolationLike> = {}): AxeViolationLike {
  return {
    id: "color-contrast",
    impact: "moderate",
    tags: ["wcag2aa", "wcag143"],
    help: "Elements must meet minimum color contrast ratio thresholds",
    helpUrl: "https://dequeuniversity.com/rules/axe/color-contrast",
    nodes: [{ target: [["#submit"]] }],
    ...overrides,
  };
}

describe("WCAG A/AA accessibility gate", () => {
  it("blocks a moderate WCAG AA violation and reports actionable evidence", () => {
    expect(() => assertNoWcagAAViolations({ violations: [violation()] })).toThrowError(
      /color-contrast[\s\S]*moderate[\s\S]*wcag2aa[\s\S]*#submit[\s\S]*dequeuniversity/u,
    );
  });

  it.each([
    ["serious", ["wcag2a", "wcag131"]],
    ["critical", ["wcag22aa", "wcag2411"]],
  ])("blocks %s WCAG A/AA findings", (impact, tags) => {
    expect(() => assertNoWcagAAViolations({ violations: [violation({ impact, tags })] })).toThrow(
      /WCAG A\/AA accessibility violations/u,
    );
  });

  it("does not convert best-practice-only or AAA-only findings into A/AA failures", () => {
    const informational = [
      violation({ id: "best-practice", tags: ["best-practice"] }),
      violation({ id: "aaa-only", tags: ["wcag2aaa", "wcag146"] }),
    ];
    expect(wcagAAViolations({ violations: informational })).toEqual([]);
    expect(() => assertNoWcagAAViolations({ violations: informational })).not.toThrow();
  });
});
