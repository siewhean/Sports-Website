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
  target: unknown = ["#target"],
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

  it("passes an empty WCAG violation list", () => {
    expect(blockingAccessibilityViolations([])).toEqual([]);
  });

  it("does not treat a non-WCAG informational finding as a WCAG failure", () => {
    expect(blockingAccessibilityViolations([violation("best-practice-note", null, ["best-practice"])])).toEqual([]);
  });

  it("retains actionable rule, impact, WCAG tags, redacted nodes and help output", () => {
    const output = formatAccessibilityViolations([
      violation("color-contrast", "moderate", ["wcag2aa", "wcag143"], [".capacity-value", '[data-token="top-secret"]']),
    ]);

    expect(output).toContain("rule: color-contrast");
    expect(output).toContain("impact: moderate");
    expect(output).toContain("wcag tags: wcag2aa, wcag143");
    expect(output).toContain('nodes: [".capacity-value","[data-token=\\"[REDACTED]\\"]"]');
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("https://dequeuniversity.com/rules/axe/4.12/color-contrast");
    expect(output).not.toContain("top-secret");
  });

  it("reports a missing Axe impact as unknown", () => {
    expect(formatAccessibilityViolations([violation("target-size", null, ["wcag22aa", "wcag258"])])).toContain(
      "impact: unknown",
    );
  });

  it("redacts complete multiword selector and object secrets without hiding benign selector state", () => {
    const output = formatAccessibilityViolations([
      violation(
        "label",
        "serious",
        ["wcag2a", "wcag412"],
        [
          '[data-authorization="Bearer abc.def.ghi"]',
          '[data-password="correct horse battery staple"]',
          '[data-session-status="active"]',
          { token: "top secret value", label: "safe diagnostic" },
        ],
      ),
    ]);

    expect(output).toContain('[data-authorization=\\"[REDACTED]\\"]');
    expect(output).toContain('[data-password=\\"[REDACTED]\\"]');
    expect(output).toContain('[data-session-status=\\"active\\"]');
    expect(output).toContain('"token":"[REDACTED]"');
    expect(output).toContain('"label":"safe diagnostic"');
    expect(output).not.toMatch(/abc\.def\.ghi|correct horse|top secret value/);
  });
});
