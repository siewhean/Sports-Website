import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";
import { installGateCC4BrowserRoutes } from "./helpers/gate-c-c4";

const approvedWebKitNativeControlDiffPixels: Readonly<Record<string, number>> = {
  "phone-webkit": 36,
  "tablet-webkit": 40,
};

test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function hidePersistentPrivacyControl(page: import("@playwright/test").Page) {
  const control = page.locator(".consent-reopen");
  if (await control.count()) await control.evaluate((element) => element.setAttribute("hidden", ""));
}

test("Gate C C4 repair workspace visual baseline", async ({ page }, testInfo) => {
  await installGateCC4BrowserRoutes(page);
  await page.goto("/organiser/competitions/singapore-open/repairs");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Result repairs" })).toBeVisible();
  await expect(page.getByLabel("Organiser decision")).toBeVisible();
  await hidePersistentPrivacyControl(page);

  await expect(page).toHaveScreenshot("gate-c-c4-repair-workspace.png", {
    fullPage: true,
    animations: "disabled",
    // These are the exact, manually reviewed native datetime-local glyph variances.
    // Chromium remains pixel-exact and every substantive layout change still fails.
    maxDiffPixels: approvedWebKitNativeControlDiffPixels[testInfo.project.name] ?? 0,
  });
});
