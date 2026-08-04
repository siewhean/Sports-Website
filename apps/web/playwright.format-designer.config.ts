import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "format-designer-interactions.spec.ts",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "https://127.0.0.1:3100",
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "format-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "format-webkit", use: { ...devices["Desktop Safari"] } },
    { name: "format-firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command:
      "APP_ENV=local MATCHDAY_PHASE2_DATA_MODE=demo MATCHDAY_ALLOW_DEMO_FIXTURES=1 MATCHDAY_PLAYWRIGHT_SKIP_BUILD=0 node tests/helpers/run-playwright-web-server.mjs",
    url: "https://127.0.0.1:3100/format",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
