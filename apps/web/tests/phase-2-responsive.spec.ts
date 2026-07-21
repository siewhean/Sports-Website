import { expect, test } from "@playwright/test";
import {
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
  openPhase2Scorekeeper,
} from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, label).toBe(dimensions.clientWidth);
}

async function settleServiceWorker(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return;
    await navigator.serviceWorker.ready;
  });
}

test("Phase 2 surfaces reflow at 320 CSS pixels without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  for (const route of [
    "/organiser/competitions/singapore-open",
    "/organiser/competitions/singapore-open/schedule",
    "/score/m12-access",
    "/competitions/singapore-open",
  ] as const) {
    await page.goto(route);
    await dismissConsent(page);
    await expectNoHorizontalOverflow(page, `${route} at 320px`);
    await settleServiceWorker(page);
  }

  await openPhase2Scorekeeper(page);
  await expectNoHorizontalOverflow(page, "live scorer at 320px");
});

test("phone scoring keeps visible event actions at least 48 by 48 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openPhase2Scorekeeper(page);
  const controls = page.locator(".p2-goal-controls button, .p2-other-controls button, .p2-score-final");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box?.width ?? 0, `control ${index} width`).toBeGreaterThanOrEqual(48);
    expect(box?.height ?? 0, `control ${index} height`).toBeGreaterThanOrEqual(48);
  }
});

test("reduced motion and forced-colour modes preserve operational controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/organiser/competitions/singapore-open");
  await dismissConsent(page);
  const activeNavigation = page.locator('.p2-organiser__nav a[aria-current="page"]');
  await expect(activeNavigation).toBeVisible();
  const transitionSeconds = await activeNavigation.evaluate((element) =>
    getComputedStyle(element)
      .transitionDuration.split(",")
      .map((value) => Number.parseFloat(value) * (value.includes("ms") ? 0.001 : 1)),
  );
  expect(Math.max(...transitionSeconds)).toBeLessThanOrEqual(0.001);

  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.reload();
  const publish = page.getByRole("link", { name: "Open public page" });
  await expect(publish).toBeVisible();
  await expect(publish).toHaveCSS("border-top-style", "solid");
});
