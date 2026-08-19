import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /phase-4-real-api\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  outputDir: process.env.PHASE4_E2E_OUTPUT_DIR,
  use: {
    baseURL: process.env.PHASE4_E2E_WEB_BASE_URL ?? "http://localhost:3103",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "phase-4-real-phone-chromium", use: { ...devices["Pixel 7"] } },
    {
      name: "phase-4-real-tablet-webkit",
      use: { ...devices["iPad Pro 11"] },
    },
    {
      name: "phase-4-real-desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
