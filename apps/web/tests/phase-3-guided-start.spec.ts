import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

const organisationId = "79685f62-e0f7-4c41-a329-5532bf41cfa2";
const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";

test.beforeEach(async ({ page, context, baseURL }) => {
  installConsoleGuard(page);
  await context.addCookies([
    { name: "matchday-redesign-p3-start", value: "1", url: baseURL ?? "http://127.0.0.1" },
    { name: "matchday-redesign-shell", value: "1", url: baseURL ?? "http://127.0.0.1" },
  ]);
});

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("guided start allows creating a competition with <= 3 inputs at 1280px desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  let bootstrapCalls = 0;
  let competitionPayload: Record<string, unknown> | null = null;

  await page.route("**/api/phase3/organisations/bootstrap", async (route) => {
    bootstrapCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: organisationId,
        name: "Organiser workspace",
        role: "owner",
        created: true,
      }),
    });
  });

  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    competitionPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: competitionId,
        status: "draft",
        sport_code: "badminton",
        revision: 1,
        account_default_applied: false,
      }),
    });
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  // Exactly 3 inputs:
  // 1. Sport
  await page.getByLabel("Sport", { exact: true }).selectOption("badminton");
  // 2. Competition name
  await page.getByLabel("Competition name").fill("National Open");
  // 3. Planned teams
  await page.getByLabel("Planned teams").fill("12");

  // Verify match estimate preview
  await expect(page.getByText("Estimated matches: ~18–24")).toBeVisible();

  // Create competition
  await page.getByRole("button", { name: "Create competition" }).click();

  await expect.poll(() => bootstrapCalls).toBe(1);
  await expect.poll(() => competitionPayload).not.toBeNull();
  const payload = competitionPayload as unknown as Record<string, unknown>;
  expect(payload).toMatchObject({
    organisation_id: organisationId,
    name: "National Open",
    slug: "national-open",
    sport_code: "badminton",
  });
  expect(payload.days).toBeDefined();
  expect(Array.isArray(payload.days)).toBe(true);
  expect(payload.divisions).toEqual([
    expect.objectContaining({
      name: "Open",
      short_code: "O",
      planned_entry_count: 12,
    }),
  ]);

  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});

test("guided start allows creating a competition with <= 3 inputs at 375px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });

  let competitionCalls = 0;

  await page.route("**/api/phase3/organisations/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: organisationId,
        name: "Organiser workspace",
        role: "owner",
        created: true,
      }),
    });
  });

  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    competitionCalls += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: competitionId,
        status: "draft",
        sport_code: "volleyball",
        revision: 1,
        account_default_applied: false,
      }),
    });
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  // 1. Sport
  await page.getByLabel("Sport", { exact: true }).selectOption("volleyball");
  // 2. Competition name
  await page.getByLabel("Competition name").fill("Beach Summer Cup");
  // 3. Planned teams
  await page.getByLabel("Planned teams").fill("8");

  await expect(page.getByText("Estimated matches: ~12–16")).toBeVisible();

  // Create competition
  await page.getByRole("button", { name: "Create competition" }).click();

  await expect.poll(() => competitionCalls).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});

test("free-plan notice appears when planned teams exceeds 16", async ({ page }) => {
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  const planNotice = page.getByText(/Free plan includes up to 16 teams/);
  await expect(planNotice).toHaveCount(0);

  await page.getByLabel("Planned teams").fill("20");
  await expect(planNotice).toBeVisible();

  await page.getByLabel("Planned teams").fill("16");
  await expect(planNotice).toHaveCount(0);
});

test("workspace checklist 'Show only what is left' toggle hides completed steps at 375px and persists in localStorage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });

  await page.goto("/organiser/competitions/singapore-open");
  await dismissConsent(page);

  const checklistHeading = page.getByRole("heading", { name: "Before you publish" });
  await expect(checklistHeading).toBeVisible();

  const toggle = page.getByTestId("checklist-show-only-left");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // Initially, there are completed and incomplete items
  const doneItems = page.locator('[data-done="true"]');
  const initialDoneCount = await doneItems.count();
  expect(initialDoneCount).toBeGreaterThan(0);

  // Toggle filter
  await toggle.check();
  await expect(toggle).toBeChecked();

  // Completed items are now hidden
  await expect(page.locator('[data-done="true"]')).toHaveCount(0);

  // Reload page to test localStorage persistence
  await page.reload();
  await dismissConsent(page);

  const reloadedToggle = page.getByTestId("checklist-show-only-left");
  await expect(reloadedToggle).toBeChecked();
  await expect(page.locator('[data-done="true"]')).toHaveCount(0);

  // Uncheck filter restores completed items
  await reloadedToggle.uncheck();
  await expect(reloadedToggle).not.toBeChecked();
  await expect(page.locator('[data-done="true"]')).toHaveCount(initialDoneCount);
});
