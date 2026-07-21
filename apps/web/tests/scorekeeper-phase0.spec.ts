import { expect, test, type Page } from "@playwright/test";

async function openScorekeeper(page: Page) {
  await page.goto("/score");
  await page.getByRole("button", { name: "Validate access" }).click();
  await page.getByRole("checkbox", { name: "I am at Match 12 and ready to score this fixture." }).check();
  await page.getByRole("button", { name: "Start scoring offline" }).click();
  await expect(page.getByRole("heading", { name: "Match 12" })).toBeVisible();
}

test("mobile scorer appends and reverses an event while the browser is physically offline", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScorekeeper(page);
  await context.setOffline(true);

  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await expect(page.getByLabel("Marina Blue 1")).toBeVisible();
  await page.getByRole("button", { name: "Undo last" }).click();
  await expect(page.getByLabel("Marina Blue 0")).toBeVisible();
  const timeline = page.getByTestId("scorekeeper-event-list").locator(":scope > li");
  await expect(timeline).toHaveCount(2);
  await expect(timeline.first()).toContainText("Reversal · Marina Blue goal");

  await context.setOffline(false);
});

test("rapid goal taps preserve every fact and render newest sequence first", async ({ page }) => {
  await openScorekeeper(page);
  const goalButton = page.getByRole("button", { name: "Goal Marina Blue" });

  await goalButton.evaluate((button) => {
    for (let index = 0; index < 12; index += 1) (button as HTMLElement).click();
  });

  await expect(page.getByLabel("Marina Blue 12")).toBeVisible();
  const timeline = page.getByTestId("scorekeeper-event-list").locator(":scope > li");
  await expect(timeline).toHaveCount(12);
  expect(await timeline.evaluateAll((items) => items.map((item) => item.getAttribute("data-event-sequence")))).toEqual([
    "12",
    "11",
    "10",
    "9",
    "8",
    "7",
    "6",
    "5",
    "4",
    "3",
    "2",
    "1",
  ]);
});

test("concurrent prototype tabs keep local queues isolated and fence stale facts on takeover", async ({
  context,
  page,
}) => {
  const secondTab = await context.newPage();
  await Promise.all([openScorekeeper(page), openScorekeeper(secondTab)]);

  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await secondTab.getByRole("button", { name: "Goal Harbour Gold" }).click();
  await expect(page.getByLabel("Marina Blue 1")).toBeVisible();
  await expect(page.getByLabel("Harbour Gold 0")).toBeVisible();
  await expect(secondTab.getByLabel("Marina Blue 0")).toBeVisible();
  await expect(secondTab.getByLabel("Harbour Gold 1")).toBeVisible();

  await page.getByRole("button", { name: "Simulate active-device conflict" }).click();
  await page.getByRole("button", { name: "Take over" }).click();
  await page.getByRole("button", { name: "Confirm takeover" }).click();
  await expect(page.getByLabel("Marina Blue 0")).toBeVisible();
  await expect(page.getByText("Reconciliation required")).toBeVisible();

  await secondTab.close();
});
