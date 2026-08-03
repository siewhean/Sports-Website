import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";
import { installGateCC4BrowserRoutes } from "./helpers/gate-c-c4";

test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function hidePersistentPrivacyControl(page: import("@playwright/test").Page) {
  const control = page.locator(".consent-reopen");
  if (await control.count()) await control.evaluate((element) => element.setAttribute("hidden", ""));
}

test("Gate C C4 repair workspace visual baseline", async ({ page }) => {
  await installGateCC4BrowserRoutes(page);
  await page.goto("/organiser/competitions/singapore-open/repairs");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Result repairs" })).toBeVisible();
  await expect(page.getByLabel("Organiser decision")).toBeVisible();
  await hidePersistentPrivacyControl(page);

  await expect(page).toHaveScreenshot("gate-c-c4-repair-workspace.png", {
    fullPage: true,
    animations: "disabled",
    // WebKit's native datetime-local glyphs can anti-alias differently by a few pixels.
    // The reviewed full-page baseline remains strict for every substantive layout change.
    maxDiffPixels: 40,
  });
});
