import Link from "next/link";
import { phase4OfficialsCopy, type ScheduleOfficialsProjection } from "@/lib/phase4-officials";
import styles from "./MatchOfficialsSummary.module.css";

export type MatchOfficialsSummaryProps = {
  competitionId: string;
  matchId: string;
  officialsProjection?: ScheduleOfficialsProjection;
};

export function MatchOfficialsSummary({ competitionId, matchId, officialsProjection }: MatchOfficialsSummaryProps) {
  const isAvailable = Boolean(officialsProjection && officialsProjection.state === "ready");
  const canEdit = Boolean(officialsProjection?.canEdit);
  const linkHref = `/organiser/competitions/${encodeURIComponent(competitionId)}/officials?match=${encodeURIComponent(matchId)}`;
  const linkText = canEdit ? phase4OfficialsCopy.manageOfficials : phase4OfficialsCopy.viewOfficials;

  if (!isAvailable || !officialsProjection) {
    return (
      <section className={styles.officialsSection} aria-labelledby="match-officials-heading">
        <h3 id="match-officials-heading" className={styles.title}>
          {phase4OfficialsCopy.officialsSectionTitle}
        </h3>
        <p className={styles.notice}>{phase4OfficialsCopy.officialsUnavailable}</p>
        <Link href={linkHref} className={styles.manageLink}>
          {linkText}
        </Link>
      </section>
    );
  }

  const matchAssignments = officialsProjection.assignments.filter((a) => a.matchId === matchId);

  if (matchAssignments.length === 0) {
    return (
      <section className={styles.officialsSection} aria-labelledby="match-officials-heading">
        <h3 id="match-officials-heading" className={styles.title}>
          {phase4OfficialsCopy.officialsSectionTitle}
        </h3>
        <p className={styles.emptyNotice}>{phase4OfficialsCopy.noOfficialsAssigned}</p>
        <Link href={linkHref} className={styles.manageLink}>
          {linkText}
        </Link>
      </section>
    );
  }

  return (
    <section className={styles.officialsSection} aria-labelledby="match-officials-heading">
      <h3 id="match-officials-heading" className={styles.title}>
        {phase4OfficialsCopy.officialsSectionTitle}
      </h3>
      <ul className={styles.officialsList} aria-label={phase4OfficialsCopy.officialsSectionTitle}>
        {matchAssignments.map((assignment) => {
          const official = officialsProjection.officials.find((o) => o.id === assignment.officialId);
          const officialName = official?.name ?? phase4OfficialsCopy.unknownOfficial;
          const isArchived = official?.archived ?? false;

          let roleText: string;
          if (assignment.assignedRole) {
            roleText = assignment.assignedRole;
          } else if (official?.defaultRole) {
            roleText = phase4OfficialsCopy.defaultRoleHelper(official.defaultRole);
          } else {
            roleText = phase4OfficialsCopy.noAssignedRole;
          }

          return (
            <li key={assignment.officialId} className={styles.officialItem} data-testid="schedule-assigned-official">
              <div className={styles.nameRow}>
                <span className={styles.officialName}>{officialName}</span>
                {isArchived ? <span className={styles.badge}>{phase4OfficialsCopy.archivedBadge}</span> : null}
              </div>
              <span className={styles.roleText}>{roleText}</span>
            </li>
          );
        })}
      </ul>
      <Link href={linkHref} className={styles.manageLink}>
        {linkText}
      </Link>
    </section>
  );
}
