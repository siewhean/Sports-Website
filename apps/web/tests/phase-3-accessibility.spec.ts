import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
}

test("sport settings editor has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Competition settings" })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("sport defaults admin identifies provisional authority accessibly", async ({ page }) => {
  await page.goto("/internal/sport-defaults");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Sport-pack defaults" })).toBeVisible();
  await expect(page.getByText("Product recommendation — not a federation profile")).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("capacity status and lossless source editor are accessible", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Capacity" })).toBeVisible();
  await expect(page.getByText("Capacity revision")).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("standings evidence and advancement conflicts are accessible", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Standings and advancement" })).toBeVisible();
  await expect(page.getByText("A correction needs organiser review")).toBeVisible();
  await expectNoBlockingViolations(page);
});
