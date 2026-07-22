import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  testMatch: /phase-4-real-gate-b\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: isCI ? 1 : 0,
  reporter: "list",
  outputDir: process.env.PHASE4_E2E_OUTPUT_DIR,
  use: {
    baseURL: process.env.PHASE4_E2E_WEB_BASE_URL ?? "http://localhost:3104",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "gate-b-real-phone-chromium", use: { ...devices["Pixel 7"] } },
    {
      name: "gate-b-real-desktop-chromium",
      dependencies: ["gate-b-real-phone-chromium"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
