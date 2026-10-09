import Link from "next/link";
import { interpolate, messages, opaqueId } from "@matchday/ui";
import { ArrowRight, CalendarDots, Clock, Trophy } from "@phosphor-icons/react/dist/ssr";
import { ConnectivityStatus } from "@/components/foundation/ConnectivityStatus";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { DoubleEliminationBracket } from "@/components/phase2/DoubleEliminationBracket";
import { PublicLiveRefresh } from "@/components/phase2/PublicLiveRefresh";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { phase2Copy, type CompetitionView, type PublicDivisionView } from "@/lib/phase2";
import { publicCompetitionPhase } from "@/lib/phase2-public-phase";
import styles from "./PublicCompetition.module.css";

export function PublicCompetition({
  competition,
  viewer = null,
  liveUpdates = true,
}: {
  competition: CompetitionView;
  viewer?: { displayName: string } | null;
  liveUpdates?: boolean;
}) {
  const phase = publicCompetitionPhase(
    {
      status: competition.status ?? "published",
      startsOn: competition.startsOn,
      endsOn: competition.endsOn,
      timezone: competition.timezone,
      hasLiveMatch: (competition.publicDivisions ?? [{ matches: competition.matches }]).some((division) =>
        division.matches.some((match) => match.status === "live"),
      ),
    },
    new Date(),
  );
  const publicDivisions =
    competition.publicDivisions && competition.publicDivisions.length > 0
      ? competition.publicDivisions
      : [
          {
            division: competition.division,
            teams: competition.teams,
            areas: competition.areas,
            matches: competition.matches,
            standings: competition.standings,
            bracket: competition.bracket,
          },
        ];
  const hasMultipleDivisions = publicDivisions.length > 1;

  return (
    <div className="p2-public">
      <a className="skip-link" href="#public-main">
        {phase2Copy.skip}
      </a>
      <SiteHeader viewer={viewer} />
      <main id="public-main">
        <header className="p2-public__identity">
          <div>
            <p>
              {competition.sport} · {competition.dateLabel}
            </p>
            <h1>{competition.name}</h1>
            <span>{competition.venue}</span>
          </div>
          <p>
            <span aria-hidden="true" />
            {messages.publicCompetition.phase[phase]}
            {" · "}
            {interpolate(messages.publicCompetition.updatedAt, { time: competition.lastUpdated })}
          </p>
        </header>
        <div className={styles.liveBar}>
          {liveUpdates && !demoFixturesEnabled() ? <PublicLiveRefresh slug={competition.slug} /> : null}
          <ConnectivityStatus />
        </div>
        <nav className="p2-public__nav" aria-label={competition.name}>
          {hasMultipleDivisions ? (
            publicDivisions.map(({ division }) => (
              <a href={`#results-${division.id}`} key={division.id}>
                {division.name}
              </a>
            ))
          ) : (
            <>
              <a href="#results">{phase2Copy.results}</a>
              <a href="#schedule">{phase2Copy.schedule}</a>
              <a href="#table">{phase2Copy.table}</a>
              <a href="#bracket">{phase2Copy.bracket}</a>
            </>
          )}
        </nav>
        {publicDivisions.map((division) => (
          <PublicDivisionSections
            key={division.division.id}
            value={division}
            isLive={phase === "live"}
            uniqueIds={hasMultipleDivisions}
            slug={competition.slug}
          />
        ))}
        <footer className="p2-public-version">
          <p>{phase2Copy.refreshNote}</p>
          <Link href="#public-main">
            {phase2Copy.results}
            <ArrowRight />
          </Link>
        </footer>
      </main>
      <SiteFooter />
    </div>
  );
}

function PublicDivisionSections({
  value,
  isLive,
  uniqueIds,
  slug,
}: {
  value: PublicDivisionView;
  isLive: boolean;
  uniqueIds: boolean;
  slug: string;
}) {
  const { division, matches, standings, bracket } = value;
  const finalMatch = matches.find((match) => match.status === "final");
  // A stale in-progress result must not shout "LIVE NOW" once the competition itself has finished.
  const liveMatch = isLive ? matches.find((match) => match.status === "live") : undefined;
  const nextMatches = matches.filter((match) => match.status === "scheduled");
  const sectionId = (name: string) => (uniqueIds ? `${name}-${division.id}` : name);
  const headingId = (name: string) => (uniqueIds ? `${name}-${division.id}` : name);

  return (
    <>
      <section
        className="p2-public-lead"
        id={sectionId("results")}
        aria-labelledby={headingId("public-result-title")}
        data-division-id={division.id}
      >
        <h2 id={headingId("public-result-title")} className="visually-hidden">
          {uniqueIds ? `${division.name} ${phase2Copy.results}` : phase2Copy.results}
        </h2>
        {liveMatch ? (
          <Link
            href={`/competitions/${slug}/matches/${liveMatch.id}`}
            className={`p2-public-score p2-public-score--live ${styles.scoreLink}`}
          >
            <header>
              <span>
                <i />
                {phase2Copy.publicLive}
              </span>
              <strong>
                {liveMatch.stage} · {liveMatch.area}
              </strong>
            </header>
            <div>
              <span>{liveMatch.home}</span>
              <strong>{liveMatch.homeScore}</strong>
            </div>
            <div>
              <span>{liveMatch.away}</span>
              <strong>{liveMatch.awayScore}</strong>
            </div>
            {liveMatch.updatedLabel ? (
              <small>{interpolate(messages.publicCompetition.updatedAt, { time: liveMatch.updatedLabel })}</small>
            ) : null}
          </Link>
        ) : null}
        {finalMatch ? (
          <Link
            href={`/competitions/${slug}/matches/${finalMatch.id}`}
            className={`p2-public-score p2-public-score--final ${styles.scoreLink}`}
          >
            <header>
              <span>{phase2Copy.publicFinal}</span>
              <strong>
                {finalMatch.label} · {finalMatch.stage}
              </strong>
            </header>
            <div>
              <span>{finalMatch.home}</span>
              <strong>{finalMatch.homeScore}</strong>
            </div>
            <p>
              <Trophy weight="light" />
            </p>
            <div>
              <span>{finalMatch.away}</span>
              <strong>{finalMatch.awayScore}</strong>
            </div>
          </Link>
        ) : null}
      </section>
      <section className={styles.allMatches} aria-label={division.name}>
        <header>
          <p>{division.name}</p>
          <h2>{opaqueId("Matches")}</h2>
        </header>
        <div className={styles.matchGrid}>
          {matches.map((match) => (
            <Link
              key={match.id}
              href={`/competitions/${slug}/matches/${match.id}`}
              className={styles.matchCard}
              data-status={match.status === "live" && !isLive ? "stale" : match.status}
            >
              <span>
                {match.status === "live" && isLive
                  ? opaqueId("Live")
                  : match.status === "final"
                    ? opaqueId("Final")
                    : match.time}
              </span>
              <strong>
                {match.home}
                <b>{match.homeScore ?? "—"}</b>
              </strong>
              <strong>
                {match.away}
                <b>{match.awayScore ?? "—"}</b>
              </strong>
              <small>
                {match.stage} · {match.area}
              </small>
            </Link>
          ))}
        </div>
      </section>
      <section
        className="p2-public-section"
        id={sectionId("schedule")}
        aria-labelledby={headingId("public-next-title")}
        data-division-id={division.id}
      >
        <header>
          <div>
            <p>{uniqueIds ? `${division.name} · ${phase2Copy.schedule}` : phase2Copy.schedule}</p>
            <h2 id={headingId("public-next-title")}>{phase2Copy.nextMatches}</h2>
          </div>
          <CalendarDots />
        </header>
        <ol className="p2-public-fixtures">
          {nextMatches.map((match) => (
            <li key={match.id} data-match-id={match.id}>
              <time>{match.dayLabel ? `${match.dayLabel}, ${match.time}` : match.time}</time>
              <span>{match.area}</span>
              <strong>
                <span>{match.home}</span>
                <span className="p2-public-fixtures__versus">{phase2Copy.versus}</span>
                <span>{match.away}</span>
              </strong>
              <small>{match.stage}</small>
            </li>
          ))}
        </ol>
      </section>
      <section
        className="p2-public-section"
        id={sectionId("table")}
        aria-labelledby={headingId("public-table-title")}
        data-division-id={division.id}
      >
        <header>
          <div>
            <p>{division.name}</p>
            <h2 id={headingId("public-table-title")}>{phase2Copy.table}</h2>
          </div>
        </header>
        <div
          className="p2-public-table"
          role="table"
          aria-label={uniqueIds ? `${division.name} ${phase2Copy.table}` : phase2Copy.table}
        >
          <div role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">{phase2Copy.team}</span>
            <span role="columnheader">{phase2Copy.played}</span>
            <span role="columnheader">{phase2Copy.won}</span>
            <span role="columnheader">{phase2Copy.difference}</span>
            <span role="columnheader">{phase2Copy.points}</span>
          </div>
          {standings.map((row) => (
            <div role="row" key={row.team}>
              <span role="cell">{row.position}</span>
              <strong role="cell">{row.team}</strong>
              <span role="cell">{row.played}</span>
              <span role="cell">{row.won}</span>
              <span role="cell">{row.difference > 0 ? `+${row.difference}` : row.difference}</span>
              <strong role="cell">{row.points}</strong>
            </div>
          ))}
        </div>
      </section>
      <section
        className="p2-public-section"
        id={sectionId("bracket")}
        aria-labelledby={headingId("public-bracket-title")}
        data-division-id={division.id}
      >
        <header>
          <div>
            <p>{division.name}</p>
            <h2 id={headingId("public-bracket-title")}>{phase2Copy.bracket}</h2>
          </div>
          <Trophy />
        </header>
        {bracket.some((m) => m.stageKind === "upper" || m.stageKind === "lower" || m.stageKind === "grand_final") ? (
          <DoubleEliminationBracket matches={bracket} divisionName={division.name} />
        ) : (
          <div className="p2-public-bracket">
            {bracket.map((match) => (
              <article key={match.id ?? `${match.round}-${match.fixture}`} data-match-id={match.id}>
                <span>{match.round}</span>
                <h3>{match.fixture}</h3>
                <strong>{match.score}</strong>
                <small>
                  <Clock />
                  {match.state}
                </small>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
