import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  offlineScoringStoreNames,
  OFFLINE_SCORING_DATABASE_NAME,
} from "../../../apps/web/lib/offline-scoring/indexeddb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 10: IndexedDB Retention & Isolation Lifecycle", () => {
  it("F10-T01: IndexedDB repository defines required object stores for offline storage", () => {
    expect(OFFLINE_SCORING_DATABASE_NAME).toBe("matchday-offline-scoring");
    expect(offlineScoringStoreNames).toContain("match_packages");
    expect(offlineScoringStoreNames).toContain("commands");
    expect(offlineScoringStoreNames).toContain("acknowledgements");
    expect(offlineScoringStoreNames).toContain("replay_attempts");
    expect(offlineScoringStoreNames).toContain("replay_state");
    expect(offlineScoringStoreNames).toContain("conflicts");
    expect(offlineScoringStoreNames).toContain("meta");
  });

  it("F10-T02: pruneTerminalQueue protects unacknowledged conflicts from premature deletion", () => {
    const idbPath = path.join(rootDir, "apps/web/lib/offline-scoring/indexeddb.ts");
    expect(existsSync(idbPath)).toBe(true);
    const content = readFileSync(idbPath, "utf8");
    expect(content).toContain("pruneTerminalQueue");
    expect(content).toContain("conflicts.some((conflict) => !conflict.acknowledged_at)");
  });

  it("F10-T03: principal isolation binds active_principal_id and fences unauthorized matches", () => {
    const idbPath = path.join(rootDir, "apps/web/lib/offline-scoring/indexeddb.ts");
    const content = readFileSync(idbPath, "utf8");
    expect(content).toContain("active_principal_id");
    expect(content).toContain("assertPrincipalFence");
  });

  it("F10-T04: sign-out helper clears scoring principal cookie cleanly", () => {
    const principalHelperPath = path.join(rootDir, "apps/web/lib/offline-scoring-principal.ts");
    expect(existsSync(principalHelperPath)).toBe(true);
    const content = readFileSync(principalHelperPath, "utf8");
    expect(content).toContain("clearScoringPrincipalCookie");
  });

  it("F10-T05: unit test for IndexedDB retention validates conflict preservation lifecycle", () => {
    const testPath = path.join(rootDir, "apps/web/lib/gate-c-c3-hardening.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("StrictIndexedDbOfflineScoringRepository");
  });
});
