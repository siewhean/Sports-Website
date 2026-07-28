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
  isScoringWorkerSafetyFrozen,
  isScoringWorkerTransitionInFlight,
  ScoringWorkerSafetyFrozenError,
} from "./scoring-service-worker";

async function workerMessageHarness() {
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
    URL,
    Response,
    caches: {
      keys: vi.fn().mockResolvedValue([]),
    },
    clearTimeout,
    fetch: vi.fn(),
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
    expect(source).not.toMatch(/addEventListener\(["']sync["']/);
    expect(source).not.toContain("SyncManager");
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
