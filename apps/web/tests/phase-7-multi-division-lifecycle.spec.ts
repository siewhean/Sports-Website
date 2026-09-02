import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type Phase7E2EState = {
  apiOrigin: string;
  competitionId: string;
  competitionSlug: string;
  publicCompetitionPath: string;
  scorekeeperPath: string;
  scoredMatchId: string;
  passToken: string;
  organiserCookie: string;
  divisionNames: string[];
  divisionFixtures: Array<{
    divisionId: string;
    divisionName: string;
    matchId: string;
    matchCode: string;
    homeName: string;
    awayName: string;
  }>;
  scheduleRevisionId: string;
  scheduleVersion: number;
  xssCompetitionPath: string;
  xssMaliciousName: string;
};

type ScoringSessionOracle = {
  through_sequence: number;
  match: {
    id: string;
    home: { name: string | null };
    away: { name: string | null };
  };
  score: {
    total_points: { home: number; away: number };
    actions: Array<{ event_type: string; side: "home" | "away" | null; reversed: boolean }>;
  };
};

type AuditDocument = {
  result: { result_version: number } | null;
  events: Array<{ event_id: string; event_type: string }>;
};

type PublicTruth = {
  publication: { schedule_version: number; result_version: number };
  freshness: { schedule_version: number; result_version: number };
  divisions: Array<{
    division: { id: string };
    schedule: Array<{ id: string; code?: string }>;
  }>;
};

async function readE2EState(): Promise<Phase7E2EState> {
  const statePath = process.env.PHASE7_E2E_STATE_FILE;
  if (!statePath) {
    throw new Error("PHASE7_E2E_STATE_FILE is required for Gate D browser qualification");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Phase 7 E2E state from ${statePath}`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Phase 7 E2E state must be a JSON object");
  }

  const state = parsed as Partial<Phase7E2EState>;
  for (const key of [
    "competitionId",
    "apiOrigin",
    "competitionSlug",
    "publicCompetitionPath",
    "scorekeeperPath",
    "scoredMatchId",
    "passToken",
    "organiserCookie",
    "scheduleRevisionId",
  ] as const) {
    if (typeof state[key] !== "string" || state[key]!.length === 0) {
      throw new Error(`Phase 7 E2E state is missing required field ${key}`);
    }
  }
  if (
    !Array.isArray(state.divisionNames) ||
    state.divisionNames.length !== 2 ||
    state.divisionNames.some((name) => !name)
  ) {
    throw new Error("Phase 7 E2E state must contain exactly two division names");
  }
  if (
    !Array.isArray(state.divisionFixtures) ||
    state.divisionFixtures.length !== 2 ||
    state.divisionFixtures.some(
      (fixture) =>
        !fixture ||
        typeof fixture.divisionId !== "string" ||
        typeof fixture.matchId !== "string" ||
        typeof fixture.matchCode !== "string" ||
        typeof fixture.homeName !== "string" ||
        typeof fixture.awayName !== "string",
    )
  ) {
    throw new Error("Phase 7 E2E state must contain two canonical division fixtures");
  }

  return state as Phase7E2EState;
}

async function finaliseThroughUi(page: Page): Promise<{ result_version: number }> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/scoring/finalise") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Review final score" }).click();
  await page.getByRole("button", { name: "Confirm final result" }).click();
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status(), `finalise\n${text}`).toBeGreaterThanOrEqual(200);
  expect(response.status(), `finalise\n${text}`).toBeLessThan(300);
  return JSON.parse(text) as { result_version: number };
}

async function reopenThroughUi(page: Page, reason: string): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/reopen") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reopen for correction" }).click();
  const dialog = page.getByRole("dialog", { name: "Reopen for correction" });
  await dialog.getByLabel("Correction reason").fill(reason);
  await dialog.getByRole("button", { name: "Reopen match" }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBeGreaterThanOrEqual(200);
  expect(response.status()).toBeLessThan(300);
  await expect(dialog).toBeHidden();
}

async function correctThroughUi(page: Page, targetEventId: string): Promise<{ result_version: number }> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/corrections") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reverse scoring event" }).click();
  const dialog = page.getByRole("dialog", { name: "Apply correction and publish result" });
  await dialog.getByLabel("Event to reverse").selectOption(targetEventId);
  await dialog.getByLabel("Change this segment winner atomically").check();
  await dialog.getByLabel("Opposing replacement points").fill("1");
  await dialog.getByLabel("Correction reason").fill("Gate D organiser correction proof");
  await dialog.getByRole("button", { name: "Publish correction" }).click();
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status(), `correction\n${text}`).toBeGreaterThanOrEqual(200);
  expect(response.status(), `correction\n${text}`).toBeLessThan(300);
  return JSON.parse(text) as { result_version: number };
}

async function sameOriginJson<T>(page: Page, requestPath: string): Promise<T> {
  const result = await page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    return { status: response.status, text: await response.text() };
  }, requestPath);
  expect(result.status, `${requestPath}\n${result.text}`).toBeGreaterThanOrEqual(200);
  expect(result.status, `${requestPath}\n${result.text}`).toBeLessThan(300);
  return JSON.parse(result.text) as T;
}

async function publicTruth(request: APIRequestContext, state: Phase7E2EState): Promise<PublicTruth> {
  const response = await request.get(
    `${state.apiOrigin}/api/v1/public/competitions/${encodeURIComponent(state.competitionSlug)}/current`,
    { failOnStatusCode: false },
  );
  const text = await response.text();
  expect(response.status(), `public truth\n${text}`).toBe(200);
  return JSON.parse(text) as PublicTruth;
}

async function scoringSession(page: Page): Promise<ScoringSessionOracle> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/scoring/session", { credentials: "same-origin" });
    return { status: response.status, text: await response.text() };
  });
  expect(result.status, `/api/scoring/session\n${result.text}`).toBe(200);
  const value = JSON.parse(result.text) as ScoringSessionOracle;
  expect(Number.isSafeInteger(value.through_sequence)).toBe(true);
  return value;
}

test.describe("QA-005 / QA-006 / QA-007 Canonical Multi-Division Browser Lifecycle & Offline Scoring Queue", () => {
  test("proves a two-division public schedule, offline replay exactly once, and real finalisation", async ({
    page,
    context,
  }) => {
    test.setTimeout(150_000);
    await installConsoleGuard(page);
    const state = await readE2EState();

    // QA-005: the real public projection must expose both seeded divisions.
    await page.goto(state.publicCompetitionPath);
    await dismissConsent(page);
    await expect(page.locator("main")).toBeVisible();
    for (const divisionName of state.divisionNames) {
      await expect(page.getByText(divisionName, { exact: true }).first()).toBeVisible();
    }
    for (const fixture of state.divisionFixtures) {
      await expect(page.getByText(fixture.homeName, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(fixture.awayName, { exact: true }).first()).toBeVisible();
    }
    const initialPublicTruth = await publicTruth(context.request, state);
    expect(initialPublicTruth.publication.schedule_version).toBe(state.scheduleVersion);
    expect(initialPublicTruth.freshness.schedule_version).toBe(state.scheduleVersion);
    for (const fixture of state.divisionFixtures) {
      const division = initialPublicTruth.divisions.find((candidate) => candidate.division.id === fixture.divisionId);
      expect(division, `missing public division ${fixture.divisionId}`).toBeDefined();
      expect(division!.schedule.some((match) => match.id === fixture.matchId && match.code === fixture.matchCode)).toBe(
        true,
      );
    }

    // The production scorekeeper consumes the raw access credential from the URL fragment.
    await page.goto(`/score#access=${encodeURIComponent(state.passToken)}`);
    await dismissConsent(page);
    await expect(page.locator('#score-main[data-scoring-phase="confirm"]')).toBeVisible();
    await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
    await page.getByRole("button", { name: "Start scoring" }).click();
    await expect(page.locator('#score-main[data-scoring-phase="live"]')).toBeVisible();

    const webOrigin = new URL(page.url()).origin;
    const started = await scoringSession(page);
    expect(started.match.id).toBe(state.scoredMatchId);
    const homeName = started.match.home.name;
    if (!homeName) throw new Error("Gate D scoreable match must have a materialised home entry");

    await page.getByRole("button", { name: "Prepare offline scoring" }).click();
    await expect(page.locator('#score-main[data-offline-state="offline-ready"]')).toBeVisible({ timeout: 15_000 });

    const getIndexedDbPendingQueueCount = async (): Promise<number> => {
      return await page.evaluate(async () => {
        try {
          const databases = await indexedDB.databases();
          if (!databases.some((database) => database.name === "matchday-offline-scoring")) return -1;
          return await new Promise<number>((resolve) => {
            const req = indexedDB.open("matchday-offline-scoring", 1);
            req.onerror = () => resolve(-1);
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains("commands")) {
                db.close();
                resolve(-1);
                return;
              }
              if (!db.objectStoreNames.contains("acknowledgements")) {
                db.close();
                resolve(-1);
                return;
              }
              // Offline commands are retained as an immutable, exportable audit
              // trail after acknowledgement. Pending work is therefore the
              // difference between queued commands and durable receipts.
              const tx = db.transaction(["commands", "acknowledgements"], "readonly");
              const commands = tx.objectStore("commands").getAll();
              const acknowledgements = tx.objectStore("acknowledgements").getAll();
              tx.oncomplete = () => {
                db.close();
                resolve(Math.max(0, commands.result.length - acknowledgements.result.length));
              };
              tx.onerror = () => {
                db.close();
                resolve(-1);
              };
            };
          });
        } catch {
          return -1;
        }
      });
    };

    await expect.poll(getIndexedDbPendingQueueCount, { timeout: 5_000, intervals: [100, 250, 500] }).toBe(0);

    const baselineSequence = started.through_sequence;
    const baselinePointActions = started.score.actions.filter((action) => action.event_type === "point").length;
    const baselineHomePoints = started.score.total_points.home;
    const baselineAwayPoints = started.score.total_points.away;

    await context.setOffline(true);
    await page.getByRole("button", { name: `Point ${homeName}` }).click();
    const pointDialog = page.getByRole("dialog", { name: "Record event: Point" });
    await expect(pointDialog).toBeVisible();
    await pointDialog.getByRole("button", { name: "Record event" }).click();
    await expect(pointDialog).toBeHidden();

    await expect
      .poll(getIndexedDbPendingQueueCount, { timeout: 10_000, intervals: [100, 250, 500] })
      .toBeGreaterThan(0);

    await context.setOffline(false);
    // Playwright restores transport but does not reliably emit the browser's
    // connectivity event. The scorer deliberately starts its replay loop from
    // that event, so model the real reconnect boundary rather than polling a
    // private component method.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(getIndexedDbPendingQueueCount, { timeout: 20_000, intervals: [250, 500, 1_000] }).toBe(0);
    await expect
      .poll(async () => (await scoringSession(page)).through_sequence, {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(baselineSequence + 1);

    const replayed = await scoringSession(page);
    expect(replayed.score.total_points.home).toBe(baselineHomePoints + 1);
    expect(replayed.score.total_points.away).toBe(baselineAwayPoints);
    expect(replayed.score.actions.filter((action) => action.event_type === "point")).toHaveLength(
      baselinePointActions + 1,
    );

    // QA-006: complete the real Volleyball segment and finalise through the scorer UI.
    const completionResponsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/scoring/events") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: `Set completion ${homeName}` }).click();
    const completionDialog = page.getByRole("dialog", { name: "Record event: Set completion" });
    await completionDialog.getByRole("button", { name: "Record event" }).click();
    const completionResponse = await completionResponsePromise;
    const completionText = await completionResponse.text();
    expect(completionResponse.status(), `set completion\n${completionText}`).toBe(200);
    await expect(completionDialog).toBeHidden();

    const finalised = await finaliseThroughUi(page);
    expect(finalised.result_version).toBeGreaterThanOrEqual(1);
    const finalisedPublicTruth = await publicTruth(context.request, state);
    expect(finalisedPublicTruth.publication.result_version).toBe(finalised.result_version);

    const [, organiserCookie] = state.organiserCookie.split("=", 2);
    if (!organiserCookie) throw new Error("Phase 7 organiser cookie is malformed");
    await context.addCookies([
      { name: "matchday_session", value: organiserCookie, url: webOrigin, httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto(`/organiser/competitions/${state.competitionId}/results?match=${state.scoredMatchId}`);
    await expect(page.getByRole("heading", { name: "Calculated tables" })).toBeVisible();
    await expect(page.getByRole("region", { name: "division standings table" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Scoring event history" })).toBeVisible();
    const audit = await sameOriginJson<AuditDocument>(
      page,
      `/api/gate-c/competitions/${state.competitionId}/matches/${state.scoredMatchId}/scoring-audit`,
    );
    const pointEvent = audit.events.find((event) => event.event_type === "point");
    if (!pointEvent) throw new Error("Gate D correction requires the replayed point event");
    await reopenThroughUi(page, "Gate D result correction proof");
    await page.reload();
    const corrected = await correctThroughUi(page, pointEvent.event_id);
    expect(corrected.result_version).toBeGreaterThan(finalised.result_version);
    await expect(page.getByRole("region", { name: "division standings table" })).toBeVisible();
    await expect(page.getByText(`${homeName} 0–1`, { exact: false }).first()).toBeVisible();

    await page.goto(state.publicCompetitionPath);
    await dismissConsent(page);
    await expect(page.locator("main")).toBeVisible();
    for (const divisionName of state.divisionNames) {
      await expect(page.getByText(divisionName, { exact: true }).first()).toBeVisible();
    }
    const publicResults = page.getByRole("region", {
      name: `${state.divisionFixtures[0]!.divisionName} Results`,
      exact: true,
    });
    await expect(publicResults).toContainText(homeName);
    await expect(publicResults).toContainText(started.match.away.name!);
    await expect(publicResults.getByText("0", { exact: true })).toBeVisible();
    await expect(publicResults.getByText("1", { exact: true })).toBeVisible();
    const correctedPublicTruth = await publicTruth(context.request, state);
    expect(correctedPublicTruth.publication.schedule_version).toBe(state.scheduleVersion);
    expect(correctedPublicTruth.publication.result_version).toBe(corrected.result_version);
    expect(correctedPublicTruth.publication.result_version).toBeGreaterThan(
      finalisedPublicTruth.publication.result_version,
    );
  });
});
