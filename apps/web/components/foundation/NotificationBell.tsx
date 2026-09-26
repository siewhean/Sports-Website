"use client";

import Link from "next/link";
import { Bell } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { messages } from "@matchday/ui";
import { gateCC4Http } from "@/lib/gate-c-c4-http";

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetch("/api/notifications", { cache: gateCC4Http.cacheNoStore })
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
    <Link href="/notifications" aria-label={messages.notifications.title} className="notification-bell">
      <Bell size={20} aria-hidden="true" />
      {unreadCount > 0 ? (
        <span className="notification-bell__badge">
          {unreadCount > 99 ? messages.notifications.overflowCount : unreadCount}
        </span>
      ) : null}
    </Link>
  );
}
