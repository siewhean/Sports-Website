import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";

test("Assisted Setup blocks invalid required fields and focuses the first error", async ({ page }) => {
  await page.goto("/setup");
  await page.getByLabel("Competition name").fill("");
  await page.getByLabel("Teams or participants").fill("-2");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "Review the fields marked below" })).toBeVisible();
  await expect(page.getByText("Enter a competition name.")).toBeVisible();
  await expect(page.getByText("Enter at least 2 teams or participants.")).toBeVisible();
  await expect(page.getByLabel("Competition name")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Basics", exact: true })).toBeVisible();

  await page.getByLabel("Competition name").fill("Harbour Series 2026");
  await page.getByLabel("Teams or participants").fill("513");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Enter no more than 512 teams or participants.")).toBeVisible();
  await page.getByLabel("Teams or participants").fill("2");
  await page.getByLabel("Divisions").fill("2");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Each division needs at least 2 teams or participants.")).toBeVisible();
  await expect(page.getByLabel("Divisions")).toBeFocused();

  await page.getByLabel("Divisions").fill("1");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Capacity", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: /Playing areas/ }).fill("65");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Enter no more than 64 playing areas.")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: /Playing areas/ })).toBeFocused();
});

test("match estimates respond to teams, divisions, and format and gate a capacity shortfall", async ({ page }) => {
  await page.goto("/setup");
  await page.getByLabel("Teams or participants").fill("48");
  await page.getByRole("button", { name: "Recommendations Format options" }).click();

  await expect(page.getByRole("heading", { name: "Recommendations", exact: true })).toBeVisible();
  await expect(page.getByText("96 matches · 48h")).toBeVisible();
  await expect(page.getByText("Short by 26 slots")).toBeVisible();

  await page.getByRole("button", { name: /Full classification/ }).click();
  await expect(page.getByText("118 matches · 59h")).toBeVisible();
  await expect(page.getByText("Short by 48 slots")).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  const acknowledgement = page.getByRole("checkbox", {
    name: /I understand that 118 matches exceed capacity by 48 slots/,
  });
  await expect(acknowledgement).toBeFocused();
  await expect(page.getByText("Acknowledge the capacity shortfall to continue.")).toBeVisible();
  await acknowledgement.check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
});

test("safe browser draft resumes settings and excludes participant data", async ({ page }) => {
  await page.goto("/setup");
  await page.getByLabel("Competition name").fill("Coastal League 2026");
  await page.getByLabel("Teams or participants").fill("12");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Capacity", exact: true })).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("matchday.assisted-setup.draft.v1") ?? ""))
    .toContain("Coastal League 2026");
  const rawDraft = await page.evaluate(() => window.localStorage.getItem("matchday.assisted-setup.draft.v1") ?? "");
  expect(rawDraft).not.toContain("participantNames");
  expect(rawDraft).not.toContain("contact");
  expect(rawDraft).not.toContain("imported");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Capacity", exact: true })).toBeVisible();
  await expect(page.getByText("Draft resumed from this device")).toBeVisible();
  await expect(page.getByText("Coastal League 2026")).toBeVisible();
});

test("browser Back walks through wizard history without leaving setup", async ({ page }) => {
  await page.goto("/setup");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Capacity", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Capacity", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Basics", exact: true })).toBeVisible();
});

test("UI Back and rapid Continue preserve every wizard step", async ({ page }) => {
  await page.goto("/setup");
  await page.getByRole("button", { name: "Continue" }).dblclick();
  await expect(page.getByRole("heading", { name: "Capacity", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeHidden();

  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Capacity", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Basics", exact: true })).toBeVisible();
});

test("@a11y phone navigation, validation, accessibility, and console remain healthy", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/setup");

  await expect(page.getByText("Step 1 of 8")).toBeVisible();
  await expect(page.getByLabel("Assisted setup progress")).toBeHidden();
  await page.getByLabel("Competition name").fill("");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Competition name")).toBeFocused();
  await assertNoWcagAOrAaViolations(page);

  await page.getByLabel("Competition name").fill("Marina Cup 2026");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Step 2 of 8")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("Step 1 of 8")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  expect(consoleErrors).toEqual([]);
});
