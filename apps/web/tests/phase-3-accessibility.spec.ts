import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { assertNoWcagAAViolations } from "./helpers/accessibility-gate";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function expectNoWcagAAViolations(page: Page) {
  assertNoWcagAAViolations(await new AxeBuilder({ page }).analyze());
}

test("sport settings editor has no WCAG A/AA accessibility violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Competition settings" })).toBeVisible();
  await expectNoWcagAAViolations(page);
});

test("sport defaults admin identifies provisional authority accessibly", async ({ page }) => {
  await page.goto("/internal/sport-defaults?sport=canoe_polo");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Sport-pack defaults" })).toBeVisible();
  await expect(page.getByText("Product recommendation — not a federation profile")).toBeVisible();
  await expectNoWcagAAViolations(page);
});

test("capacity status and lossless source editor are accessible", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Capacity" })).toBeVisible();
  await expect(page.getByText("Capacity revision")).toBeVisible();
  await expectNoWcagAAViolations(page);
});

test("standings evidence and advancement conflicts are accessible", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Standings and advancement" })).toBeVisible();
  await expect(page.getByText("A correction needs organiser review")).toBeVisible();
  await expectNoWcagAAViolations(page);
});
