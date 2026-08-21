import Link from "next/link";
import { ArrowRight, CalendarDots } from "@phosphor-icons/react/dist/ssr";
import { translate as t } from "@matchday/ui";
import { InlineNotice } from "@/components/foundation/Primitives";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { phase2Copy, type CompetitionSummaryView } from "@/lib/phase2";
import styles from "./PublicCompetitionsList.module.css";

const statusLabels: Record<CompetitionSummaryView["status"], string> = {
  active: t("prototype.92340695899b"),
  published: t("prototype.92340695899b"),
  live: t("prototype.92340695899b"),
  completed: t("prototype.22a970d2e5b1"),
  archived: t("prototype.bdb86505f806"),
};

type PublicCompetitionsViewer = Readonly<{
  displayName: string;
}>;

export function PublicCompetitionsList({
  competitions,
  viewer = null,
}: {
  competitions: CompetitionSummaryView[];
  viewer?: PublicCompetitionsViewer | null;
}) {
  return (
    <div className={styles.page}>
      <a className="skip-link" href="#public-list-main">
        {phase2Copy.skip}
      </a>
      <SiteHeader viewer={viewer} />
      <main className={styles.main} id="public-list-main">
        <header className={styles.intro}>
          <div>
            <h1>{phase2Copy.publicListTitle}</h1>
            <p>{phase2Copy.publicListIntro}</p>
          </div>
          <dl className={styles.followGuide} aria-label={t("prototype.35d3447355e9")}>
            <div>
              <dt>{t("prototype.f4830a1dae29")}</dt>
              <dd>{t("prototype.ad58797f3416")}</dd>
            </div>
            <div>
              <dt>{t("prototype.219c4a6c86a7")}</dt>
              <dd>{t("prototype.14a3ee805424")}</dd>
            </div>
            <div>
              <dt>{t("prototype.c7342049e69b")}</dt>
              <dd>{t("prototype.21a980b8febb")}</dd>
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
                <Link
                  className={styles.row}
                  data-status={competition.status}
                  href={`/competitions/${competition.slug}`}
                >
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
                    <span>{t("prototype.75e5907f069f")}</span>
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
