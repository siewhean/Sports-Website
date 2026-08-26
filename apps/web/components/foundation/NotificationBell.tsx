"use client";

import Link from "next/link";
import { Bell } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { messages } from "@matchday/ui";

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetch("/api/notifications", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((page: { unreadCount?: unknown } | null) => {
          if (!cancelled) {
            setUnreadCount(typeof page?.unreadCount === "number" && page.unreadCount > 0 ? page.unreadCount : 0);
          }
        })
        .catch(() => {
          if (!cancelled) setUnreadCount(0);
        });
    };

    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <Link
      href="/notifications"
      aria-label={messages.notifications.title}
      className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white"
    >
      <Bell size={20} aria-hidden="true" />
      {unreadCount > 0 ? (
        <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-indigo-600 px-1 text-center text-[11px] font-semibold leading-5 text-white">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </Link>
  );
}
