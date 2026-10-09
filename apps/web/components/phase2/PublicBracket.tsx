import Link from "next/link";
import { interpolate, opaqueId, spectatorMessages as copy } from "@matchday/ui";
import type { PublicDivisionView } from "@/lib/phase2";
import type { BracketModel, BracketRound, BracketRow } from "@/lib/public-competition-model";
import styles from "./PublicBracket.module.css";

/**
 * Knockout bracket: one horizontally scrolling (snap) row of rounds per section. Semantics are nested lists
 * (rounds → matches) so screen readers hear "list, 4 items" instead of a visual tree.
 */
export function PublicBracket({
  model,
  division,
  slug,
  followed,
}: {
  model: BracketModel;
  division: Pick<PublicDivisionView, "division" | "matches">;
  slug: string;
  followed: string | null;
}) {
  if (model.format === "none") {
    return (
      <>
        <h2 className={styles.title}>{copy.bracket.title}</h2>
        <p className={styles.empty}>{copy.bracket.empty}</p>
      </>
    );
  }
  const linkable = new Set(division.matches.map((match) => match.id));
  const sections: Array<{ key: string; title: string; rounds: readonly BracketRound[] }> =
    model.format === "single"
      ? [{ key: opaqueId("knockout"), title: copy.bracket.knockout, rounds: model.upper }]
      : [
          { key: opaqueId("upper"), title: copy.bracket.upper, rounds: model.upper },
          { key: opaqueId("lower"), title: copy.bracket.lower, rounds: model.lower },
          { key: opaqueId("final"), title: copy.bracket.grandFinal, rounds: model.finals },
        ].filter((section) => section.rounds.length > 0);

  return (
    <div className={styles.bracket} data-format={model.format}>
      <h2 className={styles.title}>{copy.bracket.title}</h2>
      <p className={styles.hint}>{copy.bracket.scrollHint}</p>
      {sections.map((section) => (
        <section key={section.key} className={styles.section} aria-labelledby={`bracket-${section.key}`}>
          {sections.length > 1 ? (
            <h3 id={`bracket-${section.key}`} className={styles.sectionTitle}>
              {section.title}
            </h3>
          ) : (
            <h3 id={`bracket-${section.key}`} className="visually-hidden">
              {section.title}
            </h3>
          )}
          <div
            className={styles.scroller}
            role="region"
            aria-label={interpolate(copy.bracket.roundsLabel, { section: section.title })}
            tabIndex={0}
          >
            <ol className={styles.rounds}>
              {section.rounds.map((round) => (
                <li key={round.key} className={styles.round}>
                  <h4>{round.title}</h4>
                  <ol
                    aria-label={interpolate(copy.bracket.roundMatches, {
                      round: round.title,
                      count: round.matches.length,
                    })}
                  >
                    {round.matches.map((row) => (
                      <li key={row.id ?? `${row.round}-${row.fixture}`}>
                        <BracketCard row={row} slug={slug} linkable={linkable} followed={followed} />
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </div>
        </section>
      ))}
    </div>
  );
}

function splitPair(value: string, separator: RegExp): [string, string] {
  const [left = "", right = ""] = value.split(separator).map((part) => part.trim());
  return [left, right];
}

function BracketCard({
  row,
  slug,
  linkable,
  followed,
}: {
  row: BracketRow;
  slug: string;
  linkable: ReadonlySet<string>;
  followed: string | null;
}) {
  const [home, away] = splitPair(row.fixture, / · /u);
  const [homeScore, awayScore] = row.score.includes("–") ? splitPair(row.score, /–/u) : ["", ""];
  const homeName = !home || home === "TBD" ? copy.bracket.toBeDecided : home;
  const awayName = !away || away === "TBD" ? copy.bracket.toBeDecided : away;
  const isFollowed = Boolean(followed) && (home === followed || away === followed);
  // Only a finished match has a winner; a live leader is not shown as one.
  const decided = row.state === "Final" && homeScore !== "" && awayScore !== "";
  const homeWins = decided && Number(homeScore) > Number(awayScore);
  const awayWins = decided && Number(awayScore) > Number(homeScore);
  const body = (
    <>
      <span className={styles.team} data-winner={homeWins || undefined}>
        <span>{homeName}</span>
        <strong>{homeScore}</strong>
      </span>
      <span className={styles.team} data-winner={awayWins || undefined}>
        <span>{awayName}</span>
        <strong>{awayScore}</strong>
      </span>
      <small>{row.state === "TBD" ? copy.bracket.toBeDecided : row.state}</small>
    </>
  );
  return row.id && linkable.has(row.id) ? (
    <Link
      href={`/competitions/${encodeURIComponent(slug)}/matches/${encodeURIComponent(row.id)}`}
      className={styles.card}
      data-match-id={row.id}
      data-followed={isFollowed || undefined}
    >
      {body}
    </Link>
  ) : (
    <article className={styles.card} data-match-id={row.id} data-followed={isFollowed || undefined}>
      {body}
    </article>
  );
}
