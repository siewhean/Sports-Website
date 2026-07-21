import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  testMatch: /phase-2-real-api\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: isCI ? 1 : 0,
  reporter: "list",
  outputDir: process.env.PHASE2_E2E_OUTPUT_DIR,
  use: {
    baseURL: process.env.PHASE2_E2E_WEB_BASE_URL ?? "http://localhost:3102",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "phase-2-real-phone-chromium", use: { ...devices["Pixel 7"] } }],
});
