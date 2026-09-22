import { expect, test } from "@playwright/test";
import { dismissConsent } from "./helpers/console-guard";

test("unfinished competition creation survives navigation and reload", async ({ page }) => {
  // Mock org API: return empty list so Continue is enabled (bootstrap path, no org selector)
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    } else {
      await route.fallback();
    }
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  // Step 0: fill name (auto-derives slug) and select sport to pass validation
  await page.getByLabel("Competition name").fill("Saved Draft Cup");
  await page.getByLabel("Public address").fill("saved-draft-cup");
  await page.getByLabel("Sport").selectOption("badminton");

  // Advance to step 1 (Venue)
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 1: Venue
  await page.getByLabel("Venue").fill("Draft Arena");

  // Navigate away and back (route mock persists in this page context)
  await page.goto("/");
  await page.goto("/organiser/competitions/new");

  // Should restore step 0 fields immediately
  await expect(page.getByLabel("Competition name")).toHaveValue("Saved Draft Cup");
  await expect(page.getByLabel("Public address")).toHaveValue("saved-draft-cup");

  // Advance to step 1 and verify venue persisted
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Venue")).toHaveValue("Draft Arena");

  // Navigate to step 0, reload, verify step 0 fields still present
  await page.getByRole("button", { name: "Back" }).click();
  await page.reload();

  await expect(page.getByLabel("Competition name")).toHaveValue("Saved Draft Cup");
  await expect(page.getByLabel("Public address")).toHaveValue("saved-draft-cup");
});
