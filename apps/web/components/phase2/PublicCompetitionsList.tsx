import Link from "next/link";
import { ArrowRight, CalendarDots } from "@phosphor-icons/react/dist/ssr";
import { InlineNotice } from "@/components/foundation/Primitives";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { phase2Copy, type CompetitionSummaryView } from "@/lib/phase2";

export function PublicCompetitionsList({ competitions }: { competitions: CompetitionSummaryView[] }) {
  return (
    <div className="p2-public-list">
      <a className="skip-link" href="#public-list-main">
        {phase2Copy.skip}
      </a>
      <SiteHeader />
      <main id="public-list-main">
        <header className="p2-public-list__identity">
          <h1>{phase2Copy.publicListTitle}</h1>
          <p>{phase2Copy.publicListIntro}</p>
        </header>
        {competitions.length === 0 ? (
          <InlineNotice title={phase2Copy.emptyTitle}>{phase2Copy.publicListEmptyBody}</InlineNotice>
        ) : (
          <ul className="p2-public-list__grid">
            {competitions.map((competition) => (
              <li key={competition.id}>
                <Link href={`/competitions/${competition.slug}`}>
                  <p>
                    <CalendarDots aria-hidden="true" /> {competition.dateLabel}
                  </p>
                  <h2>{competition.name}</h2>
                  <span>{competition.sport}</span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
