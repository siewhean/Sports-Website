import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /v1-exact-capacity-full-placement-real\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  outputDir: process.env.PHASE4_E2E_OUTPUT_DIR,
  use: {
    baseURL: process.env.PHASE4_E2E_WEB_BASE_URL ?? "https://localhost:3102",
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "phase-4-real-desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
