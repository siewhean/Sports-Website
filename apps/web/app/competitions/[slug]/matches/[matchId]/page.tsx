import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { interpolate, messages, opaqueId } from "@matchday/ui";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { PublicLiveRefresh } from "@/components/phase2/PublicLiveRefresh";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { publicCompetitionPhase } from "@/lib/phase2-public-phase";
import { getCompetitionView } from "@/lib/phase2-public.server";
import styles from "./page.module.css";

type Params = Promise<{ slug: string; matchId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, matchId } = await params;
  const competition = await getCompetitionView(slug).catch(() => null);
  const match = competition?.publicDivisions
    ?.flatMap((division) => division.matches)
    .find((candidate) => candidate.id === matchId);
  return match
    ? {
        title: interpolate(messages.publicCompetition.matchPageTitle, {
          home: match.home,
          away: match.away,
          competition: competition?.name ?? "",
        }),
      }
    : {};
}

export default async function PublicMatchPage({ params }: { params: Params }) {
  const { slug, matchId } = await params;
  const competition = await getCompetitionView(slug);
  if (!competition) notFound();
  const division = competition.publicDivisions?.find((item) =>
    item.matches.some((candidate) => candidate.id === matchId),
  );
  const match = division?.matches.find((candidate) => candidate.id === matchId);
  if (!match || !division) notFound();
  // Never advertise a match as live once its competition has finished (stale in-progress results).
  const phase = publicCompetitionPhase(
    {
      status: competition.status ?? "published",
      startsOn: competition.startsOn,
      endsOn: competition.endsOn,
      timezone: competition.timezone,
      hasLiveMatch: match.status === "live",
    },
    new Date(),
  );
  const showLive = match.status === "live" && phase === "live";
  const recordedTime =
    match.recordedTimeSeconds == null
      ? null
      : `${String(Math.floor(match.recordedTimeSeconds / 60)).padStart(2, "0")}:${String(match.recordedTimeSeconds % 60).padStart(2, "0")}`;
  return (
    <div className={styles.page}>
      <a className="skip-link" href="#match-main">
        {opaqueId("Skip to match")}
      </a>
      <SiteHeader />
      <main className={styles.main} id="match-main">
        <Link className={styles.back} href={`/competitions/${slug}`}>
          ← {competition.name}
        </Link>
        <header className={styles.heading}>
          <p>
            {competition.sport} · {division.division.name} · {match.stage}
          </p>
          <h1>{interpolate(messages.publicCompetition.versus, { home: match.home, away: match.away })}</h1>
          {!demoFixturesEnabled() ? <PublicLiveRefresh slug={slug} /> : null}
        </header>
        <section
          className={styles.scoreboard}
          aria-label={opaqueId("Current match score")}
          data-status={match.status === "live" && !showLive ? "stale" : match.status}
        >
          <div className={styles.meta}>
            <span>
              {showLive
                ? opaqueId("Live")
                : match.status === "final"
                  ? opaqueId("Final")
                  : match.status === "live"
                    ? opaqueId("Last recorded score")
                    : opaqueId("Scheduled")}
            </span>
            <span>{match.label}</span>
          </div>
          <div className={styles.side}>
            <span>{match.home}</span>
            <strong>{match.homeScore ?? "—"}</strong>
          </div>
          <div className={styles.side}>
            <span>{match.away}</span>
            <strong>{match.awayScore ?? "—"}</strong>
          </div>
        </section>
        <dl className={styles.details}>
          <div>
            <dt>{opaqueId("Stage")}</dt>
            <dd>{match.stage}</dd>
          </div>
          <div>
            <dt>{opaqueId("Venue")}</dt>
            <dd>{match.area}</dd>
          </div>
          <div>
            <dt>{opaqueId("Start")}</dt>
            <dd>{match.date ? `${match.date} · ${match.time}` : match.time}</dd>
          </div>
          {match.currentSegment ? (
            <div>
              <dt>{opaqueId("Current period or set")}</dt>
              <dd>{match.currentSegment}</dd>
            </div>
          ) : null}
          {recordedTime ? (
            <div>
              <dt>{opaqueId("Last recorded event time")}</dt>
              <dd>
                {recordedTime} {opaqueId("elapsed")}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{opaqueId("Last updated")}</dt>
            <dd>{match.updatedLabel ?? competition.lastUpdated}</dd>
          </div>
        </dl>
        {match.segments?.length ? (
          <section className={styles.sets} aria-label={opaqueId("Period or set scores")}>
            <h2>{opaqueId("By period or set")}</h2>
            <div className={styles.setGrid}>
              {match.segments.map((segment) => (
                <div key={segment.number}>
                  <span>{segment.number}</span>
                  <strong>
                    {segment.home} – {segment.away}
                  </strong>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </div>
  );
}
