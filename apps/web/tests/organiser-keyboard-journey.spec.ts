import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { dismissConsent, installConsoleGuard, assertConsoleGuard } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";

test("@a11y organiser competition creation walkthrough completes with keyboard only", async ({ page }) => {
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
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: competitionId,
          status: "draft",
          sport_code: "canoe_polo",
          revision: 1,
          account_default_applied: false,
        }),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  // Focus starts on or near the form; tab into the first field
  await page.getByLabel("Competition name").focus();
  await page.keyboard.type("Keyboard Invitational 2027");

  // Tab into Public address (slug)
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Public address")).toBeFocused();
  await expect(page.getByLabel("Public address")).toHaveValue("keyboard-invitational-2027");

  // Tab into Sport select
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Sport")).toBeFocused();
  await page.getByLabel("Sport").selectOption("canoe_polo");

  // Tab to Continue button and press Enter
  await page.keyboard.press("Tab");
  const continueButtonStep1 = page.getByRole("button", { name: "Continue" });
  await expect(continueButtonStep1).toBeFocused();
  await page.keyboard.press("Enter");

  // Verify transition to Step 2 (Venue)
  await expect(page.getByRole("heading", { level: 2, name: "Venue" })).toBeVisible();
  await expect(page.getByLabel("Venue name")).toBeFocused();

  // Type Venue name
  await page.keyboard.type("Kallang Water Sports Centre");

  // Tab into Address
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Address")).toBeFocused();
  await page.keyboard.type("10 Stadium Boulevard");

  // Tab into City or locality (optional)
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/City or locality/i)).toBeFocused();
  await page.keyboard.type("Singapore");

  // Tab into Country Code
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Country code")).toBeFocused();

  // Tab to Back button
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Back" })).toBeFocused();

  // Tab to Continue button and press Enter
  await page.keyboard.press("Tab");
  const continueButtonStep2 = page.getByRole("button", { name: "Continue" });
  await expect(continueButtonStep2).toBeFocused();
  await page.keyboard.press("Enter");

  // Verify transition to Step 3 (Dates and time)
  await expect(page.getByRole("heading", { level: 2, name: "Dates and time" })).toBeVisible();
  await expect(page.getByLabel("Start date")).toBeFocused();

  // Run full WCAG A/AA accessibility scan on Step 3
  await assertNoWcagAOrAaViolations(page);

  // Fill Step 3
  await page.getByLabel("Start date").fill("2027-06-01");
  await page.getByLabel("End date").fill("2027-06-02");

  await page.getByLabel("Time zone").focus();
  await expect(page.getByLabel("Time zone")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Locale")).toBeFocused();

  // Tab to Back button
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Back" })).toBeFocused();

  // Tab to Create competition submit button
  await page.keyboard.press("Tab");
  const submitButton = page.getByRole("button", { name: "Create competition" });
  await expect(submitButton).toBeFocused();
  await page.keyboard.press("Enter");

  // Verify successful keyboard submission redirects to competition setup
  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});
