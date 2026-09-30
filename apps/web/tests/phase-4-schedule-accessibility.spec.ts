import { expect, test } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));
test.use({ serviceWorkers: "block" });

function relativeLuminance([red, green, blue]: number[]): number {
  return [red, green, blue]
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((luminance, channel, index) => luminance + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function parseRgb(value: string): number[] {
  return (
    value
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number) ?? []
  );
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(parseRgb(foreground)), relativeLuminance(parseRgb(background)));
  const darker = Math.min(relativeLuminance(parseRgb(foreground)), relativeLuminance(parseRgb(background)));
  return (lighter + 0.05) / (darker + 0.05);
}

test("@a11y schedule meets WCAG A/AA requirements", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

test("@a11y move flow meets WCAG A/AA requirements", async ({ page }) => {
  await page.route("**/moves/validate", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        validation: { valid: true, violations: [] },
        assignments: [],
        consequences: {
          moved_match_id: "match",
          from: null,
          to: null,
          affected_match_ids: [],
          dependency_match_ids: [],
          locked_match_ids: [],
          messages: [],
          quality: null,
        },
      }),
    }),
  );
  await page.goto(
    "/organiser/competitions/singapore-open/schedule/revisions/70000000-0000-4000-8000-000000000004/matches/30000000-0000-4000-8000-000000000001/move",
  );
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
  const stepNumberColors = await page
    .getByTestId("move-step-number")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
  expect(contrastRatio(stepNumberColors.foreground, stepNumberColors.background)).toBeGreaterThanOrEqual(4.5);
});

test("@a11y revision comparison meets WCAG A/AA requirements", async ({ page }) => {
  await page.goto(
    "/organiser/competitions/singapore-open/schedule/compare?left=70000000-0000-4000-8000-000000000003&right=70000000-0000-4000-8000-000000000004",
  );
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-schedule-comparison")).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
});

const scheduleUrl = "/organiser/competitions/singapore-open/schedule";
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

test("@a11y schedule no_solution state with official diagnostics meets WCAG A/AA requirements", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");

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
  await expect(diagnosticsContainer.getByRole("list")).toBeVisible();
  const reviewLinks = diagnosticsContainer.getByRole("link", { name: "Review officials" });
  await expect(reviewLinks.first()).toBeVisible();
  await expect(diagnosticsContainer.getByText(/potential official scheduling conflicts/i)).toBeVisible();

  await assertNoWcagAOrAaViolations(page);
});

test("@a11y schedule generic fallback no_solution state meets WCAG A/AA requirements", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");

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

  const genericContainer = page.getByTestId("no-solution-generic");
  await expect(genericContainer).toBeVisible();
  await expect(genericContainer.getByText(/No feasible schedule could be found/i)).toBeVisible();

  await assertNoWcagAOrAaViolations(page);
});

test("@a11y schedule match inspector with officials summary meets WCAG A/AA requirements", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "A11y runs in Chromium");

  await page.goto(scheduleUrl);
  await dismissConsent(page);

  // Click M1 to open match inspector
  const matchButton = page.getByRole("button", { name: /M1, .*Pasir Ris Rapids vs Kallang Breakers/i }).first();
  await expect(matchButton).toBeVisible();
  await matchButton.click();

  const inspector = page.locator("aside").filter({ hasText: "Selected match" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Officials" })).toBeVisible();
  await expect(inspector.getByTestId("schedule-assigned-official").first()).toBeVisible();
  await expect(inspector.getByRole("link", { name: /Manage officials|View officials/i })).toBeVisible();

  await assertNoWcagAOrAaViolations(page);
});
