import type { ReactNode } from "react";

import { phase2Copy, type CompetitionView } from "@/lib/phase2";
import { v1PublicationReadiness } from "@/lib/v1-publication-readiness";

export function V1ResultsWorkspace({
  competition,
  children,
}: Readonly<{ competition: CompetitionView; children: ReactNode }>) {
  const readiness = v1PublicationReadiness(competition);
  return (
    <>
      <section className="p2-data-section" aria-labelledby="v1-results-progress-title">
        <header>
          <div>
            <p className="p2-eyebrow">{phase2Copy.readiness}</p>
            <h2 id="v1-results-progress-title">{phase2Copy.resultsTitle}</h2>
          </div>
        </header>
        <dl className="p2-publish">
          <div>
            <dt>{phase2Copy.matchesLabel}</dt>
            <dd>{readiness.totalMatches}</dd>
          </div>
          <div>
            <dt>{phase2Copy.final}</dt>
            <dd>
              {readiness.finalMatches} / {readiness.totalMatches}
            </dd>
          </div>
          <div>
            <dt>{phase2Copy.publicLive}</dt>
            <dd>{readiness.liveMatches}</dd>
          </div>
          <div>
            <dt>{phase2Copy.publicScheduled}</dt>
            <dd>{readiness.scheduledMatches}</dd>
          </div>
        </dl>
        <div className="p2-readiness">
          <span className={`p2-status-dot ${readiness.tournamentComplete ? "is-positive" : "is-warning"}`} aria-hidden="true" />
          <strong>{readiness.tournamentComplete ? phase2Copy.allReady : phase2Copy.resultsIntro}</strong>
        </div>
      </section>
      {children}
    </>
  );
}
