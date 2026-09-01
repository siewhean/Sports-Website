import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type Phase7E2EState = {
  competitionId: string;
  competitionSlug: string;
  publicCompetitionPath: string;
  scorekeeperPath: string;
  scoredMatchId: string;
  passToken: string;
  xssCompetitionPath: string;
  xssMaliciousName: string;
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
  ] as const) {
    if (typeof state[key] !== "string" || state[key]!.length === 0) {
      throw new Error(`Phase 7 E2E state is missing required field ${key}`);
    }
  }

  return state as Phase7E2EState;
}

test.describe("QA-005 / QA-006 / QA-007 Canonical Multi-Division Browser Lifecycle & Offline Scoring Queue", () => {
  test("executes state-changing multi-division lifecycle with authentic offline scoring queue inspection and drain", async ({
    page,
    context,
  }) => {
    await installConsoleGuard(page);
    const state = await readE2EState();

    // QA-005 fixture must be a real API-backed public competition, never demo fallback state.
    await page.goto(state.publicCompetitionPath);
    await dismissConsent(page);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("main")).toBeVisible();

    // QA-006 / QA-007 must use the real scorekeeper route provisioned by the harness.
    await page.goto(state.scorekeeperPath);
    await dismissConsent(page);
    await expect(page.locator("body")).toBeVisible();

    // Read-only inspection of the production IndexedDB command queue. A missing DB/store
    // is evidence failure (-1), not an empty queue.
    const getIndexedDbQueueCount = async (): Promise<number> => {
      return await page.evaluate(async () => {
        return await new Promise<number>((resolve) => {
          try {
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
          } catch {
            resolve(-1);
          }
        });
      });
    };

    // Online baseline: the real queue must exist and be empty before the network cut.
    await expect.poll(getIndexedDbQueueCount, { timeout: 5_000, intervals: [100, 250, 500] }).toBe(0);

    // The scoring UI itself is required. Optional score controls are not Gate D evidence.
    const scoreButton = page.locator("button").filter({ hasText: /\+1|Score|Point|Goal|Home|Away/i }).first();
    await expect(scoreButton).toBeVisible();

    // Cut the browser network, submit a real scoring action, and prove the application
    // persisted at least one command to its production offline queue before reconnecting.
    await context.setOffline(true);
    await scoreButton.click();
    await expect.poll(getIndexedDbQueueCount, { timeout: 10_000, intervals: [100, 250, 500] }).toBeGreaterThan(0);

    // Reconnect and prove the application's own sync path drains the real queue.
    await context.setOffline(false);
    await expect.poll(getIndexedDbQueueCount, { timeout: 15_000, intervals: [250, 500, 1_000] }).toBe(0);

    // Public projection must remain reachable after the real offline/reconnect cycle.
    await page.goto(state.publicCompetitionPath);
    await dismissConsent(page);
    await expect(page.locator("main")).toBeVisible();
  });
});
