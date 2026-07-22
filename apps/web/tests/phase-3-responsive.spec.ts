import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("settings, capacity and defaults reflow across mobile and layout boundaries without overflow", async ({
  page,
}) => {
  for (const width of [320, 390, 767, 768, 900, 901] as const) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "/organiser/competitions/singapore-open/settings",
      "/organiser/competitions/singapore-open/capacity",
      "/organiser/competitions/singapore-open/results",
      "/internal/sport-defaults?sport=canoe_polo",
    ] as const) {
      await page.goto(route);
      await dismissConsent(page);
      await expect(page.locator("main, #p2-workspace").first()).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        offenders: Array.from(document.querySelectorAll("body *"))
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            width: element.getBoundingClientRect().width,
            right: element.getBoundingClientRect().right,
          }))
          .filter(
            (item) =>
              item.right > document.documentElement.clientWidth + 0.5 ||
              item.width > document.documentElement.clientWidth + 0.5,
          )
          .slice(0, 8),
      }));
      expect(dimensions.scrollWidth, `${width}px ${route}: ${JSON.stringify(dimensions.offenders)}`).toBe(
        dimensions.clientWidth,
      );
    }
  }
});

test("results tables retain a contained scroll region on phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/organiser/competitions/singapore-open/results");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Standings and advancement" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await expect(page.getByRole("region", { name: "group a standings table" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recalculate from final results" })).toHaveCSS("min-height", "44px");
});

test("capacity controls preserve touch targets while the hydrated source stays revision-safe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  const surface = page.getByTestId("phase3-capacity");
  await expect(surface).toBeVisible();
  await expect(page.getByText("Capacity revision")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save capacity" })).toBeDisabled();
  await page.getByLabel("Area name").fill("Pool Alpha");
  await expect(page.getByRole("button", { name: "Save capacity" })).toBeEnabled();
  const controls = surface.locator("button:visible, input:visible");
  for (let index = 0; index < (await controls.count()); index += 1) {
    const box = await controls.nth(index).boundingBox();
    expect(box?.height ?? 0, `capacity control ${index}`).toBeGreaterThanOrEqual(44);
  }
});

test("settings controls preserve 44 CSS pixel targets and reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Competition settings" })).toBeVisible();
  const settings = page.getByTestId("phase3-settings");
  const controls = settings.locator("button:visible, select:visible, input[type=number]:visible");
  const count = await controls.count();
  expect(count).toBeGreaterThan(4);
  for (let index = 0; index < count; index += 1) {
    const box = await controls.nth(index).boundingBox();
    expect(box?.height ?? 0, `control ${index}`).toBeGreaterThanOrEqual(44);
  }
  const primary = page.getByTestId("phase3-primary-action");
  await expect(primary).toHaveCSS("border-top-style", "solid");
  const previous = page.getByLabel("Previous competition");
  const previousBox = await previous.boundingBox();
  expect(previousBox?.height ?? 0).toBeGreaterThanOrEqual(48);
  const toggleTarget = page.getByLabel("Manual event time").locator("..");
  const toggleBox = await toggleTarget.boundingBox();
  expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("decision rail stays in flow at the 900 CSS pixel boundary and sticks when the workspace has room", async ({
  page,
}) => {
  for (const [width, expected] of [
    [900, "static"],
    [901, "static"],
    [1200, "sticky"],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/organiser/competitions/singapore-open/settings");
    await dismissConsent(page);
    await expect(page.getByLabel("Settings tools")).toHaveCSS("position", expected);
  }
});
