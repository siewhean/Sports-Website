import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const sports = ["Canoe Polo", "Badminton", "Table Tennis", "Volleyball", "Basketball"];

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

for (const width of [1440, 390]) {
  test(`home hero and journey navigation work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await dismissConsent(page);
    const hero = page.locator('section[aria-labelledby="home-title"]');
    await expect(hero.getByRole("heading", { level: 1 })).toBeVisible();
    const list = hero.getByRole("list", { name: "Supported launch sports" });
    await expect(list.getByRole("listitem")).toHaveText(sports);
    await expect(hero.locator('ul[aria-hidden="true"]')).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBe(0);
    const navigation = page.locator("header").getByRole("navigation", { name: "Choose what to do" });
    for (const [label, href] of [
      ["View results", "/competitions"],
      ["Play a game", "/play"],
      ["Organise", "/organiser"],
      ["Officiate", "/official"],
    ]) {
      await expect(navigation.getByRole("link", { name: label, exact: true })).toBeVisible();
      await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href!);
    }
    await hero.getByRole("link", { name: "Play a game" }).click();
    await expect(page).toHaveURL(/\/play$/u);
    await page.goto("/");
    await page.locator("header").getByRole("link", { name: "View results", exact: true }).click();
    await expect(page).toHaveURL(/\/competitions$/u);
  });
}

test("hero banner scrolls and supports keyboard pause, resume and focus pause", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await dismissConsent(page);
  const track = page.getByRole("list", { name: "Supported launch sports" }).locator("..");
  const pause = page.getByRole("button", { name: "Pause sports banner" });
  await page.mouse.move(0, 0);
  const initial = await track.evaluate((element) => getComputedStyle(element).transform);
  await expect.poll(() => track.evaluate((element) => getComputedStyle(element).transform)).not.toBe(initial);
  await track.locator("..").hover();
  await expect(track).toHaveCSS("animation-play-state", "paused");
  await page.mouse.move(0, 0);
  await expect(track).toHaveCSS("animation-play-state", "running");
  await pause.focus();
  await expect(track).toHaveCSS("animation-play-state", "paused");
  await page.keyboard.press("Enter");
  const resume = page.getByRole("button", { name: "Resume sports banner" });
  await expect(resume).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(track).toHaveCSS("animation-play-state", "paused");
  const paused = await track.evaluate((element) => getComputedStyle(element).transform);
  await page.waitForTimeout(200);
  await expect(track).toHaveCSS("transform", paused);
  await resume.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(track).toHaveCSS("animation-play-state", "running");
  await expect.poll(() => track.evaluate((element) => getComputedStyle(element).transform)).not.toBe(paused);
});

test("reduced motion presents one static wrapped sports list on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await dismissConsent(page);
  const hero = page.locator('section[aria-labelledby="home-title"]');
  const list = hero.getByRole("list", { name: "Supported launch sports" });
  await expect(list.getByRole("listitem")).toHaveText(sports);
  await expect(list.locator("..")).toHaveCSS("animation-name", "none");
  await expect(list).toHaveCSS("flex-wrap", "wrap");
  await expect(hero.locator('ul[aria-hidden="true"]')).toBeHidden();
  await expect(page.getByRole("button", { name: "Pause sports banner" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
