import Link from "next/link";
import { interpolate } from "@matchday/ui";
import { phase4ScheduleCopy, type ScheduleMatch, type ScheduleOfficialDiagnostic } from "@/lib/phase4-schedule";
import styles from "./NoSolutionOfficialDiagnostics.module.css";

export function matchLabel(matchId: string, matches: readonly ScheduleMatch[]): string {
  const match = matches.find((m) => m.id === matchId);
  if (!match) return phase4ScheduleCopy.anAffectedMatch;
  if (match.roundLabel) return `${match.code} (${match.roundLabel})`;
  return match.code;
}

export function matchCode(matchId: string, matches: readonly ScheduleMatch[]): string {
  const match = matches.find((m) => m.id === matchId);
  return match?.code ?? phase4ScheduleCopy.anAffectedMatch;
}

export function formatOverlapMatchLabels(matchIds: readonly string[], matches: readonly ScheduleMatch[]): string {
  const knownCodes: string[] = [];
  let unknownCount = 0;

  for (const id of matchIds) {
    const match = matches.find((m) => m.id === id);
    if (match) {
      knownCodes.push(match.code);
    } else {
      unknownCount += 1;
    }
  }

  if (unknownCount === 0) {
    return knownCodes.join(", ");
  }

  if (knownCodes.length === 0) {
    return unknownCount > 1 ? phase4ScheduleCopy.oneOrMoreAffectedMatches : phase4ScheduleCopy.anAffectedMatch;
  }

  if (unknownCount === 1) {
    return interpolate(phase4ScheduleCopy.overlapAffectedMatchesWithAnother, {
      matches: knownCodes.join(", "),
    });
  }

  return interpolate(phase4ScheduleCopy.overlapAffectedMatchesWithMore, {
    matches: knownCodes.join(", "),
  });
}

export type NoSolutionOfficialDiagnosticsProps = Readonly<{
  competitionId: string;
  matches: readonly ScheduleMatch[];
  diagnostics: readonly ScheduleOfficialDiagnostic[] | null;
  loading?: boolean;
  error?: boolean;
}>;

export function NoSolutionOfficialDiagnostics({
  competitionId,
  matches,
  diagnostics,
  loading = false,
  error = false,
}: NoSolutionOfficialDiagnosticsProps) {
  // When diagnostics failed or are empty, show the generic no-solution notice
  if (!diagnostics || diagnostics.length === 0 || error) {
    return (
      <div className={styles.container} aria-live="polite" data-testid="no-solution-generic">
        <p className={styles.genericNotice}>
          {loading ? phase4ScheduleCopy.loading : phase4ScheduleCopy.noFeasibleScheduleGeneric}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.container} aria-live="polite" data-testid="no-solution-diagnostics">
      <div className={styles.headingRow}>
        <h3 className={styles.heading}>{phase4ScheduleCopy.officialConflictsDetected}</h3>
      </div>
      <p className={styles.disclaimer}>{phase4ScheduleCopy.officialConflictsDisclaimer}</p>
      <ul className={styles.diagnosticsList} role="list">
        {diagnostics.map((diag, index) => {
          if (diag.code === "official_unavailable") {
            const matchId = diag.matchIds[0];
            const resolvedMatch = matchId ? matches.find((m) => m.id === matchId) : null;
            const label = resolvedMatch ? matchLabel(resolvedMatch.id, matches) : phase4ScheduleCopy.anAffectedMatch;
            const reviewHref = resolvedMatch
              ? `/organiser/competitions/${encodeURIComponent(competitionId)}/officials?match=${encodeURIComponent(resolvedMatch.id)}`
              : `/organiser/competitions/${encodeURIComponent(competitionId)}/officials`;
            return (
              <li key={`${diag.code}-${index}`} className={styles.diagnosticItem}>
                <span className={styles.conditionTitle}>{phase4ScheduleCopy.officialUnavailableForMatch}</span>
                <div className={styles.matchesRow}>
                  <span className={styles.matchLabels}>{label}</span>
                  <Link className={styles.reviewLink} href={reviewHref}>
                    {phase4ScheduleCopy.reviewOfficials}
                  </Link>
                </div>
              </li>
            );
          }

          if (diag.code === "official_overlap") {
            const labels = formatOverlapMatchLabels(diag.matchIds, matches);
            return (
              <li key={`${diag.code}-${index}`} className={styles.diagnosticItem}>
                <span className={styles.conditionTitle}>{phase4ScheduleCopy.officialOverlapForMatches}</span>
                <div className={styles.matchesRow}>
                  <span className={styles.matchLabels}>{labels}</span>
                  <Link
                    className={styles.reviewLink}
                    href={`/organiser/competitions/${encodeURIComponent(competitionId)}/officials`}
                  >
                    {phase4ScheduleCopy.reviewOfficials}
                  </Link>
                </div>
              </li>
            );
          }

          return null;
        })}
      </ul>
    </div>
  );
}
