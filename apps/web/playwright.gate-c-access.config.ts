import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /gate-c-access-real\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 10_000,
    baseURL: process.env.PHASE2_E2E_WEB_BASE_URL ?? "https://localhost:3102",
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  forbidOnly: true,
  retries: 0,
  preserveOutput: "always",
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.GATE_C_ACCESS_PLAYWRIGHT_JSON ?? "test-results/gate-c-access-results.json" }],
  ],
  outputDir: process.env.PHASE2_E2E_OUTPUT_DIR,
  projects: [
    { name: "gate-c-access-phone-chromium", use: { ...devices["Pixel 7"] } },
    { name: "gate-c-access-phone-webkit", use: { ...devices["iPhone 13"] } },
    { name: "gate-c-access-desktop-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
