import Link from "next/link";
import {
  organiserCompetitionDateRange,
  organiserCompetitionGroups,
  organiserCompetitionLibraryCopy,
  organiserCompetitionPhaseCopy,
  organiserCompetitionPrimaryAction,
  organiserCompetitionRoleLabel,
  organiserCompetitionSportName,
  organiserCompetitionUpdatedLabel,
  type OrganiserCompetitionLibraryItem,
} from "@/lib/organiser-competition-library";
import styles from "./OrganiserCompetitionLibrary.module.css";

export function OrganiserCompetitionLibrary({
  competitions,
}: {
  competitions: readonly OrganiserCompetitionLibraryItem[];
}) {
  if (competitions.length === 0) {
    return (
      <section className={styles.empty} aria-labelledby="competition-library-empty-title">
        <h2 id="competition-library-empty-title">{organiserCompetitionLibraryCopy.emptyTitle}</h2>
        <p>{organiserCompetitionLibraryCopy.emptyBody}</p>
        <Link className={styles.primaryAction} href="/organiser/competitions/new">
          {organiserCompetitionLibraryCopy.createCompetition}
        </Link>
      </section>
    );
  }

  return (
    <div className={styles.library}>
      <div className={styles.toolbar}>
        <Link className={styles.primaryAction} href="/organiser/competitions/new">
          {organiserCompetitionLibraryCopy.createCompetition}
        </Link>
      </div>

      {organiserCompetitionGroups(competitions).map((group) => {
        if (group.items.length === 0) return null;
        const copy = organiserCompetitionPhaseCopy(group.phase);
        return (
          <section className={styles.group} key={group.phase} aria-labelledby={`competition-group-${group.phase}`}>
            <div className={styles.groupHeading}>
              <div>
                <h2 id={`competition-group-${group.phase}`}>{copy.title}</h2>
                <p>{copy.description}</p>
              </div>
              <span className={styles.count}>{group.items.length}</span>
            </div>

            <div className={styles.grid}>
              {group.items.map((competition) => {
                const primary = organiserCompetitionPrimaryAction(competition);
                return (
                  <article className={styles.card} key={competition.id}>
                    <div className={styles.cardTopline}>
                      <span className={styles.status} data-status={group.phase}>
                        {competition.published
                          ? organiserCompetitionLibraryCopy.published
                          : organiserCompetitionLibraryCopy.privateDraft}
                      </span>
                      <span className={styles.role}>{organiserCompetitionRoleLabel(competition)}</span>
                    </div>

                    <div className={styles.cardHeading}>
                      <h3>{competition.name}</h3>
                      <p>{competition.organisationName}</p>
                    </div>

                    <dl className={styles.meta}>
                      <div>
                        <dt>{organiserCompetitionLibraryCopy.sportLabel}</dt>
                        <dd>{organiserCompetitionSportName(competition.sportCode)}</dd>
                      </div>
                      <div>
                        <dt>{organiserCompetitionLibraryCopy.dateLabel}</dt>
                        <dd>{organiserCompetitionDateRange(competition)}</dd>
                      </div>
                      <div>
                        <dt>{organiserCompetitionLibraryCopy.organisationLabel}</dt>
                        <dd>{competition.organisationName}</dd>
                      </div>
                    </dl>

                    <p className={styles.updated}>{organiserCompetitionUpdatedLabel(competition)}</p>

                    <div className={styles.actions}>
                      <Link className={styles.primaryAction} href={primary.href}>
                        {primary.label}
                      </Link>
                      {competition.published ? (
                        <Link
                          className={styles.secondaryAction}
                          href={`/competitions/${encodeURIComponent(competition.slug)}`}
                        >
                          {organiserCompetitionLibraryCopy.viewPublicPage}
                        </Link>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
