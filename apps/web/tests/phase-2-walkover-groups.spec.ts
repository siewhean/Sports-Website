import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

// R2.5 presentation decisions (ADR 0008): walkovers show a "W/O" badge next to the winner with the forfeit score in
// the match detail, and a multi-group division renders one captioned standings table per group.
const slug = "singapore-open-groups";
const viewports = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 834, height: 1194 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const viewport of viewports) {
  test(`@a11y walkover badge and per-group standings on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto(`/competitions/${slug}?tab=schedule`);
    await dismissConsent(page);
    const fixture = page.locator('[data-match-id="M11"]').first();
    await expect(fixture).toBeVisible();
    await expect(fixture.locator("[data-walkover]")).toHaveCount(1);
    await expect(fixture.getByText("W/O", { exact: true })).toBeVisible();
    await expect(fixture.getByText("Kallang Current won by walkover")).toBeAttached();
    await capture(page, testInfo, `walkover-schedule-${viewport.name}`);
    await assertNoWcagAOrAaViolations(page);

    await page.getByRole("tab", { name: "Table", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Group A", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Group B", exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(2);
    await expect(page.getByRole("table", { name: /Group A standings/ })).toBeVisible();
    await expect(page.getByRole("table", { name: /Group B standings/ })).toBeVisible();
    await capture(page, testInfo, `group-tables-${viewport.name}`);
    await assertNoWcagAOrAaViolations(page);

    await page.goto(`/competitions/${slug}/matches/M11`);
    await expect(page.getByText("W/O (Forfeit score: 5–0)")).toBeVisible();
    await capture(page, testInfo, `walkover-detail-${viewport.name}`);
    await assertNoWcagAOrAaViolations(page);
  });
}
