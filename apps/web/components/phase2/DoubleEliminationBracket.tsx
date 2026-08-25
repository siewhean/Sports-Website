import React from "react";
import { messages } from "@matchday/ui";
import styles from "./DoubleEliminationBracket.module.css";

export type BracketMatchItem = {
  id?: string;
  round: string;
  fixture: string;
  score: string;
  state: string;
  stageKind?: "upper" | "lower" | "grand_final" | "reset_final" | string;
};

export function DoubleEliminationBracket({
  matches,
  divisionName,
}: {
  matches: readonly BracketMatchItem[];
  divisionName?: string;
}) {
  const upperMatches = matches.filter(
    (m) => m.stageKind === "upper" || m.round.toLowerCase().includes("upper") || (m.id && m.id.includes("upper")),
  );
  const lowerMatches = matches.filter(
    (m) => m.stageKind === "lower" || m.round.toLowerCase().includes("lower") || (m.id && m.id.includes("lower")),
  );
  const grandFinalMatches = matches.filter(
    (m) =>
      m.stageKind === "grand_final" ||
      m.stageKind === "reset_final" ||
      m.round.toLowerCase().includes("grand final") ||
      (m.id && m.id.includes("grand-final")),
  );

  return (
    <div
      className={styles.container}
      role="region"
      aria-label={
        divisionName ? `${divisionName} ${messages.bracket.doubleElimination}` : messages.bracket.doubleElimination
      }
    >
      {upperMatches.length > 0 && (
        <section className={styles.section} aria-label={messages.bracket.upperBracket}>
          <h3 className={styles.sectionTitle}>{messages.bracket.upperBracket}</h3>
          <div className={styles.grid}>
            {upperMatches.map((match) => (
              <article
                key={match.id ?? `${match.round}-${match.fixture}`}
                className={styles.matchCard}
                data-match-id={match.id}
              >
                <div className={styles.matchHeader}>
                  <span>{match.round}</span>
                </div>
                <div className={styles.matchFixture}>{match.fixture}</div>
                <strong className={styles.matchScore}>{match.score}</strong>
                <small className={styles.matchState}>{match.state}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      {lowerMatches.length > 0 && (
        <section className={styles.section} aria-label={messages.bracket.lowerBracket}>
          <h3 className={styles.sectionTitle}>{messages.bracket.lowerBracket}</h3>
          <div className={styles.grid}>
            {lowerMatches.map((match) => (
              <article
                key={match.id ?? `${match.round}-${match.fixture}`}
                className={styles.matchCard}
                data-match-id={match.id}
              >
                <div className={styles.matchHeader}>
                  <span>{match.round}</span>
                </div>
                <div className={styles.matchFixture}>{match.fixture}</div>
                <strong className={styles.matchScore}>{match.score}</strong>
                <small className={styles.matchState}>{match.state}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      {grandFinalMatches.length > 0 && (
        <section className={styles.section} aria-label={messages.bracket.grandFinals}>
          <h3 className={styles.sectionTitle}>{messages.bracket.grandFinals}</h3>
          <div className={styles.grid}>
            {grandFinalMatches.map((match) => (
              <article
                key={match.id ?? `${match.round}-${match.fixture}`}
                className={styles.matchCard}
                data-match-id={match.id}
              >
                <div className={styles.matchHeader}>
                  <span>{match.round}</span>
                </div>
                <div className={styles.matchFixture}>{match.fixture}</div>
                <strong className={styles.matchScore}>{match.score}</strong>
                <small className={styles.matchState}>{match.state}</small>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
