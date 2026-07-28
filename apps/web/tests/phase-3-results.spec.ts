import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("organiser results expose persisted standings and advancement provenance", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Standings and advancement" })).toBeVisible();
  await expect(page.locator('.p2-organiser__nav a[aria-current="page"]')).toContainText("Results");
  await expect(page.getByText("Server calculated")).toBeVisible();
  await expect(page.getByTestId("phase3-results").getByText("res_6")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Automatic" })).toBeVisible();
  await expect(page.getByText("semi-final-1:home:group-a:1")).toBeVisible();
  await expect(page.getByText("organiser controlled")).toBeVisible();
  await expect(page.getByText("A correction needs organiser review")).toBeVisible();
  await expect(page.getByText("Downstream match M13")).toBeVisible();
  await page.getByText("table points").first().click();
  await expect(page.getByText("Ranking explanation").first()).toBeVisible();
});

test("read-only and unavailable results states remain explicit", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/results?state=read-only");
  await dismissConsent(page);
  await expect(page.getByText("Results are read only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Recalculate from final results" })).toBeDisabled();

  await page.goto("/organiser/competitions/singapore-open/results?state=empty");
  await expect(page.getByRole("heading", { name: "No standings snapshot yet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Match corrections and audit" })).toBeVisible();

  await page.goto("/organiser/competitions/singapore-open/results?state=offline");
  await expect(page.getByRole("heading", { name: "Working offline" })).toBeVisible();

  await page.goto("/organiser/competitions/singapore-open/results?state=error");
  await expect(page.getByRole("heading", { name: "Standings could not load" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Match corrections and audit" })).toBeVisible();

  await page.goto("/organiser/competitions/singapore-open/results?state=permission");
  await expect(page.getByRole("heading", { name: "Standings access required" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Match corrections and audit" })).toHaveCount(0);

  await page.goto("/organiser/competitions/singapore-open/results?state=loading");
  await expect(page.getByLabel("Loading standings")).toHaveAttribute("aria-busy", "true");
});

test("organiser reopens, corrects and acknowledges a protected downstream conflict without losing context", async ({
  page,
}) => {
  await page.goto("/organiser/competitions/singapore-open/results?match=M13");
  await dismissConsent(page);
  await expect(page.getByLabel("Choose a completed match")).toHaveValue("");
  await expect(page.locator("[class*='matchSummary']")).toHaveCount(0);

  await page.goto("/organiser/competitions/singapore-open/results?match=M12");
  await expect(page.getByRole("heading", { name: "Match corrections and audit" })).toBeVisible();
  const completedMatchPicker = page.getByLabel("Choose a completed match");
  await expect(completedMatchPicker).toHaveValue("M12");
  await expect(completedMatchPicker.locator('option[value="M12"]')).toHaveCount(1);
  await expect(completedMatchPicker.locator('option[value="M13"]')).toHaveCount(0);
  await expect(completedMatchPicker.locator('option[value="M14"]')).toHaveCount(0);
  await expect(page.getByText("Marina Blue 4–3 Harbour Gold")).toBeVisible();

  const reopen = page.getByRole("button", { name: "Reopen for correction" });
  await reopen.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await reopen.click();
  const reopenDialog = page.getByRole("dialog", { name: "Reopen for correction" });
  await reopenDialog.getByLabel("Correction reason").fill("Verified against the signed score sheet");
  await reopenDialog.getByRole("button", { name: "Reopen match" }).click();
  await expect(page.getByText("Match reopened. Its published history remains preserved.")).toBeAttached();
  const correct = page.getByRole("button", { name: "Reverse scoring event" });
  await expect(correct).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(page.getByText("#9 · match reopened")).toBeVisible();
  await correct.click();
  const correctionDialog = page.getByRole("dialog", { name: "Apply correction and publish result" });
  await correctionDialog.getByLabel("Event to reverse").selectOption({ label: "#7 · goal · home" });
  await correctionDialog.getByLabel("Add a replacement of this validated action").check();
  await correctionDialog.getByLabel("Replacement participant name").fill("Player 11");
  await correctionDialog.getByLabel("Correction reason").fill("Goal attribution disproved by signed score sheet");
  await correctionDialog.getByRole("button", { name: "Publish correction" }).click();
  await expect(page.getByText("Correction finalised and the corrected result published.")).toBeAttached();
  await expect(page.locator("[class*='matchSummary']")).toBeFocused();
  await expect(page.getByText("#7 · goal · reversed")).toBeVisible();
  await expect(page.getByText("#10 · reversal")).toBeVisible();
  await expect(page.getByText("#12 · match finalised")).toBeVisible();
  await expect(page.getByText(/Player 11/)).toBeVisible();

  const acknowledge = page.getByRole("button", { name: "Acknowledge conflict" });
  await acknowledge.click();
  await page.getByLabel("Acknowledgement reason").fill("Schedule repair assigned to the operations lead");
  await page.getByRole("button", { name: "Record acknowledgement" }).click();
  await expect(page.getByText("Conflict acknowledged. Schedule repair remains pending.")).toBeAttached();
  await expect(page.getByRole("heading", { name: "Critical downstream conflicts" }).locator("..")).toBeFocused();
  await expect(page.getByText("No downstream conflicts require acknowledgement.")).toBeVisible();
});
