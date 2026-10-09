"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { opaqueId } from "@matchday/ui";

/* ------------------------------------------------------------- connectivity ------------------------------------------------------------- */

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Browser connectivity, hydration-safe (assumes online until the client says otherwise). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/* ------------------------------------------------------------- high contrast ------------------------------------------------------------ */

const contrastKey = opaqueId("matchday.scorer.high-contrast");
const contrastEvent = "matchday-scorer-contrast";
let contrastMemory: boolean | null = null;

function readContrast(): boolean {
  if (contrastMemory !== null) return contrastMemory;
  try {
    return window.localStorage.getItem(contrastKey) === "1";
  } catch {
    return false;
  }
}

function subscribeContrast(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(contrastEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(contrastEvent, onChange);
  };
}

/** Glare mode for direct sunlight, remembered on this phone (falls back to memory if storage is blocked). */
export function useHighContrast(): [enabled: boolean, setEnabled: (value: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeContrast, readContrast, () => false);
  const setEnabled = useCallback((value: boolean) => {
    contrastMemory = value;
    try {
      if (value) window.localStorage.setItem(contrastKey, "1");
      else window.localStorage.removeItem(contrastKey);
    } catch {
      // Storage blocked: the in-memory value keeps the choice for this visit.
    }
    window.dispatchEvent(new Event(contrastEvent));
  }, []);
  return [enabled, setEnabled];
}

/* --------------------------------------------------------------- wake lock --------------------------------------------------------------- */

type WakeLockSentinelLike = { release(): Promise<void>; addEventListener(type: "release", listener: () => void): void };
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };

export type WakeLockState = "unsupported" | "active" | "released";

/**
 * Keeps the screen on while scoring. Browsers drop the lock when the tab is hidden, so it is re-requested on
 * return. Where the API is missing or refused the caller shows a plain fallback hint instead.
 */
export function useScreenWakeLock(active: boolean): WakeLockState {
  const [state, setState] = useState<WakeLockState>(opaqueId("released"));
  useEffect(() => {
    if (!active) return;
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    const request = async () => {
      if (!wakeLock) {
        setState(opaqueId("unsupported"));
        return;
      }
      if (document.visibilityState !== "visible" || sentinel) return;
      try {
        const next = await wakeLock.request(opaqueId("screen"));
        if (disposed) {
          void next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
        setState(opaqueId("active"));
        next.addEventListener("release", () => {
          sentinel = null;
          if (!disposed) setState(opaqueId("released"));
        });
      } catch {
        if (!disposed) setState(opaqueId("unsupported"));
      }
    };
    const kickoff = window.setTimeout(() => void request(), 0);
    const visible = () => void request();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      window.clearTimeout(kickoff);
      document.removeEventListener("visibilitychange", visible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
  return active ? state : opaqueId("released");
}
