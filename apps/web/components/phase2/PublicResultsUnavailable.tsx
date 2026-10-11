"use client";

import { useEffect } from "react";
import { messages } from "@matchday/ui";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

const AUTO_RETRY_MS = 10_000;

/**
 * Friendly outage state for public results. Rendered by the `competitions` segment error boundary when the API is
 * rate limiting, failing or unreachable, so an outage is never mistaken for a missing competition (404). It keeps
 * retrying in the background while the tab is visible and as soon as the browser reports it is back online.
 */
export function PublicResultsUnavailable({ retry }: Readonly<{ retry: () => void }>) {
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) retry();
    }, AUTO_RETRY_MS);
    const onOnline = () => retry();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [retry]);

  return (
    <SystemStatePage
      kind="error"
      code="503"
      title={messages.publicCompetition.unavailableTitle}
      body={messages.publicCompetition.unavailableBody}
      detail={messages.publicCompetition.unavailableRetrying}
      actionLabel={messages.publicCompetition.unavailableRetry}
      action={retry}
    />
  );
}
