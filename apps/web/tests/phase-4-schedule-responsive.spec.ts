import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));
test.use({ serviceWorkers: "block" });

test("schedule swaps the compressed timeline for a semantic smaller-screen list", async ({ page }, testInfo) => {
  await page.goto("/organiser/competitions/singapore-open/schedule?advanced=1");
  await dismissConsent(page);
  const region = page.getByRole("region", { name: "Schedule by playing area and time" });
  const explanation = page.getByText("The timeline is replaced by an ordered schedule on smaller screens.");
  if (testInfo.project.name.includes("phone") || testInfo.project.name.includes("tablet")) {
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
    const finalMatch = region.getByRole("button", { name: /SF2, .*Telok Ayer Tide vs Bedok Undertow/ });
    const canScroll = await region.evaluate((element) => element.scrollWidth > element.clientWidth);
    if (canScroll) {
      await region.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
      await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    }
    await finalMatch.scrollIntoViewIfNeeded();
    const [regionBox, finalMatchBox] = await Promise.all([region.boundingBox(), finalMatch.boundingBox()]);
    expect(regionBox).not.toBeNull();
    expect(finalMatchBox).not.toBeNull();
    expect(finalMatchBox!.x + finalMatchBox!.width).toBeLessThanOrEqual(regionBox!.x + regionBox!.width + 1);
    if (testInfo.project.name === "desktop-chromium") {
      expect(regionBox!.y).toBeLessThan(page.viewportSize()!.height);
    }
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test("schedule uses the semantic list through 900px and the desktop timeline at 901px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Breakpoint boundary runs once in Chromium");
  const region = page.getByRole("region", { name: "Schedule by playing area and time" });
  const explanation = page.getByText("The timeline is replaced by an ordered schedule on smaller screens.");

  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/organiser/competitions/singapore-open/schedule?advanced=1");
  await dismissConsent(page);
  await expect(region).toBeHidden();
  await expect(explanation).toBeVisible();

  await page.setViewportSize({ width: 901, height: 900 });
  await expect(region).toBeVisible();
  await expect(explanation).toBeHidden();
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

test("smaller-screen organiser selects a match, day, available area and valid time before confirming", async ({
  page,
}, testInfo) => {
  const isPhone = testInfo.project.name.includes("phone");
  test.skip(!isPhone && !testInfo.project.name.includes("tablet"), "Smaller-screen sequence only");
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
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "70000000-0000-4000-8000-000000000005",
        competition_id: "singapore-open",
        revision: 5,
        parent_revision_id: revisionId,
        source_job_id: "60000000-0000-4000-8000-000000000001",
        source_option_id: null,
        status: "ready_for_review",
        editable_until: "2026-08-22T00:00:00.000Z",
        published_at: null,
        expired_at: null,
        created_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:00:00.000Z",
        assignment_hash: "a".repeat(64),
        quality: null,
        assignments: [],
        idempotent_replay: false,
        consequences: {
          moved_match_id: matchId,
          from: {
            area_id: "40000000-0000-4000-8000-000000000001",
            slot_id: "slot-current",
            start_epoch_ms: Date.parse("2026-08-15T04:30:00.000Z"),
            end_epoch_ms: Date.parse("2026-08-15T05:00:00.000Z"),
          },
          to: {
            match_id: matchId,
            playing_area_id: moveBody.playing_area_id,
            slot_id: moveBody.slot_id,
            start_epoch_ms: moveBody.start_epoch_ms,
            end_epoch_ms: moveBody.end_epoch_ms,
          },
          affected_match_ids: [matchId],
          dependency_match_ids: [],
          locked_match_ids: [],
          messages: ["Only the selected match changes."],
          quality: null,
        },
      }),
    });
  });

  await page.goto("/organiser/competitions/singapore-open/schedule?advanced=1");
  await dismissConsent(page);
  await page.getByRole("button", { name: /SF1, .*Marina Barracudas vs Seletar Paddlers.*Conflict/ }).click();
  await expect(page.getByRole("heading", { name: "SF1" })).toBeVisible();
  await Promise.all([
    page.waitForURL((url) => url.pathname.endsWith(`/matches/${matchId}/move`)),
    page.getByRole("link", { name: "Move match" }).click(),
  ]);
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible({ timeout: 10_000 });
  const slotChoices = page.getByTestId("move-slot-choices");
  const disclosure = page.getByRole("button", { name: "Show all 18 times" });
  await expect(disclosure).toBeVisible({ visible: isPhone });
  await expect(slotChoices.locator("label:visible")).toHaveCount(isPhone ? 6 : 18);
  if (isPhone) await disclosure.click();
  await expect(slotChoices.locator("label:visible")).toHaveCount(18);
  await expect(page.getByRole("button", { name: "Show fewer times" })).toBeVisible({ visible: isPhone });

  const confirmMove = page.getByRole("button", { name: "Confirm move" });
  const selectAndWaitForValidation = async (select: () => Promise<void>) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/phase4/schedule/revisions/${revisionId}/moves/validate`) &&
        response.request().method() === "POST",
    );
    await select();
    await expect(confirmMove).toBeDisabled();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(confirmMove).toBeEnabled();
  };

  await expect(confirmMove).toBeEnabled();
  await selectAndWaitForValidation(() => page.getByRole("radio", { name: "Sun, 16 Aug" }).check());
  await expect(page.getByRole("radio", { name: /Pool A/ })).toBeDisabled();
  await expect(page.getByRole("radio", { name: /Pool B/ })).toBeChecked();
  await selectAndWaitForValidation(() => page.getByRole("radio", { name: "Sat, 15 Aug" }).check());
  await selectAndWaitForValidation(() => page.getByRole("radio", { name: /Pool A/ }).check());
  if (isPhone) await page.getByRole("button", { name: "Show all 18 times" }).click();
  const validTimes = page
    .getByRole("group", { name: "Select valid time" })
    .locator('input[type="radio"]:not(:disabled)');
  await selectAndWaitForValidation(() => validTimes.last().check());
  await expect.poll(() => validationRequests).toBeGreaterThan(0);
  await expect(page.getByText("Only the selected match changes.")).toBeVisible();
  await expect(confirmMove).toBeEnabled();
  slowAreaBValidation = true;
  await page.getByRole("radio", { name: /Pool B/ }).check();
  await expect(confirmMove).toBeDisabled();
  await expect(page.getByText("Only the selected match changes.")).toBeVisible();
  await expect(confirmMove).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
  const returnedToSchedule = page.waitForURL(
    new RegExp(`/organiser/competitions/[^/]+/schedule\\?match=${matchId}&notice=moved$`),
  );
  await confirmMove.click();
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
