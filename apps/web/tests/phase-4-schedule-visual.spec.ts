import { expect, test } from "@playwright/test";
import { dismissConsent } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

test("phase 4 schedule visual baselines", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") await page.setViewportSize({ width: 1568, height: 1003 });
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  await hidePrivacyControl(page);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  await expect(page).toHaveScreenshot("phase-4-schedule.png", { animations: "disabled", fullPage: true });
});

test("phase 4 move flow visual baselines", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") await page.setViewportSize({ width: 1200, height: 900 });
  await page.route("**/moves/validate", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        validation: { valid: true, violations: [] },
        assignments: [],
        consequences: {
          moved_match_id: "match",
          from: null,
          to: null,
          affected_match_ids: ["match"],
          dependency_match_ids: [],
          locked_match_ids: [],
          messages: ["Only the selected slot changes."],
          quality: null,
        },
      }),
    }),
  );
  await page.goto(
    "/organiser/competitions/singapore-open/schedule/revisions/70000000-0000-4000-8000-000000000004/matches/30000000-0000-4000-8000-000000000001/move",
  );
  await dismissConsent(page);
  await hidePrivacyControl(page);
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  await expect(page.getByText("Only the selected slot changes.")).toBeVisible();
  await expect(page).toHaveScreenshot("phase-4-schedule-move.png", { animations: "disabled", fullPage: true });
});

async function hidePrivacyControl(page: import("@playwright/test").Page) {
  const control = page.getByRole("button", { name: "Privacy choices" });
  if (await control.isVisible())
    await control.evaluate((element) => {
      element.setAttribute("hidden", "");
    });
}
