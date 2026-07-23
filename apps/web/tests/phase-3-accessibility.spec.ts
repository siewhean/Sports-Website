import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("@a11y sport settings editor has no WCAG A or AA accessibility violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/settings");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Competition settings" })).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y sport defaults admin identifies provisional authority accessibly", async ({ page }) => {
  await page.goto("/internal/sport-defaults?sport=canoe_polo");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Sport-pack defaults" })).toBeVisible();
  await expect(page.getByText("Product recommendation — not a federation profile")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y capacity status and lossless source editor are accessible", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Capacity" })).toBeVisible();
  await expect(page.getByText("Capacity revision")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y division and entry controls are accessible", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/entries");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Divisions and entries" })).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y competition creation preserves recovery context and strict WCAG A/AA", async ({ page }) => {
  allowConsoleFailure(page, /^console\.error: Failed to load resource: the server responded with a status of 503/);
  let organisationReads = 0;
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    organisationReads += 1;
    if (organisationReads === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "API_UNAVAILABLE", message: "Unavailable" } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
          name: "National Sports",
          role: "organiser",
        },
      ]),
    });
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Competition name").fill("National Open");
  await expect(page.getByRole("alert").filter({ hasText: "Your organisations could not be loaded" })).toBeVisible();
  await page.getByRole("button", { name: "Retry organisation list" }).click();
  const organisation = page.getByLabel("Organisation");
  await expect(organisation).toBeEnabled();
  await organisation.selectOption({ label: "National Sports · Organiser" });
  await expect(page.getByLabel("Competition name")).toHaveValue("National Open");

  await page.getByRole("button", { name: "Create competition" }).click();
  await expect(page.getByLabel("Public address")).toBeFocused();
  await expect(page.getByRole("alert").filter({ hasText: "Check the highlighted competition detail" })).toBeVisible();
  await page.getByLabel("Public address").fill("national-open");
  await expect(page.getByRole("alert").filter({ hasText: "Check the highlighted competition detail" })).toHaveCount(0);
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y standings evidence and advancement conflicts are accessible", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Standings and advancement" })).toBeVisible();
  await expect(page.getByText("A correction needs organiser review")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});
