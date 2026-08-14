import { defineConfig, devices } from "@playwright/test";

/**
 * The full V1 competition proof uses the same production runner and isolated
 * aggregate-per-project contract as the basic V1 journey. It is intentionally
 * serial: group standings and downstream qualification must settle before the
 * rendered scorekeeper is allowed to open the progressed fixture.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: [/v1-create-persistence-real\.spec\.ts/, /v1-competition-real-api\.spec\.ts/],
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
    { name: "phase-4-real-phone-chromium", use: { ...devices["Pixel 7"] } },
    { name: "phase-4-real-tablet-webkit", use: { ...devices["iPad Pro 11"] } },
    {
      name: "phase-4-real-desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
