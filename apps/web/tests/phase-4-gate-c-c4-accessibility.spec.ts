import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";
import { installGateCC4BrowserRoutes } from "./helpers/gate-c-c4";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("@a11y Gate C C4 repair intake, decisions, audit, and exports meet WCAG A/AA", async ({ page }) => {
  await installGateCC4BrowserRoutes(page);
  await page.goto("/organiser/competitions/singapore-open/repairs");
  await dismissConsent(page);

  await expect(page.getByRole("heading", { level: 1, name: "Result repairs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Corrections awaiting analysis" })).toBeVisible();
  await expect(page.getByLabel("Organiser decision")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Repair audit history" })).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});
