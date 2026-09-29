"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { opaqueId } from "@matchday/ui";
import styles from "./PublicLiveRefresh.module.css";

export function PublicLiveRefresh({ slug }: { slug: string }) {
  const router = useRouter();
  const [connection, setConnection] = useState<"connected" | "reconnecting" | "stale">(opaqueId("reconnecting"));
  const lastVersion = useRef<string | null>(null);
  useEffect(() => {
    let lastContact = Date.now();
    const source = new EventSource(`/api/v1/public/competitions/${encodeURIComponent(slug)}/versions`);
    const onVersion = (event: MessageEvent<string>) => {
      lastContact = Date.now();
      setConnection(opaqueId("connected"));
      const version = JSON.parse(event.data) as string;
      if (lastVersion.current && lastVersion.current !== version) router.refresh();
      lastVersion.current = version;
    };
    source.addEventListener("version", onVersion as EventListener);
    source.addEventListener("unavailable", () => setConnection(opaqueId("stale")));
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
