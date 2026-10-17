import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

/**
 * Redesign Phase 4 Setup → Rules. The `redesign_p4_rules` flag stays off in this demo server, so the tests opt in
 * with the local-only preview cookie; without it the classic sport settings editor is shown.
 */
test.use({ serviceWorkers: "block" });

const settings = "/organiser/competitions/singapore-open/settings";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("without the flag the classic sport settings editor is shown", async ({ page }) => {
  await page.goto(settings);
  await dismissConsent(page);
  await expect(page.getByTestId("rules-page")).toHaveCount(0);
});

test.describe("with the rules preview", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: "matchday-redesign-rules", value: "1", url: baseURL ?? "http://127.0.0.1" }]);
  });

  test("shows grouped rules with defaults, sources, Changed and Reset", async ({ page }) => {
    await page.goto(settings);
    await dismissConsent(page);
    const rules = page.getByTestId("rules-page");
    await expect(rules).toBeVisible();
    // Canoe polo has no scoring targets, so its Scoring group is left out; the other plan groups are shown in order.
    const headings = await rules.getByRole("heading", { level: 3 }).allTextContents();
    expect(headings.slice(0, 4)).toEqual(["Time", "Discipline", "Standings & tie-breaks", "Forfeits"]);
    await expect(rules.getByRole("heading", { level: 3, name: "Scoring" })).toHaveCount(0);
    await expect(rules.getByRole("button", { name: /Where the shot clock .* rule comes from/u })).toBeVisible();

    const period = page.getByTestId("rule-periodDurationMinutes");
    await expect(period).toContainText("Federation default: 10");
    await expect(period).toHaveAttribute("data-changed", "false");
    await expect(period.getByRole("button", { name: /Reset/u })).toHaveCount(0);

    await period.getByLabel("Period length (minutes)", { exact: true }).fill("7");
    await expect(period).toHaveAttribute("data-changed", "true");
    await expect(period.getByText("Changed", { exact: true })).toBeVisible();
    await expect(page.getByTestId("rules-save")).toBeEnabled();
    await period.getByRole("button", { name: /Reset .* to its default/u }).click();
    await expect(period).toHaveAttribute("data-changed", "false");
    await expect(period.getByLabel("Period length (minutes)", { exact: true })).toHaveValue("10");

    // A MATCHDAY setting, not a federation rule, says so.
    await expect(page.getByTestId("rule-slotMinutes")).toContainText("MATCHDAY default");

    await expect(page.getByTestId("rules-tiebreaks")).toContainText("are ranked by most points");
    await expect(page.getByTestId("rules-history")).toContainText("Rules changes");
    await expect(page.getByTestId("rules-history")).toContainText("No rules have been changed yet.");
    await assertNoWcagAOrAaViolations(page);
  });

  test("fits a 375 px phone without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(settings);
    await dismissConsent(page);
    await expect(page.getByTestId("rules-page")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
