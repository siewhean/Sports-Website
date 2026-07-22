import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function hidePersistentPrivacyControl(page: import("@playwright/test").Page) {
  const control = page.locator(".consent-reopen");
  if (await control.count()) await control.evaluate((element) => element.setAttribute("hidden", ""));
}

test("Phase 3 competition settings visual baseline", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Competition settings" })).toBeVisible();
  await hidePersistentPrivacyControl(page);
  await expect(page).toHaveScreenshot("phase-3-competition-settings.png", { fullPage: true, animations: "disabled" });
});

test("Phase 3 defaults admin visual baseline", async ({ page }) => {
  await page.goto("/internal/sport-defaults?sport=canoe_polo");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Sport-pack defaults" })).toBeVisible();
  await hidePersistentPrivacyControl(page);
  await expect(page).toHaveScreenshot("phase-3-defaults-admin.png", { fullPage: true, animations: "disabled" });
});

test("Phase 3 production capacity visual baseline", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Capacity" })).toBeVisible();
  await hidePersistentPrivacyControl(page);
  await expect(page).toHaveScreenshot("phase-3-capacity.png", { fullPage: true, animations: "disabled" });
});

test("Phase 3 production results visual baseline", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Standings and advancement" })).toBeVisible();
  await hidePersistentPrivacyControl(page);
  await expect(page).toHaveScreenshot("phase-3-results.png", { fullPage: true, animations: "disabled" });
});

test("Phase 3 competition settings mobile visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await hidePersistentPrivacyControl(page);
  await expect(page.getByRole("heading", { name: "Competition settings" })).toBeVisible();
  await expect(page).toHaveScreenshot("phase-3-competition-settings-mobile.png", {
    fullPage: true,
    animations: "disabled",
  });
});

for (const [state, expectedHeading] of [
  ["loading", "Competition settings"],
  ["read-only", "Settings are read-only"],
  ["conflict", "A newer version was saved"],
] as const) {
  test(`Phase 3 ${state} settings visual baseline`, async ({ page }) => {
    await page.setViewportSize({ width: 901, height: 800 });
    await page.goto(`/organiser/competitions/singapore-open/settings?state=${state}`);
    await dismissConsent(page);
    await hidePersistentPrivacyControl(page);
    await expect(page.getByRole("heading", { name: expectedHeading }).first()).toBeVisible();
    await expect(page).toHaveScreenshot(`phase-3-competition-settings-${state}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });
}
