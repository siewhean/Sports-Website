import { defineConfig, devices } from "@playwright/test";
import { GATE_C_C5_PROJECT_NAMES, resolveGateCC5BrowserEvidence } from "./tests/helpers/gate-c-c5-browser-matrix";

const evidence = resolveGateCC5BrowserEvidence({
  evidenceDirectory: process.env.GATE_C_C5_EVIDENCE_DIR,
  sourceSha: process.env.GATE_C_C5_SOURCE_SHA,
});

const baseURL = process.env.PHASE2_E2E_WEB_BASE_URL;
if (!baseURL || !baseURL.startsWith("https://")) {
  throw new Error("PHASE2_E2E_WEB_BASE_URL must be the trusted HTTPS C5 deployment URL.");
}

const projectDevices = {
  "desktop-chromium": devices["Desktop Chrome"],
  "desktop-firefox": devices["Desktop Firefox"],
  "desktop-webkit": devices["Desktop Safari"],
  "phone-chromium": devices["Pixel 7"],
  "phone-webkit": devices["iPhone 13"],
  "tablet-webkit": devices["iPad Pro 11"],
} satisfies Record<(typeof GATE_C_C5_PROJECT_NAMES)[number], object>;

export default defineConfig({
  testDir: "./tests",
  testMatch: /gate-c-c5-browser-matrix\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  preserveOutput: "always",
  outputDir: evidence.outputDirectory,
  metadata: { gate: "C5", sourceSha: evidence.sourceSha },
  reporter: [["list"], ["./tests/helpers/gate-c-c5-strict-reporter.ts"], ["json", { outputFile: evidence.jsonReport }]],
  use: {
    actionTimeout: 15_000,
    baseURL,
    ignoreHTTPSErrors: false,
    serviceWorkers: "allow",
    trace: "on",
    screenshot: "on",
    video: "on",
  },
  projects: GATE_C_C5_PROJECT_NAMES.map((name) => ({ name, use: { ...projectDevices[name] } })),
});
