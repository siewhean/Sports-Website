import { expect, test } from "@playwright/test";
import {
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
  openPhase2Scorekeeper,
} from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("canonical routes expose the complete 14-step competition slice", async ({ page }) => {
  const routeEvidence = [
    ["/organiser/competitions/singapore-open/setup", "Set the event capacity", "Singapore Open 2026"],
    ["/organiser/competitions/singapore-open/settings", "Competition settings", "2"],
    ["/organiser/competitions/singapore-open/entries", "Divisions and entries", "Open division"],
    ["/organiser/competitions/singapore-open/entries", "Divisions and entries", "Women's division"],
    ["/organiser/competitions/singapore-open/capacity", "Capacity", "Required match slots"],
    ["/organiser/competitions/singapore-open/format", "Choose a format that fits your capacity", "Show format options"],
    ["/organiser/competitions/singapore-open/format?advanced=1", "Competition format", "Group A"],
    ["/organiser/competitions/singapore-open/format?advanced=1", "Competition format", "Semifinals"],
    ["/organiser/competitions/singapore-open/schedule", "Schedule", "Playing-area timeline"],
    ["/organiser/competitions/singapore-open/publish", "Publication", "Published revision 4"],
    ["/organiser/competitions/singapore-open/access", "Scoring access", "Match-scoped passes"],
    ["/score", "Marina Blue", "Validate access"],
    ["/competitions/singapore-open", "Singapore Open 2026", "Results"],
    ["/organiser/competitions/singapore-open/audit", "Audit log", "Finalised Match 12"],
    ["/competitions/singapore-open", "Singapore Open 2026", "Bracket"],
  ] as const;

  for (const [route, heading, evidence] of routeEvidence) {
    const response = await page.goto(route);
    expect(response?.ok(), route).toBe(true);
    await dismissConsent(page);
    await expect(page.getByRole("heading", { name: heading }).first(), route).toBeVisible();
    await expect(page.getByText(evidence, { exact: true }).first(), route).toBeVisible();
  }
});

test("phone scoring validates access, confirms scorer attribution, appends a goal, and finalises", async ({ page }) => {
  await page.goto("/score");
  await dismissConsent(page);

  await page.getByLabel("Scoring code").fill("INVALID");
  await page.getByRole("button", { name: "Validate access" }).click();
  await expect(page.getByText("That scoring code is not valid for this match.")).toBeVisible();

  await page.getByLabel("Scoring code").fill("POLO-12");
  await page.getByRole("button", { name: "Validate access" }).click();
  await page.getByRole("checkbox", { name: "I am at Match 12 and ready to score this fixture." }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();

  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm goal" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText("Marina Blue", { exact: true })).toBeVisible();
  const scorer = confirmation.getByLabel("Scorer or participant name");
  await expect(scorer).toBeFocused();
  await scorer.fill("Aisha Tan");
  await confirmation.getByRole("button", { name: "Record goal for Marina Blue" }).click();

  const scoringControls = page.getByRole("region", { name: "Scoring controls" });
  await expect(scoringControls).toContainText("Marina Blue1");
  await expect(scoringControls).toContainText("Harbour Gold0");
  await page.getByRole("button", { name: "Match events" }).click();
  const eventHistory = page.getByRole("dialog", { name: "Match events" });
  await expect(eventHistory).toContainText("Aisha Tan");
  await eventHistory.getByRole("button", { name: "Close match events" }).click();
  await expect(page.getByText("1 event pending sync")).toBeVisible();

  await page.getByRole("button", { name: "Review final score" }).click();
  await expect(page.getByRole("heading", { name: "Marina Blue 1–0 Harbour Gold" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm final result" }).click();
  await expect(page.getByRole("heading", { name: "Result publication acknowledged" })).toBeVisible();
  await expect(page.getByText("R-2026-09-12-M12-04")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open public page" })).toHaveAttribute(
    "href",
    "/competitions/singapore-open",
  );
});

test("default Canoe Polo scoring keeps advanced operations opt-in", async ({ page }) => {
  await openPhase2Scorekeeper(page);

  const remoteGoals = page.locator('[data-control-id="goal"]');
  await expect(remoteGoals).toHaveCount(2);
  await expect(page.locator(".p5-scoring-device")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Advanced scoring controls" })).toBeVisible();

  await page.locator("summary").getByText("Match actions", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Green card Marina Blue" })).toBeVisible();

  await page.getByRole("link", { name: "Advanced scoring controls" }).click();
  await expect(page.locator(".p5-scoring-device")).toBeVisible();
  await expect(page.getByRole("link", { name: "Simple scoring controls" })).toBeVisible();
});

test("default Canoe Polo scoring owns the viewport and reveals event history in a contained sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPhase2Scorekeeper(page);

  await expect(page.locator(".p2-score--simple")).toBeVisible();
  await expect(page.locator(".p2-event-log:visible")).toHaveCount(0);
  const documentMetrics = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(documentMetrics.scrollHeight).toBeLessThanOrEqual(documentMetrics.clientHeight);
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole("button", { name: "Match events" }).click();
  const history = page.getByRole("dialog", { name: "Match events" });
  await expect(history).toBeVisible();
  await expect(history).toContainText("No events recorded");
  await history.getByRole("button", { name: "Close match events" }).click();
  await expect(history).toBeHidden();
});

test("the action sheet dismisses from its handle without moving the scorekeeper page", async ({ page }) => {
  await openPhase2Scorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm goal" });
  await expect(confirmation).toBeVisible();

  const handle = confirmation.locator(".p2-goal-sheet__handle");
  await handle.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientY: 100 });
  await confirmation.dispatchEvent("pointermove", { pointerId: 1, pointerType: "touch", clientY: 196 });

  await expect(confirmation).toBeHidden();
  await expect(page.getByRole("button", { name: "Goal Marina Blue" })).toBeVisible();
});

test("public projection is complete in raw server-rendered HTML", async ({ request }) => {
  const response = await request.get("/competitions/singapore-open");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/html");
  const html = await response.text();
  for (const evidence of [
    "Singapore Open 2026",
    "Final",
    "Schedule",
    "Table",
    "Bracket",
    "Updated 18 seconds ago",
    "Published revision 4",
  ]) {
    expect(html, evidence).toContain(evidence);
  }
});

test("scoring helper reaches the single-active-writer surface", async ({ page }) => {
  await openPhase2Scorekeeper(page);
  await expect(page.locator(".p2-writer")).toContainText("Active scorer");
});
