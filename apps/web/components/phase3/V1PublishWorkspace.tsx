import { ActionLink } from "@/components/foundation/Primitives";
import { phase2Copy, type CompetitionView } from "@/lib/phase2";
import { v1PublicationReadiness } from "@/lib/v1-publication-readiness";

export function V1PublishWorkspace({ competition }: Readonly<{ competition: CompetitionView }>) {
  const readiness = v1PublicationReadiness(competition);
  return (
    <section className="p2-publish" aria-labelledby="v1-publish-title">
      <header>
        <div>
          <p className="p2-eyebrow">{phase2Copy.readiness}</p>
          <h2 id="v1-publish-title">{phase2Copy.publishTitle}</h2>
        </div>
        <span className={`p2-status-dot ${readiness.schedulePublished ? "is-positive" : "is-warning"}`}>
          {readiness.schedulePublished ? phase2Copy.published : phase2Copy.notPublished}
        </span>
      </header>

      <dl>
        <div>
          <dt>{phase2Copy.publicVersion}</dt>
          <dd>{competition.publishedVersionLabel ?? phase2Copy.notPublished}</dd>
        </div>
        <div>
          <dt>{phase2Copy.schedule}</dt>
          <dd>{readiness.scheduleVersion || phase2Copy.notPublished}</dd>
        </div>
        <div>
          <dt>{phase2Copy.results}</dt>
          <dd>{readiness.resultVersion || phase2Copy.notPublished}</dd>
        </div>
        <div>
          <dt>{phase2Copy.final}</dt>
          <dd>
            {readiness.finalMatches} / {readiness.totalMatches}
          </dd>
        </div>
      </dl>

      <div className="p2-readiness">
        <span
          className={`p2-status-dot ${readiness.tournamentComplete ? "is-positive" : "is-warning"}`}
          aria-hidden="true"
        />
        <strong>{readiness.tournamentComplete ? phase2Copy.allReady : phase2Copy.resultsIntro}</strong>
      </div>

      <div className="p2-section-actions">
        <ActionLink href={`/organiser/competitions/${competition.id}/schedule`}>{phase2Copy.schedule}</ActionLink>
        <ActionLink href={`/organiser/competitions/${competition.id}/results`} tone="light">
          {phase2Copy.results}
        </ActionLink>
        {readiness.publicAvailable ? (
          <ActionLink href={`/competitions/${competition.slug}`} tone="signal">
            {phase2Copy.openPublic}
          </ActionLink>
        ) : null}
      </div>
    </section>
  );
}
