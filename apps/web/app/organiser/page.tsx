import type { Metadata } from "next";
import { ArrowRight, CalendarDots, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { InlineNotice, StatusLine } from "@/components/foundation/Primitives";
import { CompetitionSetupActions } from "@/components/phase4/setup/CompetitionSetupResume";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";

export const metadata: Metadata = {
  title: messages.organiser.title,
  robots: { index: false, follow: false },
};

export default async function OrganiserPage() {
  const session = demoFixturesEnabled() ? null : await readCurrentIdentitySession();
  const viewer = session?.status === "authenticated" ? session.identity : null;

  return (
    <ProductionShell
      kind="organiser"
      title={messages.organiser.title}
      subtitle={messages.organiser.subtitle}
      utility={
        <StatusLine tone="positive">
          {viewer ? `${viewer.displayName} · ${messages.organiser.liveStatus}` : messages.organiser.liveStatus}
        </StatusLine>
      }
    >
      <section className="operational-heading" aria-labelledby="organiser-summary">
        <p>{messages.organiser.summaryBody}</p>
        <h2 id="organiser-summary">{messages.organiser.summaryTitle}</h2>
        <CompetitionSetupActions
          accountId={viewer?.accountId ?? null}
          createLabel={messages.organiser.createCompetition}
        />
      </section>
      <div className="operational-divider" />
      <section className="operational-start" aria-labelledby="start-title">
        <div className="operational-start__heading">
          <CalendarDots aria-hidden="true" />
          <h2 id="start-title">{messages.organiser.startTitle}</h2>
        </div>
        <ol>
          {messages.organiser.startSteps.map((step, index) => (
            <li key={step}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p>{step}</p>
              <ArrowRight aria-hidden="true" />
            </li>
          ))}
        </ol>
        <InlineNotice title={messages.organiser.fixturesEmptyTitle}>
          <WarningCircle aria-hidden="true" /> {messages.organiser.fixturesEmpty}
        </InlineNotice>
      </section>
    </ProductionShell>
  );
}
