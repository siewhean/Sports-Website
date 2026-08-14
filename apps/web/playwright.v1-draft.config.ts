import { defineConfig, devices } from "@playwright/test";

const demoEnvironment =
  "APP_ENV=local MATCHDAY_PHASE2_DATA_MODE=demo MATCHDAY_ALLOW_DEMO_FIXTURES=1 MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE=true";

export default defineConfig({
  testDir: "./tests",
  testMatch: /v1-competition-create-draft\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3101",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `${demoEnvironment} pnpm start --hostname 127.0.0.1 --port 3101`,
    url: "http://127.0.0.1:3101/organiser/competitions/new",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
