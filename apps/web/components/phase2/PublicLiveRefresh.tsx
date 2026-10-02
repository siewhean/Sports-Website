"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { opaqueId } from "@matchday/ui";
import styles from "./PublicLiveRefresh.module.css";

export function PublicLiveRefresh({ slug }: { slug: string }) {
  const router = useRouter();
  const [connection, setConnection] = useState<"connected" | "reconnecting" | "stale">(opaqueId("reconnecting"));
  useEffect(() => {
    let lastContact = Date.now();
    let lastVersion: string | null = null;
    const source = new EventSource(`/api/v1/public/competitions/${encodeURIComponent(slug)}/versions`);
    const onContact = () => {
      lastContact = Date.now();
      setConnection(opaqueId("connected"));
    };
    const onVersion = (event: MessageEvent<string>) => {
      try {
        const version: unknown = JSON.parse(event.data);
        if (typeof version !== "string") return;
        onContact();
        if (lastVersion && lastVersion !== version) router.refresh();
        lastVersion = version;
      } catch {
        setConnection(opaqueId("reconnecting"));
      }
    };
    source.addEventListener("version", onVersion as EventListener);
    source.addEventListener("heartbeat", onContact);
    source.addEventListener("reconnect", () => setConnection(opaqueId("reconnecting")));
    source.addEventListener("unavailable", () => {
      source.close();
      setConnection(opaqueId("stale"));
    });
    source.onerror = () => setConnection(opaqueId("reconnecting"));
    const poll = window.setInterval(() => {
      if (Date.now() - lastContact > 12_000) {
        setConnection(opaqueId("stale"));
        router.refresh();
      }
    }, 5_000);
    const onOnline = () => {
      setConnection(opaqueId("reconnecting"));
      router.refresh();
    };
    window.addEventListener("online", onOnline);
    return () => {
      source.close();
      window.clearInterval(poll);
      window.removeEventListener("online", onOnline);
    };
  }, [router, slug]);
  return (
    <p className={styles.status} role="status" data-connection={connection}>
      <span aria-hidden="true" />
      {connection === opaqueId("connected")
        ? opaqueId("Live updates connected")
        : connection === opaqueId("stale")
          ? opaqueId("Updates delayed. Refreshing results…")
          : opaqueId("Reconnecting to live results…")}
    </p>
  );
}
