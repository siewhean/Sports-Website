"use client";

import {
  phase4OfficialsCopy,
  type AvailabilityWindowView,
  type MatchOfficialAssignmentView,
  type OfficialView,
} from "@/lib/phase4-officials";
import styles from "./OfficialsRosterView.module.css";

export function OfficialRoster({
  officials,
  availability,
  assignments,
  selectedOfficialId,
  onSelectOfficial,
  showArchived,
  onToggleShowArchived,
  canEdit,
  onOpenCreate,
  busy,
}: {
  officials: OfficialView[];
  availability: Record<string, AvailabilityWindowView[]>;
  assignments: MatchOfficialAssignmentView[];
  selectedOfficialId: string | null;
  onSelectOfficial: (id: string) => void;
  showArchived: boolean;
  onToggleShowArchived: () => void;
  canEdit: boolean;
  onOpenCreate: () => void;
  busy: string | null;
}) {
  const activeOfficials = officials.filter((o) => !o.archived);
  const archivedOfficials = officials.filter((o) => o.archived);

  const getAssignmentsCount = (officialId: string) => {
    return assignments.filter((a) => a.officialId === officialId).length;
  };

  const getWindowsCount = (officialId: string) => {
    return (availability[officialId] ?? []).length;
  };

  return (
    <div className={styles.workspaceColumn}>
      <section className={styles.panel} aria-labelledby="active-officials-heading">
        <div className={styles.header}>
          <h2 id="active-officials-heading">{phase4OfficialsCopy.activeOfficials}</h2>
          <div className={styles.headerActions}>
            {canEdit ? (
              <button type="button" className={styles.primaryButton} onClick={onOpenCreate} disabled={Boolean(busy)}>
                {phase4OfficialsCopy.addOfficial}
              </button>
            ) : (
              <p className={styles.readOnlyNotice}>{phase4OfficialsCopy.readOnlyNotice}</p>
            )}
            {archivedOfficials.length > 0 ? (
              <button
                type="button"
                className={styles.toggleButton}
                onClick={onToggleShowArchived}
                aria-expanded={showArchived}
              >
                {showArchived
                  ? phase4OfficialsCopy.hideArchived
                  : `${phase4OfficialsCopy.showArchived} (${archivedOfficials.length})`}
              </button>
            ) : null}
          </div>
        </div>

        {activeOfficials.length === 0 ? (
          <p className={styles.empty}>{phase4OfficialsCopy.noOfficials}</p>
        ) : (
          <ul className={styles.list} role="list">
            {activeOfficials.map((official) => {
              const assignmentsCount = getAssignmentsCount(official.id);
              const windowsCount = getWindowsCount(official.id);
              const isSelected = selectedOfficialId === official.id;
              return (
                <li key={official.id} className={styles.cardItem}>
                  <button
                    type="button"
                    className={`${styles.cardButton} ${isSelected ? styles.cardSelected : ""}`}
                    onClick={() => onSelectOfficial(official.id)}
                    aria-pressed={isSelected}
                  >
                    <div className={styles.info}>
                      <div className={styles.nameRow}>
                        <span className={styles.name}>{official.name}</span>
                        {isSelected ? (
                          <span className={styles.selectedBadge}>{phase4OfficialsCopy.selectedOfficialBadge}</span>
                        ) : null}
                      </div>
                      <span className={styles.role}>{official.defaultRole ?? phase4OfficialsCopy.unassignedRole}</span>
                      <div className={styles.metaRow}>
                        <span>{phase4OfficialsCopy.windowsCount(windowsCount)}</span>
                        <span>{phase4OfficialsCopy.assignmentsCount(assignmentsCount)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {showArchived && archivedOfficials.length > 0 ? (
        <section className={`${styles.panel} ${styles.archivedSection}`} aria-labelledby="archived-officials-heading">
          <div className={styles.header}>
            <h2 id="archived-officials-heading">{phase4OfficialsCopy.archivedOfficials}</h2>
          </div>
          <ul className={styles.list} role="list">
            {archivedOfficials.map((official) => {
              const assignmentsCount = getAssignmentsCount(official.id);
              const isSelected = selectedOfficialId === official.id;
              return (
                <li key={official.id} className={styles.cardItem}>
                  <button
                    type="button"
                    className={`${styles.cardButton} ${styles.cardArchived} ${isSelected ? styles.cardSelected : ""}`}
                    onClick={() => onSelectOfficial(official.id)}
                    aria-pressed={isSelected}
                  >
                    <div className={styles.info}>
                      <div className={styles.nameRow}>
                        <span className={styles.name}>{official.name}</span>
                        <span className={styles.badge}>{phase4OfficialsCopy.archivedBadge}</span>
                        {isSelected ? (
                          <span className={styles.selectedBadge}>{phase4OfficialsCopy.selectedOfficialBadge}</span>
                        ) : null}
                      </div>
                      <span className={styles.role}>{official.defaultRole ?? phase4OfficialsCopy.unassignedRole}</span>
                      <div className={styles.metaRow}>
                        <span>{phase4OfficialsCopy.assignmentsCount(assignmentsCount)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
