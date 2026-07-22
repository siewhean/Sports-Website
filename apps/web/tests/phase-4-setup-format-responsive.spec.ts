import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("assisted setup reflows without horizontal overflow", async ({ page }, testInfo) => {
  await page.goto("/organiser/competitions/singapore-open/setup?step=capacity");
  await dismissConsent(page);
  const mobileProgress = page.getByTestId("setup-mobile-progress");
  if (testInfo.project.name.includes("phone")) await expect(mobileProgress).toBeVisible();
  else await expect(mobileProgress).toBeHidden();
  await expect(page.getByRole("button", { name: /Continue to settings/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
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
