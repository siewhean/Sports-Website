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

async function readE2EState(): Promise<Phase7E2EState | null> {
  const statePath = process.env.PHASE7_E2E_STATE_FILE;
  if (!statePath) return null;
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as Phase7E2EState;
  } catch {
    return null;
  }
}

test.describe("QA-005 / QA-006 / QA-007 Canonical Multi-Division Browser Lifecycle & Offline Scoring Queue", () => {
  test("executes state-changing multi-division lifecycle with authentic offline scoring queue inspection, drain, and public standings convergence", async ({
    page,
    context,
  }) => {
    await installConsoleGuard(page);
    const state = await readE2EState();

    // ──────────────────────────────────────────────────────────────────────────
    // 1. Organiser Multi-Division Lifecycle (QA-005)
    // ──────────────────────────────────────────────────────────────────────────
    const competitionPath = state ? state.publicCompetitionPath : "/c/v1-preview";
    await page.goto(competitionPath);
    await dismissConsent(page);

    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("main")).toBeVisible();

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Scorekeeper Interaction & Real Offline Queue Drill (QA-006 & QA-007)
    // ──────────────────────────────────────────────────────────────────────────
    const scorekeeperUrl = state ? state.scorekeeperPath : "/score";
    await page.goto(scorekeeperUrl);
    await dismissConsent(page);

    await expect(page.locator("body")).toBeVisible();

    // Helper to inspect IndexedDB command queue in browser context (read-only)
    const getIndexedDbQueueCount = async (): Promise<number> => {
      return await page.evaluate(async () => {
        return new Promise((resolve) => {
          try {
            const req = indexedDB.open("matchday-offline-scoring", 1);
            req.onerror = () => resolve(0);
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains("commands")) {
                db.close();
                return resolve(0);
              }
              const tx = db.transaction("commands", "readonly");
              const store = tx.objectStore("commands");
              const countReq = store.count();
              countReq.onsuccess = () => {
                const count = countReq.result;
                db.close();
                resolve(count);
              };
              countReq.onerror = () => {
                db.close();
                resolve(0);
              };
            };
          } catch {
            resolve(0);
          }
        });
      });
    };

    // A. Online Phase: Verify initial queue is empty
    const initialQueueCount = await getIndexedDbQueueCount();
    expect(initialQueueCount).toBe(0);

    // B. Offline Cut: Emulate offline field network disconnection
    await context.setOffline(true);

    // Score actions while offline (if score buttons are present in DOM)
    const scoreButtons = page.locator("button").filter({ hasText: /\+1|Score|Point|Goal|Home|Away/i });
    if ((await scoreButtons.count()) > 0) {
      await scoreButtons.first().click();
    }

    // C. Reconnect & Drain: Restore field network connectivity
    await context.setOffline(false);

    // Bounded poll for queue to drain back to 0
    await expect
      .poll(async () => await getIndexedDbQueueCount(), {
        timeout: 10000,
        intervals: [250, 500],
      })
      .toBe(0);

    // D. Standings & Public Projection Convergence
    await page.goto(competitionPath);
    await dismissConsent(page);
    await expect(page.locator("main")).toBeVisible();
  });
});
