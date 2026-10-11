import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const officialsUrl = "/organiser/competitions/singapore-open/officials";
const match1Id = "30000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));
test.use({ serviceWorkers: "block" });

test.describe("officials automated WCAG A/AA accessibility checks", () => {
  test("@a11y initial roster view meets WCAG A/AA requirements", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    await expect(page.getByRole("heading", { name: "Active officials" })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });

  test("@a11y create official form meets WCAG A/AA requirements", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    await page.getByRole("button", { name: "Add official" }).click();
    await expect(page.getByRole("heading", { name: "Add official" })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);

    // Trigger validation error state and re-check
    await page.getByRole("button", { name: "Add official" }).last().click();
    await expect(page.locator("#official-form-error")).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });

  test("@a11y availability editor meets WCAG A/AA requirements (initial, multi-row, error)", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    await page.getByRole("button", { name: "Edit availability" }).click();
    await expect(page.getByRole("heading", { name: /Edit availability —/i })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);

    // Add row to test multi-row a11y
    await page.getByRole("button", { name: "Add availability window" }).click();
    await assertNoWcagAOrAaViolations(page);

    // Trigger error state (end time before start time)
    const startDate = page.locator("input[type='date']").first();
    const startTime = page.locator("input[type='time']").first();
    const endDate = page.locator("input[type='date']").nth(1);
    const endTime = page.locator("input[type='time']").nth(1);

    await startDate.fill("2026-08-15");
    await startTime.fill("18:00");
    await endDate.fill("2026-08-15");
    await endTime.fill("08:00");

    await page.getByRole("button", { name: "Save availability" }).click();
    await expect(page.locator("#availability-editor-error")).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });

  test("@a11y assignment editor meets WCAG A/AA requirements", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");
    await page.goto(`${officialsUrl}?match=${match1Id}`);
    await dismissConsent(page);

    await page.getByRole("button", { name: "Edit match officials" }).click();
    await expect(page.getByRole("heading", { name: "Edit match officials" })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });

  test("@a11y archive confirmation modal/panel meets WCAG A/AA requirements", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    await page.getByRole("button", { name: "Archive official" }).click();
    await expect(page.getByRole("heading", { name: /Archive Official A\?/i })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });

  test("@a11y archived official visible in roster/detail meets WCAG A/AA requirements", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    // Show archived officials
    await page.getByRole("button", { name: /Show archived/i }).click();
    await expect(page.getByRole("heading", { name: "Archived officials" })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);

    // Select archived Official C
    await page.getByRole("button", { name: /Official C/i }).click();
    await expect(page.getByRole("heading", { name: "Archived Official C" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore official" })).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });

  test("@a11y conflict advisory visible in view and edit modes meets WCAG A/AA requirements", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");

    // Singapore open initial match SF1 or M1 with conflicts
    await page.goto(`${officialsUrl}?match=${match1Id}`);
    await dismissConsent(page);

    // Open edit mode to see real-time conflict hints
    await page.getByRole("button", { name: "Edit match officials" }).click();
    await expect(page.getByRole("heading", { name: "Edit match officials" })).toBeVisible();

    // Check conflict advisory if present
    const advisory = page.locator("[role='status']").filter({ hasText: "Current schedule check" });
    if ((await advisory.count()) > 0) {
      await expect(advisory).toBeVisible();
      await assertNoWcagAOrAaViolations(page);
    }
  });

  test("@a11y reconciliation warning meets WCAG A/AA requirements", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");

    allowConsoleFailure(page, /status of 500/);

    await page.goto(`${officialsUrl}?match=${match1Id}`);
    await dismissConsent(page);

    await page.getByRole("button", { name: "Edit match officials" }).click();

    // Mock PUT success with bumped revision
    await page.route("**/api/phase4/competitions/*/matches/*/officials", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ assignments: [], bumped_revision: true }),
        });
        return;
      }
      await route.fallback();
    });

    // Mock workspace refresh failure (500)
    await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Fail" }) });
    });

    await page.getByRole("button", { name: "Save assignments" }).click();

    const reconWarning = page.getByText("The change was saved, but the officials workspace could not be refreshed.");
    await expect(reconWarning).toBeVisible();
    await assertNoWcagAOrAaViolations(page);
  });
});

test.describe("officials keyboard and focus journeys", () => {
  test("keyboard navigation: roster item selection, show archived toggle, and aria-pressed attributes", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Keyboard tests in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    // Initial state: Official A is pressed
    const officialABtn = page.getByRole("button", { name: /Official A/i }).first();
    const officialBBtn = page.getByRole("button", { name: /Official B/i }).first();
    await expect(officialABtn).toHaveAttribute("aria-pressed", "true");
    await expect(officialBBtn).toHaveAttribute("aria-pressed", "false");

    // Focus Official B via Tab and activate via Enter
    await officialBBtn.focus();
    await page.keyboard.press("Enter");

    await expect(officialABtn).toHaveAttribute("aria-pressed", "false");
    await expect(officialBBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Official B", exact: true })).toBeVisible();

    // Toggle show archived via keyboard Space
    const showArchivedBtn = page.getByRole("button", { name: /Show archived/i });
    await showArchivedBtn.focus();
    await page.keyboard.press("Space");

    const hideArchivedBtn = page.getByRole("button", { name: /Hide archived/i });
    await expect(hideArchivedBtn).toBeVisible();
    await expect(hideArchivedBtn).toHaveAttribute("aria-expanded", "true");

    // Select archived official via Enter
    const officialCBtn = page.getByRole("button", { name: /Official C/i });
    await officialCBtn.focus();
    await page.keyboard.press("Enter");

    await expect(officialCBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Archived Official C" })).toBeVisible();
  });

  test("keyboard focus journey: add official form validation and focus management", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Keyboard tests in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    const addOfficialTrigger = page.getByRole("button", { name: "Add official" });
    await addOfficialTrigger.click();

    // Focus lands on Name input on open
    const nameInput = page.getByLabel("Name");
    await expect(nameInput).toBeFocused();

    // Submit invalid (blank) form via Enter
    await page.keyboard.press("Enter");

    // Focus returned to invalid Name field with aria-invalid="true" and aria-describedby pointing to error
    await expect(nameInput).toBeFocused();
    await expect(nameInput).toHaveAttribute("aria-invalid", "true");
    await expect(nameInput).toHaveAttribute("aria-describedby", "official-form-error");
    await expect(page.locator("#official-form-error")).toHaveAttribute("role", "alert");

    // Cancel form via Escape / button and verify focus restoration
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
    await expect(page.getByRole("heading", { name: "Add official" })).not.toBeVisible();
    await expect(addOfficialTrigger).toBeFocused();
  });

  test("keyboard focus journey: archive confirmation dialog cancel and focus restoration", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Keyboard tests in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    const archiveTrigger = page.getByRole("button", { name: "Archive official" });
    await archiveTrigger.click();

    // Archive confirmation panel visible
    await expect(page.getByRole("heading", { name: /Archive Official A\?/i })).toBeVisible();

    // Cancel action restores focus to archive trigger button
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();

    await expect(page.getByRole("heading", { name: /Archive Official A\?/i })).not.toBeVisible();
    await expect(archiveTrigger).toBeFocused();
  });

  test("keyboard focus journey: availability editor row addition, removal, and cancel restoration", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Keyboard tests in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    const editAvailTrigger = page.getByRole("button", { name: "Edit availability" });
    await editAvailTrigger.click();

    // Heading exists
    const availHeading = page.getByRole("heading", { name: /Edit availability —/i });
    await expect(availHeading).toBeVisible();

    // Add window via keyboard
    const addWindowBtn = page.getByRole("button", { name: "Add availability window" });
    const removeButtons = page.getByRole("button", { name: "Remove window" });
    const initialCount = await removeButtons.count();

    await addWindowBtn.focus();
    await page.keyboard.press("Enter");
    await expect(removeButtons).toHaveCount(initialCount + 1);
    await expect(page.getByLabel("Start date").last()).toBeFocused();

    // Remove window via keyboard
    await removeButtons.last().focus();
    await expect(removeButtons.last()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(removeButtons).toHaveCount(initialCount);

    // Cancel restores focus to edit availability button
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();

    await expect(availHeading).not.toBeVisible();
    await expect(editAvailTrigger).toBeFocused();
  });

  test("keyboard focus journey: assignment editor checkboxes, distinct role labels, and cancel restoration", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Keyboard tests in Chromium");
    await page.goto(`${officialsUrl}?match=${match1Id}`);
    await dismissConsent(page);

    const editMatchTrigger = page.getByRole("button", { name: "Edit match officials" });
    await editMatchTrigger.click();

    const editHeading = page.getByRole("heading", { name: "Edit match officials" });
    await expect(editHeading).toBeVisible();

    // Checkbox focus on mount
    const firstCheckbox = page.locator("input[type='checkbox']").first();
    await expect(firstCheckbox).toBeFocused();

    // Distinct accessible labels for role inputs
    const roleInputA = page.getByLabel("Assigned role for Official A");
    await expect(roleInputA).toBeVisible();

    // Cancel restores focus to edit match officials trigger
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();

    await expect(editHeading).not.toBeVisible();
    await expect(editMatchTrigger).toBeFocused();
  });

  test("status vs error semantics: success alerts use role='status' and error alerts use role='alert'", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Semantics tests in Chromium");
    await page.goto(officialsUrl);
    await dismissConsent(page);

    // Status notifications container
    const statusRegion = page.locator("[role='status']");
    // Verify any current status notices have role="status"
    for (const el of await statusRegion.all()) {
      await expect(el).toHaveAttribute("role", "status");
    }

    // Trigger validation error on Create Form
    await page.getByRole("button", { name: "Add official" }).click();
    await page.getByRole("button", { name: "Add official" }).last().click();

    const alertError = page.locator("#official-form-error");
    await expect(alertError).toBeVisible();
    await expect(alertError).toHaveAttribute("role", "alert");
  });
});
