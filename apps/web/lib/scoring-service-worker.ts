"use client";

export const scoringWorkerVersion = "gate-c-c3-v5";
export const scoringWorkerUpdateProtocolVersion = 1;
export const scoringWorkerPreparationProtocolVersion = 1;
export const scoringWorkerPreparationCapabilities = ["offline-scoring-shell-cache-v1"] as const;
export const scoringWorkerUpdateStates = {
  idle: "idle",
  checking: "checking",
  blocked: "blocked",
  activating: "activating",
  activated: "activated",
} as const;
export const scoringWorkerDomContract = {
  safetySelector: "#score-main,[data-offline-state]",
  writerStateAttribute: "data-writer-state",
  offlineStateAttribute: "data-offline-state",
  scoringPhaseAttribute: "data-scoring-phase",
} as const;
export const scoringWorkerSafetyChangedEvent = "matchday:scoring-worker-safety-changed";
export const scoringWorkerFreezeAllowedOfflineMethods = new Set<PropertyKey>(["revokeAuthority"]);
const scoringWorkerSafetyFreezes = new Set<string>();
let scoringWorkerSafetyEpoch = 0;
let scoringWorkerTransitionsInFlight = 0;

export class ScoringWorkerSafetyFrozenError extends Error {
  constructor() {
    super("SCORING_WORKER_SAFETY_FROZEN");
    this.name = "ScoringWorkerSafetyFrozenError";
  }
}

export function beginScoringWorkerSafetyFreeze(requestId: string): void {
  if (scoringWorkerSafetyFreezes.has(requestId)) return;
  scoringWorkerSafetyFreezes.add(requestId);
  scoringWorkerSafetyEpoch += 1;
}

export function endScoringWorkerSafetyFreeze(requestId: string): void {
  if (!scoringWorkerSafetyFreezes.delete(requestId)) return;
  scoringWorkerSafetyEpoch += 1;
}

export function endAllScoringWorkerSafetyFreezes(): void {
  if (scoringWorkerSafetyFreezes.size === 0) return;
  scoringWorkerSafetyFreezes.clear();
  scoringWorkerSafetyEpoch += 1;
}

export function isScoringWorkerSafetyFrozen(): boolean {
  return scoringWorkerSafetyFreezes.size > 0;
}

export function isScoringWorkerTransitionInFlight(): boolean {
  return scoringWorkerTransitionsInFlight > 0;
}

export function assertScoringWorkerTransitionAllowed(): void {
  if (isScoringWorkerSafetyFrozen()) throw new ScoringWorkerSafetyFrozenError();
}

function notifyScoringWorkerSafetyChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(scoringWorkerSafetyChangedEvent));
}

async function trackScoringWorkerTransition<T>(operation: () => Promise<T>, allowWhileFrozen: boolean): Promise<T> {
  if (!allowWhileFrozen) assertScoringWorkerTransitionAllowed();
  const epoch = scoringWorkerSafetyEpoch;
  scoringWorkerTransitionsInFlight += 1;
  notifyScoringWorkerSafetyChanged();
  try {
    const result = await operation();
    if (!allowWhileFrozen && (isScoringWorkerSafetyFrozen() || scoringWorkerSafetyEpoch !== epoch)) {
      throw new ScoringWorkerSafetyFrozenError();
    }
    return result;
  } finally {
    scoringWorkerTransitionsInFlight -= 1;
    notifyScoringWorkerSafetyChanged();
  }
}

export async function runScoringWorkerTransition<T>(operation: () => Promise<T>): Promise<T> {
  return trackScoringWorkerTransition(operation, false);
}

export function guardScoringWorkerTransport<T extends object>(
  transport: T,
  options: { allowDuringFreeze?: ReadonlySet<PropertyKey> } = {},
): T {
  return new Proxy(transport, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (options.allowDuringFreeze?.has(property)) {
        return (...args: unknown[]) =>
          trackScoringWorkerTransition(() => Promise.resolve(Reflect.apply(value, target, args)), true);
      }
      return (...args: unknown[]) =>
        runScoringWorkerTransition(() => Promise.resolve(Reflect.apply(value, target, args)));
    },
  });
}

export type ScoringWorkerClientSafety = {
  activeScoring: boolean;
  transitionInFlight: boolean;
  unresolvedQueue: boolean;
  safe: boolean;
};

export type ScoringWorkerUpdateState = "idle" | "checking" | "blocked" | "activating" | "activated";

type WorkerReply = {
  type: "MATCHDAY_SCORING_WORKER_VERSION";
  requestId: string;
  version: string;
};

type ScoringWorkerActivationReply = {
  type: "MATCHDAY_SCORING_WORKER_ACTIVATION_RESULT";
  requestId: string;
  status: "committing" | "blocked" | "no-update";
  unsafeClientCount?: number;
  version: string;
  protocolVersion: number;
};

type ScoringWorkerPreparationReply = {
  ok?: boolean;
  version?: string;
  protocolVersion?: number;
  capabilities?: unknown;
  code?: string;
};

export class ScoringWorkerPreparationError extends Error {
  constructor(
    readonly code:
      "INCOMPATIBLE_PREPARATION_PROTOCOL" | "OFFLINE_SHELL_STORAGE_UNAVAILABLE" | "OFFLINE_SHELL_PREPARATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "ScoringWorkerPreparationError";
  }
}

const scoringWorkerStoragePreparationAttempts = 2;
const scoringWorkerStorageRetryDelayMs = 100;

export function shouldRetryScoringWorkerPreparation(error: unknown, attempt: number): boolean {
  return (
    attempt < scoringWorkerStoragePreparationAttempts - 1 &&
    error instanceof ScoringWorkerPreparationError &&
    error.code === "OFFLINE_SHELL_STORAGE_UNAVAILABLE"
  );
}

export async function runScoringWorkerPreparationAttempts(
  operation: () => Promise<void>,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
): Promise<void> {
  for (let attempt = 0; attempt < scoringWorkerStoragePreparationAttempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!shouldRetryScoringWorkerPreparation(error, attempt)) throw error;
      await wait(scoringWorkerStorageRetryDelayMs);
    }
  }
}

export function scoringWorkerPreparationError(reply: ScoringWorkerPreparationReply | null): Error {
  if (reply?.code === "INCOMPATIBLE_PREPARATION_PROTOCOL" || reply?.ok === true) {
    return new ScoringWorkerPreparationError(
      "INCOMPATIBLE_PREPARATION_PROTOCOL",
      "The active scoring worker is not compatible with this offline preparation protocol. Finish or export unresolved work, then reload when it is safe.",
    );
  }
  if (reply?.code === "OFFLINE_SHELL_STORAGE_UNAVAILABLE") {
    return new ScoringWorkerPreparationError(
      "OFFLINE_SHELL_STORAGE_UNAVAILABLE",
      "This browser could not retain the offline scoring shell. Use a trusted HTTPS origin with durable browser storage, then retry.",
    );
  }
  return new ScoringWorkerPreparationError(
    "OFFLINE_SHELL_PREPARATION_FAILED",
    "The offline scoring shell could not be prepared.",
  );
}

export function isCompatibleScoringWorkerPreparationReply(value: unknown): value is ScoringWorkerPreparationReply & {
  ok: true;
  version: string;
  protocolVersion: number;
  capabilities: string[];
} {
  const reply = value as ScoringWorkerPreparationReply | null;
  const capabilities = Array.isArray(reply?.capabilities) ? reply.capabilities : [];
  return (
    reply?.ok === true &&
    typeof reply.version === "string" &&
    reply.version.length > 0 &&
    reply.protocolVersion === scoringWorkerPreparationProtocolVersion &&
    scoringWorkerPreparationCapabilities.every((capability) => capabilities.includes(capability))
  );
}

const unresolvedOfflineStates = new Set([
  "pending-sync",
  "reconnecting",
  "replaying",
  "pending-finalisation",
  "conflict",
  "expired",
  "revoked",
  "read-only",
  "storage-error",
]);
const activeOfflineStates = new Set(["preparing", "offline-ready", "offline-recording"]);

export function evaluateScoringWorkerClientSafety(input: {
  scoreRootPresent: boolean;
  scoreSurfaceActive?: boolean;
  scoringPhase?: string | null;
  writerState: string | null;
  offlineState: string | null;
  transitionInFlight?: boolean;
}): ScoringWorkerClientSafety {
  const activeScoring =
    input.scoreRootPresent &&
    ((input.scoreSurfaceActive ?? true) || input.scoringPhase === "confirm") &&
    (input.writerState === "active" ||
      input.writerState === "expiring" ||
      (input.offlineState !== null && activeOfflineStates.has(input.offlineState)));
  const unresolvedQueue = input.offlineState !== null && unresolvedOfflineStates.has(input.offlineState);
  const transitionInFlight = input.transitionInFlight ?? false;
  return {
    activeScoring,
    transitionInFlight,
    unresolvedQueue,
    safe: !activeScoring && !unresolvedQueue && !transitionInFlight,
  };
}

export function readScoringWorkerClientSafety(root: ParentNode = document): ScoringWorkerClientSafety {
  const scoreRoot = root.querySelector<HTMLElement>("#score-main");
  const offlineState = root.querySelector<HTMLElement>("[data-offline-state]")?.getAttribute("data-offline-state");
  return evaluateScoringWorkerClientSafety({
    scoreRootPresent: scoreRoot !== null,
    scoreSurfaceActive: scoreRoot?.classList.contains("p2-score") ?? false,
    scoringPhase: scoreRoot?.getAttribute(scoringWorkerDomContract.scoringPhaseAttribute) ?? null,
    writerState: scoreRoot?.getAttribute("data-writer-state") ?? null,
    offlineState: offlineState ?? null,
    transitionInFlight: isScoringWorkerTransitionInFlight(),
  });
}

export function immutableScoringAssets(
  root: ParentNode = document,
  resourceUrls: readonly string[] = performance.getEntriesByType("resource").map((entry) => entry.name),
): string[] {
  const documentAssets = [
    ...root.querySelectorAll<HTMLScriptElement | HTMLLinkElement>("script[src],link[rel=stylesheet][href]"),
  ].map((element) => ("src" in element ? element.src : element.href));
  return [...new Set([...documentAssets, ...resourceUrls])].filter((candidate) => {
    try {
      const url = new URL(candidate, window.location.origin);
      return (
        url.origin === window.location.origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith("/_next/static/")
      );
    } catch {
      return false;
    }
  });
}

export async function prepareOfflineScoringShell(): Promise<void> {
  if (!("serviceWorker" in navigator)) throw new Error("Offline scoring is unavailable in this browser.");
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active;
  if (!worker) throw new Error("The offline scoring worker is not active.");
  const assets = Object.freeze([...immutableScoringAssets()]);
  await runScoringWorkerPreparationAttempts(
    () =>
      new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = window.setTimeout(() => {
          channel.port1.close();
          reject(new Error("The offline scoring shell preparation timed out."));
        }, 10_000);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          window.clearTimeout(timeout);
          channel.port1.close();
          if (isCompatibleScoringWorkerPreparationReply(event.data)) {
            resolve();
            return;
          }
          const reply = event.data as ScoringWorkerPreparationReply | null;
          reject(scoringWorkerPreparationError(reply));
        };
        worker.postMessage(
          {
            type: "MATCHDAY_PREPARE_OFFLINE_SCORING",
            assets,
            protocolVersion: scoringWorkerPreparationProtocolVersion,
            requiredCapabilities: [...scoringWorkerPreparationCapabilities],
          },
          [channel.port2],
        );
      }),
  );
}

export async function requestScoringWorkerVersion(timeoutMs = 2_000): Promise<string> {
  if (!("serviceWorker" in navigator)) throw new Error("Offline scoring is unavailable in this browser.");
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active;
  if (!worker) throw new Error("The offline scoring worker is not active.");
  const requestId = crypto.randomUUID();
  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", receive);
      reject(new Error("The scoring worker did not report its version."));
    }, timeoutMs);
    const receive = (event: MessageEvent<unknown>) => {
      const reply = event.data as Partial<WorkerReply> | null;
      if (
        !reply ||
        reply.type !== "MATCHDAY_SCORING_WORKER_VERSION" ||
        reply.requestId !== requestId ||
        typeof reply.version !== "string"
      ) {
        return;
      }
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("message", receive);
      resolve(reply.version);
    };
    navigator.serviceWorker.addEventListener("message", receive);
    worker.postMessage({ type: "MATCHDAY_SCORING_WORKER_VERSION", requestId });
  });
}

export async function requestWaitingScoringWorkerActivation(
  timeoutMs = 6_000,
): Promise<Exclude<ScoringWorkerUpdateState, "idle" | "checking" | "activated">> {
  if (!("serviceWorker" in navigator)) return "blocked";
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration?.waiting || !navigator.serviceWorker.controller) return "blocked";
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", receive);
      resolve("blocked");
    }, timeoutMs);
    const receive = (event: MessageEvent<unknown>) => {
      const reply = event.data as Partial<ScoringWorkerActivationReply> | null;
      if (
        !reply ||
        reply.type !== "MATCHDAY_SCORING_WORKER_ACTIVATION_RESULT" ||
        reply.requestId !== requestId ||
        reply.protocolVersion !== scoringWorkerUpdateProtocolVersion
      ) {
        return;
      }
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("message", receive);
      resolve(reply.status === "committing" ? "activating" : "blocked");
    };
    navigator.serviceWorker.addEventListener("message", receive);
    navigator.serviceWorker.controller?.postMessage({
      type: "MATCHDAY_REQUEST_SCORING_WORKER_ACTIVATION",
      requestId,
      protocolVersion: scoringWorkerUpdateProtocolVersion,
    });
  });
}
