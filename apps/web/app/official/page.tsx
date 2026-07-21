import type { Metadata } from "next";
import { CloudCheck, DeviceMobileCamera } from "@phosphor-icons/react/dist/ssr";
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
        <DeviceMobileCamera aria-hidden="true" />
        <h2 id="official-access-title">{messages.official.accessAction}</h2>
        <p>{messages.official.subtitle}</p>
        <ActionLink href="/score" tone="signal">
          {messages.official.accessAction}
        </ActionLink>
        <StatusLine tone="positive">
          <CloudCheck aria-hidden="true" /> {messages.official.offlineReady}
        </StatusLine>
      </section>
    </ProductionShell>
  );
}
