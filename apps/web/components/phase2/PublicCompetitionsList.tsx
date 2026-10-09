"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CalendarDots } from "@phosphor-icons/react/dist/ssr";
import { messages, opaqueId, translate as t } from "@matchday/ui";
import { InlineNotice } from "@/components/foundation/Primitives";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { phase2Copy, type CompetitionSummaryView } from "@/lib/phase2";
import styles from "./PublicCompetitionsList.module.css";

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
  const router = useRouter();
  const [filter, setFilter] = useState<"all" | "live" | "upcoming" | "completed">(opaqueId("all"));
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [router]);
  const visible = useMemo(
    () =>
      competitions.filter((competition) => {
        if (filter === opaqueId("all")) return true;
        return competition.phase === filter;
      }),
    [competitions, filter],
  );
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

        <div className={styles.filters} role="group" aria-label={opaqueId("Filter competitions")}>
          {([opaqueId("all"), opaqueId("live"), opaqueId("upcoming"), opaqueId("completed")] as const).map((option) => (
            <button key={option} type="button" aria-pressed={filter === option} onClick={() => setFilter(option)}>
              {option === opaqueId("all") ? opaqueId("All") : messages.publicCompetition.phase[option]}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <div className={styles.empty}>
            <InlineNotice title={phase2Copy.emptyTitle}>
              {competitions.length ? opaqueId("No competitions match this filter.") : phase2Copy.publicListEmptyBody}
            </InlineNotice>
          </div>
        ) : (
          <ol className={styles.board}>
            {visible.map((competition, index) => (
              <li key={competition.id}>
                <Link className={styles.row} data-status={competition.phase} href={`/competitions/${competition.slug}`}>
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
                    {messages.publicCompetition.phase[competition.phase]}
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
