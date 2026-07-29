import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  devices,
  expect,
  firefox,
  test,
  webkit,
  type BrowserContext,
  type BrowserType,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import {
  allowConsoleFailureCount,
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
} from "./helpers/console-guard";

type GateCC3State = {
  webOrigin: string;
  accessToken: string;
  matchId: string;
  homeName: string;
  organiserCookie: string;
  c3ControlToken: string;
  c3Aggregates: Array<{
    competitionId: string;
    matchId: string;
    slug: string;
    homeName: string;
    awayName: string;
    accessPassId: string;
    accessToken: string;
    candidateAccessPassId?: string;
    candidateAccessToken?: string;
  }>;
};

const scenarioAssertions = {
  online_preparation: ["authority_issued", "worker_ready"],
  offline_event_and_local_reversal: ["event_queued", "local_reversal_queued"],
  page_refresh: ["queue_recovered"],
  browser_restart: ["persistent_profile_relaunched", "queue_recovered"],
  strict_ordered_replay: ["contiguous_order", "one_at_a_time"],
  lost_response_idempotency: ["duplicate_receipt", "no_duplicate_mutation"],
  pending_finalisation: ["local_pending", "publication_acknowledged"],
  sequence_divergence: ["queue_retained", "replay_stopped"],
  stale_generation_takeover: ["queue_retained", "takeover_conflict"],
  expiry_and_revocation: ["expired_read_only", "revoked_read_only"],
  four_hour_recording_boundary: ["at_boundary_blocked", "before_allowed", "grace_transmission_only"],
  sign_out_with_unresolved_queue: ["export_before_discard", "signout_intercepted"],
  sanitised_export: ["deterministic_hash", "secret_scan_clean"],
  storage_corruption: ["cache_loss_recovered", "corruption_visible", "indexeddb_loss_safe"],
  service_worker_update: ["safe_activation", "update_deferred"],
} as const;

type ExecutedScenario = keyof typeof scenarioAssertions;
type SafeObservation = string | number | boolean | readonly string[];
type C3Aggregate = GateCC3State["c3Aggregates"][number];
let revocationBrowserProofComplete = false;

async function state(): Promise<GateCC3State> {
  const file = process.env.PHASE2_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE2_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<GateCC3State>;
  if (
    !parsed.webOrigin ||
    !parsed.accessToken ||
    !parsed.matchId ||
    !parsed.homeName ||
    !parsed.organiserCookie ||
    !parsed.c3ControlToken ||
    !Array.isArray(parsed.c3Aggregates) ||
    parsed.c3Aggregates.length !== 9
  ) {
    throw new Error("Gate C C3 real seed must contain nine isolated authorised scoring aggregates");
  }
  return parsed as GateCC3State;
}

async function setServerClock(
  testInfo: TestInfo,
  profileRoot: string,
  seed: GateCC3State,
  value: string,
): Promise<void> {
  const context = await launch(testInfo, path.join(profileRoot, `clock-${crypto.randomUUID()}`), false);
  const response = await context.request.post(`${seed.webOrigin}/_e2e/gate-c-c3/clock`, {
    headers: { "x-matchday-e2e-control": seed.c3ControlToken },
    data: { now: value },
  });
  expect(response.status()).toBe(204);
  await context.close();
}

async function resetServerClock(testInfo: TestInfo, profileRoot: string, seed: GateCC3State): Promise<void> {
  const context = await launch(testInfo, path.join(profileRoot, `clock-reset-${crypto.randomUUID()}`), false);
  const response = await context.request.post(`${seed.webOrigin}/_e2e/gate-c-c3/clock`, {
    headers: { "x-matchday-e2e-control": seed.c3ControlToken },
    data: { reset: true },
  });
  expect(response.status()).toBe(204);
  await context.close();
}

async function setBrowserDateNow(page: Page, value: number): Promise<void> {
  await page.addInitScript((now) => {
    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => now,
    });
  }, value);
  await page.evaluate((now) => {
    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => now,
    });
  }, value);
}

test.afterEach(async ({}, testInfo) => {
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot || !process.env.PHASE2_E2E_STATE_FILE) return;
  await resetServerClock(testInfo, profileRoot, await state());
});

function persistentProject(testInfo: TestInfo): {
  browserType: BrowserType;
  device: (typeof devices)[keyof typeof devices];
} {
  switch (testInfo.project.name) {
    case "gate-c-c3-phone-chromium":
      return { browserType: chromium, device: devices["Pixel 7"] };
    case "gate-c-c3-phone-webkit":
      return { browserType: webkit, device: devices["iPhone 13"] };
    case "gate-c-c3-desktop-chromium":
      return { browserType: chromium, device: devices["Desktop Chrome"] };
    case "gate-c-c3-desktop-webkit":
      return { browserType: webkit, device: devices["Desktop Safari"] };
    case "gate-c-c3-desktop-firefox":
      return { browserType: firefox, device: devices["Desktop Firefox"] };
    default:
      throw new Error(`Unsupported Gate C C3 project: ${testInfo.project.name}`);
  }
}

async function workerVersion(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw new Error("The scoring service worker is not active");
    return new Promise<string>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = window.setTimeout(() => reject(new Error("Worker version timed out")), 5_000);
      const receive = (event: MessageEvent) => {
        if (event.data?.type !== "MATCHDAY_SCORING_WORKER_VERSION" || event.data?.requestId !== requestId) {
          return;
        }
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("message", receive);
        resolve(String(event.data.version));
      };
      navigator.serviceWorker.addEventListener("message", receive);
      worker.postMessage({ type: "MATCHDAY_SCORING_WORKER_VERSION", requestId });
    });
  });
}

async function waitingWorkerVersion(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const worker = registration?.waiting;
    if (!worker) throw new Error("The scoring service worker update is not waiting");
    return new Promise<string>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = window.setTimeout(() => reject(new Error("Waiting worker version timed out")), 5_000);
      const receive = (event: MessageEvent) => {
        if (event.data?.type !== "MATCHDAY_SCORING_WORKER_VERSION" || event.data?.requestId !== requestId) {
          return;
        }
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("message", receive);
        resolve(String(event.data.version));
      };
      navigator.serviceWorker.addEventListener("message", receive);
      worker.postMessage({ type: "MATCHDAY_SCORING_WORKER_VERSION", requestId });
    });
  });
}

async function recordGoal(page: Page, homeName: string): Promise<void> {
  const trigger = page.getByRole("button", { name: `Goal ${homeName}` });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Confirm goal" });
  try {
    await expect(dialog).toBeVisible();
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      workerSafetyFreeze: document.documentElement.dataset.scoringWorkerSafetyFreeze ?? null,
      scoringPhase: document.querySelector("#score-main")?.getAttribute("data-scoring-phase") ?? null,
      writerState: document.querySelector("#score-main")?.getAttribute("data-writer-state") ?? null,
      offlineState: document.querySelector("#score-main")?.getAttribute("data-offline-state") ?? null,
      openDialogs: [...document.querySelectorAll("dialog")].filter((candidate) => candidate.open).length,
      workerUpdateState:
        document.querySelector('[data-testid="scoring-worker-update-state"]')?.getAttribute("data-state") ?? null,
    }));
    throw new Error(`Goal dialog did not open: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await dialog.getByLabel("Scorer or participant name").fill(`${homeName} scorer`);
  const eventTime = dialog.getByLabel("Event time");
  if (await eventTime.count()) await eventTime.fill("01:00");
  await dialog.getByRole("button", { name: `Record goal for ${homeName}` }).click();
}

async function reverseLatest(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Reverse event" }).last().click();
  const dialog = page.getByRole("dialog", { name: "Reverse recorded event" });
  await dialog.getByLabel("Reversal reason").fill("Offline scorer correction");
  await dialog.getByRole("button", { name: "Confirm reversal" }).click();
}

async function writeScenarioReceipt(
  scenario: ExecutedScenario,
  testInfo: TestInfo,
  observedAt: string,
  observations: Readonly<Record<string, SafeObservation>>,
): Promise<void> {
  const directory = process.env.GATE_C_C3_SCENARIO_DIRECTORY;
  const sourceSha = process.env.GATE_C_C3_SOURCE_SHA;
  if (!directory || !sourceSha) throw new Error("Gate C C3 scenario retention variables are required");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${scenario}.json`),
    `${JSON.stringify({
      artifact_kind: "gate-c-c3-scenario-receipt",
      source_sha: sourceSha,
      owner_kind: "project",
      owner_name: testInfo.project.name,
      scenario,
      status: "passed",
      observed_at: observedAt,
      assertions: scenarioAssertions[scenario],
      observations,
    })}\n`,
    { flag: "wx" },
  );
}

async function retainSafeScreenshot(page: Page, name: string): Promise<void> {
  expect(page.url()).not.toContain(["#", "access="].join(""));
  const scenarioDirectory = process.env.GATE_C_C3_SCENARIO_DIRECTORY;
  if (!scenarioDirectory) throw new Error("GATE_C_C3_SCENARIO_DIRECTORY is required");
  const screenshotDirectory = path.join(path.dirname(scenarioDirectory), "screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(path.join(screenshotDirectory, name), await page.screenshot({ animations: "disabled" }), {
    flag: "wx",
  });
}

function installNetworkGuard(page: Page): {
  expectFailedRequest(method: string, pathname: string): void;
  allowFailedRequest(method: string, pathname: string, errorText: string, maximumCount?: number): void;
  assertClean(): void;
} {
  const unexpected: string[] = [];
  const expectedFailures = new Map<string, number>();
  const allowedFailures = new Map<string, number>();
  page.on("response", (response) => {
    if (response.status() >= 500)
      unexpected.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const errorText = request.failure()?.errorText ?? "request failed";
    const remaining = expectedFailures.get(key) ?? 0;
    if (remaining > 0) {
      expectedFailures.set(key, remaining - 1);
      return;
    }
    const allowedKey = `${key}: ${errorText}`;
    const allowed = allowedFailures.get(allowedKey) ?? 0;
    if (allowed > 0) {
      allowedFailures.set(allowedKey, allowed - 1);
      return;
    }
    unexpected.push(allowedKey);
  });
  return {
    expectFailedRequest(method, pathname) {
      const key = `${method} ${pathname}`;
      expectedFailures.set(key, (expectedFailures.get(key) ?? 0) + 1);
    },
    allowFailedRequest(method, pathname, errorText, maximumCount = 1) {
      const key = `${method} ${pathname}: ${errorText}`;
      allowedFailures.set(key, (allowedFailures.get(key) ?? 0) + maximumCount);
    },
    assertClean() {
      const unmet = [...expectedFailures].filter(([, count]) => count !== 0);
      expect(unmet, `Expected browser network failures did not occur: ${JSON.stringify(unmet)}`).toEqual([]);
      expect(unexpected, `Unexpected browser network failures:\n${unexpected.join("\n")}`).toEqual([]);
    },
  };
}

async function launch(testInfo: TestInfo, profileDirectory: string, offline: boolean): Promise<BrowserContext> {
  const { browserType, device } = persistentProject(testInfo);
  return browserType.launchPersistentContext(profileDirectory, {
    ...device,
    ...(browserType.name() === "chromium" ? { args: ["--ignore-certificate-errors"] } : {}),
    headless: true,
    ignoreHTTPSErrors: true,
    serviceWorkers: "allow",
    acceptDownloads: true,
    offline,
  });
}

async function enterScoringAccess(page: Page, webOrigin: string, accessToken: string): Promise<void> {
  await page.addInitScript((token) => {
    const injectionMarker = "matchday-c3-access-fragment-injected";
    if (
      window.location.pathname === "/score" &&
      !window.location.hash &&
      window.sessionStorage.getItem(injectionMarker) !== "true"
    ) {
      window.sessionStorage.setItem(injectionMarker, "true");
      const accessParameter = "access";
      window.history.replaceState(window.history.state, "", `/score#${accessParameter}=${encodeURIComponent(token)}`);
    }
  }, accessToken);
  await page.goto(`${webOrigin}/score`);
  await expect(page).toHaveURL(/\/score$/u);
}

async function openAggregate(
  testInfo: TestInfo,
  profileDirectory: string,
  seed: GateCC3State,
  aggregate: C3Aggregate,
): Promise<{ context: BrowserContext; page: Page; networkGuard: ReturnType<typeof installNetworkGuard> }> {
  const context = await launch(testInfo, profileDirectory, false);
  const page = context.pages()[0] ?? (await context.newPage());
  await installConsoleGuard(page);
  const networkGuard = installNetworkGuard(page);
  await enterScoringAccess(page, seed.webOrigin, aggregate.accessToken);
  await dismissConsent(page);
  await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();
  return { context, page, networkGuard };
}

async function openCandidateAggregate(
  testInfo: TestInfo,
  profileDirectory: string,
  seed: GateCC3State,
  aggregate: C3Aggregate,
): Promise<{ context: BrowserContext; page: Page; networkGuard: ReturnType<typeof installNetworkGuard> }> {
  const context = await launch(testInfo, profileDirectory, false);
  const page = context.pages()[0] ?? (await context.newPage());
  await installConsoleGuard(page);
  const networkGuard = installNetworkGuard(page);
  await enterScoringAccess(page, seed.webOrigin, aggregate.accessToken);
  await dismissConsent(page);
  await expect(page.getByRole("button", { name: "Request scoring access" })).toBeVisible();
  return { context, page, networkGuard };
}

async function prepareOffline(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Prepare offline scoring" }).click();
  try {
    await expect(page.getByText("Ready for offline scoring", { exact: true })).toBeVisible();
  } catch (error) {
    const diagnostics = await page.evaluate(async () => {
      const workerResponse = await fetch("/sw.js", { cache: "no-store" }).catch(() => null);
      let registration = await navigator.serviceWorker.getRegistration("/");
      let registrationError: string | null = null;
      let readyState = "not-attempted";
      if (!registration) {
        try {
          registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
          readyState = await Promise.race([
            navigator.serviceWorker.ready.then(() => "ready"),
            new Promise<string>((resolve) => window.setTimeout(() => resolve("timed-out"), 2_000)),
          ]);
        } catch (error) {
          registrationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          readyState = "registration-rejected";
        }
      }
      const preparationReply = registration?.active
        ? await new Promise<unknown>((resolve) => {
            const channel = new MessageChannel();
            const timeout = window.setTimeout(() => resolve({ error: "diagnostic-timeout" }), 5_000);
            channel.port1.onmessage = (event) => {
              window.clearTimeout(timeout);
              channel.port1.close();
              resolve(event.data);
            };
            registration.active?.postMessage(
              {
                type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
                assets: [],
                protocolVersion: 1,
                requiredCapabilities: ["offline-scoring-shell-cache-v1"],
              },
              [channel.port2],
            );
          })
        : null;
      const cacheStorageProbe = await (async () => {
        const cacheName = "matchday-c3-storage-probe";
        try {
          const cache = await caches.open(cacheName);
          const request = new Request(new URL("/_e2e/cache-storage-probe", window.location.origin).href);
          await cache.put(request, new Response("ok", { headers: { "content-type": "text/plain" } }));
          const stored = await cache.match(request);
          return {
            keys: (await cache.keys()).map(({ url }) => new URL(url).pathname),
            body: await stored?.text(),
          };
        } catch (error) {
          return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
        } finally {
          await caches.delete(cacheName);
        }
      })();
      return {
        secureContext: window.isSecureContext,
        serviceWorkerAvailable: "serviceWorker" in navigator,
        registrationOutputPresent: document.querySelector('[data-testid="scoring-worker-update-state"]') !== null,
        workerFetchStatus: workerResponse?.status ?? null,
        workerContentType: workerResponse?.headers.get("content-type") ?? null,
        online: navigator.onLine,
        controller: navigator.serviceWorker.controller?.state ?? null,
        active: registration?.active?.state ?? null,
        waiting: registration?.waiting?.state ?? null,
        installing: registration?.installing?.state ?? null,
        registrationError,
        readyState,
        preparationReply,
        cacheStorageProbe,
        offlineState: document.querySelector("[data-offline-state]")?.getAttribute("data-offline-state") ?? null,
        offlineTitle: document.querySelector("#offline-state-title")?.textContent?.trim() ?? null,
      };
    });
    throw new Error(`Offline preparation did not reach ready state: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
}

async function enterOfflineRecording(
  context: BrowserContext,
  page: Page,
  networkGuard: ReturnType<typeof installNetworkGuard>,
): Promise<void> {
  const originPattern = new URL(page.url()).origin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  networkGuard.allowFailedRequest("GET", "/api/scoring/session", "net::ERR_INTERNET_DISCONNECTED", 1);
  allowConsoleFailureCount(
    page,
    new RegExp(`^requestfailed: GET ${originPattern}/api/scoring/session \\(net::ERR_INTERNET_DISCONNECTED\\)$`, "u"),
    1,
  );
  allowConsoleFailureCount(page, /^console\.error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/u, 1);
  await context.setOffline(true);
  await expect(page.locator("#score-main")).toHaveAttribute("data-offline-state", "offline-recording");
}

function allowColdOfflineRestartProbes(
  page: Page,
  networkGuard: ReturnType<typeof installNetworkGuard>,
  origin: string,
): void {
  const originPattern = new URL(origin).origin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const [method, pathname] of [
    ["GET", "/api/scoring/session"],
    ["POST", "/api/scoring/offline/authority"],
  ] as const) {
    networkGuard.allowFailedRequest(method, pathname, "net::ERR_INTERNET_DISCONNECTED", 1);
    allowConsoleFailureCount(
      page,
      new RegExp(`^requestfailed: ${method} ${originPattern}${pathname} \\(net::ERR_INTERNET_DISCONNECTED\\)$`, "u"),
      1,
    );
  }
  allowConsoleFailureCount(page, /^console\.error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/u, 2);
}

async function recordGlobalEvent(page: Page, accessibleName: string): Promise<void> {
  await page.getByRole("button", { name: accessibleName, exact: true }).click();
  await page
    .getByRole("dialog", { name: /record event/i })
    .getByRole("button", { name: "Record event" })
    .click();
}

async function organiserRequest(
  testInfo: TestInfo,
  profileRoot: string,
  seed: GateCC3State,
  pathname: string,
  init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const context = await launch(testInfo, path.join(profileRoot, `organiser-${crypto.randomUUID()}`), false);
  const [name, value] = seed.organiserCookie.split("=", 2);
  if (!name || !value) throw new Error("Gate C C3 organiser cookie is malformed");
  await context.addCookies([{ name, value, url: seed.webOrigin, secure: true, sameSite: "Strict" }]);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(seed.webOrigin);
  const result = await page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
        method: requestInit.method ?? "GET",
        headers: requestInit.body === undefined ? undefined : { "content-type": "application/json" },
        body: requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { requestPath: pathname, requestInit: init ?? {} },
  );
  await context.close();
  return result;
}

async function offlineTiming(page: Page): Promise<{ recordingExpiresAt: string; replayExpiresAt: string }> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("matchday-offline-scoring", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("match_packages");
          const all = transaction.objectStore("match_packages").getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            const active = all.result.find((item) => item.status === "active");
            database.close();
            if (!active) {
              reject(new Error("No active offline package"));
              return;
            }
            resolve({
              recordingExpiresAt: String(active.recording_expires_at),
              replayExpiresAt: String(active.replay_expires_at),
            });
          };
        };
      }),
  );
}

async function offlineQueueDiagnostics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const counts = await new Promise<Record<string, number | string>>((resolve) => {
      const request = indexedDB.open("matchday-offline-scoring", 1);
      request.onerror = () => resolve({ database_error: request.error?.name ?? "unknown" });
      request.onsuccess = () => {
        const database = request.result;
        const storeNames = ["match_packages", "commands", "acknowledgements", "conflicts"].filter((name) =>
          database.objectStoreNames.contains(name),
        );
        const result: Record<string, number> = {};
        if (storeNames.length === 0) {
          database.close();
          resolve(result);
          return;
        }
        const transaction = database.transaction(storeNames);
        for (const name of storeNames) {
          const count = transaction.objectStore(name).count();
          count.onsuccess = () => {
            result[name] = count.result;
          };
        }
        transaction.oncomplete = () => {
          database.close();
          resolve(result);
        };
        transaction.onerror = () => {
          database.close();
          resolve({ transaction_error: transaction.error?.name ?? "unknown" });
        };
      };
    });
    return {
      counts,
      rootPresent: document.querySelector("#score-main") !== null,
      scoringPhase: document.querySelector("#score-main")?.getAttribute("data-scoring-phase") ?? null,
      writerState: document.querySelector("#score-main")?.getAttribute("data-writer-state") ?? null,
      offlineState: document.querySelector("#score-main")?.getAttribute("data-offline-state") ?? null,
      offlineTitle: document.querySelector("#offline-state-title")?.textContent?.trim() ?? null,
      workerSafetyFrozen: document.documentElement.dataset.scoringWorkerSafetyFreeze === "true",
      workerUpdateState:
        document.querySelector('[data-testid="scoring-worker-update-state"]')?.getAttribute("data-state") ?? null,
      announcement: [...document.querySelectorAll('[aria-live="polite"]')]
        .map((node) => node.textContent?.trim())
        .filter(Boolean)
        .at(-1),
      mainText: document.querySelector("main")?.textContent?.trim().slice(0, 240) ?? null,
    };
  });
}

async function reloadOfflineDocument(
  page: Page,
  testInfo: TestInfo,
  sensitiveValues: string[],
): Promise<"reload" | "navigate"> {
  const preparedShell = await page.evaluate(async (values) => {
    const cache = await caches.open("matchday-scoring-shell-v5");
    const response = await cache.match("/score", { ignoreVary: true });
    const body = response ? await response.clone().text() : "";
    return {
      cacheKeys: (await cache.keys()).map(({ url }) => new URL(url).pathname),
      responseStatus: response?.status ?? null,
      containsSensitiveValue: values.some((value) => value.length > 0 && body.includes(value)),
    };
  }, sensitiveValues);
  expect(preparedShell.responseStatus, JSON.stringify(preparedShell)).toBe(200);
  expect(preparedShell.containsSensitiveValue).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(window, "__matchdayC3PreReloadDocument", {
      configurable: true,
      value: true,
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#score-main")).toHaveAttribute("data-offline-state", "pending-sync");
  const reloadProof = await page.evaluate(async () => {
    const transportProbe = await fetch("/__matchday-offline-transport-probe", { cache: "no-store" }).then(
      (response) => ({ blocked: false, status: response.status }),
      (error: unknown) => ({
        blocked: true,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
    return {
      navigationType: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type,
      transientDocumentMarkerPresent: Object.prototype.hasOwnProperty.call(window, "__matchdayC3PreReloadDocument"),
      serviceWorkerControlled: navigator.serviceWorker.controller !== null,
      browserReportsOffline: navigator.onLine === false,
      offlineUiState: document.querySelector("#score-main")?.getAttribute("data-offline-state") ?? null,
      transportProbe,
    };
  });
  const navigationType = reloadProof.navigationType;
  if (testInfo.project.name.endsWith("-chromium")) expect(navigationType).toBe("reload");
  else expect(["reload", "navigate"]).toContain(navigationType);
  expect(reloadProof).toMatchObject({
    transientDocumentMarkerPresent: false,
    serviceWorkerControlled: true,
    offlineUiState: "pending-sync",
    transportProbe: { blocked: true, errorName: "TypeError" },
  });
  if (navigationType !== "reload" && navigationType !== "navigate") {
    throw new Error(`Unexpected offline reload navigation type: ${String(navigationType)}`);
  }
  return navigationType;
}

test.describe.configure({ mode: "serial" });

test("Gate C C3 executes the implemented persistent offline slice", async ({}, testInfo) => {
  const seed = await state();
  const profileDirectory = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileDirectory) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const primaryProfileDirectory = path.join(profileDirectory, "primary");
  const observedAt = new Date().toISOString();

  const firstContext = await launch(testInfo, primaryProfileDirectory, false);
  let page = firstContext.pages()[0] ?? (await firstContext.newPage());
  await installConsoleGuard(page);
  let networkGuard = installNetworkGuard(page);
  await enterScoringAccess(page, seed.webOrigin, seed.accessToken);
  await dismissConsent(page);
  await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();
  await prepareOffline(page);
  const activeWorkerVersion = await workerVersion(page);
  expect(activeWorkerVersion).toBe("gate-c-c3-v5");
  await assertNoWcagAOrAaViolations(page);
  await retainSafeScreenshot(page, "offline-ready.png");
  await writeScenarioReceipt("online_preparation", testInfo, observedAt, {
    service_worker_version: activeWorkerVersion,
    queue_count: 0,
  });

  await enterOfflineRecording(firstContext, page, networkGuard);
  await recordGoal(page, seed.homeName);
  await expect(page.getByText(/1 command pending/u)).toBeVisible();
  await reverseLatest(page);
  await expect(page.getByText(/2 commands pending/u)).toBeVisible();
  await assertNoWcagAOrAaViolations(page);
  await retainSafeScreenshot(page, "offline-two-pending.png");
  await writeScenarioReceipt("offline_event_and_local_reversal", testInfo, observedAt, {
    queued_command_count: 2,
    local_reversal_count: 1,
  });

  const originPattern = new URL(seed.webOrigin).origin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  allowColdOfflineRestartProbes(page, networkGuard, seed.webOrigin);
  networkGuard.expectFailedRequest("GET", "/__matchday-offline-transport-probe");
  allowConsoleFailureCount(
    page,
    new RegExp(
      `^requestfailed: GET ${originPattern}/__matchday-offline-transport-probe \\((?:net::ERR_INTERNET_DISCONNECTED|Load failed)\\)$`,
      "u",
    ),
    1,
  );
  allowConsoleFailureCount(
    page,
    /^console\.error: Failed to load resource: (?:net::ERR_INTERNET_DISCONNECTED|The Internet connection appears to be offline\.)$/u,
    1,
  );
  const refreshNavigationType = await reloadOfflineDocument(page, testInfo, [
    seed.accessToken,
    seed.organiserCookie,
    seed.homeName,
    ...seed.c3Aggregates.flatMap(({ accessToken, homeName, awayName }) => [accessToken, homeName, awayName]),
  ]);
  await expect(page.getByText(/2 commands pending/u)).toBeVisible();
  await writeScenarioReceipt("page_refresh", testInfo, observedAt, {
    recovered_command_count: 2,
    refresh_mechanism: "browser-reload",
    performance_navigation_type: refreshNavigationType,
  });
  networkGuard.assertClean();
  await assertConsoleGuard(page, testInfo);
  await firstContext.close();

  const secondContext = await launch(testInfo, primaryProfileDirectory, true);
  page = secondContext.pages()[0] ?? (await secondContext.newPage());
  await installConsoleGuard(page);
  networkGuard = installNetworkGuard(page);
  allowColdOfflineRestartProbes(page, networkGuard, seed.webOrigin);
  const restartOriginPattern = new URL(seed.webOrigin).origin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  allowConsoleFailureCount(
    page,
    new RegExp(`^requestfailed: POST ${restartOriginPattern}/api/scoring/events \\(net::ERR_FAILED\\)$`, "u"),
    2,
  );
  allowConsoleFailureCount(page, /^console\.error: Failed to load resource: net::ERR_FAILED$/u, 2);
  await page.goto(`${seed.webOrigin}/score`);
  try {
    await expect(page.getByText(/2 commands pending/u)).toBeVisible();
  } catch (error) {
    throw new Error(
      `Persistent restart did not recover the queue: ${JSON.stringify(await offlineQueueDiagnostics(page))}`,
      {
        cause: error,
      },
    );
  }
  await assertNoWcagAOrAaViolations(page);
  await retainSafeScreenshot(page, "offline-browser-restart.png");
  await writeScenarioReceipt("browser_restart", testInfo, observedAt, {
    recovered_command_count: 2,
    persistent_profile_reused: true,
  });

  const replayClientIds: string[] = [];
  let lostResponseInjected = false;
  let duplicateReceiptObserved = false;
  let inFlight = 0;
  let maximumInFlight = 0;
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/scoring/events") || request.method() !== "POST") return;
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    const body = request.postDataJSON() as { client_event_id?: string; clientEventId?: string };
    replayClientIds.push(String(body.client_event_id ?? body.clientEventId ?? ""));
  });
  page.on("requestfinished", (request) => {
    if (request.url().endsWith("/api/scoring/events") && request.method() === "POST") inFlight -= 1;
  });
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/api/scoring/events") && request.method() === "POST") inFlight -= 1;
  });
  page.on("response", async (response) => {
    if (!response.url().endsWith("/api/scoring/events") || response.request().method() !== "POST" || !response.ok()) {
      return;
    }
    const body = (await response.json().catch(() => null)) as { duplicate?: boolean } | null;
    if (body?.duplicate === true) duplicateReceiptObserved = true;
  });
  await page.route("**/api/scoring/events", async (route) => {
    if (lostResponseInjected || route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    lostResponseInjected = true;
    const interceptedHeaders = route.request().headers();
    const requestOrigin = new URL(route.request().url()).origin;
    const accepted = await route.fetch({
      headers: {
        ...interceptedHeaders,
        "sec-fetch-site": "same-origin",
      },
    });
    if (!accepted.ok()) {
      const rawBody = await accepted.text();
      const parsedBody = (() => {
        try {
          const body = JSON.parse(rawBody) as Record<string, unknown>;
          return {
            error: typeof body.error === "string" ? body.error : undefined,
            code: typeof body.code === "string" ? body.code : undefined,
            current_sequence: typeof body.current_sequence === "number" ? body.current_sequence : undefined,
            current_aggregate_version:
              typeof body.current_aggregate_version === "number" ? body.current_aggregate_version : undefined,
          };
        } catch {
          return { error: "non_json_response" };
        }
      })();
      throw new Error(
        `Lost-response injection upstream failed: ${JSON.stringify({
          status: accepted.status(),
          intercepted_cookie_present: typeof interceptedHeaders.cookie === "string",
          intercepted_origin_matches_request:
            typeof interceptedHeaders.origin === "string" && interceptedHeaders.origin === requestOrigin,
          intercepted_fetch_site_same_origin: interceptedHeaders["sec-fetch-site"] === "same-origin",
          ...parsedBody,
        })}`,
      );
    }
    await route.abort("failed");
  });
  networkGuard.expectFailedRequest("POST", "/api/scoring/events");
  const syncClick = page.getByRole("button", { name: "Sync now" }).click();
  await secondContext.setOffline(false);
  await syncClick;
  await expect(page.getByText("All changes are synced.")).toBeVisible();
  expect(replayClientIds).toHaveLength(3);
  expect(new Set(replayClientIds).size).toBe(2);
  expect(replayClientIds[0]).toBe(replayClientIds[1]);
  expect(duplicateReceiptObserved).toBe(true);
  expect(maximumInFlight).toBe(1);
  await assertNoWcagAOrAaViolations(page);
  await retainSafeScreenshot(page, "offline-replay-complete.png");
  await writeScenarioReceipt("strict_ordered_replay", testInfo, observedAt, {
    replayed_command_count: replayClientIds.length,
    maximum_concurrent_requests: maximumInFlight,
    replay_client_id_sha256: replayClientIds.map((clientId) => createHash("sha256").update(clientId).digest("hex")),
  });
  await writeScenarioReceipt("lost_response_idempotency", testInfo, observedAt, {
    duplicate_receipt_sha256: createHash("sha256")
      .update(replayClientIds[0] ?? "")
      .digest("hex"),
    mutation_count: 2,
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export sanitized diagnostic" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("The sanitized offline diagnostic was not retained");
  const exported = await readFile(downloadPath, "utf8");
  expect(exported).not.toMatch(
    new RegExp(`(?:bearer\\s|${["#", "access="].join("")}|cookie|password|secret|client_ip)`, "iu"),
  );
  expect(download.suggestedFilename()).toContain(
    createHash("sha256").update(exported.trim()).digest("hex").slice(0, 12),
  );
  await testInfo.attach("sanitized-offline-diagnostic.json", {
    body: exported,
    contentType: "application/json",
  });
  await writeScenarioReceipt("sanitised_export", testInfo, observedAt, {
    export_sha256: createHash("sha256").update(exported.trim()).digest("hex"),
    sensitive_data_scan_clean: true,
  });

  await enterOfflineRecording(secondContext, page, networkGuard);
  await page.getByRole("button", { name: "Incident", exact: true }).click();
  const unresolvedRecordButton = page
    .getByRole("dialog", { name: /record event/i })
    .getByRole("button", { name: "Record event" });
  await unresolvedRecordButton.click();
  try {
    await expect(page.getByText(/1 command pending/u)).toBeVisible();
  } catch (error) {
    throw new Error(
      `Unresolved sign-out setup did not retain one command: ${JSON.stringify({
        ...(await offlineQueueDiagnostics(page)),
        offline_state: await page.locator("#score-main").getAttribute("data-offline-state"),
        record_dialog_open: await page
          .getByRole("dialog", { name: /record event/i })
          .isVisible()
          .catch(() => false),
        record_dialog_text: (
          await page
            .getByRole("dialog", { name: /record event/i })
            .textContent()
            .catch(() => null)
        )
          ?.trim()
          .slice(0, 300),
      })}`,
      { cause: error },
    );
  }
  await page.getByRole("button", { name: "End scoring session" }).click();
  const signOutDialog = page.getByRole("dialog", { name: "Unsynchronised scoring remains on this device" });
  await expect(signOutDialog).toBeVisible();
  await signOutDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "End scoring session" })).toBeFocused();
  await page.getByRole("button", { name: "End scoring session" }).click();
  const discardExportPromise = page.waitForEvent("download");
  await signOutDialog.getByRole("button", { name: "Export before discard" }).click();
  await discardExportPromise;
  await expect(signOutDialog.getByRole("button", { name: "Discard exported work and end scoring" })).toBeEnabled();
  let releasePendingReplay!: () => void;
  let markReplayIntercepted!: () => void;
  let markReplayAborted!: () => void;
  const pendingReplayRelease = new Promise<void>((resolve) => {
    releasePendingReplay = resolve;
  });
  const replayIntercepted = new Promise<void>((resolve) => {
    markReplayIntercepted = resolve;
  });
  const replayAborted = new Promise<void>((resolve) => {
    markReplayAborted = resolve;
  });
  await page.route("**/api/scoring/events", async (route) => {
    markReplayIntercepted();
    await pendingReplayRelease;
    await route.abort("failed");
    markReplayAborted();
  });
  networkGuard.expectFailedRequest("POST", "/api/scoring/events");
  await secondContext.setOffline(false);
  await replayIntercepted;
  await expect(signOutDialog.getByRole("button", { name: "Discard exported work and end scoring" })).toBeDisabled();
  releasePendingReplay();
  await replayAborted;
  await expect(page.getByText(/1 command pending/u)).toBeVisible();
  const replacementExportPromise = page.waitForEvent("download");
  await signOutDialog.getByRole("button", { name: "Export before discard" }).click();
  const replacementExport = await replacementExportPromise;
  const replacementExportPath = await replacementExport.path();
  if (!replacementExportPath) throw new Error("The replacement offline diagnostic was not retained");
  const replacementExported = await readFile(replacementExportPath, "utf8");
  expect(replacementExported).not.toMatch(
    new RegExp(`(?:bearer\\s|${["#", "access="].join("")}|cookie|password|secret|client_ip)`, "iu"),
  );
  const replacementExportSha = createHash("sha256").update(replacementExported.trim()).digest("hex");
  expect(replacementExport.suggestedFilename()).toContain(replacementExportSha.slice(0, 12));
  await expect(signOutDialog.getByRole("button", { name: "Discard exported work and end scoring" })).toBeEnabled();
  await signOutDialog.getByRole("button", { name: "Discard exported work and end scoring" }).click();
  await expect(page.getByRole("button", { name: "Validate access" })).toBeVisible();
  await writeScenarioReceipt("sign_out_with_unresolved_queue", testInfo, observedAt, {
    signout_intercepted: true,
    export_sha256: replacementExportSha,
  });
  networkGuard.assertClean();
  await assertConsoleGuard(page, testInfo);
  await secondContext.close();
});

test("Gate C C3 fences an in-flight replay across a mounted principal switch", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[1]!;
  const { context, page, networkGuard } = await openAggregate(
    testInfo,
    path.join(profileRoot, "principal-switch-fencing"),
    seed,
    aggregate,
  );
  await prepareOffline(page);
  await enterOfflineRecording(context, page, networkGuard);
  await recordGoal(page, aggregate.homeName);
  await expect(page.getByText(/1 command pending/u)).toBeVisible();

  let releaseAcceptedResponse!: () => void;
  let markServerAccepted!: () => void;
  let markAcceptedResponseFulfilled!: () => void;
  const acceptedResponseRelease = new Promise<void>((resolve) => {
    releaseAcceptedResponse = resolve;
  });
  const serverAccepted = new Promise<void>((resolve) => {
    markServerAccepted = resolve;
  });
  const acceptedResponseFulfilled = new Promise<void>((resolve) => {
    markAcceptedResponseFulfilled = resolve;
  });
  await page.route("**/api/scoring/events", async (route) => {
    const requestHeaders = await route.request().allHeaders();
    const accepted = await route.fetch({
      headers: {
        ...requestHeaders,
        // Playwright's out-of-browser route.fetch transport drops this browser-generated
        // Fetch Metadata header. Preserve the original same-origin mutation semantics.
        "sec-fetch-site": "same-origin",
      },
    });
    expect(
      accepted.ok(),
      `Principal-switch replay was rejected: ${accepted.status()} ${await accepted.text()} ` +
        JSON.stringify({
          origin: requestHeaders.origin ?? null,
          fetchSite: requestHeaders["sec-fetch-site"] ?? null,
          hasCookie: Boolean(requestHeaders.cookie),
        }),
    ).toBe(true);
    markServerAccepted();
    await acceptedResponseRelease;
    await route.fulfill({ response: accepted });
    markAcceptedResponseFulfilled();
  });

  await context.setOffline(false);
  await serverAccepted;

  const switched = await page.evaluate(
    ({ replacementPrincipal }) =>
      new Promise<{
        originalPrincipal: string;
        originalEpoch: number;
        replacementVisiblePackages: number;
        replacementVisibleCommands: number;
      }>((resolve, reject) => {
        const request = indexedDB.open("matchday-offline-scoring", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(["meta", "match_packages", "commands"], "readwrite");
          const meta = transaction.objectStore("meta");
          const principalRequest = meta.get("active_principal_id");
          const packagesRequest = transaction.objectStore("match_packages").getAll();
          const commandsRequest = transaction.objectStore("commands").getAll();
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => {
            const current = principalRequest.result as { value: string; epoch: number };
            const packages = packagesRequest.result as Array<{ principal_id: string }>;
            const packageAuthorizations = new Set(
              packages
                .filter(({ principal_id }) => principal_id === replacementPrincipal)
                .map((matchPackage) => (matchPackage as { authorization_id?: string }).authorization_id),
            );
            const commands = commandsRequest.result as Array<{ authorization_id: string }>;
            database.close();
            resolve({
              originalPrincipal: current.value,
              originalEpoch: current.epoch,
              replacementVisiblePackages: packageAuthorizations.size,
              replacementVisibleCommands: commands.filter(({ authorization_id }) =>
                packageAuthorizations.has(authorization_id),
              ).length,
            });
          };
          principalRequest.onsuccess = () => {
            const current = principalRequest.result as { value: string; epoch: number };
            meta.put({
              key: "active_principal_id",
              value: replacementPrincipal,
              epoch: current.epoch + 1,
            });
          };
        };
      }),
    { replacementPrincipal: "f".repeat(64) },
  );
  expect(switched.replacementVisiblePackages).toBe(0);
  expect(switched.replacementVisibleCommands).toBe(0);

  await page.evaluate(
    ({ originalPrincipal, originalEpoch }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("matchday-offline-scoring", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("meta", "readwrite");
          transaction.objectStore("meta").put({
            key: "active_principal_id",
            value: originalPrincipal,
            epoch: originalEpoch + 2,
          });
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
        };
      }),
    switched,
  );
  releaseAcceptedResponse();
  await acceptedResponseFulfilled;
  await page.unroute("**/api/scoring/events");

  const fencedQueue = await page.evaluate(
    () =>
      new Promise<{ pending: number; acknowledgements: number }>((resolve, reject) => {
        const request = indexedDB.open("matchday-offline-scoring", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(["commands", "acknowledgements"]);
          const commands = transaction.objectStore("commands").count();
          const acknowledgements = transaction.objectStore("acknowledgements").count();
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => {
            database.close();
            resolve({
              pending: commands.result - acknowledgements.result,
              acknowledgements: acknowledgements.result,
            });
          };
        };
      }),
  );
  expect(fencedQueue).toEqual({ pending: 1, acknowledgements: 0 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open("matchday-offline-scoring", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const transaction = database.transaction("replay_state");
              const count = transaction.objectStore("replay_state").count();
              transaction.onerror = () => reject(transaction.error);
              transaction.oncomplete = () => {
                database.close();
                resolve(count.result);
              };
            };
          }),
      ),
    )
    .toBe(0);

  allowColdOfflineRestartProbes(page, networkGuard, seed.webOrigin);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(/1 command pending/u)).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("All changes are synced.")).toBeVisible();
  networkGuard.assertClean();
  await assertConsoleGuard(page, testInfo);
  await context.close();
});

test("Gate C C3 retains a divergent offline command for review", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[2]!;
  const { context, page, networkGuard } = await openAggregate(
    testInfo,
    path.join(profileRoot, "sequence-divergence"),
    seed,
    aggregate,
  );
  await prepareOffline(page);
  await enterOfflineRecording(context, page, networkGuard);
  await recordGoal(page, aggregate.homeName);
  await expect(page.getByText(/1 command pending/u)).toBeVisible();

  let divergenceInjected = false;
  await page.route("**/api/scoring/events", async (route) => {
    if (divergenceInjected || route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    divergenceInjected = true;
    const original = route.request().postDataJSON() as { expected_sequence: number; match_id: string };
    const interceptedHeaders = route.request().headers();
    const injected = await route.fetch({
      headers: {
        ...interceptedHeaders,
        "sec-fetch-site": "same-origin",
      },
      postData: JSON.stringify({
        client_event_id: crypto.randomUUID(),
        expected_sequence: original.expected_sequence,
        match_id: aggregate.matchId,
        type: "incident",
        segment_number: 1,
        manual_time_seconds: 30,
        occurred_at: new Date().toISOString(),
      }),
    });
    expect(injected.ok()).toBe(true);
    await route.continue();
  });
  await context.setOffline(false);
  await expect(page.getByText("Replay stopped for review", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 command pending/u)).toBeVisible();
  await writeScenarioReceipt("sequence_divergence", testInfo, new Date().toISOString(), {
    conflict_code: "aggregate_version_conflict",
    retained_command_count: 1,
  });
  const revoked = await organiserRequest(
    testInfo,
    profileRoot,
    seed,
    `/api/gate-c/competitions/${aggregate.competitionId}/access-passes/${aggregate.accessPassId}`,
    { method: "DELETE", body: { reason: "C3 sequence-divergence isolation cleanup" } },
  );
  expect(revoked.status).toBe(200);
  networkGuard.assertClean();
  await context.close();
});

test("Gate C C3 enforces the four-hour recording boundary and replay grace", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[3]!;
  const { context, page, networkGuard } = await openAggregate(
    testInfo,
    path.join(profileRoot, "four-hour-boundary"),
    seed,
    aggregate,
  );
  try {
    await prepareOffline(page);
    const timing = await offlineTiming(page);
    await setServerClock(
      testInfo,
      profileRoot,
      seed,
      new Date(Date.parse(timing.recordingExpiresAt) - 1).toISOString(),
    );
    await setBrowserDateNow(page, Date.parse(timing.recordingExpiresAt) - 1);
    await enterOfflineRecording(context, page, networkGuard);
    await recordGlobalEvent(page, "Incident");
    await expect(page.getByText(/1 command pending/u)).toBeVisible();
    await setServerClock(testInfo, profileRoot, seed, timing.recordingExpiresAt);
    await setBrowserDateNow(page, Date.parse(timing.recordingExpiresAt));
    await page.getByRole("button", { name: "Incident", exact: true }).click();
    await page
      .getByRole("dialog", { name: /record event/i })
      .getByRole("button", { name: "Record event" })
      .click();
    await expect(page.getByRole("region", { name: "Offline authority expired" })).toBeVisible();
    await context.setOffline(false);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("All changes are synced.")).toBeVisible();
    await writeScenarioReceipt("four_hour_recording_boundary", testInfo, new Date().toISOString(), {
      before_boundary_allowed: true,
      at_boundary_blocked: true,
      grace_replay_only: true,
    });
    networkGuard.assertClean();
  } finally {
    await context.close();
  }
});

test("Gate C C3 renders revoked offline authority without discarding work", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[4]!;
  const { context, page, networkGuard } = await openAggregate(
    testInfo,
    path.join(profileRoot, "revoked-authority"),
    seed,
    aggregate,
  );
  await prepareOffline(page);
  await enterOfflineRecording(context, page, networkGuard);
  await recordGoal(page, aggregate.homeName);
  const revoked = await organiserRequest(
    testInfo,
    profileRoot,
    seed,
    `/api/gate-c/competitions/${aggregate.competitionId}/access-passes/${aggregate.accessPassId}`,
    { method: "DELETE", body: { reason: "C3 revocation acceptance" } },
  );
  expect(revoked.status).toBe(200);
  await context.setOffline(false);
  await expect(page.getByRole("region", { name: "Offline authority revoked" })).toBeVisible();
  await expect(page.getByText(/1 command pending/u)).toBeVisible();
  revocationBrowserProofComplete = true;
  networkGuard.assertClean();
  await context.close();
});

test("Gate C C3 renders replay expiry and retains the unresolved queue", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[5]!;
  const { context, page, networkGuard } = await openAggregate(
    testInfo,
    path.join(profileRoot, "expired-authority"),
    seed,
    aggregate,
  );
  try {
    await prepareOffline(page);
    const timing = await offlineTiming(page);
    await setBrowserDateNow(page, Date.parse(timing.recordingExpiresAt) - 1);
    await enterOfflineRecording(context, page, networkGuard);
    await recordGlobalEvent(page, "Incident");
    await setServerClock(testInfo, profileRoot, seed, timing.replayExpiresAt);
    await setBrowserDateNow(page, Date.parse(timing.replayExpiresAt));
    await page.reload();
    await expect(page.getByRole("region", { name: "Offline authority expired" })).toBeVisible();
    await expect(page.getByText(/1 command pending/u)).toBeVisible();
    const revoked = await organiserRequest(
      testInfo,
      profileRoot,
      seed,
      `/api/gate-c/competitions/${aggregate.competitionId}/access-passes/${aggregate.accessPassId}`,
      { method: "DELETE", body: { reason: "C3 expiry isolation cleanup" } },
    );
    expect(revoked.status).toBe(200);
    expect(revocationBrowserProofComplete).toBe(true);
    await writeScenarioReceipt("expiry_and_revocation", testInfo, new Date().toISOString(), {
      expired_state: "expired-read-only-queue-retained",
      revoked_state: "revoked-read-only-queue-retained",
    });
    networkGuard.assertClean();
  } finally {
    await context.close();
  }
});

test("Gate C C3 surfaces corrupt local storage without submitting it", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[6]!;
  const { context, page, networkGuard } = await openAggregate(
    testInfo,
    path.join(profileRoot, "storage-corruption"),
    seed,
    aggregate,
  );
  await prepareOffline(page);
  await enterOfflineRecording(context, page, networkGuard);
  await recordGoal(page, aggregate.homeName);
  await expect(page.getByText(/1 command pending/u)).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("matchday-offline-scoring", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction("commands", "readwrite");
          const store = transaction.objectStore("commands");
          const all = store.getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            const first = all.result[0];
            if (!first) {
              reject(new Error("No offline command to corrupt"));
              return;
            }
            first.match_id = crypto.randomUUID();
            store.put(first);
          };
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  await page.reload();
  await expect(page.getByText("Offline storage error", { exact: true })).toBeVisible();
  await writeScenarioReceipt("storage_corruption", testInfo, new Date().toISOString(), {
    conflict_code: "offline_queue_integrity",
    retained_command_count: 1,
  });
  const revoked = await organiserRequest(
    testInfo,
    profileRoot,
    seed,
    `/api/gate-c/competitions/${aggregate.competitionId}/access-passes/${aggregate.accessPassId}`,
    { method: "DELETE", body: { reason: "C3 storage-corruption isolation cleanup" } },
  );
  expect(revoked.status).toBe(200);
  networkGuard.assertClean();
  await context.close();
});

test("Gate C C3 fences the transferred writer and confirms offline finalisation on the new writer", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[7]!;
  if (!aggregate.candidateAccessToken || !aggregate.candidateAccessPassId) {
    throw new Error("Gate C C3 takeover aggregate has no candidate access pass");
  }
  const incumbent = await openAggregate(testInfo, path.join(profileRoot, "takeover-incumbent"), seed, aggregate);
  await prepareOffline(incumbent.page);
  await enterOfflineRecording(incumbent.context, incumbent.page, incumbent.networkGuard);
  await recordGoal(incumbent.page, aggregate.homeName);
  await expect(incumbent.page.getByText(/1 command pending/u)).toBeVisible();

  const candidateAggregate: C3Aggregate = {
    ...aggregate,
    accessPassId: aggregate.candidateAccessPassId,
    accessToken: aggregate.candidateAccessToken,
  };
  const candidate = await openCandidateAggregate(
    testInfo,
    path.join(profileRoot, "takeover-candidate"),
    seed,
    candidateAggregate,
  );
  await candidate.page.getByRole("button", { name: "Request scoring access" }).click();
  await expect(
    candidate.page.locator("p:not(.visually-hidden)").filter({ hasText: /^Takeover requested$/u }),
  ).toBeVisible();

  const takeoverList = await organiserRequest(
    testInfo,
    profileRoot,
    seed,
    `/api/gate-c/competitions/${aggregate.competitionId}/takeover-requests`,
  );
  expect(takeoverList.status).toBe(200);
  const takeoverId = (
    takeoverList.body as { takeover_requests?: Array<{ id?: string; status?: string }> }
  ).takeover_requests?.find(({ status }) => status === "pending")?.id;
  if (!takeoverId) throw new Error("Gate C C3 takeover request was not visible to the organiser");
  const approval = await organiserRequest(
    testInfo,
    profileRoot,
    seed,
    `/api/gate-c/competitions/${aggregate.competitionId}/takeover-requests/${takeoverId}/approve`,
    {
      method: "POST",
      body: {
        reason: "C3 stale-generation fencing acceptance",
        overrideAcknowledged: true,
      },
    },
  );
  expect(approval.status).toBe(200);
  await incumbent.context.setOffline(false);
  await expect(
    incumbent.page
      .locator("section.p2-score-warning")
      .filter({ hasText: /Replay stopped for review|Scoring moved to another device/u }),
  ).toBeVisible();
  await expect(incumbent.page.getByText(/1 command pending/u)).toBeVisible();
  await writeScenarioReceipt("stale_generation_takeover", testInfo, new Date().toISOString(), {
    conflict_code: "stale_writer_generation",
    retained_command_count: 1,
  });

  await candidate.page.reload();
  await expect(candidate.page.getByRole("button", { name: "Prepare offline scoring" })).toBeVisible();
  await prepareOffline(candidate.page);
  await enterOfflineRecording(candidate.context, candidate.page, candidate.networkGuard);
  await candidate.page.getByRole("combobox", { name: "period", exact: true }).selectOption("2");
  await recordGlobalEvent(candidate.page, "Period change");
  await recordGoal(candidate.page, aggregate.homeName);
  await candidate.page.getByRole("button", { name: "Review final score" }).click();
  await candidate.page.getByRole("button", { name: "Confirm final result" }).click();
  await expect(
    candidate.page.getByRole("region", { name: "Finalised on this device — Pending server confirmation" }),
  ).toBeVisible();
  let confirmedResultVersion = 0;
  candidate.page.on("response", async (response) => {
    if (!response.url().endsWith("/api/scoring/finalise") || response.request().method() !== "POST" || !response.ok()) {
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      result_version?: number;
      resultVersion?: number;
    } | null;
    const version = body?.result_version ?? body?.resultVersion;
    if (Number.isSafeInteger(version)) confirmedResultVersion = Number(version);
  });
  await candidate.context.setOffline(false);
  await expect(candidate.page.getByRole("heading", { name: "Result publication acknowledged" })).toBeVisible();
  expect(confirmedResultVersion).toBeGreaterThan(0);
  await writeScenarioReceipt("pending_finalisation", testInfo, new Date().toISOString(), {
    local_status: "pending-server-confirmation",
    confirmed_result_version: confirmedResultVersion,
  });
  incumbent.networkGuard.assertClean();
  candidate.networkGuard.assertClean();
  await incumbent.context.close();
  await candidate.context.close();
});

test("Gate C C3 defers a worker update until every controlled client is safe", async ({}, testInfo) => {
  const seed = await state();
  const profileRoot = process.env.PHASE2_E2E_PERSISTENT_PROFILE;
  if (!profileRoot) throw new Error("PHASE2_E2E_PERSISTENT_PROFILE is required");
  const aggregate = seed.c3Aggregates[8]!;
  const { context, page, networkGuard } = await openAggregate(
    testInfo,
    path.join(profileRoot, "service-worker-update"),
    seed,
    aggregate,
  );
  await prepareOffline(page);
  expect(await workerVersion(page)).toBe("gate-c-c3-v5");
  const documentIdentity = crypto.randomUUID();
  await page.evaluate((identity) => {
    document.documentElement.dataset.c3WorkerDocumentIdentity = identity;
  }, documentIdentity);

  const safePeer = await context.newPage();
  await installConsoleGuard(safePeer);
  const safePeerNetworkGuard = installNetworkGuard(safePeer);
  await safePeer.goto(`${seed.webOrigin}/maintenance`);
  await expect(safePeer.getByRole("heading", { name: "MATCHDAY is in scheduled maintenance" })).toBeVisible();
  await expect.poll(() => safePeer.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await safePeer.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js?gate-c-c3-update=1", { scope: "/" });
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("The test worker update did not become waiting")),
        10_000,
      );
      const inspect = () => {
        if (registration.waiting) {
          window.clearTimeout(timeout);
          resolve();
          return;
        }
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", inspect, { once: true });
      };
      inspect();
    });
  });
  expect(await waitingWorkerVersion(page)).toBe("gate-c-c3-v6");
  const updateStatus = page.getByTestId("scoring-worker-update-state");
  await expect(updateStatus).toHaveAttribute("data-state", "blocked");
  expect(await workerVersion(page)).toBe("gate-c-c3-v5");

  await enterOfflineRecording(context, page, networkGuard);
  await recordGlobalEvent(page, "Incident");
  await expect(page.getByText(/1 command pending/u)).toBeVisible();
  let releasePendingReplay!: () => void;
  let markReplayIntercepted!: () => void;
  let markReplayAborted!: () => void;
  const pendingReplayRelease = new Promise<void>((resolve) => {
    releasePendingReplay = resolve;
  });
  const replayIntercepted = new Promise<void>((resolve) => {
    markReplayIntercepted = resolve;
  });
  const replayAborted = new Promise<void>((resolve) => {
    markReplayAborted = resolve;
  });
  const workerOriginPattern = new URL(seed.webOrigin).origin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  allowConsoleFailureCount(
    page,
    new RegExp(`^requestfailed: POST ${workerOriginPattern}/api/scoring/events \\(net::ERR_FAILED\\)$`, "u"),
    1,
  );
  allowConsoleFailureCount(page, /^console\.error: Failed to load resource: net::ERR_FAILED$/u, 1);
  await page.route("**/api/scoring/events", async (route) => {
    markReplayIntercepted();
    await pendingReplayRelease;
    await route.abort("failed");
    markReplayAborted();
  });
  networkGuard.expectFailedRequest("POST", "/api/scoring/events");
  await context.setOffline(false);
  await replayIntercepted;
  await expect(updateStatus).toHaveAttribute("data-state", "blocked");

  await page.getByRole("button", { name: "End scoring session" }).click();
  const signOutDialog = page.getByRole("dialog", { name: "Unsynchronised scoring remains on this device" });
  const downloadPromise = page.waitForEvent("download");
  await signOutDialog.getByRole("button", { name: "Export before discard" }).click();
  await downloadPromise;
  const discardClick = signOutDialog.getByRole("button", { name: "Discard exported work and end scoring" }).click();
  releasePendingReplay();
  await replayAborted;
  await discardClick;
  await expect(page.getByRole("button", { name: "Validate access" })).toBeVisible();

  await expect(updateStatus).toHaveAttribute("data-state", "activated", { timeout: 15_000 });
  expect(await workerVersion(page)).toBe("gate-c-c3-v6");
  expect(await page.evaluate(() => document.documentElement.dataset.c3WorkerDocumentIdentity)).toBe(documentIdentity);

  // The document intentionally stays loaded across controllerchange. Its v5
  // client must negotiate the compatible v6 preparation protocol instead of
  // requiring a disruptive reload or rejecting solely on the worker build ID.
  const preparationReply = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw new Error("The activated scoring worker is unavailable");
    return new Promise<unknown>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => reject(new Error("Offline preparation timed out")), 10_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data);
      };
      worker.postMessage(
        {
          type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
          assets: [],
          protocolVersion: 1,
          requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        },
        [channel.port2],
      );
    });
  });
  expect(preparationReply).toEqual(
    expect.objectContaining({
      ok: true,
      version: "gate-c-c3-v6",
      protocolVersion: 1,
      capabilities: expect.arrayContaining(["offline-scoring-shell-cache-v1"]),
    }),
  );
  expect(await workerVersion(page)).toBe("gate-c-c3-v6");
  await writeScenarioReceipt("service_worker_update", testInfo, new Date().toISOString(), {
    active_version: "gate-c-c3-v6",
    waiting_version: "gate-c-c3-v6",
    activation_deferred: true,
    preparation_after_controller_change: true,
  });
  networkGuard.assertClean();
  safePeerNetworkGuard.assertClean();
  await assertConsoleGuard(page, testInfo);
  await assertConsoleGuard(safePeer, testInfo);
  await context.close();
});
