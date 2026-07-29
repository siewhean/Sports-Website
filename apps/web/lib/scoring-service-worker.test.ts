import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginScoringWorkerSafetyFreeze,
  endAllScoringWorkerSafetyFreezes,
  endScoringWorkerSafetyFreeze,
  evaluateScoringWorkerClientSafety,
  guardScoringWorkerTransport,
  immutableScoringAssets,
  isCompatibleScoringWorkerPreparationReply,
  isScoringWorkerSafetyFrozen,
  isScoringWorkerTransitionInFlight,
  scoringWorkerPreparationError,
  ScoringWorkerPreparationError,
  ScoringWorkerSafetyFrozenError,
} from "./scoring-service-worker";

async function workerMessageHarness(
  options: {
    fetch?: ReturnType<typeof vi.fn>;
    openCache?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const active = { postMessage: vi.fn() };
  const waiting = { postMessage: vi.fn() };
  const clients = [
    { id: "client-a", postMessage: vi.fn() },
    { id: "client-b", postMessage: vi.fn() },
  ];
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const serviceWorkerGlobal = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler),
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll: vi.fn().mockResolvedValue(clients),
    },
    location: { origin: "https://matchday.test" },
    registration: { active, waiting },
    skipWaiting,
  };
  runInNewContext(source, {
    Headers,
    Request,
    URL,
    Response,
    caches: {
      keys: vi.fn().mockResolvedValue([]),
      ...(options.openCache ? { open: options.openCache } : {}),
    },
    clearTimeout,
    fetch: options.fetch ?? vi.fn(),
    Promise,
    self: serviceWorkerGlobal,
    setTimeout,
  });
  const message = handlers.get("message");
  if (!message) throw new Error("The scoring worker did not install a message handler.");
  return { active, clients, message, skipWaiting, waiting };
}

describe("Gate C3 scoring service worker", () => {
  afterEach(() => {
    endAllScoringWorkerSafetyFreezes();
    vi.unstubAllGlobals();
  });
  it("does not activate unconditionally or delete caches outside its owned scoring prefix", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/install[\s\S]{0,180}self\.skipWaiting\(\)/);
    expect(source).toContain("key.startsWith(SCORING_CACHE_PREFIX)");
    expect(source).not.toMatch(/keys\.filter\(\(key\) => key !==/);
    expect(source).not.toContain("MATCHDAY_ACTIVATE_SCORING_WORKER");
    expect(source).toContain("MATCHDAY_SCORING_WORKER_SAFE_STATE_QUERY");
    expect(source).toContain("event.source === self.registration.active");
    expect(source).toContain("response.activeScoring === false");
    expect(source).toContain("response.unresolvedQueue === false");
    expect(source).toContain("response.frozen === true");
    expect(source).toContain("message.protocolVersion === UPDATE_PROTOCOL_VERSION");
  });

  it("keeps mutations out of the worker and requires explicit shell preparation", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    expect(source).toContain("MATCHDAY_PREPARE_OFFLINE_SCORING");
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain("The offline scoring shell could not be retained.");
    expect(source).toContain('code: "INCOMPATIBLE_PREPARATION_PROTOCOL"');
    expect(source).toContain('"OFFLINE_SHELL_STORAGE_UNAVAILABLE"');
    expect(source).toContain("message.protocolVersion !== PREPARATION_PROTOCOL_VERSION");
    expect(source).toContain("requiredCapabilities.some");
    expect(source).toContain("cache.match(shellRequest, { ignoreVary: true })");
    expect(source).toMatch(/if \(cached\) return cached;[\s\S]*return fetch\(request\)\.catch/);
    expect(source).not.toMatch(/addEventListener\(["']sync["']/);
    expect(source).not.toContain("SyncManager");
  });

  it("accepts a newer worker build only when its preparation protocol and capabilities are compatible", () => {
    expect(
      isCompatibleScoringWorkerPreparationReply({
        ok: true,
        version: "gate-c-c3-v6",
        protocolVersion: 1,
        capabilities: ["offline-scoring-shell-cache-v1"],
      }),
    ).toBe(true);
    expect(
      isCompatibleScoringWorkerPreparationReply({
        ok: true,
        version: "gate-c-c3-v6",
        protocolVersion: 2,
        capabilities: ["offline-scoring-shell-cache-v1"],
      }),
    ).toBe(false);
    expect(
      isCompatibleScoringWorkerPreparationReply({
        ok: true,
        version: "gate-c-c3-v6",
        protocolVersion: 1,
        capabilities: [],
      }),
    ).toBe(false);
  });

  it("rejects an unknown preparation protocol before touching the scoring cache", async () => {
    const harness = await workerMessageHarness();
    const reply = vi.fn();
    harness.message({
      data: {
        type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
        protocolVersion: 2,
        requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        assets: [],
      },
      ports: [{ postMessage: reply }],
    });
    expect(reply).toHaveBeenCalledWith({
      ok: false,
      version: "gate-c-c3-v5",
      protocolVersion: 1,
      capabilities: ["offline-scoring-shell-cache-v1"],
      code: "INCOMPATIBLE_PREPARATION_PROTOCOL",
    });
  });

  it("reports unavailable durable shell storage distinctly from protocol skew", () => {
    const error = scoringWorkerPreparationError({
      ok: false,
      version: "gate-c-c3-v5",
      protocolVersion: 1,
      capabilities: ["offline-scoring-shell-cache-v1"],
      code: "OFFLINE_SHELL_STORAGE_UNAVAILABLE",
    });
    expect(error).toBeInstanceOf(ScoringWorkerPreparationError);
    expect(error).toMatchObject({
      code: "OFFLINE_SHELL_STORAGE_UNAVAILABLE",
      message: expect.stringContaining("trusted HTTPS origin"),
    });
    expect(
      scoringWorkerPreparationError({
        ok: false,
        version: "gate-c-c3-v5",
        protocolVersion: 1,
        capabilities: ["offline-scoring-shell-cache-v1"],
        code: "INCOMPATIBLE_PREPARATION_PROTOCOL",
      }),
    ).toMatchObject({
      code: "INCOMPATIBLE_PREPARATION_PROTOCOL",
      message: expect.stringContaining("reload when it is safe"),
    });
  });

  it("returns the stable storage-unavailable code when the privacy-verified shell has no durable readback", async () => {
    const postMessage = vi.fn();
    const harness = await workerMessageHarness({
      fetch: vi.fn().mockResolvedValue(
        new Response('<main data-offline-scoring-shell="v1">score</main>', {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
      openCache: vi.fn().mockResolvedValue({
        put: vi.fn().mockResolvedValue(undefined),
        match: vi.fn().mockResolvedValue(undefined),
      }),
    });
    let preparation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
        protocolVersion: 1,
        requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        assets: [],
      },
      ports: [{ postMessage }],
      waitUntil: (promise: Promise<unknown>) => {
        preparation = promise;
      },
    });
    await preparation;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        protocolVersion: 1,
        code: "OFFLINE_SHELL_STORAGE_UNAVAILABLE",
        error: "Error: The offline scoring shell could not be retained.",
      }),
    );
  });

  it("fails preparation when any required immutable asset fetch fails before retaining resources", async () => {
    const postMessage = vi.fn();
    const cache = {
      put: vi.fn().mockResolvedValue(undefined),
      match: vi.fn(),
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), "https://matchday.test");
      if (url.pathname === "/score") {
        return new Response('<main data-offline-scoring-shell="v1">score</main>', {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: url.pathname.endsWith("/missing.js") ? 503 : 200 });
    });
    const harness = await workerMessageHarness({
      fetch,
      openCache: vi.fn().mockResolvedValue(cache),
    });
    let preparation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
        protocolVersion: 1,
        requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        assets: [
          "https://matchday.test/_next/static/chunks/scoring.js",
          "https://matchday.test/_next/static/chunks/missing.js",
        ],
      },
      ports: [{ postMessage }],
      waitUntil: (promise: Promise<unknown>) => {
        preparation = promise;
      },
    });
    await preparation;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cache.put).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: "OFFLINE_SHELL_PREPARATION_FAILED",
        error: "Error: A required offline scoring asset could not be fetched.",
      }),
    );
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("rejects an off-origin or non-static required asset instead of silently dropping it", async () => {
    const postMessage = vi.fn();
    const fetch = vi.fn();
    const cache = { put: vi.fn(), match: vi.fn() };
    const harness = await workerMessageHarness({
      fetch,
      openCache: vi.fn().mockResolvedValue(cache),
    });
    let preparation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
        protocolVersion: 1,
        requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        assets: ["https://other.test/_next/static/chunks/scoring.js"],
      },
      ports: [{ postMessage }],
      waitUntil: (promise: Promise<unknown>) => {
        preparation = promise;
      },
    });
    await preparation;
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: "OFFLINE_SHELL_PREPARATION_FAILED",
        error: "Error: The offline scoring asset manifest is invalid.",
      }),
    );
  });

  it("fails preparation when any fetched immutable asset is not retained", async () => {
    const postMessage = vi.fn();
    const retained = new Map<string, Response>();
    const requestUrl = (request: RequestInfo | URL) =>
      new URL(request instanceof Request ? request.url : request.toString(), "https://matchday.test").href;
    const cache = {
      put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
        retained.set(requestUrl(request), response.clone());
      }),
      match: vi.fn(async (request: RequestInfo | URL) => {
        const url = requestUrl(request);
        if (url.endsWith("/missing-readback.js")) return undefined;
        return retained.get(url)?.clone();
      }),
    };
    const harness = await workerMessageHarness({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString(), "https://matchday.test");
        return url.pathname === "/score"
          ? new Response('<main data-offline-scoring-shell="v1">score</main>', {
              status: 200,
              headers: { "content-type": "text/html" },
            })
          : new Response("immutable", { status: 200 });
      }),
      openCache: vi.fn().mockResolvedValue(cache),
    });
    let preparation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
        protocolVersion: 1,
        requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        assets: [
          "https://matchday.test/_next/static/chunks/scoring.js",
          "https://matchday.test/_next/static/chunks/missing-readback.js",
        ],
      },
      ports: [{ postMessage }],
      waitUntil: (promise: Promise<unknown>) => {
        preparation = promise;
      },
    });
    await preparation;
    expect(cache.put).toHaveBeenCalledTimes(3);
    expect(cache.match).toHaveBeenCalledTimes(3);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: "OFFLINE_SHELL_STORAGE_UNAVAILABLE",
        error: "Error: The offline scoring shell could not be retained.",
      }),
    );
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("retains the privacy-verified shell and every required immutable asset before reporting success", async () => {
    const postMessage = vi.fn();
    const retained = new Map<string, Response>();
    const requestUrl = (request: RequestInfo | URL) =>
      new URL(request instanceof Request ? request.url : request.toString(), "https://matchday.test").href;
    const cache = {
      put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
        retained.set(requestUrl(request), response.clone());
      }),
      match: vi.fn(async (request: RequestInfo | URL) => retained.get(requestUrl(request))?.clone()),
    };
    const harness = await workerMessageHarness({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString(), "https://matchday.test");
        return url.pathname === "/score"
          ? new Response('<main data-offline-scoring-shell="v1">score</main>', {
              status: 200,
              headers: { "content-type": "text/html" },
            })
          : new Response("immutable", { status: 200 });
      }),
      openCache: vi.fn().mockResolvedValue(cache),
    });
    let preparation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
        protocolVersion: 1,
        requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        assets: [
          "https://matchday.test/_next/static/chunks/scoring.js",
          "https://matchday.test/_next/static/css/scoring.css",
        ],
      },
      ports: [{ postMessage }],
      waitUntil: (promise: Promise<unknown>) => {
        preparation = promise;
      },
    });
    await preparation;
    expect(cache.put).toHaveBeenCalledTimes(3);
    expect(cache.match).toHaveBeenCalledTimes(3);
    expect([...retained]).toHaveLength(3);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        version: "gate-c-c3-v5",
        protocolVersion: 1,
      }),
    );
  });

  it("preserves shell privacy verification before caching any immutable asset", async () => {
    const postMessage = vi.fn();
    const cache = {
      put: vi.fn().mockResolvedValue(undefined),
      match: vi.fn(),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<main data-offline-scoring-shell="v1">#access=raw-secret</main>', {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValue(new Response("immutable", { status: 200 }));
    const harness = await workerMessageHarness({
      fetch,
      openCache: vi.fn().mockResolvedValue(cache),
    });
    let preparation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
        protocolVersion: 1,
        requiredCapabilities: ["offline-scoring-shell-cache-v1"],
        assets: ["https://matchday.test/_next/static/chunks/scoring.js"],
      },
      ports: [{ postMessage }],
      waitUntil: (promise: Promise<unknown>) => {
        preparation = promise;
      },
    });
    await preparation;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: "OFFLINE_SHELL_PREPARATION_FAILED",
        error: "Error: The offline scoring shell failed its privacy verification.",
      }),
    );
  });

  it("provides a deliberate recovery path for an incompatible active worker without forcing navigation", async () => {
    const clientSource = await readFile(new URL("./scoring-service-worker.ts", import.meta.url), "utf8");
    const registrationSource = await readFile(
      new URL("../components/foundation/ServiceWorkerRegistration.tsx", import.meta.url),
      "utf8",
    );
    expect(clientSource).toContain("Finish or export unresolved work, then reload when it is safe.");
    expect(clientSource).not.toContain("window.location.reload");
    expect(registrationSource).not.toContain("window.location.reload");
    expect(registrationSource).not.toContain("location.assign");
  });

  it("prepares exact immutable resources already loaded by the uncontrolled first navigation", () => {
    const root = {
      querySelectorAll: () => [
        { src: "https://matchday.test/_next/static/chunks/scoring.js" },
        { href: "https://matchday.test/_next/static/css/scoring.css" },
      ],
    } as unknown as ParentNode;
    vi.stubGlobal("window", { location: { origin: "https://matchday.test" } });
    expect(
      immutableScoringAssets(root, [
        "https://matchday.test/_next/static/media/Geist.woff2",
        "https://matchday.test/_next/static/chunks/scoring.js",
        "https://other.test/_next/static/media/untrusted.woff2",
        "https://matchday.test/api/scoring/session",
      ]),
    ).toEqual([
      "https://matchday.test/_next/static/chunks/scoring.js",
      "https://matchday.test/_next/static/css/scoring.css",
      "https://matchday.test/_next/static/media/Geist.woff2",
    ]);
  });

  it("blocks activation while a client is actively scoring", () => {
    expect(
      evaluateScoringWorkerClientSafety({
        scoreRootPresent: true,
        writerState: "active",
        offlineState: "offline-ready",
      }),
    ).toEqual({ activeScoring: true, transitionInFlight: false, unresolvedQueue: false, safe: false });
  });

  it.each(["pending-sync", "pending-finalisation", "conflict", "expired", "revoked", "storage-error"])(
    "blocks activation while %s work remains unresolved",
    (offlineState) => {
      expect(
        evaluateScoringWorkerClientSafety({
          scoreRootPresent: true,
          writerState: "transferred",
          offlineState,
        }).safe,
      ).toBe(false);
    },
  );

  it("allows activation after export and discard remove active scoring and the unresolved package", () => {
    expect(
      evaluateScoringWorkerClientSafety({
        scoreRootPresent: true,
        writerState: null,
        offlineState: null,
      }),
    ).toEqual({ activeScoring: false, transitionInFlight: false, unresolvedQueue: false, safe: true });
  });

  it("keeps an offline-prepared scorer unsafe after the short writer lease starts expiring", () => {
    expect(
      evaluateScoringWorkerClientSafety({
        scoreRootPresent: true,
        scoreSurfaceActive: true,
        writerState: "expiring",
        offlineState: "offline-recording",
      }),
    ).toEqual({ activeScoring: true, transitionInFlight: false, unresolvedQueue: false, safe: false });
  });

  it("treats match confirmation with an acquired writer lease as active scoring", () => {
    expect(
      evaluateScoringWorkerClientSafety({
        scoreRootPresent: true,
        scoreSurfaceActive: false,
        scoringPhase: "confirm",
        writerState: "active",
        offlineState: "online",
      }).safe,
    ).toBe(false);
    expect(
      evaluateScoringWorkerClientSafety({
        scoreRootPresent: true,
        scoreSurfaceActive: false,
        scoringPhase: "access",
        writerState: "checking",
        offlineState: "online",
      }).safe,
    ).toBe(true);
  });

  it("requires every controlled client to report safe before the active worker approves activation", async () => {
    const harness = await workerMessageHarness();
    let activationCheck: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_REQUEST_SCORING_WORKER_ACTIVATION",
        requestId: "request-safe",
        protocolVersion: 1,
      },
      source: harness.clients[0],
      waitUntil: (promise: Promise<unknown>) => {
        activationCheck = promise;
      },
    });
    await activationCheck;

    expect(harness.clients[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "MATCHDAY_SCORING_WORKER_SAFE_STATE_QUERY", requestId: "request-safe" }),
    );
    expect(harness.clients[1].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "MATCHDAY_SCORING_WORKER_SAFE_STATE_QUERY", requestId: "request-safe" }),
    );
    harness.message({
      data: {
        type: "MATCHDAY_SCORING_WORKER_SAFE_STATE",
        requestId: "request-safe",
        protocolVersion: 1,
        epoch: 4,
        safe: true,
        activeScoring: false,
        unresolvedQueue: false,
      },
      source: harness.clients[0],
    });
    expect(harness.waiting.postMessage).not.toHaveBeenCalled();

    let firstRoundEvaluation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_SCORING_WORKER_SAFE_STATE",
        requestId: "request-safe",
        protocolVersion: 1,
        epoch: 7,
        safe: true,
        activeScoring: false,
        unresolvedQueue: false,
      },
      source: harness.clients[1],
      waitUntil: (promise: Promise<unknown>) => {
        firstRoundEvaluation = promise;
      },
    });
    await firstRoundEvaluation;
    expect(harness.waiting.postMessage).not.toHaveBeenCalled();

    for (const [index, client] of harness.clients.entries()) {
      let finalEvaluation: Promise<unknown> | undefined;
      harness.message({
        data: {
          type: "MATCHDAY_SCORING_WORKER_SAFE_STATE",
          requestId: "request-safe",
          protocolVersion: 1,
          epoch: index === 0 ? 4 : 7,
          stable: true,
          frozen: true,
          safe: true,
          activeScoring: false,
          unresolvedQueue: false,
        },
        source: client,
        waitUntil: (promise: Promise<unknown>) => {
          finalEvaluation = promise;
        },
      });
      await finalEvaluation;
    }
    expect(harness.waiting.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MATCHDAY_SCORING_WORKER_ACTIVATION_APPROVED",
        requestId: "request-safe",
        checkedClientIds: ["client-a", "client-b"],
      }),
    );
  });

  it("blocks activation when any controlled client has unresolved scoring work", async () => {
    const harness = await workerMessageHarness();
    let activationCheck: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_REQUEST_SCORING_WORKER_ACTIVATION",
        requestId: "request-blocked",
        protocolVersion: 1,
      },
      source: harness.clients[0],
      waitUntil: (promise: Promise<unknown>) => {
        activationCheck = promise;
      },
    });
    await activationCheck;
    for (const [index, client] of harness.clients.entries()) {
      let roundEvaluation: Promise<unknown> | undefined;
      harness.message({
        data: {
          type: "MATCHDAY_SCORING_WORKER_SAFE_STATE",
          requestId: "request-blocked",
          protocolVersion: 1,
          epoch: index,
          safe: index === 0,
          activeScoring: false,
          unresolvedQueue: index !== 0,
        },
        source: client,
        waitUntil: (promise: Promise<unknown>) => {
          roundEvaluation = promise;
        },
      });
      await roundEvaluation;
    }
    expect(harness.waiting.postMessage).not.toHaveBeenCalled();
    expect(harness.clients[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MATCHDAY_SCORING_WORKER_ACTIVATION_RESULT",
        requestId: "request-blocked",
        status: "blocked",
      }),
    );
  });

  it("invalidates a pending quorum when a previously safe client changes state", async () => {
    const harness = await workerMessageHarness();
    let activationCheck: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_REQUEST_SCORING_WORKER_ACTIVATION",
        requestId: "request-invalidated",
        protocolVersion: 1,
      },
      source: harness.clients[0],
      waitUntil: (promise: Promise<unknown>) => {
        activationCheck = promise;
      },
    });
    await activationCheck;
    harness.message({
      data: {
        type: "MATCHDAY_SCORING_WORKER_SAFE_STATE",
        requestId: "request-invalidated",
        protocolVersion: 1,
        epoch: 1,
        safe: true,
        activeScoring: false,
        unresolvedQueue: false,
      },
      source: harness.clients[0],
    });
    harness.message({
      data: {
        type: "MATCHDAY_SCORING_WORKER_SAFETY_INVALIDATED",
        protocolVersion: 1,
        epoch: 2,
      },
      source: harness.clients[0],
    });
    expect(harness.waiting.postMessage).not.toHaveBeenCalled();
    expect(harness.clients[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MATCHDAY_SCORING_WORKER_ACTIVATION_RESULT",
        requestId: "request-invalidated",
        status: "blocked",
      }),
    );
  });

  it("rejects activation approval from a window client", async () => {
    const harness = await workerMessageHarness();
    let directActivation: Promise<unknown> | undefined;
    harness.message({
      data: {
        type: "MATCHDAY_SCORING_WORKER_ACTIVATION_APPROVED",
        requestId: "spoofed",
        protocolVersion: 1,
        checkedClientIds: ["client-a", "client-b"],
      },
      source: harness.clients[0],
      waitUntil: (promise: Promise<unknown>) => {
        directActivation = promise;
      },
    });
    expect(directActivation).toBeUndefined();
    expect(harness.skipWaiting).not.toHaveBeenCalled();

    harness.message({
      data: {
        type: "MATCHDAY_SCORING_WORKER_ACTIVATION_APPROVED",
        requestId: "approved",
        protocolVersion: 1,
        checkedClientIds: ["client-a", "client-b"],
      },
      source: harness.active,
      waitUntil: (promise: Promise<unknown>) => {
        directActivation = promise;
      },
    });
    await directActivation;
    expect(harness.skipWaiting).toHaveBeenCalledOnce();
  });

  it("prevents a programmatic scorer transition from starting after the final client freeze", async () => {
    const recoverSession = vi.fn().mockResolvedValue({ mode: "writer" });
    const guarded = guardScoringWorkerTransport({ recoverSession });
    beginScoringWorkerSafetyFreeze("commit-start");

    await expect(guarded.recoverSession()).rejects.toBeInstanceOf(ScoringWorkerSafetyFrozenError);
    expect(recoverSession).not.toHaveBeenCalled();
    expect(isScoringWorkerSafetyFrozen()).toBe(true);
  });

  it("rejects an in-flight heartbeat or recovery completion when the commit freeze begins", async () => {
    let resolveRecovery: ((value: { mode: string }) => void) | undefined;
    const recoverSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ mode: string }>((resolve) => {
            resolveRecovery = resolve;
          }),
      )
      .mockResolvedValue({ mode: "writer" });
    const guarded = guardScoringWorkerTransport({ recoverSession });
    const pending = guarded.recoverSession();
    expect(isScoringWorkerTransitionInFlight()).toBe(true);
    beginScoringWorkerSafetyFreeze("commit-in-flight");
    resolveRecovery?.({ mode: "writer" });

    await expect(pending).rejects.toBeInstanceOf(ScoringWorkerSafetyFrozenError);
    expect(isScoringWorkerTransitionInFlight()).toBe(false);
    endScoringWorkerSafetyFreeze("commit-in-flight");
    await expect(guarded.recoverSession()).resolves.toEqual({ mode: "writer" });
  });

  it("allows only the explicit revocation path needed for export-and-discard while frozen", async () => {
    let resolveRevocation: (() => void) | undefined;
    const revokeAuthority = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRevocation = resolve;
        }),
    );
    const establishAuthority = vi.fn().mockResolvedValue(undefined);
    const guarded = guardScoringWorkerTransport(
      { establishAuthority, revokeAuthority },
      { allowDuringFreeze: new Set(["revokeAuthority"]) },
    );
    beginScoringWorkerSafetyFreeze("commit-discard");

    const pendingRevocation = guarded.revokeAuthority();
    expect(isScoringWorkerTransitionInFlight()).toBe(true);
    resolveRevocation?.();
    await expect(pendingRevocation).resolves.toBeUndefined();
    expect(isScoringWorkerTransitionInFlight()).toBe(false);
    await expect(guarded.establishAuthority()).rejects.toBeInstanceOf(ScoringWorkerSafetyFrozenError);
    expect(revokeAuthority).toHaveBeenCalledOnce();
    expect(establishAuthority).not.toHaveBeenCalled();
  });
});
