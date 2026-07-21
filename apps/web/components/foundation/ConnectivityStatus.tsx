"use client";

import { useEffect, useState } from "react";
import { messages, opaqueId } from "@matchday/ui";
import { InlineNotice } from "./Primitives";

type ConnectionState = "live" | "polling" | "offline" | "restored";

export function ConnectivityStatus() {
  const [state, setState] = useState<ConnectionState>(opaqueId("live"));

  useEffect(() => {
    let pollingTimer: number | undefined;

    const stopPolling = () => {
      if (pollingTimer) window.clearInterval(pollingTimer);
      pollingTimer = undefined;
    };
    const startPolling = () => {
      stopPolling();
      pollingTimer = window.setInterval(() => {
        window.dispatchEvent(new CustomEvent("matchday:public-refresh"));
      }, 30_000);
    };
    const goOffline = () => {
      setState(opaqueId("offline"));
      stopPolling();
    };
    const goOnline = () => {
      setState(opaqueId("restored"));
      stopPolling();
      window.setTimeout(() => setState(opaqueId("live")), 2_000);
    };
    const realtimeFailure = () => {
      if (!navigator.onLine) return;
      setState(opaqueId("polling"));
      startPolling();
    };

    if (!navigator.onLine) goOffline();
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    window.addEventListener("matchday:realtime-failed", realtimeFailure);
    return () => {
      stopPolling();
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("matchday:realtime-failed", realtimeFailure);
    };
  }, []);

  if (state === "live") return null;
  const copy =
    state === "offline"
      ? messages.public.offline
      : state === "polling"
        ? messages.public.polling
        : messages.public.restored;
  const title =
    state === "offline"
      ? messages.public.offlineTitle
      : state === "polling"
        ? messages.public.pollingTitle
        : messages.public.restoredTitle;
  return <InlineNotice title={title}>{copy}</InlineNotice>;
}
