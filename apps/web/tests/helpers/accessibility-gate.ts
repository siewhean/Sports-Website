type AxeNodeLike = Readonly<{
  target: readonly unknown[];
}>;

export type AxeViolationLike = Readonly<{
  id: string;
  impact: string | null;
  tags: readonly string[];
  help: string;
  helpUrl: string;
  nodes: readonly AxeNodeLike[];
}>;

export type AxeResultsLike = Readonly<{
  violations: readonly AxeViolationLike[];
}>;

const wcagAALevelTags = new Set([
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
]);

export function wcagAAViolations(results: AxeResultsLike): readonly AxeViolationLike[] {
  return results.violations.filter((violation) => violation.tags.some((tag) => wcagAALevelTags.has(tag)));
}

function selectorList(violation: AxeViolationLike): string {
  const selectors = violation.nodes.flatMap((node) => node.target.map((target) => JSON.stringify(target)));
  return selectors.length > 0 ? selectors.join(", ") : "(no selector reported)";
}

export function assertNoWcagAAViolations(results: AxeResultsLike): void {
  const blocking = wcagAAViolations(results);
  if (blocking.length === 0) return;

  const details = blocking
    .map(
      (violation) =>
        [
          `${violation.id} (${violation.impact ?? "unknown impact"})`,
          `WCAG tags: ${violation.tags.filter((tag) => tag.startsWith("wcag")).join(", ") || "none"}`,
          `Affected selectors: ${selectorList(violation)}`,
          `${violation.help}: ${violation.helpUrl}`,
        ].join("\n"),
    )
    .join("\n\n");

  throw new Error(`WCAG A/AA accessibility violations:\n\n${details}`);
}
