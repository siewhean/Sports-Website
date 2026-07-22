import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("assisted setup reflows without horizontal overflow", async ({ page }, testInfo) => {
  await page.goto("/organiser/competitions/singapore-open/setup?step=capacity");
  await dismissConsent(page);
  const mobileProgress = page.getByTestId("setup-mobile-progress");
  if (testInfo.project.name.includes("phone")) {
    await expect(mobileProgress).toBeVisible();
    await expect(mobileProgress.getByText("Step 2 of 8", { exact: true })).toBeVisible();
  } else await expect(mobileProgress).toBeHidden();
  await expect(page.getByRole("button", { name: /Continue to settings/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("recommendation evidence stays accessible without phone overflow", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/setup?step=format_recommendations");
  await dismissConsent(page);
  const card = page.locator("article").filter({ hasText: "Balanced groups" });
  await expect(card.getByText("Matches", { exact: true })).toBeVisible();
  await expect(card.getByText("Minimum play", { exact: true })).toBeVisible();
  await expect(card.getByText("Ranking coverage", { exact: true })).toBeVisible();
  await expect(card.getByText("Available slots", { exact: true })).toBeVisible();
  await expect(card.getByText("Schedule", { exact: true })).toBeVisible();
  await card.getByRole("button").focus();
  await expect(card.getByRole("button")).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test("assisted setup and manual format editing reflow at 320 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const url of [
    "/organiser/competitions/singapore-open/setup?step=format_recommendations",
    "/organiser/competitions/singapore-open/format",
  ]) {
    await page.goto(url);
    await dismissConsent(page);
    if (url.endsWith("/format")) {
      await expect(page.getByRole("button", { name: /Manual/ })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("heading", { name: "Stages and advancement" })).toBeVisible();
    } else {
      await expect(page.getByTestId("setup-mobile-progress")).toBeVisible();
      await expect(page.locator("article").filter({ hasText: "Balanced groups" })).toBeVisible();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      url,
    ).toBeLessThanOrEqual(1);
  }
});

test("format designer defaults to structured manual mode on phones", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("phone"), "Phone-only default");
  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  await expect(page.getByRole("button", { name: /Manual/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Stages and advancement" })).toBeVisible();
  await expect(page.getByTestId("format-canvas")).toBeHidden();
  const finalRow = page.locator('[data-stage-index="4"]');
  const validationBar = page.getByTestId("format-validation-bar");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const [finalBox, barBox] = await Promise.all([finalRow.boundingBox(), validationBar.boundingBox()]);
  expect(finalBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  expect((finalBox?.y ?? 0) + (finalBox?.height ?? 0)).toBeLessThanOrEqual((barBox?.y ?? 0) - 8);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("format designer tablet keeps the complete graph and inspector reachable", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("tablet"), "Tablet reachability only");
  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  const canvas = page.getByTestId("format-canvas");
  const finalStage = canvas.locator('[data-stage-id="stage-final"]');
  const inspector = page.getByRole("complementary", { name: "Stage inspector" });
  await expect(canvas).toBeVisible();
  await expect(inspector).toBeVisible();
  expect(await canvas.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await finalStage.scrollIntoViewIfNeeded();
  await finalStage.click();
  await expect(inspector.locator("input").first()).toHaveValue("Final");
  const [canvasBox, finalBox] = await Promise.all([canvas.boundingBox(), finalStage.boundingBox()]);
  expect(canvasBox).not.toBeNull();
  expect(finalBox).not.toBeNull();
  expect(finalBox!.x).toBeGreaterThanOrEqual(canvasBox!.x);
  expect(finalBox!.x + finalBox!.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});
