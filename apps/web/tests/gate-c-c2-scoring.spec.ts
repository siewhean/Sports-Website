import { expect, test, type Page } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const sports = [
  { id: "canoe_polo", name: "Canoe Polo", action: "Goal Marina Blue", participant: true, manualTime: true },
  { id: "badminton", name: "Badminton", action: "Point Marina Blue", participant: true, manualTime: false },
  { id: "table_tennis", name: "Table Tennis", action: "Point Marina Blue", participant: true, manualTime: false },
  { id: "volleyball", name: "Volleyball", action: "Point Marina Blue", participant: false, manualTime: false },
  {
    id: "basketball",
    name: "Basketball",
    action: "Three-point score Marina Blue",
    participant: true,
    manualTime: true,
  },
] as const;

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function openScoring(page: Page, sportId: string) {
  await page.goto(`/score?sport=${sportId}`);
  await dismissConsent(page);
  await page.getByLabel("Scoring code").fill("POLO-12");
  await page.getByRole("button", { name: "Validate access" }).click();
  await page.getByRole("checkbox", { name: "I am at Match 12 and ready to score this fixture." }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();
  await expect(page.getByRole("heading", { name: "Scoring controls" })).toBeVisible();
}

for (const sport of sports) {
  test(`${sport.name} shared scorer visual baseline`, async ({ page }) => {
    await openScoring(page, sport.id);
    await expect(page).toHaveScreenshot(`gate-c-c2-${sport.id}-active-scorer.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test(`@a11y ${sport.name} uses the shared canonical scoring shell`, async ({ page }) => {
    await openScoring(page, sport.id);

    await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
    await expect(page.getByText(sport.name, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Event time")).toHaveCount(sport.manualTime ? 1 : 0);
    const trigger = page.getByRole("button", { name: sport.action });
    await expect(trigger).toHaveJSProperty("disabled", false);
    await trigger.click();
    const scrollBeforeClose = await page.evaluate(() => window.scrollY);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const participant = dialog.getByLabel("Scorer or participant name");
    if (sport.participant) {
      await expect(participant).toBeFocused();
      await participant.fill("Player 14");
    } else {
      await expect(participant).toHaveCount(0);
      await expect(dialog.getByRole("heading")).toBeFocused();
    }
    await assertNoWcagAOrAaViolations(page);
    await dialog
      .getByRole("button", { name: sport.id === "canoe_polo" ? "Record goal for Marina Blue" : "Record event" })
      .click();

    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("heading", { name: "Recent canonical events" })).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeClose);

    const reverse = page.getByRole("button", { name: "Reverse event" });
    await reverse.click();
    const reversal = page.getByRole("dialog", { name: "Reverse recorded event" });
    await expect(reversal.getByLabel("Reversal reason")).toBeFocused();
    await reversal.getByLabel("Reversal reason").fill("Recorded for the wrong side");
    await reversal.getByRole("button", { name: "Confirm reversal" }).click();
    await expect(reversal).toBeHidden();
    await expect(page.getByRole("listitem").filter({ hasText: "Reversed" })).toBeFocused();

    await page.getByRole("button", { name: "Review final score" }).click();
    const summary = page.getByRole("heading", { name: /Marina Blue .* Harbour Gold/ });
    await expect(summary).toBeVisible();
    await expect(summary.locator("..")).toBeFocused();
    await expect(page.getByText("No live match clock is running.", { exact: false })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });
}

test("@a11y 320px reflow keeps Basketball controls reachable with 48px targets", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openScoring(page, "basketball");

  const threePoint = page.getByRole("button", { name: "Three-point score Harbour Gold" });
  await threePoint.scrollIntoViewIfNeeded();
  await expect(threePoint).toBeVisible();
  const box = await threePoint.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(48);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByRole("button", { name: "Review final score" })).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("recent canonical events are newest-first without changing the authoritative projection", async ({ page }) => {
  await openScoring(page, "canoe_polo");

  const recordGoal = async (participant: string) => {
    await page.getByRole("button", { name: "Goal Marina Blue" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Scorer or participant name").fill(participant);
    await dialog.getByRole("button", { name: "Record goal for Marina Blue" }).click();
  };

  await recordGoal("Player 1");
  const events = page.locator(".p2-event-log ol > li");
  await expect(events).toHaveCount(1);
  const firstEventId = await events.nth(0).getAttribute("data-event-id");

  await recordGoal("Player 2");

  await expect(events).toHaveCount(2);
  await expect(events.nth(1)).toHaveAttribute("data-event-id", firstEventId ?? "");
  await expect(events.nth(0)).not.toHaveAttribute("data-event-id", firstEventId ?? "");
});
