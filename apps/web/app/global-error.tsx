"use client";

import { useEffect } from "react";
import { messages } from "@matchday/ui";
import { captureClientError } from "@/lib/sentry-client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    captureClientError(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="system-state">
          <section aria-labelledby="global-error-title">
            <p className="system-state__code">500</p>
            <h1 id="global-error-title">{messages.system.errorTitle}</h1>
            <p>{messages.system.errorBody}</p>
            <button className="foundation-action foundation-action--dark" type="button" onClick={reset}>
              {messages.system.retry}
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
