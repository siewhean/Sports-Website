import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("hydrated capacity reports server-owned status and edits the lossless source", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Capacity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tight" })).toBeVisible();
  await expect(page.getByText("16")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Save capacity" })).toBeDisabled();
  await page.getByLabel("Area name").fill("Pool Alpha");
  await expect(page.getByRole("button", { name: "Save capacity" })).toBeEnabled();
  await expect(page.getByText("Capacity revision")).toBeVisible();
});

test("capacity loading preview is guarded", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity?state=loading");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Loading saved capacity" })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
});
