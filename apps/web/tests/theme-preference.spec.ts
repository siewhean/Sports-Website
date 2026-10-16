import { expect, test, type Page } from "@playwright/test";
import { designTokens, messages } from "@matchday/ui";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

// Theme preference (owner decision D10): Dark by default, Light, or Same as device, applied before first paint.
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  // Record the theme and page background on the first animation frame, which runs before the first paint.
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      const root = document.documentElement;
      (window as unknown as { __firstFrame: unknown }).__firstFrame = {
        theme: root.getAttribute("data-theme"),
        canvas: getComputedStyle(root).getPropertyValue("--canvas").trim(),
        background: getComputedStyle(document.body ?? root).backgroundColor,
      };
    });
  });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

type FirstFrame = { theme: string | null; canvas: string; background: string };

async function firstFrame(page: Page): Promise<FirstFrame> {
  await page.waitForFunction(() => Boolean((window as unknown as { __firstFrame?: unknown }).__firstFrame));
  return page.evaluate(() => (window as unknown as { __firstFrame: FirstFrame }).__firstFrame);
}

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Normalises "rgb(r, g, b)" and "color(srgb r g b)" (how Chromium serialises color-mix) to "rgb(r, g, b)". */
function normaliseColour(value: string): string {
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!srgb) return value;
  return `rgb(${srgb
    .slice(1, 4)
    .map((channel) => Math.round(Number(channel) * 255))
    .join(", ")})`;
}

async function bodyBackground(page: Page): Promise<string> {
  return normaliseColour(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
}

async function themeColorMeta(page: Page): Promise<string | null> {
  return page.locator('meta[name="theme-color"]').first().getAttribute("content");
}

const darkCanvas = hexToRgb(designTokens.themeColor.dark);
const lightCanvas = hexToRgb(designTokens.themeColor.light);
const themeButton = new RegExp(`^${messages.navigation.theme}: `);

test("a clean profile renders Dark on the first frame, even on a light device", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "theme bootstrap is engine-independent");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: testInfo.outputPath("clean-profile-domcontentloaded.png") });
  const frame = await firstFrame(page);
  expect(frame.theme).toBe("dark");
  expect(normaliseColour(frame.background)).toBe(darkCanvas);
  await expect.poll(() => themeColorMeta(page)).toBe(designTokens.themeColor.dark);
  expect(await page.evaluate(() => localStorage.getItem("matchday-theme"))).toBeNull();
});

test("a chosen theme persists across reloads and is applied before first paint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "theme bootstrap is engine-independent");
  await page.goto("/");
  await dismissConsent(page);
  const button = page.getByRole("button", { name: themeButton }).first();
  await expect(button).toHaveAttribute("data-theme-preference", "dark");
  await button.click();
  await expect(button).toHaveAttribute("data-theme-preference", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => bodyBackground(page)).toBe(lightCanvas);
  await expect.poll(() => themeColorMeta(page)).toBe(designTokens.themeColor.light);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.screenshot({ path: testInfo.outputPath("light-after-reload-domcontentloaded.png") });
  const frame = await firstFrame(page);
  expect(frame.theme).toBe("light");
  expect(normaliseColour(frame.background)).toBe(lightCanvas);
  await expect(page.getByRole("button", { name: themeButton }).first()).toHaveAttribute(
    "data-theme-preference",
    "light",
  );

  // Cycle on to "Same as device", then back to Dark.
  await page.getByRole("button", { name: themeButton }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await page.getByRole("button", { name: themeButton }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("Same as device follows the emulated colour scheme", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "theme bootstrap is engine-independent");
  await page.addInitScript(() => localStorage.setItem("matchday-theme", "system"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const frame = await firstFrame(page);
  expect(frame.theme).toBe("system");
  expect(normaliseColour(frame.background)).toBe(lightCanvas);
  await expect.poll(() => themeColorMeta(page)).toBe(designTokens.themeColor.light);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => bodyBackground(page)).toBe(darkCanvas);
  await expect.poll(() => themeColorMeta(page)).toBe(designTokens.themeColor.dark);
  await expect(page.getByRole("button", { name: themeButton }).first()).toHaveAttribute(
    "data-theme-preference",
    "system",
  );
});

test("an unreadable saved value falls back to Dark", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "theme bootstrap is engine-independent");
  await page.addInitScript(() => localStorage.setItem("matchday-theme", "sepia"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect((await firstFrame(page)).theme).toBe("dark");
});
