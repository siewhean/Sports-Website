"use client";

import { useState } from "react";
import { phase4OfficialsCopy, type OfficialWorkspaceDocument } from "@/lib/phase4-officials";
import type { ScheduleDocument } from "@/lib/phase4-schedule";
import styles from "./OfficialsRosterView.module.css";

export function OfficialsRosterView({
  document,
  scheduleDocument,
}: {
  document: OfficialWorkspaceDocument;
  scheduleDocument?: ScheduleDocument;
}) {
  const [showArchived, setShowArchived] = useState(false);

  const activeOfficials = document.officials.filter((o) => !o.archived);
  const archivedOfficials = document.officials.filter((o) => o.archived);

  const getAssignmentsCount = (officialId: string) => {
    return document.assignments.filter((a) => a.officialId === officialId).length;
  };

  const getAssignedMatchesSummary = (officialId: string) => {
    const assignedMatchIds = document.assignments.filter((a) => a.officialId === officialId).map((a) => a.matchId);
    if (assignedMatchIds.length === 0 || !scheduleDocument) return null;
    const matchLabels = assignedMatchIds
      .map((mId) => scheduleDocument.matches.find((m) => m.id === mId)?.code ?? mId)
      .slice(0, 3);
    return matchLabels.join(", ");
  };

  const getWindowsCount = (officialId: string) => {
    return (document.availability[officialId] ?? []).length;
  };

  return (
    <div className={styles.workspace}>
      <section className={styles.panel} aria-labelledby="active-officials-heading">
        <div className={styles.header}>
          <h2 id="active-officials-heading">{phase4OfficialsCopy.activeOfficials}</h2>
          {archivedOfficials.length > 0 ? (
            <button
              type="button"
              className={styles.toggleButton}
              onClick={() => setShowArchived((prev) => !prev)}
              aria-expanded={showArchived}
            >
              {showArchived
                ? phase4OfficialsCopy.hideArchived
                : `${phase4OfficialsCopy.showArchived} (${archivedOfficials.length})`}
            </button>
          ) : null}
        </div>

        {activeOfficials.length === 0 ? (
          <p className={styles.empty}>{phase4OfficialsCopy.noOfficials}</p>
        ) : (
          <ul className={styles.list} role="list">
            {activeOfficials.map((official) => {
              const assignmentsCount = getAssignmentsCount(official.id);
              const windowsCount = getWindowsCount(official.id);
              return (
                <li key={official.id} className={styles.card}>
                  <div className={styles.info}>
                    <div className={styles.nameRow}>
                      <span className={styles.name}>{official.name}</span>
                    </div>
                    <span className={styles.role}>{official.defaultRole ?? phase4OfficialsCopy.unassignedRole}</span>
                    <div className={styles.metaRow}>
                      <span>{phase4OfficialsCopy.windowsCount(windowsCount)}</span>
                      <span>{phase4OfficialsCopy.assignmentsCount(assignmentsCount)}</span>
                      {getAssignedMatchesSummary(official.id) ? (
                        <span>({getAssignedMatchesSummary(official.id)})</span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {showArchived && archivedOfficials.length > 0 ? (
        <section className={styles.panel} aria-labelledby="archived-officials-heading">
          <div className={styles.header}>
            <h2 id="archived-officials-heading">{phase4OfficialsCopy.archivedOfficials}</h2>
          </div>
          <ul className={styles.list} role="list">
            {archivedOfficials.map((official) => {
              const assignmentsCount = getAssignmentsCount(official.id);
              return (
                <li key={official.id} className={`${styles.card} ${styles.cardArchived}`}>
                  <div className={styles.info}>
                    <div className={styles.nameRow}>
                      <span className={styles.name}>{official.name}</span>
                      <span className={styles.badge}>{phase4OfficialsCopy.archivedBadge}</span>
                    </div>
                    <span className={styles.role}>{official.defaultRole ?? phase4OfficialsCopy.unassignedRole}</span>
                    <div className={styles.metaRow}>
                      <span>{phase4OfficialsCopy.assignmentsCount(assignmentsCount)}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
