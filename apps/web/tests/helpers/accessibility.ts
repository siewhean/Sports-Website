import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

// target-size is a required WCAG criterion in this validation layer.
export const WCAG_A_AND_AA_TAGS = new Set(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);

export type AccessibilityViolation = Readonly<{
  id: string;
  impact?: string | null;
  tags: readonly string[];
  helpUrl: string;
  nodes: readonly Readonly<{ target: unknown }>[];
}>;

export function isBlockingAccessibilityViolation(violation: AccessibilityViolation): boolean {
  return violation.tags.some((tag) => WCAG_A_AND_AA_TAGS.has(tag));
}

export function blockingAccessibilityViolations(
  violations: readonly AccessibilityViolation[],
): AccessibilityViolation[] {
  return violations.filter(isBlockingAccessibilityViolation);
}

export function formatAccessibilityViolations(violations: readonly AccessibilityViolation[]): string {
  return violations
    .map((violation) => {
      const selectors = violation.nodes.map((node) => JSON.stringify(node.target)).join(", ");
      return [
        `rule: ${violation.id}`,
        `wcag tags: ${violation.tags.filter((tag) => tag.startsWith("wcag")).join(", ") || "none"}`,
        `selectors: ${selectors || "none"}`,
        `help: ${violation.helpUrl}`,
      ].join("\n");
    })
    .join("\n\n");
}

export async function assertNoWcagAOrAaViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags([...WCAG_A_AND_AA_TAGS]).analyze();
  const blocking = blockingAccessibilityViolations(results.violations);
  if (blocking.length > 0) {
    throw new Error(
      `Found ${blocking.length} blocking accessibility violation(s):\n\n${formatAccessibilityViolations(blocking)}`,
    );
  }
}
