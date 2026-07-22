import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("schedule has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
});

test("move flow has no serious or critical accessibility violations", async ({ page }) => {
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
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
});
