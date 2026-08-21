import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /gate-c-c3-real\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  preserveOutput: "always",
  outputDir: process.env.PHASE2_E2E_OUTPUT_DIR,
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.GATE_C_C3_PLAYWRIGHT_JSON ?? "test-results/gate-c-c3-results.json" }],
  ],
  use: {
    actionTimeout: 15_000,
    baseURL: process.env.PHASE2_E2E_WEB_BASE_URL ?? "https://localhost:3102",
    ignoreHTTPSErrors: true,
    serviceWorkers: "allow",
    // C3 access is exchanged from a one-time secret. Automatic failure capture can
    // serialize page URLs and request data before the fragment is cleared, so the
    // certifying harness retains only explicit post-exchange screenshots.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "gate-c-c3-phone-chromium", use: { ...devices["Pixel 7"] } },
    { name: "gate-c-c3-phone-webkit", use: { ...devices["iPhone 13"] } },
    { name: "gate-c-c3-desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "gate-c-c3-desktop-webkit", use: { ...devices["Desktop Safari"] } },
    { name: "gate-c-c3-desktop-firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
