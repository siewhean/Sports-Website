"use client";

import { useCallback, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

export function usePreservedRouterRefresh() {
  const router = useRouter();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const pendingPosition = useRef<Readonly<{ left: number; top: number }> | null>(null);
  const [refreshing, startRefresh] = useTransition();

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
