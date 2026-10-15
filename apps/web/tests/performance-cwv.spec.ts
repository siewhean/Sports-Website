import { devices, expect, test, type Page } from "@playwright/test";
import { dismissConsent, installConsoleGuard, assertConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test.use({ ...devices["Pixel 7"] });

// CLS uses the web.dev "good" threshold everywhere. LCP is only held to the 2500 ms "good" threshold on local runs;
// shared CI runners are CPU-contended, so CI enforces a regression ceiling instead and does not certify "good" LCP.
const CLS_GOOD = 0.1;
const LCP_GOOD_MS = 2500;
const LCP_CI_CEILING_MS = 4000;
const lcpLimit = process.env.CI ? LCP_CI_CEILING_MS : LCP_GOOD_MS;

type Vitals = { lcp: number; cls: number; supportsLcp: boolean; shifts: string[] };

async function emulateFast4G(page: Page) {
  const client = await page
    .context()
    .newCDPSession(page)
    .catch(() => null);
  await client
    ?.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: (4 * 1024 * 1024) / 8,
      uploadThroughput: (3 * 1024 * 1024) / 8,
    })
    .catch(() => {});
}

async function measureVitals(page: Page): Promise<Vitals> {
  return page.evaluate(async () => {
    let cls = 0;
    let lcp = 0;
    const shifts: string[] = [];
    type Shift = PerformanceEntry & {
      hadRecentInput?: boolean;
      value?: number;
      sources?: Array<{ node?: Node | null }>;
    };
    await new Promise<void>((resolve) => {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "largest-contentful-paint") {
            lcp = entry.startTime;
          } else if (entry.entryType === "layout-shift") {
            const shift = entry as Shift;
            if (shift.hadRecentInput) continue;
            cls += shift.value ?? 0;
            const nodes = (shift.sources ?? []).map((source) => {
              const element = source.node as Element | null | undefined;
              return element?.tagName ? `${element.tagName.toLowerCase()}.${element.className}` : "#text";
            });
            shifts.push(`${Math.round(shift.startTime)}ms ${(shift.value ?? 0).toFixed(4)} ${nodes.join(", ")}`);
          }
        }
      });
      try {
        observer.observe({ type: "largest-contentful-paint", buffered: true });
        observer.observe({ type: "layout-shift", buffered: true });
      } catch {
        // supportsLcp below fails the test if the engine cannot observe these entries.
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
    return { lcp, cls, supportsLcp, shifts };
  });
}

function assertVitals(vitals: Vitals) {
  const summary = `LCP ${Math.round(vitals.lcp)} ms (limit ${lcpLimit} ms${process.env.CI ? ", CI ceiling" : ", good"}), CLS ${vitals.cls.toFixed(4)}`;
  test.info().annotations.push({ type: "cwv", description: summary });
  console.log(`[cwv] ${test.info().title}: ${summary}`);
  expect(vitals.supportsLcp, "Browser engine must support largest-contentful-paint observer").toBe(true);
  expect(vitals.lcp, "LCP value must be measured and greater than 0").toBeGreaterThan(0);
  expect(vitals.lcp, summary).toBeLessThanOrEqual(lcpLimit);
  expect(vitals.cls, `${summary}\nlayout shifts:\n${vitals.shifts.join("\n")}`).toBeLessThanOrEqual(CLS_GOOD);
}

test.describe("mobile Core Web Vitals (R6.6, Pixel 7 + Fast 4G emulation)", () => {
  test("public competition page has good CLS and LCP under the run's ceiling", async ({ page }) => {
    await emulateFast4G(page);
    await page.goto("/competitions/singapore-open");
    await dismissConsent(page);
    await expect(page.getByRole("heading", { name: "Latest results" })).toBeVisible();
    assertVitals(await measureVitals(page));
  });

  test("scoring page has good CLS and LCP under the run's ceiling", async ({ page }) => {
    await emulateFast4G(page);
    await page.goto("/score");
    await dismissConsent(page);
    await expect(page.locator('[data-offline-scoring-shell="v1"]')).toBeVisible();
    assertVitals(await measureVitals(page));
  });
});
