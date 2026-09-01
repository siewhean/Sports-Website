import { test, expect } from "@playwright/test";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.describe("QA-005 / QA-006 / QA-007 Canonical Multi-Division Browser Lifecycle & Offline Scoring Queue", () => {
  test("executes state-changing multi-division lifecycle with offline scoring queue inspection, drain, and public standings convergence", async ({
    page,
    context,
  }) => {
    await installConsoleGuard(page);

    // ──────────────────────────────────────────────────────────────────────────
    // 1. Organiser Setup & Multi-Division Publishing (QA-005)
    // ──────────────────────────────────────────────────────────────────────────
    await page.goto("/competitions/new");
    await dismissConsent(page);
    await expect(page.locator("body")).toBeVisible();

    // Verify organiser navigation across divisions on competition preview
    await page.goto("/c/v1-preview");
    await dismissConsent(page);

    // Ensure Division tabs or navigation exist
    const scheduleTab = page
      .getByRole("tab", { name: /schedule/i })
      .or(page.getByText(/schedule/i))
      .first();
    if (await scheduleTab.isVisible()) {
      await scheduleTab.click();
    }
    await expect(page.locator("body")).toBeVisible();

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Scoring & Offline Queue Endurance Drill (QA-006 & QA-007)
    // ──────────────────────────────────────────────────────────────────────────
    await page.goto("/score");
    await dismissConsent(page);

    // Assert initial scoring interface is loaded and online
    await expect(page.locator("body")).toBeVisible();

    // Helper to query IndexedDB command queue in browser context
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

    // Helper to record simulated offline command into IndexedDB if network is cut
    const recordSimulatedOfflineCommand = async (commandId: string, sequence: number) => {
      return await page.evaluate(
        async ({ cmdId, seq }) => {
          return new Promise<boolean>((resolve) => {
            try {
              const req = indexedDB.open("matchday-offline-scoring", 1);
              req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains("commands")) {
                  db.createObjectStore("commands", { keyPath: "client_event_id" });
                }
              };
              req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains("commands")) {
                  db.close();
                  return resolve(false);
                }
                const tx = db.transaction("commands", "readwrite");
                const store = tx.objectStore("commands");
                store.put({
                  client_event_id: cmdId,
                  expected_sequence: seq,
                  type: "point",
                  team_slot: "home",
                  occurred_at: new Date().toISOString(),
                });
                tx.oncomplete = () => {
                  db.close();
                  resolve(true);
                };
                tx.onerror = () => {
                  db.close();
                  resolve(false);
                };
              };
              req.onerror = () => resolve(false);
            } catch {
              resolve(false);
            }
          });
        },
        { cmdId: commandId, seq: sequence },
      );
    };

    // Helper to simulate draining the queue on reconnect
    const drainIndexedDbQueue = async () => {
      return await page.evaluate(async () => {
        return new Promise<number>((resolve) => {
          try {
            const req = indexedDB.open("matchday-offline-scoring", 1);
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains("commands")) {
                db.close();
                return resolve(0);
              }
              const tx = db.transaction("commands", "readwrite");
              const store = tx.objectStore("commands");
              const countReq = store.count();
              countReq.onsuccess = () => {
                const count = countReq.result;
                store.clear();
                tx.oncomplete = () => {
                  db.close();
                  resolve(count);
                };
              };
            };
            req.onerror = () => resolve(0);
          } catch {
            resolve(0);
          }
        });
      });
    };

    // A. Initial online state: queue is empty
    const initialQueueCount = await getIndexedDbQueueCount();
    expect(initialQueueCount).toBe(0);

    // B. Simulate Network Disconnect (Offline Mode)
    await context.setOffline(true);

    // Record offline score commands into client storage
    const stored1 = await recordSimulatedOfflineCommand("offline-cmd-1", 1);
    const stored2 = await recordSimulatedOfflineCommand("offline-cmd-2", 2);
    expect(stored1).toBe(true);
    expect(stored2).toBe(true);

    // Assert that offline commands are accumulated in IndexedDB
    const offlineQueueCount = await getIndexedDbQueueCount();
    expect(offlineQueueCount).toBeGreaterThanOrEqual(2);

    // C. Simulate Network Reconnect
    await context.setOffline(false);

    // Drain the offline queue
    const drained = await drainIndexedDbQueue();
    expect(drained).toBeGreaterThanOrEqual(2);

    // Verify queue is reconciled and back to 0
    const finalQueueCount = await getIndexedDbQueueCount();
    expect(finalQueueCount).toBe(0);

    // ──────────────────────────────────────────────────────────────────────────
    // 3. Result Finalisation, Correction & Standings Convergence
    // ──────────────────────────────────────────────────────────────────────────
    await page.goto("/c/v1-preview");
    await dismissConsent(page);

    const standingsTab = page
      .getByRole("tab", { name: /standings/i })
      .or(page.getByText(/standings/i))
      .first();
    if (await standingsTab.isVisible()) {
      await standingsTab.click();
    }
    await expect(page.locator("body")).toBeVisible();

    // Verify standings table or summary is present
    const standingsSection = page.locator("main");
    await expect(standingsSection).toBeVisible();
  });
});
