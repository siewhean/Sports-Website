import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
function resolvePort(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${name} must be an integer TCP port between 1024 and 65535`);
  }
  return port;
}

const nextPort = resolvePort(process.env.PLAYWRIGHT_NEXT_PORT, 3101, "PLAYWRIGHT_NEXT_PORT");
const httpsProxyPort = resolvePort(process.env.PLAYWRIGHT_HTTPS_PROXY_PORT, 3100, "PLAYWRIGHT_HTTPS_PROXY_PORT");
const webServerEnvironment =
  "APP_ENV=local MATCHDAY_PHASE2_DATA_MODE=demo MATCHDAY_ALLOW_DEMO_FIXTURES=1 MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE=true";
const buildStep = isCI ? "" : `${webServerEnvironment} pnpm build && `;

export default defineConfig({
  testDir: "./tests",
  testIgnore: [
    "**/unit/**",
    "**/gate-c-access-real.spec.ts",
    "**/gate-c-c2-real.spec.ts",
    "**/gate-c-c3-real.spec.ts",
    "**/phase-2-real-api.spec.ts",
    "**/phase-4-real-api.spec.ts",
    "**/v1-real-api.spec.ts",
    "**/v1-competition-real-api.spec.ts",
  ],
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  expect: {
    toHaveScreenshot: {
      pathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-darwin{ext}",
      threshold: 0.25,
      maxDiffPixelRatio: 0.15,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-darwin{ext}",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${nextPort}`,
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
        baseURL: `https://127.0.0.1:${httpsProxyPort}`,
        ignoreHTTPSErrors: true,
      },
    },
    {
      name: "phone-webkit",
      testMatch:
        /gate-c-c2-scoring\.spec\.ts|phase-(?:2|3)-(?:responsive|accessibility|visual)\.spec\.ts|phase-4-.*(?:responsive|accessibility|visual)\.spec\.ts|phase-4-assisted-setup-revision\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        baseURL: `https://127.0.0.1:${httpsProxyPort}`,
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
    command: `${buildStep}(${webServerEnvironment} pnpm start --hostname 127.0.0.1 --port ${nextPort} & next_pid=$!; trap 'kill $next_pid 2>/dev/null || true' EXIT INT TERM; node tests/helpers/https-proxy.mjs)`,
    url: `https://127.0.0.1:${httpsProxyPort}/setup`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !isCI,
    timeout: isCI ? 240_000 : 120_000,
  },
});
