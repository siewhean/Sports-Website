"use client";

import { useCallback, useSyncExternalStore } from "react";
import { opaqueId } from "@matchday/ui";

const urlChangeEvent = "matchday-url-change";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(urlChangeEvent, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(urlChangeEvent, onChange);
  };
}

const readSearch = () => window.location.search;
// The server (and hydration) render always uses the default state; the real query string is applied right after.
const readServerSearch = () => "";

/**
 * Shareable view state kept in the query string without a server round trip: reading is hydration-safe via
 * useSyncExternalStore, and writes use the History API so the cached page HTML is never re-requested.
 */
export function useUrlSearch(): [search: string, navigate: (query: string, mode?: "push" | "replace") => void] {
  const search = useSyncExternalStore(subscribe, readSearch, readServerSearch);
  const navigate = useCallback((query: string, mode: "push" | "replace" = opaqueId("push")) => {
    const url = `${window.location.pathname}${query}${window.location.hash}`;
    if (mode === "replace") window.history.replaceState(window.history.state, "", url);
    else window.history.pushState(window.history.state, "", url);
    window.dispatchEvent(new Event(urlChangeEvent));
  }, []);
  return [search, navigate];
}
