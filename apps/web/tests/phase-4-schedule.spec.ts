import { expect, test } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const scheduleUrl = "/organiser/competitions/singapore-open/schedule";
const revisionId = "70000000-0000-4000-8000-000000000004";
const acceptedRevisionId = "70000000-0000-4000-8000-000000000005";
const matchId = "30000000-0000-4000-8000-000000000001";
const startEpochMs = Date.parse("2026-08-15T00:00:00.000Z");
const assignment = {
  match_id: matchId,
  division_id: "40000000-0000-4000-8000-000000000001",
  area_id: "20000000-0000-4000-8000-000000000001",
  interval_id: "21000000-0000-4000-8000-000000000001",
  slot_id: "21000000-0000-4000-8000-000000000001:1",
  start_epoch_ms: startEpochMs,
  end_epoch_ms: startEpochMs + 30 * 60_000,
  fixed: false,
};
const assignments = Array.from({ length: 8 }, (_, index) => ({
  ...assignment,
  match_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  area_id: `20000000-0000-4000-8000-00000000000${(index % 2) + 1}`,
  slot_id: `21000000-0000-4000-8000-00000000000${(index % 2) + 1}:${index + 1}`,
  start_epoch_ms: startEpochMs + index * 30 * 60_000,
  end_epoch_ms: startEpochMs + (index + 1) * 30 * 60_000,
  fixed: index < 2,
}));
const quality = {
  score: 91,
  objective: "balanced",
  valid: true,
  makespan_minutes: 600,
  minimum_rest_minutes: 60,
  maximum_matches_per_entry_day: 4,
  preferred_final_delta_minutes: 15,
  required_violation_count: 0,
  preferred_penalty: 5,
  components: [
    {
      key: "rest",
      score: 92,
      weight: 4,
      measured: 60,
      unit: "minutes",
      explanation: "Minimum rest is sixty minutes.",
    },
  ],
};

function revisionResponse({
  id = acceptedRevisionId,
  revision = 5,
  parentRevisionId = revisionId,
  status = "ready_for_review",
  publishedAt = null,
}: {
  id?: string;
  revision?: number;
  parentRevisionId?: string;
  status?: "ready_for_review" | "published";
  publishedAt?: string | null;
} = {}) {
  return {
    id,
    competition_id: "00000000-0000-4000-8000-000000000001",
    revision,
    parent_revision_id: parentRevisionId,
    source_job_id: "60000000-0000-4000-8000-000000000001",
    source_option_id: "50000000-0000-4000-8000-000000000001",
    status,
    editable_until: "2026-08-19T04:22:00.000Z",
    published_at: publishedAt,
    expired_at: null,
    created_at: "2026-07-20T04:22:00.000Z",
    updated_at: "2026-07-20T04:25:00.000Z",
    assignment_hash: "a".repeat(64),
    quality,
    assignments,
    idempotent_replay: false,
  };
}

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("schedule exposes measurable alternatives, timeline, inspector and explicit publication", async ({ page }) => {
  let published = false;
  let acceptedFastest = false;
  let mainFrameNavigations = 0;
  await page.route("**/api/phase4/schedule/jobs/*/options/*/accept", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_job_revision).toBe(5);
    acceptedFastest = true;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(revisionResponse()) });
  });
  await page.route("**/api/phase4/schedule/revisions/*/publish", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_revision).toBe(5);
    expect(typeof body.idempotency_key).toBe("string");
    published = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...revisionResponse({
          status: "published",
          publishedAt: "2026-07-20T04:25:00.000Z",
        }),
        schedule_version: 1,
      }),
    });
  });
  await page.goto(scheduleUrl);
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compare schedule quality" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fastest" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Balanced" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rest-focused" })).toBeVisible();
  await expect(page.getByText("Moved matches").first()).toBeVisible();
  await expect(page.getByText(/existing assignments move/).first()).toBeVisible();
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  await page.getByRole("button", { name: /M2/ }).first().click();
  await expect(page.getByRole("heading", { name: "M2" })).toBeVisible();
  const useFastest = page.getByRole("button", { name: "Use Fastest" });
  await useFastest.scrollIntoViewIfNeeded();
  const acceptScroll = await page.evaluate(() => window.scrollY);
  await useFastest.click();
  await expect.poll(() => acceptedFastest).toBe(true);
  await expect(page.getByText("The selected option was saved as a new private revision.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule update status" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "M2" })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(acceptScroll);
  expect(mainFrameNavigations).toBe(0);
  await expect(page.getByText(/13 candidates explored\./)).toBeVisible();
  await expect(page.getByRole("region", { name: "Schedule by playing area and time" })).toBeVisible();
  const publishButton = page.getByRole("button", { name: "Publish schedule" });
  await publishButton.scrollIntoViewIfNeeded();
  const publishScroll = await page.evaluate(() => window.scrollY);
  await publishButton.click();
  await expect.poll(() => published).toBe(true);
  await expect(page.getByText("Schedule published. The public schedule version has advanced.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule update status" })).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(publishScroll);
  expect(mainFrameNavigations).toBe(0);
});

test("lock and unlock preserve selection, focus and scroll without navigation", async ({ page }) => {
  let method = "";
  await page.route(`**/api/phase4/schedule/revisions/${revisionId}/locks/${matchId}`, async (route) => {
    method = route.request().method();
    expect(Object.keys(route.request().postDataJSON() as object)).toEqual(["idempotency_key"]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ match_id: matchId, unlocked: true, idempotent_replay: false }),
    });
  });
  await page.goto(scheduleUrl);
  await dismissConsent(page);
  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  const unlockButton = page.getByRole("button", { name: "Unlock match" });
  await unlockButton.scrollIntoViewIfNeeded();
  const unlockScroll = await page.evaluate(() => window.scrollY);
  await unlockButton.click();
  await expect.poll(() => method).toBe("DELETE");
  await expect(page.getByText("Match unlocked. The selected match remains open.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule update status" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "M1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lock match" })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(unlockScroll);

  await page.route(`**/api/phase4/schedule/revisions/${revisionId}/locks`, async (route) => {
    method = route.request().method();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "lock-2",
        match_id: matchId,
        source_schedule_revision_id: revisionId,
        playing_area_id: assignment.area_id,
        start_epoch_ms: assignment.start_epoch_ms,
        end_epoch_ms: assignment.end_epoch_ms,
        locked_by: "account-1",
        created_at: "2026-07-20T04:26:00.000Z",
        idempotent_replay: false,
      }),
    });
  });
  const lockButton = page.getByRole("button", { name: "Lock match" });
  await lockButton.click();
  await expect.poll(() => method).toBe("POST");
  await expect(page.getByText("Match locked. The selected match remains open.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule update status" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Unlock match" })).toBeVisible();
  expect(mainFrameNavigations).toBe(0);
});

test("schedule conflicts preserve the selected match, focus and scroll context", async ({ page }) => {
  allowConsoleFailure(
    page,
    /^console\.error: Failed to load resource: the server responded with a status of 409 \(Conflict\)$/,
  );
  await page.route("**/api/phase4/schedule/jobs/*/options/*/accept", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "STALE_SCHEDULE_INPUT" } }),
    });
  });
  await page.goto(scheduleUrl);
  await dismissConsent(page);
  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  await page.getByRole("button", { name: /M2/ }).first().click();
  const useFastest = page.getByRole("button", { name: "Use Fastest" });
  await useFastest.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await useFastest.click();
  await expect(page.getByTestId("phase4-schedule").getByRole("alert")).toContainText(
    "Schedule inputs changed. Generate a new schedule from the latest format and capacity.",
  );
  await expect(useFastest).toBeFocused();
  await expect(page.getByRole("heading", { name: "M2" })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  expect(mainFrameNavigations).toBe(0);
});

test("move flow validates consequences before sending the optimistic revision", async ({ page }) => {
  let confirmed = false;
  await page.route(`**/api/phase4/schedule/revisions/${revisionId}/moves/validate`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        validation: { valid: true, violations: [] },
        assignments: [],
        consequences: {
          moved_match_id: matchId,
          from: null,
          to: body,
          affected_match_ids: [matchId],
          dependency_match_ids: [],
          locked_match_ids: [],
          messages: ["Only the selected match changes."],
          quality: null,
        },
      }),
    });
  });
  await page.route(`**/api/phase4/schedule/revisions/${revisionId}/moves`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_revision).toBe(4);
    expect(body.match_id).toBe(matchId);
    confirmed = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        ...revisionResponse({ revision: 5, parentRevisionId: revisionId }),
        consequences: {
          moved_match_id: matchId,
          from: {
            area_id: assignment.area_id,
            slot_id: assignment.slot_id,
            start_epoch_ms: assignment.start_epoch_ms,
            end_epoch_ms: assignment.end_epoch_ms,
          },
          to: {
            match_id: matchId,
            playing_area_id: body.playing_area_id,
            slot_id: body.slot_id,
            start_epoch_ms: body.start_epoch_ms,
            end_epoch_ms: body.end_epoch_ms,
          },
          affected_match_ids: [matchId],
          dependency_match_ids: [],
          locked_match_ids: [],
          messages: ["Only the selected match changes."],
          quality,
        },
      }),
    });
  });
  await page.goto(`${scheduleUrl}/revisions/${revisionId}/matches/${matchId}/move`);
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  await expect(page.getByText("Only the selected match changes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm move" })).toBeEnabled();
  await page.getByRole("button", { name: "Confirm move" }).click();
  await expect.poll(() => confirmed).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/schedule\\?match=${matchId}&notice=moved$`));
  await expect(page.getByText("Match moved into a new private schedule revision.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule update status" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "M1" })).toBeVisible();
});

test("schedule state routes remain truthful and non-mutating", async ({ page }) => {
  for (const [state, heading] of [
    ["empty", "No schedule draft yet"],
    ["offline", "Schedule service offline"],
    ["permission", "Schedule access required"],
    ["error", "Schedule could not load"],
  ] as const) {
    await page.goto(`${scheduleUrl}?state=${state}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await page.goto(`${scheduleUrl}?state=read-only`);
  await expect(page.getByText("Schedule is read only", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeDisabled();
});
