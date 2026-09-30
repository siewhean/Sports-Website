import Link from "next/link";
import { phase4ScheduleCopy, type ScheduleMatch, type ScheduleOfficialDiagnostic } from "@/lib/phase4-schedule";
import styles from "./NoSolutionOfficialDiagnostics.module.css";

export function matchLabel(matchId: string, matches: readonly ScheduleMatch[]): string {
  const match = matches.find((m) => m.id === matchId);
  if (!match) return `Match ${matchId.slice(0, 8)}`;
  if (match.roundLabel) return `${match.code} (${match.roundLabel})`;
  return match.code;
}

export function matchCode(matchId: string, matches: readonly ScheduleMatch[]): string {
  const match = matches.find((m) => m.id === matchId);
  return match?.code ?? matchId.slice(0, 8);
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
            const label = matchId ? matchLabel(matchId, matches) : phase4ScheduleCopy.noMatchSelected;
            return (
              <li key={`${diag.code}-${index}`} className={styles.diagnosticItem}>
                <span className={styles.conditionTitle}>{phase4ScheduleCopy.officialUnavailableForMatch}</span>
                <div className={styles.matchesRow}>
                  <span className={styles.matchLabels}>{label}</span>
                  {matchId ? (
                    <Link
                      className={styles.reviewLink}
                      href={`/organiser/competitions/${encodeURIComponent(competitionId)}/officials?match=${encodeURIComponent(matchId)}`}
                    >
                      {phase4ScheduleCopy.reviewOfficials}
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          }

          if (diag.code === "official_overlap") {
            const labels = diag.matchIds.map((id) => matchCode(id, matches)).join(", ");
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
