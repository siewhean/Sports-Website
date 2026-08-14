import type { Metadata } from "next";
import { ArrowRight, CloudCheck, DeviceMobileCamera } from "@phosphor-icons/react/dist/ssr";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { ActionLink, StatusLine } from "@/components/foundation/Primitives";

export const metadata: Metadata = {
  title: messages.official.title,
  robots: { index: false, follow: false },
};

export default function OfficialPage() {
  return (
    <ProductionShell
      kind="official"
      title={messages.official.title}
      subtitle={messages.official.subtitle}
      utility={<StatusLine tone="positive">{messages.official.status}</StatusLine>}
    >
      <section className="official-access" aria-labelledby="official-access-title">
        <div className="official-access__eyebrow">
          <DeviceMobileCamera aria-hidden="true" />
          <span>{messages.official.status}</span>
        </div>
        <h2 id="official-access-title">{messages.official.accessAction}</h2>
        <p>{messages.official.accessGuide}</p>
        <ActionLink href="/score" tone="signal">
          {messages.official.accessAction}
        </ActionLink>
        <ol>
          {messages.official.accessSteps.map((step, index) => (
            <li key={step}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p>{step}</p>
              <ArrowRight aria-hidden="true" />
            </li>
          ))}
        </ol>
        <StatusLine tone="positive">
          <CloudCheck aria-hidden="true" /> {messages.official.offlineReady}
        </StatusLine>
      </section>
    </ProductionShell>
  );
}
