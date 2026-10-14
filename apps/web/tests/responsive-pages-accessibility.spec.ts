import { test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
            name: "National Sports Organisation",
            role: "owner",
          },
        ]),
      });
      return;
    }
    await route.fallback();
  });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

const viewports = [
  { name: "phone", width: 375, height: 667 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

const keyRoutes = [
  { name: "home", path: "/" },
  { name: "pricing", path: "/pricing" },
  { name: "sign-in", path: "/sign-in" },
  { name: "public competition", path: "/competitions/singapore-open" },
  { name: "scorekeeper", path: "/score" },
  { name: "organiser competition library", path: "/organiser/competitions" },
  { name: "organiser create competition", path: "/organiser/competitions/new" },
  { name: "organiser schedule", path: "/organiser/competitions/singapore-open/schedule" },
  { name: "organiser settings", path: "/organiser/competitions/singapore-open/settings" },
] as const;

for (const vp of viewports) {
  test.describe(`responsive accessibility on ${vp.name} (${vp.width}x${vp.height})`, () => {
    for (const route of keyRoutes) {
      test(`@a11y ${route.name} route has zero WCAG A/AA violations on ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route.path);
        await dismissConsent(page);
        await page.waitForLoadState("networkidle");
        await assertNoWcagAOrAaViolations(page);
      });
    }
  });
}
