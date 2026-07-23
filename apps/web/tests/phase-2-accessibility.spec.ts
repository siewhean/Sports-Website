import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { assertNoWcagAAViolations } from "./helpers/accessibility-gate";
import {
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
  openPhase2Scorekeeper,
} from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function expectNoWcagAAViolations(page: Page) {
  assertNoWcagAAViolations(await new AxeBuilder({ page }).analyze());
}

test("organiser workflow has no WCAG A/AA accessibility violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await expectNoWcagAAViolations(page);
});

test("scorer goal-confirmation interaction has no WCAG A/AA accessibility violations", async ({ page }) => {
  await openPhase2Scorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm goal" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Scorer name").fill("Aisha Tan");
  await expectNoWcagAAViolations(page);
});

test("public results, table and bracket have no WCAG A/AA accessibility violations", async ({ page }) => {
  await page.goto("/competitions/singapore-open");
  await dismissConsent(page);
  await page.getByRole("link", { name: "Table", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Table" })).toBeVisible();
  await expectNoWcagAAViolations(page);
});
