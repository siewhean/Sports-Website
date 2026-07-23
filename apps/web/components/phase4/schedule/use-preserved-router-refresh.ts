"use client";

import { useCallback, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

const navigationAnnouncementKey = "matchday.schedule.navigation-announcement";

export function storeScheduleNavigationAnnouncement(message: string): void {
  window.sessionStorage.setItem(navigationAnnouncementKey, message);
}

export function usePreservedRouterRefresh() {
  const router = useRouter();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const pendingPosition = useRef<Readonly<{ left: number; top: number }> | null>(null);
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    const announcement = window.sessionStorage.getItem(navigationAnnouncementKey);
    if (!announcement || !statusRef.current) return;
    window.sessionStorage.removeItem(navigationAnnouncementKey);
    statusRef.current.textContent = announcement;
    statusRef.current.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (refreshing || !pendingPosition.current) return;
    const position = pendingPosition.current;
    pendingPosition.current = null;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ ...position, behavior: "auto" });
      statusRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [refreshing]);

  const refresh = useCallback(() => {
    pendingPosition.current = { left: window.scrollX, top: window.scrollY };
    startRefresh(() => router.refresh());
  }, [router]);

  return { statusRef, refreshing, refresh } as const;
}
