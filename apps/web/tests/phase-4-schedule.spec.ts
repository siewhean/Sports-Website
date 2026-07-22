import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const scheduleUrl = "/organiser/competitions/singapore-open/schedule";
const competitionId = "singapore-open";
const revisionId = "70000000-0000-4000-8000-000000000004";
const matchId = "30000000-0000-4000-8000-000000000001";
const jobId = "60000000-0000-4000-8000-000000000001";
const optionId = "50000000-0000-4000-8000-000000000001";
const formatId = "43e3501f-df87-466c-b2a7-ded47ae92ee5";
const candidateId = "balanced-groups";
const divisionId = "4a1cae2b-1ef7-4fb0-b323-7046077f7a80";
const hash = "1".repeat(64);
const now = "2026-07-20T06:18:00.000Z";

function setupDocument(
  revision = 4,
  scheduleReview: Record<string, unknown> | null = null,
  reviewPublish: Record<string, unknown> | null = null,
) {
  const stepIds = [
    "basics",
    "capacity",
    "settings",
    "entries",
    "format_preferences",
    "format_recommendations",
    "schedule_review",
    "review_publish",
  ] as const;
  const currentIndex = scheduleReview ? 7 : 6;
  return {
    schema_version: 1,
    id: "0cc48815-adc6-4bda-838f-3b52eb8c7862",
    organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
    competition_id: competitionId,
    competition_status: "draft",
    revision,
    status: "active",
    current_step: scheduleReview ? "review_publish" : "schedule_review",
    completed_steps: stepIds.slice(0, reviewPublish ? 8 : currentIndex),
    steps: stepIds.map((id, index) => ({
      id,
      status: index < (reviewPublish ? 8 : currentIndex) ? "completed" : index === currentIndex ? "current" : "not_started",
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
      errors: [],
      completed_at: index < (reviewPublish ? 8 : currentIndex) ? now : null,
    })),
    values: {
      basics: {
        name: "Singapore Open 2026",
        sport_code: "canoe_polo",
        location: {
          venue: "OCBC Aquatic Centre",
          address: "7 Stadium Drive",
          locality: "Singapore",
          country_code: "SG",
        },
        starts_on: "2026-08-15",
        ends_on: "2026-08-16",
        time_zone: "Asia/Singapore",
        locale: "en-SG",
        entry_count: 8,
        division_count: 1,
        entry_count_status: "confirmed",
      },
      capacity: {
        kind: "phase3_capacity_revision",
        competition_id: competitionId,
        revision: 4,
        time_zone: "Asia/Singapore",
        area_ids: ["8e66bd53-a9cb-4cde-840a-cc94988ca461"],
        source_hash: hash,
        effective: {
          slotMinutes: 30,
          rawTotalSlots: 36,
          fixedReserveSlots: 0,
          availableMatchSlots: 36,
          requiredMatchSlots: 31,
          remainingMatchSlots: 5,
          status: "comfortable",
        },
      },
      settings: [
        {
          competition_id: competitionId,
          scope: "competition",
          division_id: null,
          settings_revision: 3,
          mode: "recommended",
          pack_schema_version: 1,
          pack_version: "2026.1",
          pack_definition_hash: hash,
        },
      ],
      entries: {
        competition_id: competitionId,
        divisions: [
          {
            division_id: divisionId,
            division_revision: 2,
            entry_ids: Array.from({ length: 8 }, (_, index) => `demo-entry-${index + 1}`),
            confirmed_count: 8,
            placeholder_count: 0,
          },
        ],
        imports: [],
        total_entry_count: 8,
      },
      format_preferences: {
        minimum_matches: { per_entry: 3 },
        ranking: { rank_all_entries: true },
        knockout: { required: true },
        placement: { required: true },
        qualification: { cross_group_allowed: false },
        priority: { value: "participation" },
      },
      format_recommendations: {
        recommendations: [
          {
            id: candidateId,
            format_revision_id: formatId,
            format_definition_hash: hash,
            name: "Balanced groups",
            structure: "Two groups, semi-finals, bronze match and final",
            advantage: "Every team plays at least three matches with a complete podium.",
            match_count: 31,
            minimum_matches_per_entry: 3,
            guaranteed_matches: 3,
            ranking_coverage: "all_entries",
            available_match_slots: 36,
            division_formats: [
              {
                division_id: divisionId,
                candidate_division_id: "43e3501f-df87-466c-b2a7-ded47ae92ee1",
                format_revision_id: formatId,
                format_definition_hash: hash,
                match_count: 31,
                guaranteed_matches: 3,
                ranking_coverage: "all_entries",
              },
            ],
            capacity_status: "fits",
            scheduling_status: "feasible",
            warning_codes: [],
          },
        ],
        requires_changes: null,
        selected_recommendation_id: candidateId,
        acknowledged_capacity_shortfall: false,
        recommendation_set_hash: hash,
      },
      schedule_review: scheduleReview,
      review_publish: reviewPublish,
    },
    permission: "write",
    read_only: false,
    autosave: { status: "saved", last_saved_at: now, expires_at: "2026-08-19T06:18:00.000Z" },
    created_at: "2026-07-20T05:50:00.000Z",
    updated_at: now,
    completed_at: null,
  };
}

function scheduleRevision(status: "ready_for_review" | "published") {
  const revision = {
    id: revisionId,
    competition_id: competitionId,
    revision: 4,
    parent_revision_id: null,
    source_job_id: jobId,
    source_option_id: optionId,
    status,
    editable_until: status === "published" ? null : "2026-08-19T06:18:00.000Z",
    published_at: status === "published" ? now : null,
    expired_at: null,
    created_at: now,
    updated_at: now,
    assignment_hash: hash,
    quality: null,
    assignments: [],
    idempotent_replay: false,
  };
  return status === "published" ? { ...revision, schedule_version: 1 } : revision;
}

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("schedule exposes measurable alternatives, timeline, inspector and explicit publication without navigation", async ({
  page,
}) => {
  let published = false;
  let acceptedFastest = false;
  let currentSetup = setupDocument();

  await page.route("**/api/phase4/competitions/singapore-open/setup-draft", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const body = route.request().postDataJSON() as {
      expected_revision: number;
      transition: { step: { step_id: string; value: Record<string, unknown> } };
    };
    expect(body.expected_revision).toBe(currentSetup.revision);
    if (body.transition.step.step_id === "schedule_review") {
      currentSetup = setupDocument(currentSetup.revision + 1, body.transition.step.value, null);
    } else if (body.transition.step.step_id === "review_publish") {
      currentSetup = setupDocument(
        currentSetup.revision + 1,
        currentSetup.values.schedule_review,
        body.transition.step.value,
      );
    } else throw new Error(`Unexpected setup step ${body.transition.step.step_id}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "saved", document: currentSetup }),
    });
  });
  await page.route("**/api/phase4/competitions/singapore-open/setup-draft/resume", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentSetup) });
  });
  await page.route("**/api/phase4/schedule/jobs/*/options/*/accept", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_job_revision).toBe(5);
    acceptedFastest = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(scheduleRevision("ready_for_review")),
    });
  });
  await page.route(`**/api/phase4/schedule/revisions/${revisionId}/publish`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_revision).toBe(4);
    expect(typeof body.idempotency_key).toBe("string");
    published = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scheduleRevision("published")),
    });
  });

  await page.goto(scheduleUrl);
  await dismissConsent(page);
  const stableUrl = page.url();
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compare schedule quality" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fastest" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Balanced" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rest-focused" })).toBeVisible();
  await expect(page.getByText("Moved matches").first()).toBeVisible();
  await expect(page.getByText(/existing assignments move/).first()).toBeVisible();

  await page.getByRole("button", { name: "Use Fastest" }).click();
  await expect.poll(() => acceptedFastest).toBe(true);
  await expect(page).toHaveURL(stableUrl);
  await expect(page.getByTestId("phase4-schedule")).toContainText(/schedule option saved/i);
  expect(currentSetup.values.schedule_review).toMatchObject({
    schedule_job_id: jobId,
    schedule_revision_id: revisionId,
    selected_result_hash: hash,
  });

  await expect(page.getByText(/13 candidates explored\./)).toBeVisible();
  await expect(page.getByRole("region", { name: "Schedule by playing area and time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "M1" })).toBeVisible();
  await page.getByRole("button", { name: "Publish schedule" }).click();
  await expect.poll(() => published).toBe(true);
  await expect(page).toHaveURL(stableUrl);
  await expect(page.getByTestId("phase4-schedule")).toContainText(/schedule published/i);
  expect(currentSetup.values.review_publish).toMatchObject({
    publication_status: "published",
    published_schedule_revision_id: revisionId,
  });
});

test("unlock uses DELETE and keeps a single idempotent command body", async ({ page }) => {
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
  await page.getByRole("button", { name: "Unlock match" }).click();
  await expect.poll(() => method).toBe("DELETE");
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
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`${scheduleUrl}/revisions/${revisionId}/matches/${matchId}/move`);
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  await expect(page.getByText("Only the selected match changes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm move" })).toBeEnabled();
  await page.getByRole("button", { name: "Confirm move" }).click();
  await expect.poll(() => confirmed).toBe(true);
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
