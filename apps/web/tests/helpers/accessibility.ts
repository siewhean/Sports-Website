import AxeBuilder from "@axe-core/playwright";
import { test, type Page } from "@playwright/test";

export const WCAG_A_AND_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;
// color-contrast is in the wcag2aa tag set already; listing it keeps it on even if a tag filter changes.
export const ENABLED_WCAG_RULES = ["target-size", "color-contrast"] as const;
// Every scan runs in both themes: dark mode is where hard-coded light colours used to hide text.
export const SCANNED_COLOR_SCHEMES = ["light", "dark"] as const;

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

async function waitForSettledAnimations(page: Page): Promise<void> {
  // Scan the settled UI: mid-transition opacity (e.g. a dialog fading in) makes axe report false
  // colour-contrast failures. Finite animations only; infinite ones (spinners, live pulses) are ignored.
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== "running" || animation.effect?.getComputedTiming().endTime === Infinity,
          ),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
}

export async function assertNoWcagAOrAaViolations(page: Page): Promise<void> {
  // Two full scans (light and dark) per call: give each call its own time budget.
  test.info().setTimeout(test.info().timeout + 20_000);
  const failures: string[] = [];
  const initialScheme = await page.evaluate(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  try {
    for (const colorScheme of SCANNED_COLOR_SCHEMES) {
      await page.emulateMedia({ colorScheme });
      await waitForSettledAnimations(page);
      const results = await new AxeBuilder({ page })
        .options({
          runOnly: { type: "tag", values: [...WCAG_A_AND_AA_TAGS] },
          rules: Object.fromEntries(ENABLED_WCAG_RULES.map((rule) => [rule, { enabled: true }])),
        })
        .analyze();
      const blocking = blockingAccessibilityViolations(results.violations);
      if (blocking.length > 0) {
        failures.push(
          `${colorScheme} theme: ${blocking.length} WCAG A/AA accessibility violation(s):\n\n${formatAccessibilityViolations(blocking)}`,
        );
      }
    }
  } finally {
    await page.emulateMedia({ colorScheme: initialScheme });
  }
  if (failures.length > 0) {
    throw new Error(`Found WCAG A/AA accessibility violations\n\n${failures.join("\n\n")}`);
  }
}
