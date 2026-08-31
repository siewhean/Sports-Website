import { expect, test } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const competitionId = "singapore-open";
const publishUrl = `/organiser/competitions/${competitionId}/publish`;
const assignment = {
  match_id: "30000000-0000-4000-8000-000000000001",
  division_id: "40000000-0000-4000-8000-000000000001",
  area_id: "20000000-0000-4000-8000-000000000001",
  interval_id: "21000000-0000-4000-8000-000000000001",
  slot_id: "21000000-0000-4000-8000-000000000001:1",
  start_epoch_ms: Date.parse("2026-08-15T00:00:00.000Z"),
  end_epoch_ms: Date.parse("2026-08-15T00:30:00.000Z"),
  fixed: false,
};
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
  components: [],
};

function publishedEnvelope() {
  return {
    id: "70000000-0000-4000-8000-000000000004",
    competition_id: "00000000-0000-4000-8000-000000000001",
    revision: 4,
    parent_revision_id: "70000000-0000-4000-8000-000000000003",
    source_job_id: "60000000-0000-4000-8000-000000000001",
    source_option_id: "50000000-0000-4000-8000-000000000001",
    status: "published",
    editable_until: null,
    published_at: "2026-08-15T06:00:00.000Z",
    expired_at: null,
    created_at: "2026-07-20T04:22:00.000Z",
    updated_at: "2026-08-15T06:00:00.000Z",
    assignment_hash: "a".repeat(64),
    quality,
    assignments: [assignment],
    idempotent_replay: false,
    schedule_version: 1,
  };
}

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("V1 Publish page performs the real schedule publication mutation", async ({ page }) => {
  let expectedRevision: number | null = null;
  let idempotencyKey: unknown = null;
  await page.route("**/api/phase4/schedule/revisions/*/publish", async (route) => {
    const requestBody = route.request().postDataJSON() as Record<string, unknown>;
    expectedRevision = typeof requestBody.expected_revision === "number" ? requestBody.expected_revision : null;
    idempotencyKey = requestBody.idempotency_key;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(publishedEnvelope()) });
  });

  await page.goto(publishUrl);
  await dismissConsent(page);

  await expect(page.getByTestId("v1-publish-workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Schedule revision 4" })).toBeVisible();
  await expect(page.getByText("8", { exact: true })).toBeVisible();
  const publish = page.getByRole("button", { name: "Publish schedule" });
  await expect(publish).toBeEnabled();
  await publish.click();

  await expect.poll(() => expectedRevision).toBe(4);
  expect(typeof idempotencyKey).toBe("string");
  await expect(page.getByRole("status").filter({ hasText: "Schedule revision 4 is now public." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open public competition" })).toBeVisible();
});

test("V1 Publish page preserves public truth when optimistic publication conflicts", async ({ page }) => {
  allowConsoleFailure(
    page,
    /^console\.error: Failed to load resource: the server responded with a status of 409 \(Conflict\)$/,
  );
  await page.route("**/api/phase4/schedule/revisions/*/publish", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "STALE_SCHEDULE_REVISION" } }),
    });
  });

  await page.goto(publishUrl);
  await dismissConsent(page);
  await page.getByRole("button", { name: "Publish schedule" }).click();

  await expect(
    page.getByText("This schedule changed before publication. Reload the latest revision and review it again."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open public competition" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeEnabled();
});

test("V1 Publish page keeps unavailable schedule state non-destructive", async ({ page }) => {
  await page.goto(`${publishUrl}?state=offline`);
  await dismissConsent(page);

  await expect(page.getByTestId("v1-publish-unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open schedule" })).toBeVisible();
});
