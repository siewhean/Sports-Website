import Link from "next/link";
import { ArrowRight, CalendarDots, Clock, Trophy } from "@phosphor-icons/react/dist/ssr";
import { ConnectivityStatus } from "@/components/foundation/ConnectivityStatus";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { phase2Copy, type CompetitionView, type PublicDivisionView } from "@/lib/phase2";

export function PublicCompetition({ competition }: { competition: CompetitionView }) {
  const publicationVersion = publicPublicationVersion(competition.publicationRevision);
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
      <SiteHeader />
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
            {phase2Copy.updated}
          </p>
        </header>
        <ConnectivityStatus />
        <nav className="p2-public__nav" aria-label={phase2Copy.competitionContext}>
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
            publicationVersion={publicationVersion}
            publicationRevision={competition.publicationRevision}
            uniqueIds={hasMultipleDivisions}
          />
        ))}
        <footer className="p2-public-version">
          <div>
            <strong>{publicationVersion}</strong>
            <span>{competition.publishedAt}</span>
          </div>
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
  publicationVersion,
  publicationRevision,
  uniqueIds,
}: {
  value: PublicDivisionView;
  publicationVersion: string;
  publicationRevision: string;
  uniqueIds: boolean;
}) {
  const { division, matches, standings, bracket } = value;
  const finalMatch = matches.find((match) => match.status === "final");
  const liveMatch = matches.find((match) => match.status === "live");
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
          <div className="p2-public-score p2-public-score--live">
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
            <p>
              <span>{phase2Copy.periodPrefix}2</span>
              <strong>04:12</strong>
            </p>
            <div>
              <span>{liveMatch.away}</span>
              <strong>{liveMatch.awayScore}</strong>
            </div>
            <small>{phase2Copy.updated}</small>
          </div>
        ) : null}
        {finalMatch ? (
          <div className="p2-public-score p2-public-score--final">
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
            <small>{publicationRevision}</small>
          </div>
        ) : null}
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
              <time>{match.time}</time>
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
          <span>{publicationVersion}</span>
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
        <div className="p2-public-bracket">
          {bracket.map((match) => (
            <article key={`${match.round}-${match.fixture}`}>
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
      </section>
    </>
  );
}

function publicPublicationVersion(value: string): string {
  const match = /^sch_(\d+) · res_(\d+)$/.exec(value);
  if (match) return `Schedule ${match[1]} · Results ${match[2]}`;
  const legacy = /^pub_(\d+)$/.exec(value);
  return legacy ? `Published revision ${Number(legacy[1])}` : value;
}
