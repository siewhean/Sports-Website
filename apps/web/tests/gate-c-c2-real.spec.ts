import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { dismissConsent, installConsoleGuard, assertConsoleGuard } from "./helpers/console-guard";

type SportId = "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
type SportSeed = {
  sportId: SportId;
  competitionId: string;
  divisionId: string;
  matchId: string;
  downstreamMatchId: string | null;
  slug: string;
  homeName: string;
  awayName: string;
  accessToken: string;
  secondaryDivision?: {
    divisionId: string;
    matchId: string;
    homeName: string;
    awayName: string;
    accessToken: string;
  };
  action: {
    eventType: string;
    accessibleName: string;
    participantRequired: boolean;
    manualTimeRequired: boolean;
  };
};
type SeedState = {
  webOrigin: string;
  organiserCookie: string;
  sports: SportSeed[];
};
type AuditDocument = {
  aggregate_version: number;
  result: { result_version: number } | null;
  events: Array<{
    event_id: string;
    event_type: string;
    segment_number: number | null;
    manual_time_seconds: number | null;
  }>;
  audit: unknown[];
};

async function state(): Promise<SeedState> {
  const file = process.env.PHASE2_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE2_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<SeedState>;
  if (!parsed.webOrigin || !parsed.organiserCookie || parsed.sports?.length !== 5) {
    throw new Error("Gate C C2 real seed must contain five isolated sport aggregates");
  }
  return parsed as SeedState;
}

async function sameOriginJson<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: Record<string, unknown> },
): Promise<T> {
  const result = await page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
        method: requestInit?.method ?? "GET",
        credentials: "same-origin",
        headers: requestInit?.body ? { "content-type": "application/json" } : undefined,
        body: requestInit?.body ? JSON.stringify(requestInit.body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, text };
    },
    { requestPath: path, requestInit: init },
  );
  expect(result.status, `${path}\n${result.text}`).toBeGreaterThanOrEqual(200);
  expect(result.status, `${path}\n${result.text}`).toBeLessThan(300);
  return JSON.parse(result.text) as T;
}

async function completeSport(page: Page, sport: SportSeed, initialSequence: number): Promise<number> {
  if (sport.sportId === "badminton" || sport.sportId === "table_tennis" || sport.sportId === "volleyball") {
    const label = sport.sportId === "volleyball" ? "Set completion" : "Game completion";
    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/scoring/events") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: `${label} ${sport.homeName}` }).click();
    const dialog = page.getByRole("dialog", { name: `Record event: ${label}` });
    await dialog.getByRole("button", { name: "Record event" }).click();
    const response = await responsePromise;
    const body = response.request().postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({
      type: sport.sportId === "volleyball" ? "set_completion" : "game_completion",
      team_slot: "home",
      segment_number: 1,
      expected_sequence: initialSequence,
    });
    const text = await response.text();
    expect(response.status(), `segment completion\n${text}`).toBe(200);
    const receipt = JSON.parse(text) as { sequence: number; duplicate: boolean };
    expect(receipt).toEqual({ sequence: initialSequence + 1, duplicate: false });
    await expect(dialog).toBeHidden();
    return receipt.sequence;
  }
  return initialSequence;
}

async function recordUiAction(page: Page, sport: SportSeed): Promise<Record<string, unknown>> {
  const requestPromise = page.waitForRequest(
    (request) => request.url().endsWith("/api/scoring/events") && request.method() === "POST",
  );
  await page.getByRole("button", { name: sport.action.accessibleName }).click();
  const dialog = page.getByRole("dialog");
  const participant = dialog.getByLabel("Scorer or participant name");
  if (await participant.count()) await participant.fill(`${sport.homeName} scorer`);
  await dialog
    .getByRole("button", {
      name: sport.sportId === "canoe_polo" ? `Record goal for ${sport.homeName}` : "Record event",
    })
    .click();
  await expect(dialog).toBeHidden();
  const request = await requestPromise;
  const body = request.postDataJSON() as Record<string, unknown>;
  expect(body.type).toBe(sport.action.eventType);
  return body;
}

async function finaliseThroughUi(page: Page): Promise<{ result_version: number }> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/scoring/finalise") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Review final score" }).click();
  await page.getByRole("button", { name: "Confirm final result" }).click();
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status(), `/api/scoring/finalise\n${text}`).toBeGreaterThanOrEqual(200);
  expect(response.status(), `/api/scoring/finalise\n${text}`).toBeLessThan(300);
  return JSON.parse(text) as { result_version: number };
}

async function reopenThroughUi(page: Page, reason: string): Promise<{ aggregate_version: number }> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/reopen") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reopen for correction" }).click();
  const dialog = page.getByRole("dialog", { name: "Reopen for correction" });
  await dialog.getByLabel("Correction reason").fill(reason);
  await dialog.getByRole("button", { name: "Reopen match" }).click();
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status(), `organiser reopen\n${text}`).toBeGreaterThanOrEqual(200);
  expect(response.status(), `organiser reopen\n${text}`).toBeLessThan(300);
  await expect(dialog).toBeHidden();
  return JSON.parse(text) as { aggregate_version: number };
}

async function correctThroughUi(
  page: Page,
  sport: SportSeed,
  targetEventId: string,
): Promise<{ result_version: number; aggregate_version: number }> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/corrections") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reverse scoring event" }).click();
  const dialog = page.getByRole("dialog", { name: "Apply correction and publish result" });
  await dialog.getByLabel("Event to reverse").selectOption(targetEventId);
  const segmented = sport.sportId === "badminton" || sport.sportId === "table_tennis" || sport.sportId === "volleyball";
  if (segmented) {
    await dialog.getByLabel("Change this segment winner atomically").check();
    await expect(dialog.getByRole("heading", { name: "Correction command review" })).toBeVisible();
    await dialog.getByLabel("Opposing replacement points").fill("1");
  } else {
    await dialog.getByLabel("Add a replacement of this validated action").check();
    await dialog.getByLabel("Replacement side").selectOption("away");
  }
  const participant = dialog.getByLabel("Replacement participant name");
  if (await participant.count()) await participant.fill(`${sport.awayName} corrected scorer`);
  await dialog.getByLabel("Correction reason").fill("Official C2 score sheet correction");
  await dialog.getByRole("button", { name: "Publish correction" }).click();
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status(), `organiser correction\n${text}`).toBeGreaterThanOrEqual(200);
  expect(response.status(), `organiser correction\n${text}`).toBeLessThan(300);
  const request = response.request().postDataJSON() as { events?: Array<Record<string, unknown>> };
  const eventTypes = request.events?.map((event) => event.type);
  expect(eventTypes).toEqual([
    "reversal",
    sport.action.eventType,
    ...(segmented ? [sport.sportId === "volleyball" ? "set_completion" : "game_completion"] : []),
  ]);
  for (const event of request.events?.slice(1) ?? []) {
    expect(event).toMatchObject({ team_slot: "away", segment_number: 1 });
  }
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Correction finalised and the corrected result published.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Match state", { exact: true }).locator("..").locator("..")).toBeFocused();
  return JSON.parse(text) as { result_version: number; aggregate_version: number };
}

test("C2 real five-sport scoring, correction, audit, and downstream conflict", async ({ context, page }, testInfo) => {
  test.setTimeout(240_000);
  const seed = await state();
  const [, organiserCookie] = seed.organiserCookie.split("=", 2);
  if (!organiserCookie) throw new Error("Organiser cookie fixture is malformed");
  await context.addCookies([
    {
      name: "matchday_session",
      value: organiserCookie,
      url: seed.webOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await installConsoleGuard(page);
  const browserSports = [];
  let multiDivisionBrowserOracle:
    | {
        competition_id: string;
        primary_division_id: string;
        secondary_division_id: string;
        primary_result_versions: number[];
        secondary_result_versions: number[];
        public_packages_visible: boolean;
        cross_division_names_absent: boolean;
      }
    | undefined;
  let conflictReviewed = false;

  for (const sport of seed.sports) {
    const observedSteps: string[] = [];
    const observedResultVersions: number[] = [];
    await context.clearCookies({ name: "__Host-matchday-scoring-session" });
    await page.goto(`/score#access=${encodeURIComponent(sport.accessToken)}`);
    await dismissConsent(page);
    await expect(page).toHaveURL(`${seed.webOrigin}/score`);
    await expect(page.getByRole("heading", { name: `${sport.homeName} vs ${sport.awayName}` })).toBeVisible();
    await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
    await page.getByRole("button", { name: "Start scoring" }).click();
    await expect(page.getByRole("heading", { name: "Scoring controls" })).toBeVisible();
    observedSteps.push("match_started");
    const scorerScreenshotPath = testInfo.outputPath(`${sport.sportId}-live-scorer.png`);
    await page.screenshot({ path: scorerScreenshotPath, fullPage: true });
    await testInfo.attach(`${sport.sportId}-live-scorer`, {
      path: scorerScreenshotPath,
      contentType: "image/png",
    });
    const actionBody = await recordUiAction(page, sport);
    observedSteps.push("sport_action");

    const replay = await sameOriginJson<{ sequence: number; duplicate: boolean }>(page, "/api/scoring/events", {
      method: "POST",
      body: actionBody,
    });
    expect(replay.sequence).toBe(2);
    expect(replay.duplicate).toBe(true);
    observedSteps.push("idempotent_replay");
    await completeSport(page, sport, 2);
    observedSteps.push("sport_completion");
    const firstFinal = await finaliseThroughUi(page);
    expect(firstFinal.result_version).toBe(1);
    observedResultVersions.push(firstFinal.result_version);
    observedSteps.push("finalised");
    if (sport.secondaryDivision) {
      const browser = page.context().browser();
      if (!browser) throw new Error("C2 multi-division scorer requires a browser context");
      const secondaryContext = await browser.newContext({
        baseURL: seed.webOrigin,
        ignoreHTTPSErrors: true,
      });
      const secondaryPage = await secondaryContext.newPage();
      await installConsoleGuard(secondaryPage);
      const secondarySport: SportSeed = {
        ...sport,
        divisionId: sport.secondaryDivision.divisionId,
        matchId: sport.secondaryDivision.matchId,
        homeName: sport.secondaryDivision.homeName,
        awayName: sport.secondaryDivision.awayName,
        accessToken: sport.secondaryDivision.accessToken,
        secondaryDivision: undefined,
        action: {
          ...sport.action,
          accessibleName: sport.action.accessibleName.replace(sport.homeName, sport.secondaryDivision.homeName),
        },
      };
      await secondaryPage.goto(`/score#access=${encodeURIComponent(secondarySport.accessToken)}`);
      await dismissConsent(secondaryPage);
      await expect(secondaryPage).toHaveURL(`${seed.webOrigin}/score`);
      await secondaryPage.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
      await secondaryPage.getByRole("button", { name: "Start scoring" }).click();
      await recordUiAction(secondaryPage, secondarySport);
      await completeSport(secondaryPage, secondarySport, 2);
      const secondaryFinal = await finaliseThroughUi(secondaryPage);
      expect(secondaryFinal.result_version).toBe(2);
      await assertConsoleGuard(secondaryPage, testInfo);
      await secondaryContext.close();
    }

    const auditPath = `/api/gate-c/competitions/${sport.competitionId}/matches/${sport.matchId}/scoring-audit`;
    let audit = await sameOriginJson<AuditDocument>(page, auditPath);
    const target = audit.events.find((event) => event.event_type === sport.action.eventType);
    if (!target) throw new Error(`Authoritative ${sport.sportId} score event is missing`);
    await page.goto(`/organiser/competitions/${sport.competitionId}/results?match=${sport.matchId}`);
    await expect(page.getByRole("heading", { name: "Calculated tables" })).toBeVisible();
    await expect(page.getByRole("region", { name: "division standings table" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Advancement decisions" })).toBeVisible();
    await expect(page.getByText("Standings could not load", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Scoring event history" })).toBeVisible();
    await reopenThroughUi(page, "C2 independent reopen proof");
    observedSteps.push("organiser_reopen");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Scoring event history" })).toBeVisible();
    const correction = await correctThroughUi(page, sport, target.event_id);
    expect(correction.result_version).toBe(sport.secondaryDivision ? 4 : 3);
    observedResultVersions.push(correction.result_version);
    observedSteps.push("organiser_correction");
    audit = await sameOriginJson<AuditDocument>(page, auditPath);
    expect(audit.events.some((event) => event.event_type === "reversal")).toBe(true);
    await reopenThroughUi(page, "C2 independent refinalisation proof");
    observedSteps.push("organiser_reopen");
    await page.goto("/score");
    await expect(page.getByRole("button", { name: "Review final score" })).toBeVisible();
    const finalAfterReopen = await finaliseThroughUi(page);
    expect(finalAfterReopen.result_version).toBe(sport.secondaryDivision ? 6 : 5);
    observedResultVersions.push(finalAfterReopen.result_version);
    observedSteps.push("refinalised");
    audit = await sameOriginJson<AuditDocument>(page, auditPath);
    expect(audit.result?.result_version).toBe(sport.secondaryDivision ? 6 : 5);

    await page.goto(`/organiser/competitions/${sport.competitionId}/results?match=${sport.matchId}`);
    await expect(page.getByRole("heading", { name: "Calculated tables" })).toBeVisible();
    await expect(page.getByRole("region", { name: "division standings table" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Advancement decisions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Scoring event history" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Immutable match audit" })).toBeVisible();
    await expect(
      page.getByText(`${sport.homeName} 0–${sport.sportId === "basketball" ? 3 : 1} ${sport.awayName}`, {
        exact: true,
      }),
    ).toBeVisible();
    observedSteps.push("audit_review");
    if (sport.secondaryDivision) {
      await page.goto(`/competitions/${sport.slug}`);
      const primarySections = page.locator(`[data-division-id="${sport.divisionId}"]`);
      const secondarySections = page.locator(`[data-division-id="${sport.secondaryDivision.divisionId}"]`);
      await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Women", exact: true })).toBeVisible();
      await expect(primarySections.filter({ hasText: sport.homeName }).first()).toBeVisible();
      await expect(secondarySections.filter({ hasText: sport.secondaryDivision.homeName }).first()).toBeVisible();
      await expect(primarySections.filter({ hasText: sport.secondaryDivision.homeName })).toHaveCount(0);
      await expect(secondarySections.filter({ hasText: sport.homeName })).toHaveCount(0);
      multiDivisionBrowserOracle = {
        competition_id: sport.competitionId,
        primary_division_id: sport.divisionId,
        secondary_division_id: sport.secondaryDivision.divisionId,
        primary_result_versions: observedResultVersions,
        secondary_result_versions: [2],
        public_packages_visible: true,
        cross_division_names_absent: true,
      };
    }
    if (sport.downstreamMatchId) {
      const conflictSection = page.getByRole("heading", { name: "Critical downstream conflicts" }).locator("..");
      await expect(conflictSection).toContainText(sport.downstreamMatchId);
      await conflictSection.getByRole("button", { name: "Acknowledge conflict" }).click();
      const dialog = page.getByRole("dialog", { name: "Acknowledge conflict" });
      await dialog.getByLabel("Acknowledgement reason").fill("Reviewed against the corrected official result");
      await dialog.getByRole("button", { name: "Record acknowledgement" }).click();
      await expect(dialog).toBeHidden();
      conflictReviewed = true;
    }

    const screenshotPath = testInfo.outputPath(`${sport.sportId}-organiser-audit.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach(`${sport.sportId}-organiser-audit`, { path: screenshotPath, contentType: "image/png" });
    browserSports.push({
      sport_id: sport.sportId,
      action_event_type: sport.action.eventType,
      steps: observedSteps,
      observed_result_versions: observedResultVersions,
      observed_audit_event_count: audit.audit.length,
      displayed_result: `${sport.homeName} 0–${sport.sportId === "basketball" ? 3 : 1} ${sport.awayName}`,
    });
  }

  expect(conflictReviewed).toBe(true);
  const receiptPath = process.env.GATE_C_C2_BROWSER_RECEIPT;
  if (!receiptPath) throw new Error("GATE_C_C2_BROWSER_RECEIPT is required");
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        artifact_kind: "gate-c-c2-browser-oracle",
        project_name: testInfo.project.name,
        sports: browserSports,
        conflict_review: { sport_id: "canoe_polo", status: "acknowledged" },
        multi_division: multiDivisionBrowserOracle,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  await assertConsoleGuard(page, testInfo);
});
