import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

const slotLength = "More about match slot (minutes)";
const slotExplanation = "Time allocated per match slot, including changeover. Typically 30 or 45 minutes.";

test("@a11y info tips open by keyboard and tap, close on Escape and outside click", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);

  const button = page.getByRole("button", { name: slotLength }).first();
  const popover = page.getByText(slotExplanation).first();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(popover).toBeHidden();

  // The secondary explanation never leaks into the field's accessible name.
  await expect(page.getByRole("textbox", { name: "Match slot (minutes)", exact: true }).first()).toBeVisible();

  // 48px target.
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(48);
  expect(box?.height).toBeGreaterThanOrEqual(48);

  // Keyboard: focus, Enter opens, Escape closes and keeps focus on the button.
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  const controls = await button.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  await expect(button).toHaveAttribute("aria-describedby", controls!);
  await assertNoWcagAOrAaViolations(page);
  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(popover).toBeHidden();
  await expect(button).toBeFocused();

  // Pointer/tap toggles; a click outside closes.
  await button.click();
  await expect(popover).toBeVisible();
  await page.getByRole("heading", { name: "Capacity", level: 1 }).click();
  await expect(popover).toBeHidden();
  await button.click();
  await expect(popover).toBeVisible();
  await button.click();
  await expect(popover).toBeHidden();

  // Opened near the right edge, the popover stays inside the viewport.
  await page.getByRole("button", { name: "More about reserve slots" }).first().click();
  const panel = page
    .getByText("This saved total applies once across this area’s available days.", { exact: false })
    .first();
  await expect(panel).toBeVisible();
  const rect = await panel.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
});

test("@a11y number fields drop leading zeros and show no spin buttons", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  const reserve = page.getByRole("textbox", { name: "Reserve slots across all days", exact: true }).first();
  await expect(reserve).toHaveAttribute("inputmode", "numeric");
  await reserve.fill("");
  await reserve.pressSequentially("010");
  await expect(reserve).toHaveValue("10");
  await reserve.fill("");
  await reserve.blur();
  await expect(reserve).toHaveValue("10");
  expect(await page.locator('main input[type="number"]').count()).toBe(0);
});

const touchProjects = new Set(["tablet-webkit", "phone-webkit", "phone-chromium"]);

test("@a11y info tips open on mouse hover, stay open over the popover, close after leaving", async ({
  page,
}, testInfo) => {
  test.skip(touchProjects.has(testInfo.project.name), "Hover is a fine-pointer behaviour; touch projects tap.");
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);

  const button = page.getByRole("button", { name: slotLength }).first();
  const popover = page.getByText(slotExplanation).first();
  const heading = page.getByRole("heading", { name: "Capacity", level: 1 });

  await button.hover();
  await expect(popover).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");

  // Moving the mouse from the (i) into the popover keeps it open.
  await popover.hover();
  await page.waitForTimeout(500);
  await expect(popover).toBeVisible();

  // Leaving the tip closes it after the close delay.
  await heading.hover();
  await expect(popover).toBeHidden();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // A click after hovering pins it open rather than toggling it shut.
  await button.hover();
  await expect(popover).toBeVisible();
  await button.click();
  await expect(popover).toBeVisible();
  await heading.hover();
  await page.waitForTimeout(500);
  await expect(popover).toBeVisible();
  // A second click closes the pinned tip.
  await button.click();
  await expect(popover).toBeHidden();
});

test("@a11y info tips toggle on tap for touch devices", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "Tap needs a touch-enabled project.");
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);

  const button = page.getByRole("button", { name: slotLength }).first();
  const popover = page.getByText(slotExplanation).first();
  await button.tap();
  await expect(popover).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await button.tap();
  await expect(popover).toBeHidden();
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test("@a11y info tips toggle with Enter and Space and Escape returns focus", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);

  const button = page.getByRole("button", { name: slotLength }).first();
  const popover = page.getByText(slotExplanation).first();
  await button.focus();

  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(popover).toBeHidden();

  await page.keyboard.press("Space");
  await expect(popover).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(button).toBeFocused();
});
