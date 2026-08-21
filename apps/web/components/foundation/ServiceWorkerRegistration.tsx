"use client";

import { useEffect, useState } from "react";
import {
  beginScoringWorkerSafetyFreeze,
  endAllScoringWorkerSafetyFreezes,
  endScoringWorkerSafetyFreeze,
  readScoringWorkerClientSafety,
  requestWaitingScoringWorkerActivation,
  scoringWorkerDomContract,
  scoringWorkerSafetyChangedEvent,
  scoringWorkerUpdateProtocolVersion,
  scoringWorkerUpdateStates,
  type ScoringWorkerUpdateState,
} from "@/lib/scoring-service-worker";

type ServiceWorkerRegistrar = Pick<ServiceWorkerContainer, "register">;
type NavigatorWithOptionalServiceWorker = {
  readonly serviceWorker?: ServiceWorkerContainer;
};

export function availableServiceWorkerContainer(
  navigatorLike: NavigatorWithOptionalServiceWorker,
): ServiceWorkerContainer | null {
  return navigatorLike.serviceWorker ?? null;
}

function nodeContainsScoringSafetyState(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return (
    node.matches(scoringWorkerDomContract.safetySelector) ||
    node.querySelector(scoringWorkerDomContract.safetySelector) !== null
  );
}

export function mutationAffectsScoringWorkerSafety(mutation: MutationRecord): boolean {
  if (mutation.type === "attributes") return true;
  if (mutation.target instanceof Element && mutation.target.closest("#score-main")) return true;
  return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsScoringSafetyState);
}

export async function registerServiceWorker(
  registrar: ServiceWorkerRegistrar,
): Promise<globalThis.ServiceWorkerRegistration | null> {
  try {
    return (await registrar.register("/sw.js", { scope: "/" })) ?? null;
  } catch {
    // Offline support is progressive enhancement. Navigation or teardown may
    // cancel registration, and that rejection must not escape as a page error.
    return null;
  }
}

export function ServiceWorkerRegistration() {
  const [updateState, setUpdateState] = useState<ScoringWorkerUpdateState>(scoringWorkerUpdateStates.idle);

  useEffect(() => {
    const serviceWorker = availableServiceWorkerContainer(navigator);
    if (process.env.NODE_ENV !== "production" || !serviceWorker) return;
    let disposed = false;
    let retryTimer: number | null = null;
    let observer: MutationObserver | null = null;
    let registration: globalThis.ServiceWorkerRegistration | null = null;
    let registrationUpdateFound: (() => void) | null = null;
    const installingStateListeners = new Map<ServiceWorker, () => void>();
    let safetyEpoch = 0;
    const safetyFreezes = new Set<string>();
    const safetyFreezeTimers = new Map<string, number>();

    const releaseSafetyFreeze = (requestId: string) => {
      safetyFreezes.delete(requestId);
      endScoringWorkerSafetyFreeze(requestId);
      const timer = safetyFreezeTimers.get(requestId);
      if (timer !== undefined) window.clearTimeout(timer);
      safetyFreezeTimers.delete(requestId);
      if (safetyFreezes.size === 0) delete document.documentElement.dataset.scoringWorkerSafetyFreeze;
    };
    const invalidateAndReleaseSafetyFreeze = (requestId: string) => {
      safetyEpoch += 1;
      serviceWorker.controller?.postMessage({
        type: "MATCHDAY_SCORING_WORKER_SAFETY_INVALIDATED",
        protocolVersion: scoringWorkerUpdateProtocolVersion,
        epoch: safetyEpoch,
      });
      releaseSafetyFreeze(requestId);
    };
    const holdSafetyFreezeForActivation = (requestId: string) => {
      const timer = safetyFreezeTimers.get(requestId);
      if (timer !== undefined) window.clearTimeout(timer);
      safetyFreezeTimers.set(
        requestId,
        window.setTimeout(() => {
          invalidateAndReleaseSafetyFreeze(requestId);
          setUpdateState(scoringWorkerUpdateStates.blocked);
          scheduleUpdateCheck();
        }, 7_000),
      );
    };
    const blockInteractionWhileFrozen = (event: Event) => {
      if (safetyFreezes.size === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const coordinateUpdate = async () => {
      if (disposed || !registration?.waiting) return;
      setUpdateState(scoringWorkerUpdateStates.checking);
      const state = await requestWaitingScoringWorkerActivation();
      if (!disposed) {
        setUpdateState(state);
        if (state === "blocked" && registration?.waiting) {
          retryTimer = window.setTimeout(() => void coordinateUpdate(), 2_000);
        }
      }
    };
    const scheduleUpdateCheck = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void coordinateUpdate(), 50);
    };
    const answerSafetyQuery = (event: MessageEvent<unknown>) => {
      const message = event.data as {
        type?: string;
        requestId?: string;
        protocolVersion?: number;
        round?: number | "commit";
        expectedEpoch?: number | null;
        status?: string;
      } | null;
      if (message?.type === "MATCHDAY_SCORING_WORKER_ACTIVATION_RESULT" && typeof message.requestId === "string") {
        if (message.status === "committing") holdSafetyFreezeForActivation(message.requestId);
        else releaseSafetyFreeze(message.requestId);
        return;
      }
      if (
        message?.type !== "MATCHDAY_SCORING_WORKER_SAFE_STATE_QUERY" ||
        typeof message.requestId !== "string" ||
        message.protocolVersion !== scoringWorkerUpdateProtocolVersion
      ) {
        return;
      }
      const safety = readScoringWorkerClientSafety();
      if ((message.round === 1 || message.round === "commit") && safety.safe) {
        safetyFreezes.add(message.requestId);
        beginScoringWorkerSafetyFreeze(message.requestId);
        document.documentElement.dataset.scoringWorkerSafetyFreeze = "true";
        const existingTimer = safetyFreezeTimers.get(message.requestId);
        if (existingTimer !== undefined) window.clearTimeout(existingTimer);
        safetyFreezeTimers.set(
          message.requestId,
          window.setTimeout(() => invalidateAndReleaseSafetyFreeze(message.requestId as string), 7_000),
        );
      }
      const frozen = safetyFreezes.has(message.requestId);
      event.source?.postMessage({
        type: "MATCHDAY_SCORING_WORKER_SAFE_STATE",
        requestId: message.requestId,
        protocolVersion: scoringWorkerUpdateProtocolVersion,
        epoch: safetyEpoch,
        stable: message.round === 1 || message.round === "commit" || (frozen && message.expectedEpoch === safetyEpoch),
        frozen,
        ...safety,
      });
    };
    const controllerChanged = () => {
      safetyFreezes.clear();
      endAllScoringWorkerSafetyFreezes();
      for (const timer of safetyFreezeTimers.values()) window.clearTimeout(timer);
      safetyFreezeTimers.clear();
      delete document.documentElement.dataset.scoringWorkerSafetyFreeze;
      setUpdateState(scoringWorkerUpdateStates.activated);
    };
    const transitionChanged = () => {
      safetyEpoch += 1;
      serviceWorker.controller?.postMessage({
        type: "MATCHDAY_SCORING_WORKER_SAFETY_INVALIDATED",
        protocolVersion: scoringWorkerUpdateProtocolVersion,
        epoch: safetyEpoch,
      });
      for (const requestId of [...safetyFreezes]) releaseSafetyFreeze(requestId);
      scheduleUpdateCheck();
    };

    serviceWorker.addEventListener("message", answerSafetyQuery);
    serviceWorker.addEventListener("controllerchange", controllerChanged);
    window.addEventListener(scoringWorkerSafetyChangedEvent, transitionChanged);
    document.addEventListener("click", blockInteractionWhileFrozen, true);
    document.addEventListener("keydown", blockInteractionWhileFrozen, true);
    document.addEventListener("pointerdown", blockInteractionWhileFrozen, true);
    document.addEventListener("submit", blockInteractionWhileFrozen, true);
    observer = new MutationObserver((mutations) => {
      if (!mutations.some(mutationAffectsScoringWorkerSafety)) return;
      safetyEpoch += 1;
      serviceWorker.controller?.postMessage({
        type: "MATCHDAY_SCORING_WORKER_SAFETY_INVALIDATED",
        protocolVersion: scoringWorkerUpdateProtocolVersion,
        epoch: safetyEpoch,
      });
      scheduleUpdateCheck();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [
        scoringWorkerDomContract.writerStateAttribute,
        scoringWorkerDomContract.offlineStateAttribute,
        scoringWorkerDomContract.scoringPhaseAttribute,
      ],
      childList: true,
      subtree: true,
    });
    void registerServiceWorker(serviceWorker).then((nextRegistration) => {
      if (disposed || !nextRegistration) return;
      registration = nextRegistration;
      const watchInstallingWorker = () => {
        const installing = nextRegistration.installing;
        if (!installing || installingStateListeners.has(installing)) return;
        const stateChanged = () => {
          if (installing.state === "installed" && nextRegistration.waiting) scheduleUpdateCheck();
        };
        installingStateListeners.set(installing, stateChanged);
        installing.addEventListener("statechange", stateChanged);
      };
      registrationUpdateFound = watchInstallingWorker;
      nextRegistration.addEventListener("updatefound", watchInstallingWorker);
      watchInstallingWorker();
      if (nextRegistration.waiting) scheduleUpdateCheck();
    });

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      observer?.disconnect();
      safetyFreezes.clear();
      endAllScoringWorkerSafetyFreezes();
      for (const timer of safetyFreezeTimers.values()) window.clearTimeout(timer);
      safetyFreezeTimers.clear();
      delete document.documentElement.dataset.scoringWorkerSafetyFreeze;
      document.removeEventListener("click", blockInteractionWhileFrozen, true);
      document.removeEventListener("keydown", blockInteractionWhileFrozen, true);
      document.removeEventListener("pointerdown", blockInteractionWhileFrozen, true);
      document.removeEventListener("submit", blockInteractionWhileFrozen, true);
      if (registration && registrationUpdateFound) {
        registration.removeEventListener("updatefound", registrationUpdateFound);
      }
      for (const [worker, listener] of installingStateListeners) {
        worker.removeEventListener("statechange", listener);
      }
      serviceWorker.removeEventListener("message", answerSafetyQuery);
      serviceWorker.removeEventListener("controllerchange", controllerChanged);
      window.removeEventListener(scoringWorkerSafetyChangedEvent, transitionChanged);
    };
  }, []);

  return (
    <output className="visually-hidden" data-testid="scoring-worker-update-state" data-state={updateState}>
      {updateState}
    </output>
  );
}
