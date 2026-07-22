import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("phase 4 setup and format visual baselines", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") await page.setViewportSize({ width: 1568, height: 1003 });
  await page.goto("/organiser/competitions/singapore-open/setup?step=capacity");
  await dismissConsent(page);
  await hidePrivacyControl(page);
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("phase-4-assisted-setup.png", {
    animations: "disabled",
    fullPage: true,
  });

  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  await hidePrivacyControl(page);
  await expect(page.getByTestId("phase4-format-designer")).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("phase-4-format-designer.png", {
    animations: "disabled",
    fullPage: true,
  });
});

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
}

async function hidePrivacyControl(page: import("@playwright/test").Page) {
  const control = page.getByRole("button", { name: "Privacy choices" });
  if (await control.isVisible())
    await control.evaluate((element) => {
      element.setAttribute("hidden", "");
    });
}
