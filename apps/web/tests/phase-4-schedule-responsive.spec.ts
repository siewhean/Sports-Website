import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("schedule swaps the compressed timeline for a semantic phone list", async ({ page }, testInfo) => {
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  const region = page.getByRole("region", { name: "Schedule by playing area and time" });
  const explanation = page.getByText("The timeline is replaced by an ordered schedule on smaller screens.");
  if (testInfo.project.name.includes("phone")) {
    await expect(region).toBeHidden();
    await expect(explanation).toBeVisible();
  } else {
    await expect(region).toBeVisible();
    await expect(explanation).toBeHidden();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test("move flow keeps a reachable safe-area action bar", async ({ page }) => {
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
  const confirm = page.getByRole("button", { name: "Confirm move" });
  await expect(confirm).toBeVisible();
  expect((await confirm.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});
