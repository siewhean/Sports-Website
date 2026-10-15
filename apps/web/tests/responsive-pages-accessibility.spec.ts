import { test } from "@playwright/test";
import { designTokens } from "@matchday/ui";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page, context }) => {
  installConsoleGuard(page);
  await context.addCookies([
    {
      name: "matchday_session",
      value: "test-organiser-session-token",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
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
  await page.route("**/api/v1/organiser/competitions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
          name: "National Sports Organisation",
          slug: "singapore-open",
          sport: "canoe_polo",
          role: "owner",
          status: "published",
        },
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
  { name: "signed-in organiser competition library", path: "/organiser/competitions" },
  { name: "signed-in organiser create competition", path: "/organiser/competitions/new" },
  { name: "signed-in organiser schedule", path: "/organiser/competitions/singapore-open/schedule" },
  { name: "signed-in organiser settings", path: "/organiser/competitions/singapore-open/settings" },
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
