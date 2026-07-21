"use client";

import { useEffect } from "react";
import { interpolate, messages, opaqueId } from "@matchday/ui";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reference = error.digest ?? opaqueId("WEB-UNAVAILABLE");

  useEffect(() => {
    console.error("MATCHDAY route error", { reference });
  }, [reference]);

  return (
    <SystemStatePage
      kind="error"
      code="500"
      title={messages.system.errorTitle}
      body={messages.system.errorBody}
      detail={interpolate(messages.system.incident, { reference })}
      actionLabel={messages.system.retry}
      action={reset}
    />
  );
}
