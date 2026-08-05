import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export const WCAG_A_AND_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;
export const ENABLED_WCAG_RULES = ["target-size"] as const;

export type AccessibilityViolation = Readonly<{
  id: string;
  impact?: string | null;
  tags: readonly string[];
  helpUrl: string;
  nodes: readonly Readonly<{ target: unknown }>[];
}>;

export function isBlockingAccessibilityViolation(violation: AccessibilityViolation): boolean {
  return violation.tags.some((tag) => (WCAG_A_AND_AA_TAGS as readonly string[]).includes(tag));
}

export function blockingAccessibilityViolations(
  violations: readonly AccessibilityViolation[],
): AccessibilityViolation[] {
  return violations.filter(isBlockingAccessibilityViolation);
}

export function formatAccessibilityViolations(violations: readonly AccessibilityViolation[]): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes.map((node) => redactSensitiveNodeTarget(node.target)).join(", ");
      return [
        `rule: ${violation.id}`,
        `impact: ${violation.impact ?? "unknown"}`,
        `wcag tags: ${violation.tags.filter((tag) => tag.startsWith("wcag")).join(", ") || "none"}`,
        `nodes: ${nodes || "none"}`,
        `help: ${violation.helpUrl}`,
      ].join("\n");
    })
    .join("\n\n");
}

function redactSensitiveNodeTarget(target: unknown): string {
  const serialized = JSON.stringify(target, (key, value: unknown) => {
    if (isSensitiveNodeKey(key)) {
      return "[REDACTED]";
    }
    return typeof value === "string" ? redactSensitiveSelectorValue(value) : value;
  });
  if (serialized === undefined) {
    return String(target);
  }

  return serialized;
}

function isSensitiveNodeKey(key: string): boolean {
  return /^(?:data-)?(?:api[-_]?key|authorization|cookie|csrf(?:[-_]?token)?|password|secret|session(?:[-_]?token)?|token)$/i.test(
    key,
  );
}

function redactSensitiveSelectorValue(value: string): string {
  return value
    .replace(
      /(\[(?:data-)?(?:api[-_]?key|authorization|cookie|csrf(?:[-_]?token)?|password|secret|session(?:[-_]?token)?|token)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\]]+)(\])/gi,
      '$1"[REDACTED]"$2',
    )
    .replace(
      /([?&](?:api[-_]?key|authorization|cookie|csrf(?:[-_]?token)?|password|secret|session(?:[-_]?token)?|token)=)[^&#]*/gi,
      "$1[REDACTED]",
    );
}

export async function assertNoWcagAOrAaViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .options({
      runOnly: { type: "tag", values: [...WCAG_A_AND_AA_TAGS] },
      rules: Object.fromEntries(ENABLED_WCAG_RULES.map((rule) => [rule, { enabled: true }])),
    })
    .analyze();
  const blocking = blockingAccessibilityViolations(results.violations);
  if (blocking.length > 0) {
    throw new Error(
      `Found ${blocking.length} WCAG A/AA accessibility violation(s):\n\n${formatAccessibilityViolations(blocking)}`,
    );
  }
}
