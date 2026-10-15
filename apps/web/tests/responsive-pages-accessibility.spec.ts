import { test } from "@playwright/test";
import { designTokens } from "@matchday/ui";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

// Organiser routes here render from the demo fixtures enabled by the browser-e2e webServer
// (MATCHDAY_ALLOW_DEMO_FIXTURES=1, MATCHDAY_PHASE2_DATA_MODE=demo). This is demo-fixture a11y coverage of the
// organiser UI, not a signed-in session against the real API; signed-in journeys are covered by the real-API configs.
test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  // The create-competition form loads the organiser's organisations client-side; there is no demo fixture for that
  // browser fetch, so it is mocked here. Server-rendered organiser pages need no session mock in demo mode.
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "79685f62-e0f7-4c41-a329-5532bf41cfa2", name: "National Sports Organisation", role: "owner" },
      ]),
    });
  });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

const viewports = [
  { name: "phone", width: designTokens.breakpoints.phone, height: 667 },
  { name: "tablet", width: designTokens.breakpoints.tablet, height: 1024 },
  { name: "desktop", width: designTokens.breakpoints.desktop, height: 800 },
] as const;

const keyRoutes = [
  { name: "home", path: "/" },
  { name: "pricing", path: "/pricing" },
  { name: "sign-in", path: "/sign-in" },
  { name: "public competition", path: "/competitions/singapore-open" },
  { name: "scorekeeper", path: "/score" },
  { name: "demo-fixture organiser competition library", path: "/organiser/competitions" },
  { name: "demo-fixture organiser create competition", path: "/organiser/competitions/new" },
  { name: "demo-fixture organiser schedule", path: "/organiser/competitions/singapore-open/schedule" },
  { name: "demo-fixture organiser settings", path: "/organiser/competitions/singapore-open/settings" },
] as const;

for (const route of keyRoutes) {
  test(`@a11y ${route.name} route has zero WCAG A/AA violations`, async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop-chromium") {
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route.path);
        await dismissConsent(page);
        await page.waitForLoadState("networkidle");
        await assertNoWcagAOrAaViolations(page);
      }
    } else {
      await page.goto(route.path);
      await dismissConsent(page);
      await page.waitForLoadState("networkidle");
      await assertNoWcagAOrAaViolations(page);
    }
  });
}
