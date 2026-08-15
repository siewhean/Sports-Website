import Link from "next/link";
import { ArrowRight, CalendarDots } from "@phosphor-icons/react/dist/ssr";
import { InlineNotice } from "@/components/foundation/Primitives";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { phase2Copy, type CompetitionSummaryView } from "@/lib/phase2";
import styles from "./PublicCompetitionsList.module.css";

const statusLabels: Record<CompetitionSummaryView["status"], string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

export function PublicCompetitionsList({ competitions }: { competitions: CompetitionSummaryView[] }) {
  return (
    <div className={styles.page}>
      <a className="skip-link" href="#public-list-main">
        {phase2Copy.skip}
      </a>
      <SiteHeader />
      <main className={styles.main} id="public-list-main">
        <header className={styles.intro}>
          <div>
            <h1>{phase2Copy.publicListTitle}</h1>
            <p>{phase2Copy.publicListIntro}</p>
          </div>
          <dl className={styles.followGuide} aria-label="What you can follow in each competition">
            <div>
              <dt>Schedule</dt>
              <dd>Published fixtures and start times</dd>
            </div>
            <div>
              <dt>Results</dt>
              <dd>Live and final match scores</dd>
            </div>
            <div>
              <dt>Standings</dt>
              <dd>Table positions as results land</dd>
            </div>
          </dl>
        </header>

        {competitions.length === 0 ? (
          <div className={styles.empty}>
            <InlineNotice title={phase2Copy.emptyTitle}>{phase2Copy.publicListEmptyBody}</InlineNotice>
          </div>
        ) : (
          <ol className={styles.board}>
            {competitions.map((competition, index) => (
              <li key={competition.id}>
                <Link className={styles.row} data-status={competition.status} href={`/competitions/${competition.slug}`}>
                  <span className={styles.index} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className={styles.identity}>
                    <span className={styles.date}>
                      <CalendarDots aria-hidden="true" />
                      {competition.dateLabel}
                    </span>
                    <strong>{competition.name}</strong>
                    <span className={styles.sport}>{competition.sport}</span>
                  </span>
                  <span className={styles.status}>
                    <span aria-hidden="true" />
                    {statusLabels[competition.status]}
                  </span>
                  <span className={styles.destination}>
                    <span>Schedule · results · standings</span>
                    <ArrowRight aria-hidden="true" />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
