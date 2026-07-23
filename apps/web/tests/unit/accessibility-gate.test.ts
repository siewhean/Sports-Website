import { describe, expect, it } from "vitest";
import {
  blockingAccessibilityViolations,
  formatAccessibilityViolations,
  type AccessibilityViolation,
} from "../helpers/accessibility";

function violation(
  id: string,
  impact: string | null,
  tags: readonly string[],
  target = ["#target"],
): AccessibilityViolation {
  return {
    id,
    impact,
    tags,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.12/${id}`,
    nodes: [{ target }],
  };
}

describe("WCAG A/AA accessibility gate", () => {
  it("blocks a moderate WCAG AA violation", () => {
    expect(
      blockingAccessibilityViolations([violation("color-contrast", "moderate", ["wcag2aa", "wcag143"])]),
    ).toHaveLength(1);
  });

  it.each([
    ["serious", "wcag2a"],
    ["critical", "wcag22aa"],
  ])("blocks a %s WCAG violation", (impact, tag) => {
    expect(blockingAccessibilityViolations([violation("label", impact, [tag])])).toHaveLength(1);
  });

  it("blocks a WCAG AA violation even when axe does not assign an impact", () => {
    expect(blockingAccessibilityViolations([violation("target-size", null, ["wcag22aa", "wcag258"])])).toHaveLength(1);
  });

  it("does not treat a non-WCAG informational finding as a WCAG failure", () => {
    expect(blockingAccessibilityViolations([violation("best-practice-note", null, ["best-practice"])])).toEqual([]);
  });

  it("retains actionable rule, impact, tags, selector and help output", () => {
    const output = formatAccessibilityViolations([
      violation("color-contrast", "moderate", ["wcag2aa", "wcag143"], [".capacity-value"]),
    ]);

    expect(output).toContain("rule: color-contrast");
    expect(output).toContain("impact: moderate");
    expect(output).toContain("wcag tags: wcag2aa, wcag143");
    expect(output).toContain('selectors: [".capacity-value"]');
    expect(output).toContain("https://dequeuniversity.com/rules/axe/4.12/color-contrast");
  });
});
