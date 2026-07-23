import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));
test.use({ serviceWorkers: "block" });

function relativeLuminance([red, green, blue]: number[]): number {
  return [red, green, blue]
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((luminance, channel, index) => luminance + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function parseRgb(value: string): number[] {
  return (
    value
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number) ?? []
  );
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(parseRgb(foreground)), relativeLuminance(parseRgb(background)));
  const darker = Math.min(relativeLuminance(parseRgb(foreground)), relativeLuminance(parseRgb(background)));
  return (lighter + 0.05) / (darker + 0.05);
}

test("@a11y schedule has no WCAG A or AA accessibility violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y move flow has no WCAG A or AA accessibility violations", async ({ page }) => {
  await page.route("**/moves/validate", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        validation: { valid: true, violations: [] },
        assignments: [],
        consequences: {
          moved_match_id: "match",
          from: null,
          to: null,
          affected_match_ids: [],
          dependency_match_ids: [],
          locked_match_ids: [],
          messages: [],
          quality: null,
        },
      }),
    }),
  );
  await page.goto(
    "/organiser/competitions/singapore-open/schedule/revisions/70000000-0000-4000-8000-000000000004/matches/30000000-0000-4000-8000-000000000001/move",
  );
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
  const stepNumberColors = await page
    .getByTestId("move-step-number")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
  expect(contrastRatio(stepNumberColors.foreground, stepNumberColors.background)).toBeGreaterThanOrEqual(4.5);
});

test("@a11y revision comparison has no WCAG A or AA accessibility violations", async ({ page }) => {
  await page.goto(
    "/organiser/competitions/singapore-open/schedule/compare?left=70000000-0000-4000-8000-000000000003&right=70000000-0000-4000-8000-000000000004",
  );
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-schedule-comparison")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});
