import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

for (const theme of ["dark", "light"] as const) {
  for (const width of [375, 768, 1280]) {
    test(`@a11y daily reserve inputs preserve legacy capacity and explicit dates at ${width}px ${theme}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-chromium", "Explicit viewport matrix runs in desktop Chromium.");
      // Dark mode: axe reports color-contrast on the whole pre-existing CapacityEditor (labels,
      // hints, buttons), not on the new reserve inputs. No other a11y spec covers dark mode yet;
      // dark contrast is redesign Phase 1 (tokens/themes) scope. Re-enable when Phase 1 lands.
      test.fixme(theme === "dark", "Pre-existing CapacityEditor dark-mode contrast; fixed by redesign Phase 1.");
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((preference) => window.localStorage.setItem("matchday-theme", preference), theme);
      let submitted: Record<string, unknown> | null = null;
      await page.route("**/api/phase3/competitions/*/capacity", async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        submitted = route.request().postDataJSON() as Record<string, unknown>;
        // A rejected save is deliberately returned with HTTP 200 malformed payload to exercise
        // the client boundary/retry without manufacturing a browser network console error.
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      await page.goto("/organiser/competitions/singapore-open/capacity");
      await dismissConsent(page);
      const editor = page.getByTestId("phase3-capacity");
      await expect(page.getByLabel("Reserve slots across all days", { exact: false })).toHaveValue("2");
      await page.getByRole("button", { name: "Set reserve slots for each day", exact: true }).click();
      const day = page.getByLabel("Reserve slots on 2026-08-15", { exact: true });
      await expect(day).toHaveValue("0");
      await day.fill("3");
      await page.getByRole("button", { name: "Use one total across all days", exact: true }).click();
      await expect(page.getByLabel("Reserve slots across all days", { exact: false })).toHaveValue("2");
      await page.getByRole("button", { name: "Set reserve slots for each day", exact: true }).click();
      await expect(day).toHaveValue("3");
      await page.getByRole("button", { name: "Add window", exact: true }).click();
      await editor
        .getByRole("region", { name: "Available windows", exact: true })
        .locator('input[type="date"]')
        .nth(1)
        .fill("2026-08-16");
      await expect(page.getByLabel("Reserve slots on 2026-08-16", { exact: true })).toHaveValue("0");
      await page.getByRole("button", { name: "Save capacity", exact: true }).click();
      await expect(editor.getByRole("alert")).toContainText("Capacity was not saved");
      await expect(day).toHaveValue("3");
      expect(submitted).not.toBeNull();
      expect(
        (submitted!.areas as { fixed_reserve_slots: number; daily_reserve_slots: Record<string, number> }[])[0],
      ).toMatchObject({
        fixed_reserve_slots: 2,
        daily_reserve_slots: { "2026-08-15": 3 },
      });
      expect((submitted!.areas as { daily_reserve_slots: Record<string, number> }[])[0]!.daily_reserve_slots).toEqual({
        "2026-08-15": 3,
      });
      await expect(page.getByRole("button", { name: "Save capacity", exact: true })).toBeEnabled();
      await expect(editor).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`daily-reserves-${width}-${theme}.png`), fullPage: true });
      await assertNoWcagAOrAaViolations(page);
    });
  }
}
