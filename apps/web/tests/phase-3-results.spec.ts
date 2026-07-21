import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("organiser results expose persisted standings and advancement provenance", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Standings and advancement" })).toBeVisible();
  await expect(page.locator('.p2-organiser__nav a[aria-current="page"]')).toContainText("Results");
  await expect(page.getByText("Server calculated")).toBeVisible();
  await expect(page.getByTestId("phase3-results").getByText("res_6")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Automatic" })).toBeVisible();
  await expect(page.getByText("semi-final-1:home:group-a:1")).toBeVisible();
  await expect(page.getByText("organiser controlled")).toBeVisible();
  await expect(page.getByText("A correction needs organiser review")).toBeVisible();
  await page.getByText("table points").first().click();
  await expect(page.getByText("Ranking explanation").first()).toBeVisible();
});

test("read-only and unavailable results states remain explicit", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results?state=read-only");
  await dismissConsent(page);
  await expect(page.getByText("Results are read only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Recalculate from final results" })).toBeDisabled();

  await page.goto("/organiser/competitions/singapore-open/results?state=empty");
  await expect(page.getByRole("heading", { name: "No standings snapshot yet" })).toBeVisible();

  await page.goto("/organiser/competitions/singapore-open/results?state=offline");
  await expect(page.getByRole("heading", { name: "Working offline" })).toBeVisible();

  await page.goto("/organiser/competitions/singapore-open/results?state=error");
  await expect(page.getByRole("heading", { name: "Standings could not load" })).toBeVisible();

  await page.goto("/organiser/competitions/singapore-open/results?state=permission");
  await expect(page.getByRole("heading", { name: "Standings access required" })).toBeVisible();

  await page.goto("/organiser/competitions/singapore-open/results?state=loading");
  await expect(page.getByLabel("Loading standings")).toHaveAttribute("aria-busy", "true");
});
