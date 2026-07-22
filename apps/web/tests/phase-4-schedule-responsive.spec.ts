import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));
test.use({ serviceWorkers: "block" });

test("schedule swaps the compressed timeline for a semantic phone list", async ({ page }, testInfo) => {
  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  const region = page.getByRole("region", { name: "Schedule by playing area and time" });
  const explanation = page.getByText("The timeline is replaced by an ordered schedule on smaller screens.");
  if (testInfo.project.name.includes("phone")) {
    await expect(region).toBeHidden();
    await expect(explanation).toBeVisible();
    await expect(
      page.getByRole("button", { name: /M1, .*Pasir Ris Rapids vs Kallang Breakers.*Locked/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /SF1, .*Marina Barracudas vs Seletar Paddlers.*Conflict/ }),
    ).toBeVisible();
  } else {
    await expect(region).toBeVisible();
    await expect(explanation).toBeHidden();
    await expect(
      region.getByRole("button", { name: /M1, .*Pasir Ris Rapids vs Kallang Breakers.*Locked/ }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", { name: /SF1, .*Marina Barracudas vs Seletar Paddlers.*Conflict/ }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test("immutable revision comparison names movement, rest, completion and conflict deltas", async ({ page }) => {
  await page.goto(
    "/organiser/competitions/singapore-open/schedule/compare?left=70000000-0000-4000-8000-000000000003&right=70000000-0000-4000-8000-000000000004",
  );
  await dismissConsent(page);
  const comparison = page.getByTestId("phase4-schedule-comparison");
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText("Moved matches", { exact: true })).toBeVisible();
  await expect(comparison.getByText("Minimum rest change", { exact: true })).toBeVisible();
  await expect(comparison.getByText("Completion change", { exact: true })).toBeVisible();
  await expect(comparison.getByText("Required conflicts", { exact: true })).toBeVisible();
  await expect(comparison.getByText("+15 min", { exact: true })).toBeVisible();
  await expect(comparison.getByText("+30 min", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test("phone organiser selects a match, day, available area and valid time before confirming", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("phone"), "Phone sequence only");
  const revisionId = "70000000-0000-4000-8000-000000000004";
  const matchId = "30000000-0000-4000-8000-000000000007";
  let validationRequests = 0;
  let moveBody: Record<string, unknown> | null = null;
  let slowAreaBValidation = false;
  await page.route(`**/api/phase4/schedule/revisions/${revisionId}/moves/validate`, async (route) => {
    validationRequests += 1;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (slowAreaBValidation && String(body.playing_area_id).endsWith("2"))
      await new Promise((resolve) => setTimeout(resolve, 400));
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
    moveBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/organiser/competitions/singapore-open/schedule");
  await dismissConsent(page);
  await page.getByRole("button", { name: /SF1, .*Marina Barracudas vs Seletar Paddlers.*Conflict/ }).click();
  await expect(page.getByRole("heading", { name: "SF1" })).toBeVisible();
  await page.getByRole("link", { name: "Move match" }).click();
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();

  await page.getByRole("radio", { name: "Sun, 16 Aug" }).check();
  await expect(page.getByRole("radio", { name: /Pool A/ })).toBeDisabled();
  await expect(page.getByRole("radio", { name: /Pool B/ })).toBeChecked();
  await page.getByRole("radio", { name: "Sat, 15 Aug" }).check();
  await page.getByRole("radio", { name: /Pool A/ }).check();
  const validTimes = page
    .getByRole("group", { name: "Select valid time" })
    .locator('input[type="radio"]:not(:disabled)');
  await validTimes.last().check();
  await expect.poll(() => validationRequests).toBeGreaterThan(0);
  await expect(page.getByText("Only the selected match changes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm move" })).toBeEnabled();
  slowAreaBValidation = true;
  await page.getByRole("radio", { name: /Pool B/ }).check();
  await expect(page.getByRole("button", { name: "Confirm move" })).toBeDisabled();
  await expect(page.getByText("Only the selected match changes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm move" })).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
  const returnedToSchedule = page.waitForURL(/\/organiser\/competitions\/[^/]+\/schedule$/);
  await page.getByRole("button", { name: "Confirm move" }).click();
  await expect.poll(() => moveBody).not.toBeNull();
  await returnedToSchedule;
  expect(moveBody).toMatchObject({ expected_revision: 4, match_id: matchId });
});

test("move flow keeps a reachable safe-area action bar", async ({ page }) => {
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
  const confirm = page.getByRole("button", { name: "Confirm move" });
  await expect(confirm).toBeVisible();
  expect((await confirm.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});
