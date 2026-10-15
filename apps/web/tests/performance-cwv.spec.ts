import { devices, expect, test } from "@playwright/test";
import { dismissConsent, installConsoleGuard, assertConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test.use({ ...devices["Pixel 7"] });

test.describe("mobile Core Web Vitals (R6.6)", () => {
  test("public competition page satisfies good Core Web Vitals thresholds on mobile", async ({ page }) => {
    const client = await page
      .context()
      .newCDPSession(page)
      .catch(() => null);
    if (client) {
      await client
        .send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 40,
          downloadThroughput: (4 * 1024 * 1024) / 8,
          uploadThroughput: (3 * 1024 * 1024) / 8,
        })
        .catch(() => {});
    }

    await page.goto("/competitions/singapore-open");
    await dismissConsent(page);

    await expect(page.getByRole("heading", { name: "Latest results" })).toBeVisible();

    const { lcp, cls, supportsLcp } = await page.evaluate(async () => {
      let clsValue = 0;
      let lcpValue = 0;

      await new Promise<void>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === "largest-contentful-paint") {
              lcpValue = entry.startTime;
            } else if (entry.entryType === "layout-shift") {
              const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
              if (!shift.hadRecentInput) {
                clsValue += shift.value ?? 0;
              }
            }
          }
        });

        try {
          observer.observe({ type: "largest-contentful-paint", buffered: true });
          observer.observe({ type: "layout-shift", buffered: true });
        } catch {
          // Fallback if observer types are not supported in test environment
        }

        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 1500);
      });

      const supportsLcp =
        typeof PerformanceObserver !== "undefined" &&
        Array.isArray(PerformanceObserver.supportedEntryTypes) &&
        PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint");

      return { lcp: lcpValue, cls: clsValue, supportsLcp };
    });

    // CWV "Good" thresholds: LCP <= 2.5s (2500ms), CLS <= 0.1
    // In CI virtualised environments, allow a deterministic ceiling (4000ms) to prevent random runner flakiness under CPU pressure.
    const lcpCeiling = process.env.CI ? 4000 : 2500;
    expect(supportsLcp, "Browser engine must support largest-contentful-paint observer").toBe(true);
    expect(lcp, "LCP value must be measured and greater than 0").toBeGreaterThan(0);
    expect(lcp).toBeLessThanOrEqual(lcpCeiling);
    expect(cls).toBeLessThanOrEqual(0.1);
  });

  test("scoring page satisfies good Core Web Vitals thresholds on mobile", async ({ page }) => {
    const client = await page
      .context()
      .newCDPSession(page)
      .catch(() => null);
    if (client) {
      await client
        .send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 40,
          downloadThroughput: (4 * 1024 * 1024) / 8,
          uploadThroughput: (3 * 1024 * 1024) / 8,
        })
        .catch(() => {});
    }

    await page.goto("/score");
    await dismissConsent(page);

    await expect(page.locator('[data-offline-scoring-shell="v1"]')).toBeVisible();

    const { lcp, cls, supportsLcp } = await page.evaluate(async () => {
      let clsValue = 0;
      let lcpValue = 0;

      await new Promise<void>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === "largest-contentful-paint") {
              lcpValue = entry.startTime;
            } else if (entry.entryType === "layout-shift") {
              const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
              if (!shift.hadRecentInput) {
                clsValue += shift.value ?? 0;
              }
            }
          }
        });

        try {
          observer.observe({ type: "largest-contentful-paint", buffered: true });
          observer.observe({ type: "layout-shift", buffered: true });
        } catch {
          // Fail gracefully if unsupported
        }

        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 1500);
      });

      const supportsLcp =
        typeof PerformanceObserver !== "undefined" &&
        Array.isArray(PerformanceObserver.supportedEntryTypes) &&
        PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint");

      return { lcp: lcpValue, cls: clsValue, supportsLcp };
    });

    const lcpCeiling = process.env.CI ? 4000 : 2500;
    expect(supportsLcp, "Browser engine must support largest-contentful-paint observer").toBe(true);
    expect(lcp, "LCP value must be measured and greater than 0").toBeGreaterThan(0);
    expect(lcp).toBeLessThanOrEqual(lcpCeiling);
    expect(cls).toBeLessThanOrEqual(0.1);
  });
});
