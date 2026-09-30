import { expect, test } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const officialsUrl = "/organiser/competitions/singapore-open/officials";
const competitionId = "00000000-0000-4000-8000-000000000001";
const match1Id = "30000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page }) => installConsoleGuard(page));

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));
test.use({ serviceWorkers: "block" });

const VIEWPORTS = [
  { width: 390, height: 844, name: "phone-390" },
  { width: 768, height: 1024, name: "tablet-768" },
  { width: 899, height: 900, name: "pre-split-899" },
  { width: 900, height: 900, name: "split-boundary-900" },
  { width: 1280, height: 900, name: "desktop-1280" },
];

async function assertNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("officials global overflow across viewports and major states", () => {
  for (const vp of VIEWPORTS) {
    test(`no document horizontal overflow at ${vp.width}x${vp.height} (${vp.name}) across major states`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-chromium", "Viewport matrix runs once in Chromium");

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(officialsUrl);
      await dismissConsent(page);

      // 1. Initial roster view
      await expect(page.getByRole("heading", { name: "Active officials" })).toBeVisible();
      await assertNoHorizontalOverflow(page);

      // 2. Create form
      await page.getByRole("button", { name: "Add official" }).click();
      await expect(page.getByRole("heading", { name: "Add official" })).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await page.getByRole("button", { name: "Cancel" }).click();

      // 3. Availability editor
      await page.getByRole("button", { name: "Edit availability" }).click();
      await expect(page.getByRole("heading", { name: /Edit availability —/i })).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await page.getByRole("button", { name: "Cancel" }).click();

      // 4. Archive confirmation
      await page.getByRole("button", { name: "Archive official" }).click();
      await expect(page.getByRole("heading", { name: /Archive Official A\?/i })).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await page.getByRole("button", { name: "Cancel" }).click();

      // 5. Assignment editor
      await page.getByRole("button", { name: "Edit match officials" }).click();
      await expect(page.getByRole("heading", { name: "Edit match officials" })).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await page.getByRole("button", { name: "Cancel" }).click();
    });
  }
});

test("roster and detail layout adapts cleanly across 390, 768, 899, 900, and 1280 viewports", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Breakpoint boundary verification in Chromium");

  // 1. Phone 390: Single column, roster first, details after roster
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(officialsUrl);
  await dismissConsent(page);

  const rosterHeading = page.getByRole("heading", { name: "Active officials" });
  const detailsHeading = page.getByRole("heading", { name: "Official A", exact: true });
  await expect(rosterHeading).toBeVisible();
  await expect(detailsHeading).toBeVisible();

  const rosterBox390 = await rosterHeading.boundingBox();
  const detailsBox390 = await detailsHeading.boundingBox();
  expect(rosterBox390).not.toBeNull();
  expect(detailsBox390).not.toBeNull();
  // Roster appears above details vertically in stacked layout
  expect(detailsBox390!.y).toBeGreaterThan(rosterBox390!.y);

  // Buttons wrap rather than overflowing
  const addBtn = page.getByRole("button", { name: "Add official" });
  await expect(addBtn).toBeVisible();
  await assertNoHorizontalOverflow(page);

  // 2. Tablet 768: Usable single-column layout, no overflow
  await page.setViewportSize({ width: 768, height: 1024 });
  await assertNoHorizontalOverflow(page);
  const detailsBox768 = await detailsHeading.boundingBox();
  const rosterBox768 = await rosterHeading.boundingBox();
  expect(detailsBox768!.y).toBeGreaterThan(rosterBox768!.y);

  // 3. Immediately before breakpoint: 899px
  await page.setViewportSize({ width: 899, height: 900 });
  await assertNoHorizontalOverflow(page);
  const detailsBox899 = await detailsHeading.boundingBox();
  const rosterBox899 = await rosterHeading.boundingBox();
  expect(detailsBox899!.y).toBeGreaterThan(rosterBox899!.y);

  // 4. Breakpoint boundary: 900px activates two-column layout
  await page.setViewportSize({ width: 900, height: 900 });
  await assertNoHorizontalOverflow(page);
  const rosterPanel = page.locator("section").filter({ has: rosterHeading });
  const detailsPanel = page.locator("section").filter({ has: detailsHeading });
  const rosterPanelBox = await rosterPanel.boundingBox();
  const detailsPanelBox = await detailsPanel.boundingBox();

  expect(rosterPanelBox).not.toBeNull();
  expect(detailsPanelBox).not.toBeNull();
  // Side by side: details X is to the right of roster X
  expect(detailsPanelBox!.x).toBeGreaterThan(rosterPanelBox!.x);
  // No overlapping of panels
  expect(detailsPanelBox!.x).toBeGreaterThanOrEqual(rosterPanelBox!.x + rosterPanelBox!.width - 1);
  // Both columns remain readable and no horizontal scroll
  await assertNoHorizontalOverflow(page);

  // 5. Desktop 1280: Two-column layout is spacious and usable
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertNoHorizontalOverflow(page);
  const rosterPanelBox1280 = await rosterPanel.boundingBox();
  const detailsPanelBox1280 = await detailsPanel.boundingBox();
  expect(detailsPanelBox1280!.x).toBeGreaterThan(rosterPanelBox1280!.x);
});

test("long-content stress fixture wraps names, roles, match labels and conflict copy without overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Long-content stress run once in Chromium");

  const longName = "Alexandra-Christina Montgomery-Wellington Official";
  const longRole = "Senior Championship Court Official";
  const longOfficialId = "60000000-0000-4000-8000-000000000077";

  const stressWorkspace = {
    officials: [
      {
        id: longOfficialId,
        competition_id: competitionId,
        name: longName,
        default_role: longRole,
        archived: false,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    ],
    availability: {
      [longOfficialId]: [
        {
          starts_at: "2026-08-15T00:00:00.000Z",
          ends_at: "2026-08-15T08:00:00.000Z",
        },
      ],
    },
    assignments: [
      {
        match_id: match1Id,
        official_id: longOfficialId,
        assigned_role: longRole,
      },
    ],
  };

  await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stressWorkspace),
    });
  });

  // Test at 390px (narrow phone)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(officialsUrl);
  await dismissConsent(page);

  await page.route("**/api/phase4/competitions/*/officials", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(stressWorkspace.officials[0]),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stressWorkspace),
    });
  });

  await page.getByRole("button", { name: "Add official" }).click();
  await page.getByLabel("Name").fill(longName);
  await page.getByLabel("Default role").fill(longRole);
  await page.getByRole("button", { name: "Add official" }).last().click();

  const officialNameInRoster = page.locator(`text=${longName}`).first();
  await expect(officialNameInRoster).toBeVisible();

  // Name wraps and does not force document overflow
  await assertNoHorizontalOverflow(page);

  // Check detail header with long name
  const detailTitle = page.getByRole("heading", { name: longName });
  await expect(detailTitle).toBeVisible();
  await assertNoHorizontalOverflow(page);

  // Test at 1280px
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertNoHorizontalOverflow(page);
});

test("availability editor fits native date/time controls and supports multi-row and cross-midnight drafts responsively", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Responsive editor verification in Chromium");

  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(officialsUrl);
    await dismissConsent(page);

    await page.getByRole("button", { name: "Edit availability" }).click();
    await expect(page.getByRole("heading", { name: /Edit availability —/i })).toBeVisible();

    // Verify row 1 controls exist and fit inside their container
    const startDateInput = page.locator("#canonical-0-start-date, input[type='date']").first();
    const startTimeInput = page.locator("#canonical-0-start-time, input[type='time']").first();
    const endDateInput = page.locator("#canonical-0-end-date, input[type='date']").nth(1);
    const endTimeInput = page.locator("#canonical-0-end-time, input[type='time']").nth(1);
    const removeBtn = page.getByRole("button", { name: "Remove window" }).first();

    await expect(startDateInput).toBeVisible();
    await expect(startTimeInput).toBeVisible();
    await expect(endDateInput).toBeVisible();
    await expect(endTimeInput).toBeVisible();
    await expect(removeBtn).toBeVisible();

    // Ensure native controls do not cause document overflow
    await assertNoHorizontalOverflow(page);

    // Add another row dynamically
    const removeButtons = page.getByRole("button", { name: "Remove window" });
    const initialCount = await removeButtons.count();
    await page.getByRole("button", { name: "Add availability window" }).click();
    await expect(removeButtons).toHaveCount(initialCount + 1);
    await assertNoHorizontalOverflow(page);

    // Enter cross-midnight draft in the new row
    const newRowStartDate = page.locator("input[type='date']").nth(initialCount * 2);
    const newRowStartTime = page.locator("input[type='time']").nth(initialCount * 2);
    const newRowEndDate = page.locator("input[type='date']").nth(initialCount * 2 + 1);
    const newRowEndTime = page.locator("input[type='time']").nth(initialCount * 2 + 1);

    await newRowStartDate.fill("2026-08-15");
    await newRowStartTime.fill("23:00");
    await newRowEndDate.fill("2026-08-16");
    await newRowEndTime.fill("02:00");

    await assertNoHorizontalOverflow(page);

    // Cancel out cleanly
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: /Edit availability —/i })).not.toBeVisible();
  }
});

test("assignment editor candidate rows switch between stacked (390px) and two-column (768px) layouts", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Responsive layout check in Chromium");

  // 1. At 390px: stacked candidate row
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${officialsUrl}?match=${match1Id}`);
  await dismissConsent(page);

  await page.getByRole("button", { name: "Edit match officials" }).click();
  await expect(page.getByRole("heading", { name: "Edit match officials" })).toBeVisible();

  // Reachable controls at 390px
  const candidateCheckbox = page.locator("input[type='checkbox']").first();
  await expect(candidateCheckbox).toBeVisible();
  await expect(candidateCheckbox).toBeChecked(); // Official A is assigned

  const roleInput = page.locator("input[placeholder='e.g. Lead official']").first();
  await expect(roleInput).toBeVisible();
  await expect(page.getByRole("button", { name: "Save assignments" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();

  // Verify candidate row is stacked vertically at 390px (checkbox above role input)
  const checkboxBox390 = await candidateCheckbox.boundingBox();
  const roleBox390 = await roleInput.boundingBox();
  expect(checkboxBox390).not.toBeNull();
  expect(roleBox390).not.toBeNull();
  expect(roleBox390!.y).toBeGreaterThan(checkboxBox390!.y);

  await assertNoHorizontalOverflow(page);

  // 2. At 768px: two-column candidate row (min-width: 640px activates)
  await page.setViewportSize({ width: 768, height: 1024 });
  await assertNoHorizontalOverflow(page);

  const checkboxBox768 = await candidateCheckbox.boundingBox();
  const roleBox768 = await roleInput.boundingBox();
  expect(checkboxBox768).not.toBeNull();
  expect(roleBox768).not.toBeNull();

  // Role column is to the right of checkbox column
  expect(roleBox768!.x).toBeGreaterThan(checkboxBox768!.x);
  // Vertically aligned within the row
  expect(Math.abs(roleBox768!.y - checkboxBox768!.y)).toBeLessThan(30);

  await page.getByRole("button", { name: "Cancel" }).click();
});

test("match selector, scheduled summary, and edit action remain usable at phone width (390px)", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Phone width check in Chromium");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(officialsUrl);
  await dismissConsent(page);

  const matchSelect = page.locator("#match-selector, select").first();
  await expect(matchSelect).toBeVisible();
  await expect(page.getByText("Scheduled time:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit match officials" })).toBeVisible();

  // Change selected match via selector
  const options = await matchSelect.locator("option").all();
  if (options.length > 1) {
    const secondVal = await options[1]!.getAttribute("value");
    if (secondVal) {
      await matchSelect.selectOption(secondVal);
      await expect(matchSelect).toHaveValue(secondVal);
    }
  }

  await assertNoHorizontalOverflow(page);
});

test("simultaneous schedule invalidation and reconciliation banners wrap cleanly without overflow at 390px", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Banner wrapping check in Chromium");

  allowConsoleFailure(page, /status of 500/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${officialsUrl}?match=${match1Id}`);
  await dismissConsent(page);

  await page.getByRole("button", { name: "Edit match officials" }).click();
  await expect(page.getByRole("heading", { name: "Edit match officials" })).toBeVisible();

  // Mock PUT to succeed with bumped_revision=true
  await page.route("**/api/phase4/competitions/*/matches/*/officials", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          assignments: [],
          bumped_revision: true,
        }),
      });
      return;
    }
    await route.fallback();
  });

  // Mock GET workspace to fail (500) to trigger reconciliation warning
  let refreshCount = 0;
  await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
    refreshCount += 1;
    if (refreshCount === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Fail" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        officials: [],
        availability: {},
        assignments: [],
      }),
    });
  });

  await page.getByRole("button", { name: "Save assignments" }).click();

  // Assert both banners are visible simultaneously
  const scheduleWarning = page.getByText("This official was assigned to a match.");
  const reconWarning = page.getByText("The change was saved, but the officials workspace could not be refreshed.");

  await expect(scheduleWarning).toBeVisible();
  await expect(reconWarning).toBeVisible();

  // Links and buttons remain reachable
  const reviewLink = page.getByRole("link", { name: "Review schedule" });
  const retryBtn = page.getByRole("button", { name: "Retry refresh" });
  await expect(reviewLink).toBeVisible();
  await expect(retryBtn).toBeVisible();

  // No horizontal document overflow
  await assertNoHorizontalOverflow(page);

  // Recovery works
  await retryBtn.click();
  await expect(reconWarning).not.toBeVisible();
});
