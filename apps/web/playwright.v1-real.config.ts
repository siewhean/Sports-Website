import { defineConfig, devices } from "@playwright/test";

/**
 * The production V1 harness deliberately retains the established Phase 4
 * project names: its runner gives each project a distinct aggregate while
 * this config proves only the default, simple routes.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /v1-real-api\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  outputDir: process.env.PHASE4_E2E_OUTPUT_DIR,
  use: {
    baseURL: process.env.PHASE4_E2E_WEB_BASE_URL ?? "https://localhost:3102",
    ignoreHTTPSErrors: true,
    // Offline/service-worker behaviour has its own C3/C5 browser matrix. The
    // V1 organiser journey validates the production BFF and must not register
    // a worker against a throwaway self-signed local certificate.
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
