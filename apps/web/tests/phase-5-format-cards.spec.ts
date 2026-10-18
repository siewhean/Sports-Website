import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

// Unlisted demo competition whose divisions have entries and saved recommendations (lib/phase2.ts).
const formatPath = "/organiser/competitions/singapore-open-format/format";
const competitionId = "cmp_sgopen_format_2026";

test.beforeEach(async ({ page, context, baseURL }) => {
  installConsoleGuard(page);
  await context.addCookies([{ name: "matchday-redesign-p5-cards", value: "1", url: baseURL ?? "http://127.0.0.1" }]);
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

test("Phase 5 format cards show the domain numbers and apply the chosen format", async ({ page }) => {
  let appliedRecommendationId: string | null = null;
  let applyBody: unknown = null;

  await page.route("**/api/phase4/competitions/*/v1-format-recommendations/*/apply", async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split("/");
    const recommendationId = segments[segments.length - 2] ?? "balanced-groups";
    appliedRecommendationId = recommendationId;
    applyBody = route.request().postDataJSON();

    // Answer with the demo setup document (valid by construction) with the chosen card saved.
    const resume = await page.request.post(`/api/phase4/competitions/${competitionId}/setup-draft/resume`, {
      data: { idempotency_key: "phase5-format-cards-resume" },
    });
    expect(resume.ok()).toBe(true);
    const document = await resume.json();
    document.values.format_recommendations.selected_recommendation_id = recommendationId;
    const chosen = document.values.format_recommendations.recommendations.find(
      (recommendation: { id: string }) => recommendation.id === recommendationId,
    );

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document,
        materialised: chosen.division_formats.map((division: { format_revision_id: string }) => ({
          revision: { revision_id: division.format_revision_id },
          materialised: true,
        })),
      }),
    });
  });

  await page.goto(formatPath);
  await dismissConsent(page);

  const container = page.getByTestId("v1-format-picker");
  await expect(container).toBeVisible();
  await expect(container.getByRole("heading", { level: 1, name: "Format for Open division" })).toBeVisible();
  // The subhead counts the cards shown, and each division has exactly one tab.
  await expect(container.getByText(/Here are two ways to run it/)).toBeVisible();
  await expect(container.getByRole("button", { name: /^Open division/ })).toHaveCount(1);

  // The demo setup document holds two recommendations; the first is the saved choice.
  const cards = container.locator("article");
  await expect(cards).toHaveCount(2);
  const balanced = cards.nth(0);
  const compact = cards.nth(1);
  await expect(balanced.getByRole("button", { name: "Current format" })).toBeVisible();

  // Open division numbers come from that division's row; slots used are for both divisions combined.
  await expect(balanced.locator("dd")).toHaveText(["16", "3", "31 / 36", "Yes"]);
  await expect(compact.locator("dd")).toHaveText(["12", "2", "23 / 36", "Yes"]);

  // Switching division swaps in that division's numbers and editor link.
  await container.getByRole("button", { name: "Women's division · 8" }).click();
  await expect(container.getByRole("heading", { level: 1, name: "Format for Women's division" })).toBeVisible();
  await expect(balanced.locator("dd")).toHaveText(["15", "3", "31 / 36", "Yes"]);
  await expect(compact.getByRole("link", { name: "Customise" })).toHaveAttribute(
    "href",
    "/organiser/competitions/cmp_sgopen_format_2026/format?division=fd16448b-61ab-4dd0-a0a1-b61e77fd5c3a&mode=editor",
  );

  // Choosing the other card sends it to the apply endpoint and marks it as the current format.
  await compact.getByRole("button", { name: "Use this format" }).click();
  await expect(compact.getByRole("button", { name: "Current format" })).toBeVisible();
  await expect(balanced.getByRole("button", { name: "Use this format" })).toBeVisible();
  expect(appliedRecommendationId).toBe("compact-knockout");
  expect(applyBody).toEqual({ idempotency_key: expect.any(String) });
});

test("@a11y Phase 5 format recommendation cards have no WCAG A or AA violations", async ({ page }) => {
  await page.goto(formatPath);
  await dismissConsent(page);
  await expect(page.getByTestId("v1-format-picker")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("Phase 5 format cards visual baseline", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.goto(formatPath);
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
  await page.goto(formatPath);
  await dismissConsent(page);
  await hidePersistentPrivacyControl(page);
  await expect(page.getByTestId("v1-format-picker")).toBeVisible();
  await expect(page).toHaveScreenshot("phase-5-format-cards-mobile.png", {
    fullPage: true,
    animations: "disabled",
  });
});
