import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page, context }) => {
  installConsoleGuard(page);
  await context.addCookies([
    {
      name: "matchday-redesign-p5-cards",
      value: "1",
      path: "/",
      domain: "localhost",
    },
  ]);
});

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function hidePersistentPrivacyControl(page: import("@playwright/test").Page) {
  const control = page.locator(".consent-reopen");
  if (await control.count()) await control.evaluate((element) => element.setAttribute("hidden", ""));
  const privacyButton = page.getByRole("button", { name: "Privacy choices" });
  if (await privacyButton.isVisible()) {
    await privacyButton.evaluate((element) => element.setAttribute("hidden", ""));
  }
}

test("Phase 5 format recommendation cards render, allow choosing format, and persist selection", async ({ page }) => {
  let appliedRecommendationId: string | null = null;

  await page.route("**/api/phase4/competitions/*/v1-format-recommendations/*/apply", async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split("/");
    const recommendationId = segments[segments.length - 2] ?? "balanced-groups";
    appliedRecommendationId = recommendationId;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document: {
          schema_version: 1,
          id: "0cc48815-adc6-4bda-838f-3b52eb8c7862",
          organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
          competition_id: "singapore-open",
          competition_status: "draft",
          revision: 1,
          status: "active",
          current_step: "format_recommendations",
          completed_steps: ["basics", "capacity", "settings", "entries", "format_preferences"],
          steps: [],
          values: {
            basics: null,
            capacity: null,
            settings: null,
            entries: null,
            format_preferences: null,
            format_recommendations: {
              recommendations: [
                {
                  id: "balanced-groups",
                  format_revision_id: "7b47b425-450e-436f-8557-4f932f9958ee",
                  format_definition_hash: "demo-format-balanced",
                  name: "Full placement",
                  structure: "2 divisions · full placement",
                  advantage: "Balances game time across divisions.",
                  match_count: 24,
                  minimum_matches_per_entry: 3,
                  guaranteed_matches: 3,
                  ranking_coverage: "all_entries",
                  available_match_slots: 36,
                  division_formats: [
                    {
                      division_id: "a641f08e-23de-4611-8893-01bfebf42684",
                      candidate_division_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c1",
                      format_revision_id: "7b47b425-450e-436f-8557-4f932f9958ee",
                      format_definition_hash: "demo-format-balanced",
                      match_count: 12,
                      guaranteed_matches: 3,
                      ranking_coverage: "all_entries",
                    },
                    {
                      division_id: "fd16448b-61ab-4dd0-a0a1-b61e77fd5c3a",
                      candidate_division_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c2",
                      format_revision_id: "7b47b425-450e-436f-8557-4f932f9958ef",
                      format_definition_hash: "demo-format-balanced-women",
                      match_count: 12,
                      guaranteed_matches: 3,
                      ranking_coverage: "all_entries",
                    },
                  ],
                  capacity_status: "fits",
                  scheduling_status: "feasible",
                  warning_codes: [],
                },
                {
                  id: "compact-knockout",
                  format_revision_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c8",
                  format_definition_hash: "demo-format-compact",
                  name: "Compact knockout",
                  structure: "2 divisions · compact knockout",
                  advantage: "Finishes earlier while preserving final rankings.",
                  match_count: 23,
                  minimum_matches_per_entry: 2,
                  guaranteed_matches: 2,
                  ranking_coverage: "all_entries",
                  available_match_slots: 36,
                  division_formats: [
                    {
                      division_id: "a641f08e-23de-4611-8893-01bfebf42684",
                      candidate_division_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c1",
                      format_revision_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c8",
                      format_definition_hash: "demo-format-compact",
                      match_count: 12,
                      guaranteed_matches: 2,
                      ranking_coverage: "all_entries",
                    },
                    {
                      division_id: "fd16448b-61ab-4dd0-a0a1-b61e77fd5c3a",
                      candidate_division_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c2",
                      format_revision_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c9",
                      format_definition_hash: "demo-format-compact-women",
                      match_count: 11,
                      guaranteed_matches: 2,
                      ranking_coverage: "all_entries",
                    },
                  ],
                  capacity_status: "fits",
                  scheduling_status: "feasible",
                  warning_codes: [],
                },
              ],
              requires_changes: null,
              selected_recommendation_id: recommendationId,
              acknowledged_capacity_shortfall: false,
              recommendation_set_hash: "demo-recommendation-set",
            },
            schedule_review: null,
            review_publish: null,
          },
          permission: "write",
          read_only: false,
          autosave: {
            status: "saved",
            last_saved_at: "2026-07-20T06:18:00.000Z",
            expires_at: "2026-08-19T06:18:00.000Z",
          },
          created_at: "2026-07-20T05:50:00.000Z",
          updated_at: "2026-07-20T06:18:00.000Z",
          completed_at: null,
        },
        materialised: [
          { revision: { revision_id: "7b47b425-450e-436f-8557-4f932f9958ee" }, materialised: true },
          { revision: { revision_id: "7b47b425-450e-436f-8557-4f932f9958ef" }, materialised: true },
        ],
      }),
    });
  });

  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);

  // 1. Verify 3-card recommendation container is mounted
  const container = page.getByTestId("v1-format-picker");
  await expect(container).toBeVisible();

  // 2. Format recommendation cards are displayed
  const cards = container.locator("article");
  await expect(cards).toHaveCount(2);

  // 3. Check "Use this format" button on second card
  const secondCardUseBtn = cards.nth(1).getByRole("button", { name: "Use this format" });
  await expect(secondCardUseBtn).toBeVisible();
  await secondCardUseBtn.click();

  // 4. Verify apply endpoint was called with the recommendation id and button reflects current format
  expect(appliedRecommendationId).toBe("compact-knockout");
  await expect(cards.nth(1).getByRole("button", { name: "Current format" })).toBeVisible();

  // 5. Verify customise link points to editor with active division
  const customiseLink = cards.first().getByRole("link", { name: "Customise" });
  await expect(customiseLink).toHaveAttribute("href", /mode=editor/);
});

test("@a11y Phase 5 format recommendation cards have no WCAG A or AA violations", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  await expect(page.getByTestId("v1-format-picker")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("Phase 5 format cards visual baseline", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  await hidePersistentPrivacyControl(page);
  await expect(page.getByTestId("v1-format-picker")).toBeVisible();
  await expect(page).toHaveScreenshot("phase-5-format-cards-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("Phase 5 format cards mobile visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  await hidePersistentPrivacyControl(page);
  await expect(page.getByTestId("v1-format-picker")).toBeVisible();
  await expect(page).toHaveScreenshot("phase-5-format-cards-mobile.png", {
    fullPage: true,
    animations: "disabled",
  });
});
