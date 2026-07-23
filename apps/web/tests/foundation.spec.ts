import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { assertNoWcagAAViolations } from "./helpers/accessibility-gate";

async function rejectOptionalConsent(page: Page) {
  const button = page.getByRole("button", { name: "Reject optional" });
  if (await button.isVisible()) await button.click();
}

test("production pages use nonce-based scripts and the full security header set", async ({ request }) => {
  for (const route of ["/", "/organiser", "/official", "/competitions/singapore-open", "/missing"] as const) {
    const response = await request.get(route);
    const headers = response.headers();
    const csp = headers["content-security-policy"] ?? "";
    const scriptPolicy = csp.split("; ").find((directive) => directive.startsWith("script-src ")) ?? "";
    expect(scriptPolicy).toContain("'nonce-");
    expect(scriptPolicy).toContain("'strict-dynamic'");
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    if (response.url().startsWith("https:")) {
      expect(csp).toContain("upgrade-insecure-requests");
      expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    } else {
      expect(csp).not.toContain("upgrade-insecure-requests");
      expect(headers["strict-transport-security"]).toBeUndefined();
    }
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toContain("camera=()");
  }
});

test("consent is granular, persistent and gates every optional adapter", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose how MATCHDAY uses data" })).toBeVisible();
  await expect(page.locator("[data-consent-adapter]")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Analytics Helps us understand performance and feature use." }).check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await expect(page.locator('[data-consent-adapter="analytics"]')).toHaveCount(1);
  await expect(page.locator('[data-consent-adapter="marketing"]')).toHaveCount(0);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("matchday-consent-v1") ?? "null"));
  expect(stored).toMatchObject({ version: 1, essential: true, analytics: true, marketing: false });

  await page.reload();
  await expect(page.getByRole("button", { name: "Privacy choices" })).toBeVisible();
  await expect(page.locator('[data-consent-adapter="analytics"]')).toHaveCount(1);
});

test("public home keeps its headline wide and preserves reduced-motion behavior", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await rejectOptionalConsent(page);
  const headline = page.getByRole("heading", { level: 1 });
  await expect(headline).toBeVisible();
  const failedImages = await page.locator("img").evaluateAll((images) =>
    images.flatMap((image) => {
      if (!(image instanceof HTMLImageElement)) return ["unexpected non-image element"];
      return !image.complete || image.naturalWidth === 0 ? [image.currentSrc || image.src] : [];
    }),
  );
  expect(failedImages).toEqual([]);
  const lineCount = await headline.evaluate((element) => {
    const styles = getComputedStyle(element);
    return Math.round(element.getBoundingClientRect().height / Number.parseFloat(styles.lineHeight));
  });
  expect(lineCount).toBeGreaterThanOrEqual(2);
  expect(lineCount).toBeLessThanOrEqual(3);
  await expect(page.locator("[data-marquee-track]")).toHaveCSS("transform", "none");
});

test("organiser, official and public shells expose role-specific primary actions", async ({ page }) => {
  await page.goto("/organiser");
  await rejectOptionalConsent(page);
  await expect(page.getByRole("navigation", { name: "Organiser workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review schedule warnings" })).toBeVisible();

  await page.goto("/official");
  await expect(page.getByRole("navigation", { name: "Official workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open match access" })).toBeVisible();

  await page.goto("/competitions/singapore-open");
  await expect(page.getByRole("heading", { name: "Singapore Open 2026" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Next matches" })).toBeVisible();
});

test("public realtime failure degrades to polling and offline copy", async ({ page, context }) => {
  await page.goto("/competitions/singapore-open");
  await rejectOptionalConsent(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("matchday:realtime-failed")));
  await expect(page.getByRole("status", { name: "Connection fallback" })).toContainText(
    "Live connection unavailable. Updating every 30 seconds.",
  );

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByRole("status", { name: "Saved competition state" })).toContainText(
    "You are offline. Showing the latest saved competition state.",
  );
  await context.setOffline(false);
});

test("service worker keeps private documents and mutable images out of Cache Storage", async ({ page, context }) => {
  await page.goto("/");
  await rejectOptionalConsent(page);
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await page.goto("/offline");
  await page.goto("/score");
  await page.goto("/organiser");
  const mutableImage = await page.goto("/images/venue-arc.svg");
  expect((await mutableImage?.allHeaders())?.["cache-control"]).toContain("max-age=0");

  const cachedPaths = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  expect(cachedPaths).not.toContain("/offline");
  expect(cachedPaths).not.toContain("/score");
  expect(cachedPaths).not.toContain("/organiser");
  expect(cachedPaths).not.toContain("/official");
  expect(cachedPaths).not.toContain("/");
  expect(cachedPaths).not.toContain("/competitions/singapore-open");
  expect(cachedPaths).not.toContain("/images/venue-arc.svg");

  await page.goto("/");
  await context.setOffline(true);
  const offlineResponse = await page.goto("/organiser");
  expect(offlineResponse?.status()).toBe(503);
  expect((await offlineResponse?.allHeaders())?.["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: "MATCHDAY is offline" })).toBeVisible();
  await expect(page.getByText("Reconnect, then refresh this page to continue.")).toBeVisible();
  await context.setOffline(false);

  const cachedAfterFallback = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  expect(cachedAfterFallback).not.toContain("/offline");
  expect(cachedAfterFallback).not.toContain("/organiser");
});

test("production image optimizer negotiates modern raster formats", async ({ request }) => {
  const source = await request.get("/api/image-probe");
  expect(source.ok()).toBe(true);
  expect(source.headers()["content-type"]).toContain("image/png");

  const optimizerUrl = "/_next/image?url=%2Fapi%2Fimage-probe&w=64&q=75";
  const avif = await request.get(optimizerUrl, { headers: { Accept: "image/avif,image/webp,image/*,*/*" } });
  expect(avif.ok()).toBe(true);
  expect(avif.headers()["content-type"]).toContain("image/avif");
  expect(avif.headers().vary).toContain("Accept");

  const webp = await request.get(optimizerUrl, { headers: { Accept: "image/webp,image/*,*/*" } });
  expect(webp.ok()).toBe(true);
  expect(webp.headers()["content-type"]).toContain("image/webp");
  expect(webp.headers().vary).toContain("Accept");
});

test("system pages provide contextual recovery", async ({ page }) => {
  await page.goto("/forbidden");
  await rejectOptionalConsent(page);
  await expect(page.getByRole("heading", { name: "This workspace is not available to your account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to organiser workspace" })).toBeVisible();

  const missingResponse = await page.goto("/missing-foundation-route");
  expect(missingResponse?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "That page is not on the schedule" })).toBeVisible();

  const maintenanceResponse = await page.goto("/maintenance");
  expect(maintenanceResponse?.status()).toBe(200);
  await expect(page.getByText("Estimated return: 18 July 2026, 02:30 SGT")).toBeVisible();

  await page.goto("/offline");
  await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
});

for (const route of [
  "/",
  "/organiser",
  "/official",
  "/competitions/singapore-open",
  "/forbidden",
  "/maintenance",
  "/offline",
] as const) {
  test(`${route} has no WCAG A/AA accessibility violations`, async ({ page }) => {
    await page.goto(route);
    await rejectOptionalConsent(page);
    assertNoWcagAAViolations(await new AxeBuilder({ page }).analyze());
  });
}

test("production shells do not overflow desktop, tablet or phone viewports", async ({ page }) => {
  for (const route of ["/", "/organiser", "/official", "/competitions/singapore-open", "/maintenance"] as const) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      await rejectOptionalConsent(page);
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth, `${route} at ${width}px`).toBe(dimensions.clientWidth);
    }
  }
});

test("desktop, tablet and phone visual baselines", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await rejectOptionalConsent(page);
  await expect(page).toHaveScreenshot("home-desktop.png", { fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/organiser");
  await expect(page).toHaveScreenshot("organiser-tablet.png", { fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/competitions/singapore-open");
  await expect(page).toHaveScreenshot("public-phone.png", { fullPage: true, animations: "disabled" });
});
