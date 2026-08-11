import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import {
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
  openPhase2Scorekeeper,
} from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("@a11y organiser workflow has no WCAG A or AA accessibility violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y scorer goal-confirmation interaction has no WCAG A or AA accessibility violations", async ({ page }) => {
  await openPhase2Scorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm goal" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Scorer or participant name").fill("Aisha Tan");
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y public results, table and bracket have no WCAG A or AA accessibility violations", async ({ page }) => {
  await page.goto("/competitions/singapore-open");
  await dismissConsent(page);
  const latestResults = page.getByRole("list", { name: "Latest results" });
  await expect(page.getByRole("heading", { name: "Latest results" })).toBeVisible();
  await expect(latestResults.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("link", { name: "Table", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Table" })).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});
