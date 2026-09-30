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

test.describe("read-only official assignment integration (CP 5.5)", () => {
  const match1Id = "30000000-0000-4000-8000-000000000001";
  const match2Id = "30000000-0000-4000-8000-000000000002";
  const match3Id = "30000000-0000-4000-8000-000000000003";

  test("assigned official visible in MatchInspector and deep links to Officials page", async ({ page }) => {
    await page.goto(`${scheduleUrl}?match=${match1Id}`);
    await dismissConsent(page);

    // Inspector shows Officials section with Official A and assigned role
    const inspector = page.locator("aside").filter({ hasText: "Selected match" });
    await expect(inspector.getByRole("heading", { name: "Officials" })).toBeVisible();

    const officialItem = inspector.getByTestId("schedule-assigned-official").filter({ hasText: "Official A" });
    await expect(officialItem).toBeVisible();
    await expect(officialItem).toContainText("Lead Official");

    // Manage officials link is present and points to Officials page with ?match=
    const manageLink = inspector.getByRole("link", { name: "Manage officials" });
    await expect(manageLink).toBeVisible();
    await expect(manageLink).toHaveAttribute("href", new RegExp(`/officials\\?match=${match1Id}$`));

    // Click Manage officials and verify navigation + preselection
    await manageLink.click();
    await expect(page).toHaveURL(new RegExp(`/officials\\?match=${match1Id}$`));
    await expect(page.getByRole("heading", { name: "Match official assignments" })).toBeVisible();

    // Verify M1 is selected in Officials page match selector
    const matchSelect = page.locator("select").filter({ has: page.locator(`option[value="${match1Id}"]`) });
    await expect(matchSelect).toHaveValue(match1Id);
  });

  test("displays empty state when match has no assigned officials", async ({ page }) => {
    await page.goto(`${scheduleUrl}?match=${match3Id}`);
    await dismissConsent(page);

    const inspector = page.locator("aside").filter({ hasText: "Selected match" });
    await expect(inspector.getByRole("heading", { name: "Officials" })).toBeVisible();
    await expect(inspector.getByText("No officials assigned")).toBeVisible();
    await expect(inspector.getByRole("link", { name: "Manage officials" })).toHaveAttribute(
      "href",
      new RegExp(`/officials\\?match=${match3Id}$`),
    );
  });

  test("displays archived badge for archived assigned official", async ({ page }) => {
    await page.goto(`${scheduleUrl}?match=${match2Id}`);
    await dismissConsent(page);

    const inspector = page.locator("aside").filter({ hasText: "Selected match" });
    await expect(inspector.getByRole("heading", { name: "Officials" })).toBeVisible();

    const archivedItem = inspector.getByTestId("schedule-assigned-official").filter({ hasText: "Archived Official C" });
    await expect(archivedItem).toBeVisible();
    await expect(archivedItem.getByText("Archived", { exact: true })).toBeVisible();
  });

  test("displays temporary unavailable notice when officials workspace cannot load", async ({ page }) => {
    await page.goto(`${scheduleUrl}?match=${match1Id}&officials_state=error`);
    await dismissConsent(page);

    const inspector = page.locator("aside").filter({ hasText: "Selected match" });
    await expect(inspector.getByRole("heading", { name: "Officials" })).toBeVisible();
    await expect(inspector.getByText("Official assignments are temporarily unavailable.")).toBeVisible();
    await expect(inspector.getByText("No officials assigned")).not.toBeVisible();
  });

  test("fresh return: Schedule reflects updated assignments after editing on Officials page", async ({
    page,
    context,
  }) => {
    // Isolate demo state with demo scope cookie
    await context.addCookies([
      {
        name: "matchday_demo_scope",
        value: "cp55-roundtrip",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    // 1. Initial Schedule view: M1 has Official A
    await page.goto(`${scheduleUrl}?match=${match1Id}`);
    await dismissConsent(page);

    const inspector = page.locator("aside").filter({ hasText: "Selected match" });
    await expect(inspector.getByTestId("schedule-assigned-official").filter({ hasText: "Official A" })).toBeVisible();

    // 2. Click Manage officials to navigate
    await inspector.getByRole("link", { name: "Manage officials" }).click();
    await expect(page).toHaveURL(new RegExp(`/officials\\?match=${match1Id}$`));

    // 3. Edit assignments on Officials page
    await page.getByRole("button", { name: "Edit match officials" }).click();

    // Check Official B and uncheck Official A
    const checkboxA = page.locator(`#match-official-60000000-0000-4000-8000-000000000001`);
    const checkboxB = page.locator(`#match-official-60000000-0000-4000-8000-000000000002`);
    await checkboxA.uncheck();
    await checkboxB.check();
    await page.locator(`#match-role-60000000-0000-4000-8000-000000000002`).fill("Line Judge");

    // Save
    await page.getByRole("button", { name: "Save assignments" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Match officials saved." })).toBeVisible();

    // 4. Return to Schedule
    await page.goto(`${scheduleUrl}?match=${match1Id}`);

    // Inspector now shows Official B and does not show Official A
    const inspectorAfter = page.locator("aside").filter({ hasText: "Selected match" });
    await expect(
      inspectorAfter.getByTestId("schedule-assigned-official").filter({ hasText: "Official B" }),
    ).toBeVisible();
    await expect(
      inspectorAfter.getByTestId("schedule-assigned-official").filter({ hasText: "Official A" }),
    ).not.toBeVisible();
  });
});

test.describe("safe no_solution official diagnostics (CP 5.6)", () => {
  const jobId = "60000000-0000-4000-8000-000000000020";
  const match1Id = "30000000-0000-4000-8000-000000000001";
  const match2Id = "30000000-0000-4000-8000-000000000002";

  function queuedJob(id = jobId) {
    return {
      id,
      competition_id: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      source_revision: 1,
      capacity_revision: 1,
      capacity_hash: "cap-hash",
      status: "queued",
      objective: "balanced",
      continued_from_job_id: null,
      current_best_option_id: null,
      current_best: null,
      progress_iteration: null,
      explored_candidates: 0,
      progress_updated_at: null,
      cancellation_requested_at: null,
      started_at: null,
      completed_at: null,
      failure_class: null,
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
    };
  }

  function noSolutionJob(id = jobId) {
    return {
      id,
      competition_id: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      source_revision: 1,
      capacity_revision: 1,
      capacity_hash: "cap-hash",
      status: "no_solution",
      objective: "balanced",
      continued_from_job_id: null,
      current_best_option_id: null,
      current_best: null,
      progress_iteration: null,
      explored_candidates: 12,
      progress_updated_at: null,
      cancellation_requested_at: null,
      started_at: "2026-08-15T00:00:00.000Z",
      completed_at: "2026-08-15T00:01:00.000Z",
      failure_class: null,
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:01:00.000Z",
    };
  }

  test("terminal no_solution transition fetches diagnostics exactly once", async ({ page }) => {
    let diagnosticsCalls = 0;
    let pollCount = 0;

    await page.route("**/api/phase4/competitions/*/schedule/jobs", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          job: queuedJob(),
          enqueued: true,
          recoverable: true,
          idempotent_replay: false,
        }),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}`, async (route) => {
      pollCount += 1;
      const job = pollCount === 1 ? queuedJob() : noSolutionJob();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(job),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}/diagnostics`, async (route) => {
      diagnosticsCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: jobId,
          status: "no_solution",
          diagnostics: [
            {
              code: "official_unavailable",
              severity: "required",
              match_ids: [match1Id],
            },
          ],
        }),
      });
    });

    await page.goto(scheduleUrl);
    await dismissConsent(page);

    const generateBtn = page.getByRole("button", { name: /Generate/ }).first();
    await generateBtn.click();

    const diagnosticsContainer = page.getByTestId("no-solution-diagnostics");
    await expect(diagnosticsContainer).toBeVisible();
    expect(diagnosticsCalls).toBe(1);

    await page.waitForTimeout(500);
    expect(diagnosticsCalls).toBe(1);
  });

  test("displays official overlap diagnostics with review officials link", async ({ page }) => {
    await page.route("**/api/phase4/competitions/*/schedule/jobs", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          job: queuedJob(),
          enqueued: true,
          recoverable: true,
          idempotent_replay: false,
        }),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(noSolutionJob()),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}/diagnostics`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: jobId,
          status: "no_solution",
          diagnostics: [
            {
              code: "official_overlap",
              severity: "hard",
              match_ids: [match1Id, match2Id],
            },
          ],
        }),
      });
    });

    await page.goto(scheduleUrl);
    await dismissConsent(page);

    await page
      .getByRole("button", { name: /Generate/ })
      .first()
      .click();

    const diagnosticsContainer = page.getByTestId("no-solution-diagnostics");
    await expect(diagnosticsContainer).toBeVisible();
    await expect(diagnosticsContainer.getByText("Official conflicts detected")).toBeVisible();
    await expect(diagnosticsContainer.getByText("Official assigned to concurrent/overlapping matches")).toBeVisible();
    const reviewLink = diagnosticsContainer.getByRole("link", { name: "Review officials" });
    await expect(reviewLink).toBeVisible();
    await expect(reviewLink).toHaveAttribute("href", new RegExp(`/officials$`));
  });

  test("displays official unavailable diagnostics with match deep-link", async ({ page }) => {
    await page.route("**/api/phase4/competitions/*/schedule/jobs", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          job: queuedJob(),
          enqueued: true,
          recoverable: true,
          idempotent_replay: false,
        }),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(noSolutionJob()),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}/diagnostics`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: jobId,
          status: "no_solution",
          diagnostics: [
            {
              code: "official_unavailable",
              severity: "required",
              match_ids: [match1Id],
            },
          ],
        }),
      });
    });

    await page.goto(scheduleUrl);
    await dismissConsent(page);

    await page
      .getByRole("button", { name: /Generate/ })
      .first()
      .click();

    const diagnosticsContainer = page.getByTestId("no-solution-diagnostics");
    await expect(diagnosticsContainer).toBeVisible();
    await expect(diagnosticsContainer.getByText("Official unavailable for required match")).toBeVisible();
    const reviewLink = diagnosticsContainer.getByRole("link", { name: /Review officials/ });
    await expect(reviewLink).toBeVisible();
    await expect(reviewLink).toHaveAttribute("href", new RegExp(`/officials\\?match=${match1Id}$`));
  });

  test("displays generic notice when diagnostics array is empty", async ({ page }) => {
    await page.route("**/api/phase4/competitions/*/schedule/jobs", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          job: queuedJob(),
          enqueued: true,
          recoverable: true,
          idempotent_replay: false,
        }),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(noSolutionJob()),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}/diagnostics`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: jobId,
          status: "no_solution",
          diagnostics: [],
        }),
      });
    });

    await page.goto(scheduleUrl);
    await dismissConsent(page);

    await page
      .getByRole("button", { name: /Generate/ })
      .first()
      .click();

    const genericNotice = page.getByTestId("no-solution-generic");
    await expect(genericNotice).toBeVisible();
    await expect(
      genericNotice.getByText(
        "No feasible schedule could be found that satisfies all required constraints and playing areas.",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("no-solution-diagnostics")).not.toBeVisible();
  });

  test("degrades gracefully on 503 error and allows regeneration", async ({ page }) => {
    allowConsoleFailure(page, /^console\.error: Failed to load resource: the server responded with a status of 503/);

    await page.route("**/api/phase4/competitions/*/schedule/jobs", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          job: queuedJob(),
          enqueued: true,
          recoverable: true,
          idempotent_replay: false,
        }),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(noSolutionJob()),
      });
    });

    await page.route(`**/api/phase4/schedule/jobs/${jobId}/diagnostics`, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }),
      });
    });

    await page.goto(scheduleUrl);
    await dismissConsent(page);

    await page
      .getByRole("button", { name: /Generate/ })
      .first()
      .click();

    const genericNotice = page.getByTestId("no-solution-generic");
    await expect(genericNotice).toBeVisible();
    await expect(
      genericNotice.getByText(
        "No feasible schedule could be found that satisfies all required constraints and playing areas.",
      ),
    ).toBeVisible();

    const regenBtn = page.getByRole("button", { name: /Generate/ }).first();
    await expect(regenBtn).toBeEnabled();
  });
});
