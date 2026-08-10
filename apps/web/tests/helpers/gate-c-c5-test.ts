import { expect, test as base, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

type RuntimeFailure = { category: string; detail: string };

function formatConsoleLocation(message: { location(): { url?: string; lineNumber?: number; columnNumber?: number } }) {
  const location = message.location();
  if (!location.url) return "unknown";
  return `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`;
}

async function installRuntimeGuard(context: BrowserContext, failures: RuntimeFailure[]) {
  await context.addInitScript(() => {
    if (window.location.origin === "null") return;
    window.localStorage.setItem(
      "matchday-consent-v1",
      JSON.stringify({
        version: 1,
        essential: true,
        analytics: false,
        marketing: false,
        decidedAt: "2026-07-04T08:30:00.000Z",
      }),
    );
  });

  context.on("console", (message) => {
    if (message.type() !== "error") return;
    failures.push({
      category: `console.${message.type()}`,
      detail: `${message.text()} (${formatConsoleLocation(message)})`,
    });
  });
  context.on("weberror", (error) => {
    failures.push({ category: "pageerror", detail: error.error().message });
  });
  context.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown error";
    if (["cancelled", "net::ERR_ABORTED", "NS_BINDING_ABORTED"].includes(failure) && request.url().includes("_rsc=")) {
      return;
    }
    failures.push({
      category: "requestfailed",
      detail: `${request.method()} ${request.url()} (${failure})`,
    });
  });
  context.on("response", (response) => {
    if (response.status() < 400) return;
    failures.push({
      category: "http",
      detail: `${response.status()} ${response.request().method()} ${response.url()}`,
    });
  });
}

async function attachAndAssertRuntimeHealth(failures: RuntimeFailure[], testInfo: TestInfo) {
  const report = failures.length
    ? failures.map(({ category, detail }) => `${category}: ${detail}`).join("\n")
    : "No console errors, page errors, failed requests, or HTTP error responses.";
  await testInfo.attach("c5-browser-runtime-health", { body: report, contentType: "text/plain" });
  expect(failures, "C5 browser/runtime errors are forbidden").toEqual([]);
}

export const test = base.extend<{ c5RuntimeGuard: void }>({
  c5RuntimeGuard: [
    async ({ context }, use, testInfo) => {
      const failures: RuntimeFailure[] = [];
      await installRuntimeGuard(context, failures);
      await use();
      await attachAndAssertRuntimeHealth(failures, testInfo);
    },
    { auto: true },
  ],
});

export { expect };

export async function activateAndInspectServiceWorker(page: Page, context: BrowserContext) {
  const controlled = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("This browser does not expose navigator.serviceWorker.");
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  });
  if (!controlled) await page.reload({ waitUntil: "networkidle" });

  const status = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      activeState: registration.active?.state ?? null,
      controllerUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
      scope: registration.scope,
    };
  });

  expect(status.activeState).toBe("activated");
  expect(status.controllerUrl).toMatch(/\/sw\.js$/u);
  expect(status.scope).toMatch(/\/$/u);

  // Playwright exposes BrowserContext.serviceWorkers() only for Chromium.
  // The page-level registration assertions above are the cross-engine source
  // of truth; inspect the worker global as an additional Chromium assertion.
  const worker = context.serviceWorkers()[0];
  if (worker) {
    const workerState = await worker.evaluate(() => {
      const registration = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
      return {
        activeState: registration.active?.state ?? null,
        installingState: registration.installing?.state ?? null,
        waitingState: registration.waiting?.state ?? null,
      };
    });
    expect(workerState).toEqual({ activeState: "activated", installingState: null, waitingState: null });
  }

  return status;
}
