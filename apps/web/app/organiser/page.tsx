import type { Metadata } from "next";
import { CalendarDots, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { ActionLink, InlineNotice, StatusLine } from "@/components/foundation/Primitives";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { organiserCompetitionLibraryCopy } from "@/lib/organiser-competition-library";

export const metadata: Metadata = {
  title: messages.organiser.title,
  robots: { index: false, follow: false },
};

export default function OrganiserPage() {
  return (
    <ProductionShell
      kind="organiser"
      title={messages.organiser.title}
      subtitle={messages.organiser.subtitle}
      utility={<StatusLine tone="warning">{messages.organiser.liveStatus}</StatusLine>}
    >
      <section className="operational-heading" aria-labelledby="organiser-summary">
        <p>{messages.organiser.summaryBody}</p>
        <h2 id="organiser-summary">{messages.organiser.summaryTitle}</h2>
        <ActionLink href="/organiser/competitions">{organiserCompetitionLibraryCopy.openLibrary}</ActionLink>
        <ActionLink href="/organiser/competitions/new">{messages.organiser.createCompetition}</ActionLink>
        {demoFixturesEnabled() ? <ActionLink href="/format">{messages.organiser.nextAction}</ActionLink> : null}
      </section>
      <div className="operational-divider" />
      <section className="operational-list" aria-labelledby="fixtures-title">
        <div>
          <CalendarDots aria-hidden="true" />
          <h2 id="fixtures-title">{messages.organiser.fixturesTitle}</h2>
        </div>
        <InlineNotice title={messages.organiser.fixturesEmpty}>
          <WarningCircle aria-hidden="true" /> {messages.organiser.fixturesEmpty}
        </InlineNotice>
      </section>
    </ProductionShell>
  );
}
