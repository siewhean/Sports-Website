import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PHASE7_E2E_WEB_BASE_URL;

if (!baseURL) {
  throw new Error(
    "PHASE7_E2E_WEB_BASE_URL is required. Gate D browser qualification must target a real production-backed web deployment; demo mode is prohibited.",
  );
}

const parsedBaseUrl = new URL(baseURL);
if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
  throw new Error("PHASE7_E2E_WEB_BASE_URL must be an http(s) URL");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: /phase-7-(?:multi-division-lifecycle|security-rendering)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  reporter: "list",
  use: {
    baseURL: parsedBaseUrl.toString(),
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "gate-d-desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
