"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompetitionView } from "@/lib/phase2";
import { changedMatchIds, scoreChanges, type ScoreChange } from "@/lib/public-competition-model";
import {
  fetchPublicSnapshot,
  liveConnection,
  liveContactTimeoutMs,
  type LiveConnection,
} from "@/lib/public-live-snapshot";

/** How often the status is re-evaluated and, without a stream, how often the snapshot is polled. */
const tickMs = 5_000;
/** How long a changed score keeps its highlight. */
const highlightMs = 2_500;

export type LiveCompetitionState = Readonly<{
  view: CompetitionView;
  connection: LiveConnection;
  /** Epoch ms of the last confirmed-fresh data, or null before the first sync. */
  lastSyncedAt: number | null;
  /** Match ids whose score just changed (cleared after a short highlight). */
  changed: ReadonlySet<string>;
}>;

/**
 * Keeps a public competition view current without reloading the page: the version stream (SSE) says *when*
 * something changed, the same-origin snapshot endpoint supplies *what* changed (ETag-revalidated JSON).
 * If the stream is silent for too long we poll the snapshot instead, and the status says so honestly.
 */
export function useLiveCompetition(
  initial: CompetitionView,
  enabled: boolean,
  onScoreChanges?: (changes: readonly ScoreChange[], previous: CompetitionView, next: CompetitionView) => void,
): LiveCompetitionState {
  const [view, setView] = useState(initial);
  const [lastContactAt, setLastContactAt] = useState<number | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [online, setOnline] = useState(true);
  const [now, setNow] = useState(0);
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set());
  const viewRef = useRef(initial);
  const onChangesRef = useRef(onScoreChanges);
  const slug = initial.slug;

  useEffect(() => {
    onChangesRef.current = onScoreChanges;
  }, [onScoreChanges]);

  const apply = useCallback((next: CompetitionView) => {
    const previous = viewRef.current;
    viewRef.current = next;
    setView(next);
    const ids = changedMatchIds(previous, next);
    if (ids.length > 0) setChanged(new Set(ids));
    const changes = scoreChanges(previous, next, () => true);
    if (changes.length > 0) onChangesRef.current?.(changes, previous, next);
  }, []);

  useEffect(() => {
    if (changed.size === 0) return;
    const timer = window.setTimeout(() => setChanged(new Set()), highlightMs);
    return () => window.clearTimeout(timer);
  }, [changed]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let etag: string | null = null;
    let lastVersion: string | null = null;
    let contactAt = 0;
    let inFlight: AbortController | null = null;
    let syncAgain = false;
    const kickoff = window.setTimeout(() => {
      setOnline(navigator.onLine);
      setNow(Date.now());
    }, 0);

    const touch = () => {
      contactAt = Date.now();
      setLastContactAt(contactAt);
    };
    const confirmFresh = () => {
      touch();
      setLastSyncedAt(Date.now());
    };

    const sync = async (): Promise<void> => {
      if (disposed) return;
      if (inFlight) {
        syncAgain = true;
        return;
      }
      const controller = new AbortController();
      inFlight = controller;
      try {
        const result = await fetchPublicSnapshot(slug, etag, { signal: controller.signal });
        if (disposed) return;
        if (result.status === "updated") {
          etag = result.etag;
          apply(result.competition);
        }
        // Unavailable / not found: keep the last good data; the status turns "reconnecting" on its own.
        if (result.status === "updated" || result.status === "not_modified") confirmFresh();
      } catch {
        // Aborted on unmount.
      } finally {
        if (inFlight === controller) inFlight = null;
        if (syncAgain && !disposed) {
          syncAgain = false;
          void sync();
        }
      }
    };

    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      source = new EventSource(`/api/v1/public/competitions/${encodeURIComponent(slug)}/versions`);
      source.addEventListener("version", ((event: MessageEvent<string>) => {
        let version: unknown;
        try {
          version = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof version !== "string") return;
        touch();
        if (lastVersion === version) {
          setLastSyncedAt(Date.now());
          return;
        }
        lastVersion = version;
        void sync();
      }) as EventListener);
      source.addEventListener("heartbeat", touch);
      source.addEventListener("unavailable", () => {
        source?.close();
        source = null;
      });
    }

    // The page HTML may come from a shared cache, so confirm freshness once straight away.
    void sync();

    const tick = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState !== "visible") return;
      if (Date.now() - contactAt > liveContactTimeoutMs - tickMs) void sync();
    }, tickMs);
    const goOnline = () => {
      setOnline(true);
      void sync();
    };
    const goOffline = () => setOnline(false);
    const visible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      window.clearTimeout(kickoff);
      inFlight?.abort();
      source?.close();
      window.clearInterval(tick);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [apply, enabled, slug]);

  const connection = liveConnection({ enabled, online, lastContactAt, lastSyncedAt, now });
  return { view, connection, lastSyncedAt, changed };
}
