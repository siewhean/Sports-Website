import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const webServerEnvironment =
  "APP_ENV=local MATCHDAY_PHASE2_DATA_MODE=demo MATCHDAY_ALLOW_DEMO_FIXTURES=1 MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE=true";

export default defineConfig({
  testDir: "./tests",
  testIgnore: [
    "**/unit/**",
    "**/gate-c-access-real.spec.ts",
    "**/gate-c-c2-real.spec.ts",
    "**/gate-c-c3-real.spec.ts",
    "**/phase-2-real-api.spec.ts",
    "**/phase-4-real-api.spec.ts",
  ],
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3101",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "tablet-webkit",
      testMatch:
        /phase-(?:2|3)-(?:responsive|accessibility|visual)\.spec\.ts|phase-4-.*(?:responsive|accessibility|visual)\.spec\.ts|phase-4-assisted-setup-revision\.spec\.ts/,
      use: {
        ...devices["iPad Pro 11"],
        baseURL: "https://127.0.0.1:3100",
        ignoreHTTPSErrors: true,
      },
    },
    {
      name: "phone-webkit",
      testMatch:
        /gate-c-c2-scoring\.spec\.ts|phase-(?:2|3)-(?:responsive|accessibility|visual)\.spec\.ts|phase-4-.*(?:responsive|accessibility|visual)\.spec\.ts|phase-4-assisted-setup-revision\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        baseURL: "https://127.0.0.1:3100",
        ignoreHTTPSErrors: true,
      },
    },
    {
      name: "phone-chromium",
      testMatch:
        /gate-c-c2-scoring\.spec\.ts|phase-(?:2|3)-(?:responsive|accessibility|visual)\.spec\.ts|phase-4-.*(?:responsive|accessibility|visual)\.spec\.ts|phase-4-assisted-setup-revision\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: `${webServerEnvironment} MATCHDAY_PLAYWRIGHT_SKIP_BUILD=${isCI ? "1" : "0"} node tests/helpers/run-playwright-web-server.mjs`,
    url: "https://127.0.0.1:3100/setup",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: isCI ? 240_000 : 120_000,
  },
});
