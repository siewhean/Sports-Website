import { expect, test } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const officialsUrl = "/organiser/competitions/singapore-open/officials";
const competitionId = "00000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("officials roster supports view, create, edit, archive and restore flows", async ({ page }) => {
  await page.goto(officialsUrl);
  await dismissConsent(page);

  // 1. Initial view: active officials, first active official is selected
  await expect(page.getByRole("heading", { name: "Active officials" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Official A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add official" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit official" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive official" })).toBeVisible();

  // 2. Toggle show/hide archived
  const showArchivedBtn = page.getByRole("button", { name: /Show archived/i });
  await expect(showArchivedBtn).toBeVisible();
  await showArchivedBtn.click();
  await expect(page.getByRole("heading", { name: "Archived officials" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Hide archived/i })).toBeVisible();

  // 3. Create flow: client validation (blank name, overlong role) and successful addition
  await page.getByRole("button", { name: "Add official" }).click();
  await expect(page.getByRole("heading", { name: "Add official" })).toBeVisible();

  // Blank name validation
  await page.getByRole("button", { name: "Add official" }).last().click();
  await expect(page.locator("#official-form-error")).toContainText("Name is required.");
  await expect(page.getByLabel("Name")).toBeFocused();
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");

  // Overlong role validation
  await page.getByLabel("Name").fill("Charlie Davis");
  await page.getByLabel("Default role").fill("A".repeat(45));
  await page.getByRole("button", { name: "Add official" }).last().click();
  await expect(page.locator("#official-form-error")).toContainText("Default role must be 40 characters or fewer.");
  await expect(page.getByLabel("Default role")).toBeFocused();
  await expect(page.getByLabel("Default role")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "false");

  // Fill valid official details
  const newOfficialId = "60000000-0000-4000-8000-000000000099";
  const newOfficial = {
    id: newOfficialId,
    competition_id: competitionId,
    name: "Charlie Davis",
    default_role: "Field Judge",
    archived: false,
    created_at: "2026-09-30T00:00:00.000Z",
    updated_at: "2026-09-30T00:00:00.000Z",
  };

  let createdOfficial = false;
  await page.route("**/api/phase4/competitions/*/officials", async (route) => {
    if (route.request().method() === "POST") {
      createdOfficial = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(newOfficial),
      });
      return;
    }
    await route.fallback();
  });

  const workspaceData = {
    officials: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        competition_id: competitionId,
        name: "Official A",
        default_role: "Lead Official",
        archived: false,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "60000000-0000-4000-8000-000000000002",
        competition_id: competitionId,
        name: "Official B",
        default_role: "Line Judge",
        archived: false,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "60000000-0000-4000-8000-000000000003",
        competition_id: competitionId,
        name: "Official C",
        default_role: null,
        archived: true,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
      newOfficial,
    ],
    availability: {
      [newOfficialId]: [],
    },
    assignments: [],
  };

  await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(workspaceData),
    });
  });

  await page.getByLabel("Default role").fill("Field Judge");
  await page.getByRole("button", { name: "Add official" }).last().click();

  expect(createdOfficial).toBe(true);
  await expect(page.getByRole("status").first()).toContainText("Official added.");
  await expect(page.getByRole("heading", { name: "Charlie Davis" })).toBeVisible();

  // 4. Edit flow
  await page.getByRole("button", { name: "Edit official" }).click();
  await expect(page.getByRole("heading", { name: "Edit official details" })).toBeVisible();

  let updatedOfficial = false;
  await page.route(`**/api/phase4/competitions/*/officials/${newOfficialId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      updatedOfficial = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...newOfficial,
          default_role: "Head Referee",
        }),
      });
      return;
    }
    await route.fallback();
  });

  await page.getByLabel("Default role").fill("Head Referee");
  await page.getByRole("button", { name: "Save changes" }).click();

  expect(updatedOfficial).toBe(true);
  await expect(page.getByRole("status").first()).toContainText("Official details saved.");

  // 5. Archive flow: two-step confirmation
  await page.getByRole("button", { name: "Archive official" }).click();
  await expect(page.getByRole("heading", { name: "Archive Charlie Davis?" })).toBeVisible();

  // Cancel returns to details
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Charlie Davis" })).toBeVisible();

  // Archive confirmed with bumped_revision = true and refresh failure (reconciliation warning)
  await page.getByRole("button", { name: "Archive official" }).click();
  let archivedOfficial = false;
  await page.route(`**/api/phase4/competitions/*/officials/${newOfficialId}/archive`, async (route) => {
    archivedOfficial = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        official: {
          ...newOfficial,
          archived: true,
        },
        bumped_revision: true,
      }),
    });
  });

  // Temporarily fail workspace refresh to test reconciliation state
  allowConsoleFailure(page, /server responded with a status of 500/);
  let refreshCount = 0;
  await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
    refreshCount += 1;
    if (refreshCount === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...workspaceData,
        officials: workspaceData.officials.map((o) => (o.id === newOfficialId ? { ...o, archived: true } : o)),
      }),
    });
  });

  await page.getByRole("button", { name: "Archive official" }).last().click();
  expect(archivedOfficial).toBe(true);

  // Both schedule invalidation and reconciliation notice must be visible simultaneously
  await expect(page.getByText("This official was assigned to a match.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review schedule" })).toBeVisible();
  await expect(
    page.getByText("The change was saved, but the officials workspace could not be refreshed."),
  ).toBeVisible();

  // Mutation controls are disabled while out of sync
  await expect(page.getByRole("button", { name: "Add official" })).toBeDisabled();
  const retryBtn = page.getByRole("button", { name: "Retry refresh" });
  await expect(retryBtn).toBeVisible();

  // Clicking Retry refresh recovers from out of sync
  await retryBtn.click();
  await expect(
    page.getByText("The change was saved, but the officials workspace could not be refreshed."),
  ).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Add official" })).toBeEnabled();
});

test.describe("competition timezone availability in non-host browser timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("edits official availability in competition timezone and compiles UTC payload", async ({ page }) => {
    await page.goto(officialsUrl);
    await dismissConsent(page);

    // Initial official selected is Official A
    await expect(page.getByRole("heading", { name: "Official A" })).toBeVisible();
    await expect(page.getByText("Competition timezone: Asia/Singapore")).toBeVisible();

    // Verify initial windows rendered in Asia/Singapore civil time (09:00–13:00, 14:00–18:00)
    // even though browser timezone is America/Los_Angeles (where 01:00 UTC would be 18:00 previous day)
    await expect(page.getByText("09:00–13:00")).toBeVisible();
    await expect(page.getByText("14:00–18:00")).toBeVisible();

    // Click "Edit availability"
    await page.getByRole("button", { name: "Edit availability" }).click();
    await expect(page.getByRole("heading", { name: /Edit availability/i })).toBeVisible();
    await expect(page.getByText("Times are entered in Asia/Singapore.")).toBeVisible();

    // Verify initial inputs are pre-populated in Asia/Singapore civil time
    await expect(page.getByLabel("Start date").first()).toHaveValue("2026-08-15");
    await expect(page.getByLabel("Start time").first()).toHaveValue("09:00");
    await expect(page.getByLabel("End time").first()).toHaveValue("13:00");

    // Test client validation: end time before start time
    await page.getByLabel("End time").first().fill("08:00");
    await page.getByRole("button", { name: "Save availability" }).click();
    await expect(page.locator("#availability-editor-error")).toContainText("End time must be after start time.");
    await expect(page.getByLabel("End time").first()).toBeFocused();
    await expect(page.getByLabel("End time").first()).toHaveAttribute("aria-invalid", "true");

    // Set end time to valid: 17:00
    await page.getByLabel("End time").first().fill("17:00");

    // Remove window 2
    await page.getByRole("button", { name: "Remove window" }).last().click();

    let savedPayload: { windows: { starts_at: string; ends_at: string }[] } | null = null;
    await page.route("**/api/phase4/competitions/*/officials/*/availability", async (route) => {
      if (route.request().method() === "PUT") {
        const payload = JSON.parse(route.request().postData() || "{}") as {
          windows: { starts_at: string; ends_at: string }[];
        };
        savedPayload = payload;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            windows: payload.windows,
            bumped_revision: true,
          }),
        });
        return;
      }
      await route.fallback();
    });

    const refreshedWorkspace = {
      officials: [
        {
          id: "60000000-0000-4000-8000-000000000001",
          competition_id: competitionId,
          name: "Official A",
          default_role: "Lead Official",
          archived: false,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      availability: {
        "60000000-0000-4000-8000-000000000001": [
          { starts_at: "2026-08-15T01:00:00.000Z", ends_at: "2026-08-15T09:00:00.000Z" },
        ],
      },
      assignments: [],
    };

    await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(refreshedWorkspace),
      });
    });

    await page.getByRole("button", { name: "Save availability" }).click();

    // Verify PUT request payload contains exact UTC ISO strings converted from Asia/Singapore, NOT America/Los_Angeles!
    // 2026-08-15 09:00 to 17:00 SGT is 01:00 to 09:00 UTC (SGT is UTC+8)
    expect(savedPayload).not.toBeNull();
    expect(savedPayload!.windows).toHaveLength(1);
    expect(savedPayload!.windows[0]).toEqual({
      starts_at: "2026-08-15T01:00:00.000Z",
      ends_at: "2026-08-15T09:00:00.000Z",
    });

    // Success notice displayed
    await expect(page.getByRole("status").filter({ hasText: "Availability saved." })).toBeVisible();

    // Schedule warning banner is displayed because bumped_revision: true
    await expect(page.getByText("This official was assigned to a match.")).toBeVisible();

    // Formatted window displayed in details panel in Asia/Singapore civil time
    await expect(page.getByText("09:00–17:00")).toBeVisible();
  });
});
