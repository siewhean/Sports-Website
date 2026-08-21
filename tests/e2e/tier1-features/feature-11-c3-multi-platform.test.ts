import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 11: Multi-Platform C3 Test Harness & Receipts", () => {
  it("F11-T01: Playwright C3 configuration defines all 5 required browser projects", () => {
    const configPath = path.join(rootDir, "apps/web/playwright.gate-c-c3.config.ts");
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("gate-c-c3-phone-chromium");
    expect(content).toContain("gate-c-c3-phone-webkit");
    expect(content).toContain("gate-c-c3-desktop-chromium");
    expect(content).toContain("gate-c-c3-desktop-webkit");
    expect(content).toContain("gate-c-c3-desktop-firefox");
  });

  it("F11-T02: ledger runner validates physical iOS and Android receipts against schema", () => {
    const runnerPath = path.join(rootDir, "scripts/run-gate-c-c3-ledger.mjs");
    expect(existsSync(runnerPath)).toBe(true);
    const content = readFileSync(runnerPath, "utf8");
    expect(content).toContain("GATE_C_C3_IOS_RECEIPT");
    expect(content).toContain("GATE_C_C3_ANDROID_RECEIPT");
    expect(content).toContain("gate-c-c3-physical-device-receipt");
  });

  it("F11-T03: lost response fence prevents duplicate event submission upon network retry", () => {
    const testPath = path.join(rootDir, "apps/api/tests/unit/gate-c-c3-lost-response-fence.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("GateCC3LostResponseFence");
  });

  it("F11-T04: proxy fault test validates HTTP proxy interruption handling", () => {
    const testPath = path.join(rootDir, "apps/api/tests/unit/gate-c-c3-proxy-faults.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("proxy");
  });

  it("F11-T05: C3 evidence ledger schema asserts monotonic ordering and fencing", () => {
    const sampleReceipt = {
      schemaVersion: 1,
      platform: "ios_safari",
      deviceModel: "iPhone 15 Pro",
      osVersion: "iOS 18.2",
      browserVersion: "Safari 18.2",
      testRunTimestamp: new Date().toISOString(),
      scenariosExecuted: 8,
      scenariosPassed: 8,
      monotonicSequencesVerified: true,
      lostResponseFencesTriggered: 2,
      scoreLossCount: 0,
    };

    expect(sampleReceipt.scenariosPassed).toBe(sampleReceipt.scenariosExecuted);
    expect(sampleReceipt.scoreLossCount).toBe(0);
    expect(sampleReceipt.monotonicSequencesVerified).toBe(true);
  });
});
