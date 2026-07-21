import { expect, test } from "@playwright/test";
import {
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
  openPhase2Scorekeeper,
} from "./helpers/console-guard";

test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("Phase 2 organiser visual baseline", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Event-day control room" })).toBeVisible();
  await expect(page).toHaveScreenshot("phase-2-organiser.png", { fullPage: true, animations: "disabled" });
});

test("Phase 2 scorer attribution visual baseline", async ({ page }) => {
  await openPhase2Scorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm goal" })).toBeVisible();
  await expect(page).toHaveScreenshot("phase-2-scorer-confirmation.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("Phase 2 public competition visual baseline", async ({ page }) => {
  await page.goto("/competitions/singapore-open");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Singapore Open 2026" })).toBeVisible();
  await expect(page).toHaveScreenshot("phase-2-public.png", { fullPage: true, animations: "disabled" });
});
