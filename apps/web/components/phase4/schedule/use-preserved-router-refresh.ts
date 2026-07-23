"use client";

import { useCallback, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

export function usePreservedRouterRefresh() {
  const router = useRouter();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [refreshing, startRefresh] = useTransition();

  const refresh = useCallback(() => {
    const left = window.scrollX;
    const top = window.scrollY;
    startRefresh(() => router.refresh());
    window.requestAnimationFrame(() => {
      window.scrollTo({ left, top, behavior: "auto" });
      statusRef.current?.focus({ preventScroll: true });
    });
  }, [router]);

  return { statusRef, refreshing, refresh } as const;
}
