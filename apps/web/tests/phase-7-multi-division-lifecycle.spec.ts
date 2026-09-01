import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type Phase7E2EState = {
  competitionId: string;
  competitionSlug: string;
  publicCompetitionPath: string;
  scorekeeperPath: string;
  scoredMatchId: string;
  passToken: string;
  divisionNames: string[];
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
    "competitionSlug",
    "publicCompetitionPath",
    "scorekeeperPath",
    "scoredMatchId",
    "passToken",
  ] as const) {
    if (typeof state[key] !== "string" || state[key]!.length === 0) {
      throw new Error(`Phase 7 E2E state is missing required field ${key}`);
    }
  }
  if (!Array.isArray(state.divisionNames) || state.divisionNames.length !== 2 || state.divisionNames.some((name) => !name)) {
    throw new Error("Phase 7 E2E state must contain exactly two division names");
  }

  return state as Phase7E2EState;
}

async function scoringSession(request: APIRequestContext, origin: string): Promise<ScoringSessionOracle> {
  const response = await request.get(`${origin}/api/scoring/session`, { failOnStatusCode: false });
  const text = await response.text();
  expect(response.status(), `/api/scoring/session\n${text}`).toBe(200);
  const value = JSON.parse(text) as ScoringSessionOracle;
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

    // The production scorekeeper consumes the raw access credential from the URL fragment.
    await page.goto(`/score#access=${encodeURIComponent(state.passToken)}`);
    await dismissConsent(page);
    await expect(page.locator('#score-main[data-scoring-phase="confirm"]')).toBeVisible();
    await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
    await page.getByRole("button", { name: "Start scoring" }).click();
    await expect(page.locator('#score-main[data-scoring-phase="live"]')).toBeVisible();

    const webOrigin = new URL(page.url()).origin;
    const started = await scoringSession(context.request, webOrigin);
    expect(started.match.id).toBe(state.scoredMatchId);
    const homeName = started.match.home.name;
    if (!homeName) throw new Error("Gate D scoreable match must have a materialised home entry");

    await page.getByRole("button", { name: "Prepare offline scoring" }).click();
    await expect(page.locator('#score-main[data-offline-state="offline-ready"]')).toBeVisible({ timeout: 15_000 });

    const getIndexedDbQueueCount = async (): Promise<number> => {
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
              const tx = db.transaction("commands", "readonly");
              const countReq = tx.objectStore("commands").count();
              countReq.onsuccess = () => {
                const count = countReq.result;
                db.close();
                resolve(count);
              };
              countReq.onerror = () => {
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

    await expect.poll(getIndexedDbQueueCount, { timeout: 5_000, intervals: [100, 250, 500] }).toBe(0);

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

    await expect.poll(getIndexedDbQueueCount, { timeout: 10_000, intervals: [100, 250, 500] }).toBeGreaterThan(0);

    const whileOffline = await scoringSession(context.request, webOrigin);
    expect(whileOffline.through_sequence).toBe(baselineSequence);
    expect(whileOffline.score.total_points.home).toBe(baselineHomePoints);
    expect(whileOffline.score.total_points.away).toBe(baselineAwayPoints);
    expect(whileOffline.score.actions.filter((action) => action.event_type === "point")).toHaveLength(
      baselinePointActions,
    );

    await context.setOffline(false);
    await expect.poll(getIndexedDbQueueCount, { timeout: 20_000, intervals: [250, 500, 1_000] }).toBe(0);
    await expect
      .poll(async () => (await scoringSession(context.request, webOrigin)).through_sequence, {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(baselineSequence + 1);

    const replayed = await scoringSession(context.request, webOrigin);
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

    const finaliseResponsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/scoring/finalise") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Review final score" }).click();
    await page.getByRole("button", { name: "Confirm final result" }).click();
    const finaliseResponse = await finaliseResponsePromise;
    const finaliseText = await finaliseResponse.text();
    expect(finaliseResponse.status(), `finalise\n${finaliseText}`).toBeGreaterThanOrEqual(200);
    expect(finaliseResponse.status(), `finalise\n${finaliseText}`).toBeLessThan(300);
    const finalised = JSON.parse(finaliseText) as { result_version?: number };
    expect(finalised.result_version).toBeGreaterThanOrEqual(1);

    await page.goto(state.publicCompetitionPath);
    await dismissConsent(page);
    await expect(page.locator("main")).toBeVisible();
    for (const divisionName of state.divisionNames) {
      await expect(page.getByText(divisionName, { exact: true }).first()).toBeVisible();
    }
  });
});
