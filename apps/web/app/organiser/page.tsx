import type { Metadata } from "next";
import { CalendarDots, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { ActionLink, InlineNotice, StatusLine } from "@/components/foundation/Primitives";
import { getOrganiserCompetitions } from "@/lib/organiser-competitions.server";

export const metadata: Metadata = {
  title: messages.organiser.title,
  robots: { index: false, follow: false },
};

export default async function OrganiserPage() {
  const result = await getOrganiserCompetitions();
  return (
    <ProductionShell
      kind="organiser"
      title={messages.organiser.title}
      subtitle={messages.organiser.subtitle}
      utility={<StatusLine tone="warning">{messages.organiser.liveStatus}</StatusLine>}
    >
      <section className="operational-heading" aria-labelledby="organiser-summary">
        <p>{messages.organiser.competitionsIntro}</p>
        <h2 id="organiser-summary">{messages.organiser.yourCompetitions}</h2>
        <ActionLink href="/organiser/competitions/new">{messages.organiser.createCompetition}</ActionLink>
      </section>
      <div className="operational-divider" />
      <section className="operational-list" aria-labelledby="competitions-title">
        <div>
          <CalendarDots aria-hidden="true" />
          <h2 id="competitions-title">{messages.organiser.yourCompetitions}</h2>
        </div>
        {result.state === "ready" && result.competitions.length > 0 ? (
          <ul>
            {result.competitions.map((competition) => (
              <li key={competition.id}>
                <strong>{competition.name}</strong>
                <span>{competition.organisation_name}</span>
                <ActionLink href={`/organiser/competitions/${encodeURIComponent(competition.id)}`}>
                  {messages.organiser.openCompetition}
                </ActionLink>
              </li>
            ))}
          </ul>
        ) : (
          <InlineNotice
            title={
              result.state === "error" ? messages.organiser.competitionsUnavailable : messages.organiser.noCompetitions
            }
          >
            <WarningCircle aria-hidden="true" />{" "}
            {result.state === "error" ? messages.organiser.competitionsUnavailable : messages.organiser.noCompetitions}
          </InlineNotice>
        )}
      </section>
    </ProductionShell>
  );
}
