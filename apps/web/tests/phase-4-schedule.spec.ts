import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const scheduleUrl = "/organiser/competitions/singapore-open/schedule";
const revisionId = "70000000-0000-4000-8000-000000000004";
const matchId = "30000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("schedule exposes measurable alternatives, timeline, inspector and explicit publication", async ({ page }) => {
  let published = false;
  let acceptedFastest = false;
  await page.route("**/api/phase4/schedule/jobs/*/options/*/accept", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_job_revision).toBe(5);
    acceptedFastest = true;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/phase4/schedule/revisions/${revisionId}/publish`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_revision).toBe(4);
    expect(typeof body.idempotency_key).toBe("string");
    published = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
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
  const acceptedReload = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await page.getByRole("button", { name: "Use Fastest" }).click();
  await expect.poll(() => acceptedFastest).toBe(true);
  await acceptedReload;
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  await expect(page.getByText(/13 candidates explored\./)).toBeVisible();
  await expect(page.getByRole("region", { name: "Schedule by playing area and time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "M1" })).toBeVisible();
  await page.getByRole("button", { name: "Publish schedule" }).click();
  await expect.poll(() => published).toBe(true);
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
