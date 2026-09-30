import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

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

  // 3. Create flow: client validation and successful addition
  await page.getByRole("button", { name: "Add official" }).click();
  await expect(page.getByRole("heading", { name: "Add official" })).toBeVisible();

  // Submit empty -> validation error
  await page.getByRole("button", { name: "Add official" }).last().click();
  await expect(page.getByRole("alert")).toContainText("Name is required.");

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

  await page.route("**/api/phase4/competitions/*/officials/workspace", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
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
      }),
    });
  });

  await page.getByLabel("Name").fill("Charlie Davis");
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

  // Archive confirmed with bumped_revision = true
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

  await page.getByRole("button", { name: "Archive official" }).last().click();
  expect(archivedOfficial).toBe(true);
  await expect(page.getByRole("status").first()).toContainText("Official archived.");

  // Verify scheduling invalidation warning banner appears with review link
  await expect(page.getByText("This official was assigned to a match.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review schedule" })).toBeVisible();
});
