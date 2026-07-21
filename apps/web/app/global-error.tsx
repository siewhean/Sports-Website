"use client";

import { messages } from "@matchday/ui";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
