import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("unsupported settings commands never report simulated success", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await page.getByLabel("Match slot").fill("36");
  await expect(page.getByText("Local draft — not saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Saving unavailable" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy previous" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save as my default" })).toBeDisabled();
  await expect(page.getByText("Settings saved as a new revision.")).toHaveCount(0);
});

test("division settings are honestly unavailable until their endpoint exists", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/settings/divisions/open");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "This settings action is not available yet" })).toBeVisible();
  await expect(page.getByTestId("phase3-settings-form")).toHaveCount(0);
});

test("settings header reports document truth and scope links expose the current page", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Competition settings" })).toBeVisible();
  await expect(
    page.getByText("Set the versioned competition baseline, then review any division-specific overrides."),
  ).toBeVisible();
  await expect(page.getByText("Revision loaded 4 · saving unavailable")).toBeVisible();
  await expect(page.getByText("Draft synced 18 seconds ago")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Competition", exact: true })).toHaveAttribute("aria-current", "page");

  await page.goto("/organiser/competitions/singapore-open/settings?state=offline");
  await expect(page.getByText("Offline — no changes saved")).toBeVisible();
});

test("defaults selector provides keyboard tab semantics without enabling admin mutations", async ({ page }) => {
  await page.goto("/internal/sport-defaults");
  await dismissConsent(page);
  const tablist = page.getByRole("tablist", { name: "Sport packs" });
  await expect(tablist).toBeVisible();
  const canoePolo = page.getByRole("tab", { name: /Canoe Polo/ });
  const badminton = page.getByRole("tab", { name: /Badminton/ });
  await canoePolo.focus();
  await canoePolo.press("ArrowRight");
  await expect(badminton).toBeFocused();
  await expect(badminton).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: /Badminton/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
});

test("competition settings preserve conflict, read-only and permission states", async ({ page }) => {
  for (const [state, heading] of [
    ["conflict", "A newer version was saved"],
    ["read-only", "Settings are read-only"],
    ["permission", "You cannot edit these settings"],
    ["error", "Settings could not be loaded"],
    ["offline", "You are offline"],
    ["empty", "No settings yet"],
  ] as const) {
    await page.goto(`/organiser/competitions/singapore-open/settings?state=${state}`);
    await dismissConsent(page);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("internal defaults admin denies mutations and renders every service state", async ({ page }) => {
  await page.goto("/internal/sport-defaults");
  await dismissConsent(page);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Activate baseline" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Edit/ })).toHaveCount(0);

  for (const [state, heading] of [
    ["permission", "Defaults administration is restricted"],
    ["error", "Defaults could not be loaded"],
    ["offline", "Administration is offline"],
    ["empty", "No provisional packs found"],
    ["conflict", "Sport-pack version changed"],
    ["expired", "Administrator session expired"],
    ["revoked", "Administrator access was revoked"],
  ] as const) {
    await page.goto(`/internal/sport-defaults?state=${state}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});
