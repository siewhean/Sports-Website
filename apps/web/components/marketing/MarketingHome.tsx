import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, Broadcast, CalendarDots } from "@phosphor-icons/react/dist/ssr";
import { messages } from "@matchday/ui";
import type { CompetitionSummaryView } from "@/lib/phase2";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { SportsBanner } from "./SportsBanner";
import styles from "./MarketingHome.module.css";

export function MarketingHome({
  viewer = null,
  competitions = [],
}: {
  viewer?: { displayName: string } | null;
  competitions?: CompetitionSummaryView[];
}) {
  const live = competitions.filter((competition) => competition.status === "live");
  const upcoming = competitions.filter(
    (competition) => competition.status === "active" || competition.status === "published",
  );
  const featured = (live.length ? live : upcoming).slice(0, 3);

  return (
    <div className={styles.page}>
      <a className="skip-link" href="#main-content">
        {messages.navigation.skip}
      </a>
      <SiteHeader viewer={viewer} />
      <main id="main-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="home-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>{messages.home.eyebrow}</p>
            <h1 id="home-title">
              {messages.home.titleStart}
              <br />
              <span>{messages.home.titleEnd}</span>
            </h1>
            <p className={styles.summary}>{messages.home.summary}</p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryAction} href="/competitions">
                {messages.navigation.viewResults}
                <ArrowUpRight aria-hidden="true" />
              </Link>
              <Link className={styles.secondaryAction} href="/play">
                {messages.navigation.play}
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
          </div>
          <div className={styles.heroVisual} aria-hidden="true">
            <Image src="/images/venue-arc.svg" alt="" fill priority sizes="(max-width: 760px) 100vw, 52vw" />
          </div>
          <SportsBanner />
        </section>

        <section className={styles.section} aria-labelledby="journey-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>01 / {messages.navigation.journeys}</p>
            <h2 id="journey-title">{messages.home.journeyTitle}</h2>
            <p>{messages.home.journeyIntro}</p>
          </div>
          <div className={styles.journeys}>
            {messages.home.journeys.map((journey, index) => (
              <Link href={journey.href} className={styles.journey} key={journey.href}>
                <span className={styles.journeyIndex}>{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{journey.title}</strong>
                  <small>{journey.detail}</small>
                </span>
                <ArrowUpRight aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>

        <section className={`${styles.section} ${styles.liveSection}`} aria-labelledby="live-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>02 / {messages.navigation.viewResults}</p>
            <h2 id="live-title">{messages.home.liveTitle}</h2>
            <Link className={styles.textLink} href="/competitions">
              {messages.home.liveViewAll}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </div>
          {featured.length ? (
            <ol className={styles.events}>
              {featured.map((competition) => (
                <li key={competition.id}>
                  <Link href={`/competitions/${competition.slug}`}>
                    <span className={styles.eventStatus} data-live={competition.status === "live"}>
                      {competition.status === "live" ? (
                        <Broadcast aria-hidden="true" />
                      ) : (
                        <CalendarDots aria-hidden="true" />
                      )}
                      {competition.status === "live" ? messages.home.liveStatus : messages.home.nextStatus}
                    </span>
                    <strong>{competition.name}</strong>
                    <span className={styles.eventMeta}>
                      {competition.sport} · {competition.dateLabel}
                    </span>
                    <ArrowUpRight className={styles.eventArrow} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.empty}>{messages.home.liveEmpty}</p>
          )}
        </section>

        <section className={`${styles.section} ${styles.sports}`} aria-labelledby="sports-title">
          <p className={styles.kicker}>03 / {messages.home.marqueeLabel}</p>
          <h2 id="sports-title">{messages.home.sportsTitle}</h2>
          <ul>
            {messages.home.marqueeItems.map((sport) => (
              <li key={sport}>{sport}</li>
            ))}
          </ul>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
