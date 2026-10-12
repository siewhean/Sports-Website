import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

// Track R2.1 (capacity change → affected matches + re-plan) and R2.2 (schedule delay control).
// The BFF command responses are fulfilled at the browser boundary so the demo-fixture build can
// render the post-command states; the API contract itself is covered by API integration tests.

const areaId = "8e66bd53-a9cb-4cde-840a-cc94988ca461";
const retainedAreaId = "6f1d6a5e-7c1a-4a51-9f0f-7c9e1d1e2b33";

// Route interception must see the BFF fetches, which a registered service worker would bypass.
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(`${name}-${testInfo.project.name}`, { path, contentType: "image/png" });
}

function windowRow(id: string, start: string, end: string, startsAt: string, endsAt: string) {
  return {
    id,
    date: "2026-08-15",
    start_time: start,
    end_time: end,
    cross_midnight: false,
    starts_at: startsAt,
    ends_at: endsAt,
  };
}

function capacityResponse(competitionId: string) {
  return {
    competition_id: competitionId,
    revision: 5,
    timezone: "Asia/Singapore",
    permission: "write",
    read_only: false,
    areas: [
      {
        id: areaId,
        name: "Pool A",
        sort_order: 0,
        slot_minutes: 30,
        fixed_reserve_slots: 2,
        scheduled_match_count: 6,
        retained: false,
        availability: [
          windowRow(
            "75706328-3058-44f0-a06a-8eb08980dd81",
            "09:00",
            "15:00",
            "2026-08-15T01:00:00.000Z",
            "2026-08-15T07:00:00.000Z",
          ),
        ],
        unavailable: [],
      },
      {
        id: retainedAreaId,
        name: "Pool B",
        sort_order: 1,
        slot_minutes: 30,
        fixed_reserve_slots: 0,
        scheduled_match_count: 2,
        retained: true,
        availability: [],
        unavailable: [],
      },
    ],
    effective: {
      timeZone: "Asia/Singapore",
      slotMinutes: 30,
      rawTotalSlots: 12,
      fixedReserveSlots: 2,
      availableMatchSlots: 10,
      requiredMatchSlots: 16,
      remainingMatchSlots: -6,
      status: "does_not_fit",
      areas: [
        { areaId, areaName: "Pool A", sortOrder: 0, usableMinutes: 360, rawSlots: 12, intervalCount: 1 },
        { areaId: retainedAreaId, areaName: "Pool B", sortOrder: 1, usableMinutes: 0, rawSlots: 0, intervalCount: 0 },
      ],
      intervals: [
        {
          id: "effective-a",
          areaId,
          areaName: "Pool A",
          startEpochMs: Date.parse("2026-08-15T01:00:00.000Z"),
          endEpochMs: Date.parse("2026-08-15T07:00:00.000Z"),
          startIso: "2026-08-15T01:00:00.000Z",
          endIso: "2026-08-15T07:00:00.000Z",
          usableMinutes: 360,
          slots: 12,
          unusedMinutes: 0,
          sourceAvailabilityIds: ["75706328-3058-44f0-a06a-8eb08980dd81"],
        },
      ],
    },
    idempotent_replay: false,
    affected_matches: [
      {
        match_id: "0b6f6a2e-4a8e-4d0e-9a39-2d6c8ad7a001",
        match_code: "G1-M5",
        playing_area_id: areaId,
        starts_at: "2026-08-15T08:00:00.000Z",
        ends_at: "2026-08-15T08:30:00.000Z",
        reason: "outside_availability_windows",
      },
      {
        match_id: "0b6f6a2e-4a8e-4d0e-9a39-2d6c8ad7a002",
        match_code: "G2-M3",
        playing_area_id: retainedAreaId,
        starts_at: "2026-08-15T02:00:00.000Z",
        ends_at: "2026-08-15T02:30:00.000Z",
        reason: "playing_area_removed",
      },
    ],
    replan_required: true,
  };
}

test("capacity save lists affected matches and offers re-planning", async ({ page }, testInfo) => {
  await page.route("**/api/phase3/competitions/*/capacity", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const competitionId = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[4]!);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(capacityResponse(competitionId)),
    });
  });
  await page.goto("/organiser/competitions/singapore-open/capacity");
  await dismissConsent(page);
  await page.getByLabel("Area name").fill("Pool Alpha");
  await page.getByRole("button", { name: "Save capacity" }).click();
  const panel = page.getByTestId("capacity-replan");
  await expect(panel.getByRole("heading", { name: "Scheduled matches need re-planning" })).toBeVisible();
  await expect(panel.getByText("G1-M5")).toBeVisible();
  await expect(panel.getByText("Outside available time")).toBeVisible();
  await expect(panel.getByText("Area removed")).toBeVisible();
  await expect(page.getByTestId("capacity-retained-areas").getByText("2 scheduled matches")).toBeVisible();
  await expect(panel.getByRole("link", { name: "Re-plan schedule" })).toHaveAttribute(
    "href",
    /\/organiser\/competitions\/[^/]+\/schedule$/,
  );
  // The retained area is not offered as editable capacity.
  await expect(page.getByLabel("Area name")).toHaveCount(1);
  await assertNoWcagAOrAaViolations(page);
  await capture(page, testInfo, "r2-capacity-replan");
});

test("schedule delay shows server conflicts and validates input", async ({ page }, testInfo) => {
  const conflict = "Delay rejected: it would create 1 conflict: possible entry overlap (G1-M3, G2-M1)";
  await page.route("**/api/phase4/schedule/revisions/*/delays", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "SCHEDULE_INVALID", message: conflict } }),
    });
  });
  allowConsoleFailure(page, /status of 422/);
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  const delay = page.getByTestId("schedule-delay");
  await expect(delay.getByRole("heading", { name: "Delay matches" })).toBeVisible();

  await delay.getByLabel("Delay (minutes)").fill("0");
  await delay.getByRole("button", { name: "Apply delay" }).click();
  await expect(delay.getByRole("alert")).toContainText("Enter a delay from 1 to 720 minutes");

  await delay.getByLabel("Delay (minutes)").fill("30");
  await delay.getByRole("button", { name: "Apply delay" }).click();
  await expect(delay.getByTestId("schedule-delay-error")).toContainText(conflict);
  await assertNoWcagAOrAaViolations(page);
  await capture(page, testInfo, "r2-schedule-delay");
});
