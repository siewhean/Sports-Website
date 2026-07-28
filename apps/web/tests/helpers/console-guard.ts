import { expect, type Page, type TestInfo } from "@playwright/test";

type AllowedFailure = { pattern: RegExp; remaining: number | null };
type GuardState = { failures: string[]; allowed: AllowedFailure[] };

const guards = new WeakMap<Page, GuardState>();

function isExpectedFrameworkWarning(text: string) {
  if (text === "Service Worker registration blocked by Playwright") return true;
  return (
    /was preloaded using link preload but not used within a few seconds/.test(text) &&
    (/\/_next\/static\/media\/Geist(?:Mono)?_Variable/.test(text) ||
      /\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.css/.test(text))
  );
}

export function isExpectedTeardownFontCancellation(input: {
  failure: string;
  pageUrl: string;
  requestUrl: string;
  resourceType: string;
}): boolean {
  if (input.failure !== "cancelled" || input.resourceType !== "font") return false;
  try {
    const pageUrl = new URL(input.pageUrl);
    const requestUrl = new URL(input.requestUrl);
    return pageUrl.origin === requestUrl.origin && /\.woff2?$/.test(requestUrl.pathname);
  } catch {
    return false;
  }
}

export function isExpectedTeardownServiceWorkerCancellation(input: {
  failure: string;
  pageUrl: string;
  requestUrl: string;
}): boolean {
  if (input.failure !== "cancelled") return false;
  try {
    const pageUrl = new URL(input.pageUrl);
    const requestUrl = new URL(input.requestUrl);
    return pageUrl.origin === requestUrl.origin && requestUrl.pathname === "/sw.js";
  } catch {
    return false;
  }
}

export function isExpectedTeardownStaticAssetCancellation(input: {
  failure: string;
  pageUrl: string;
  requestUrl: string;
  resourceType: string;
}): boolean {
  if (
    !["cancelled", "net::ERR_ABORTED"].includes(input.failure) ||
    !["script", "stylesheet"].includes(input.resourceType)
  )
    return false;
  try {
    const pageUrl = new URL(input.pageUrl);
    const requestUrl = new URL(input.requestUrl);
    return pageUrl.origin === requestUrl.origin && requestUrl.pathname.startsWith("/_next/static/");
  } catch {
    return false;
  }
}

export function installConsoleGuard(page: Page) {
  const state: GuardState = { failures: [], allowed: [] };
  guards.set(page, state);

  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      if (message.type() === "warning" && isExpectedFrameworkWarning(message.text())) return;
      state.failures.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    // WebKit reports cancelled speculative Next RSC prefetches as access-control
    // errors rather than request cancellation events.
    if (error.message.includes("_rsc=") && error.message.endsWith("due to access control checks.")) return;
    state.failures.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown error";
    const url = request.url();
    // Next cancels speculative RSC prefetches when navigation makes them stale.
    if ((failure === "net::ERR_ABORTED" || failure === "cancelled") && url.includes("_rsc=")) return;
    // WebKit may cancel an in-flight local font while a page or context is
    // being replaced. Keep every other font/network failure observable.
    if (
      isExpectedTeardownFontCancellation({
        failure,
        pageUrl: page.url(),
        requestUrl: url,
        resourceType: request.resourceType(),
      })
    )
      return;
    if (isExpectedTeardownServiceWorkerCancellation({ failure, pageUrl: page.url(), requestUrl: url })) return;
    if (
      isExpectedTeardownStaticAssetCancellation({
        failure,
        pageUrl: page.url(),
        requestUrl: url,
        resourceType: request.resourceType(),
      })
    )
      return;
    state.failures.push(`requestfailed: ${request.method()} ${url} (${failure})`);
  });

  return page.addInitScript(() => {
    window.localStorage.setItem(
      "matchday-consent-v1",
      JSON.stringify({
        version: 1,
        essential: true,
        analytics: false,
        marketing: false,
        decidedAt: "2026-07-17T00:00:00.000Z",
      }),
    );
  });
}

export function allowConsoleFailure(page: Page, pattern: RegExp) {
  guards.get(page)?.allowed.push({ pattern, remaining: null });
}

export function allowConsoleFailureCount(page: Page, pattern: RegExp, maximumCount: number) {
  if (!Number.isSafeInteger(maximumCount) || maximumCount < 1) {
    throw new Error("Console failure allowance count must be a positive integer.");
  }
  guards.get(page)?.allowed.push({ pattern, remaining: maximumCount });
}

export async function assertConsoleGuard(page: Page, testInfo: TestInfo) {
  const state = guards.get(page);
  const failures = (state?.failures ?? []).filter((failure) => {
    const allowance = (state?.allowed ?? []).find(({ pattern, remaining }) => remaining !== 0 && pattern.test(failure));
    if (!allowance) return true;
    if (allowance.remaining !== null) allowance.remaining -= 1;
    return false;
  });
  await testInfo.attach("browser-runtime-health", {
    body: failures.length
      ? failures.join("\n")
      : "No console warnings, console errors, page errors, or failed requests.",
    contentType: "text/plain",
  });
  expect(failures, "unexpected browser runtime failures").toEqual([]);
}

export async function dismissConsent(page: Page) {
  const reject = page.getByRole("button", { name: "Reject optional" });
  const preferences = page.getByRole("button", { name: "Privacy choices" });
  await Promise.race([
    reject.waitFor({ state: "visible", timeout: 1_000 }),
    preferences.waitFor({ state: "visible", timeout: 1_000 }),
  ]).catch(() => undefined);
  if (await reject.isVisible().catch(() => false)) {
    await reject.click();
    await expect(reject).toBeHidden();
  }
}

export async function openPhase2Scorekeeper(page: Page) {
  await page.goto("/score");
  await dismissConsent(page);
  await page.getByLabel("Scoring code").fill("POLO-12");
  await page.getByRole("button", { name: "Validate access" }).click();
  await page.getByRole("checkbox", { name: "I am at Match 12 and ready to score this fixture." }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();
  await expect(page.getByRole("heading", { name: "Match 12" })).toBeVisible();
}
