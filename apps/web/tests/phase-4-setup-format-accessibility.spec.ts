import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

for (const [surface, url] of [
  ["assisted setup", "/organiser/competitions/singapore-open/setup?step=basics"],
  ["format designer", "/organiser/competitions/singapore-open/format"],
] as const) {
  test(`${surface} has no serious or critical accessibility violations`, async ({ page }) => {
    await page.goto(url);
    await dismissConsent(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    ).toEqual([]);
  });
}

test.describe("mocked format validation", () => {
  // Keep the mocked BFF request visible to page.route instead of allowing an
  // installed worker from another test to answer it outside Playwright routing.
  test.use({ serviceWorkers: "block" });

  test("format validation issue links focus to its stage field", async ({ page }) => {
    await page.route("**/api/phase4/competitions/*/divisions/*/format-builder/validate", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          valid: false,
          issues: [{ code: "missing_output", path: "graph.stages[0].outputRanks", message: "Choose an output rank." }],
          graph_hash: null,
          materialisation: null,
        }),
      }),
    );
    await page.goto("/organiser/competitions/singapore-open/format");
    await dismissConsent(page);
    await page.getByRole("button", { name: "Validate graph" }).click();
    await expect(page.getByText("1 validation issue", { exact: true })).toBeVisible();
    await expect(page.locator('[data-stage-index="0"]')).toBeFocused();
  });
});
