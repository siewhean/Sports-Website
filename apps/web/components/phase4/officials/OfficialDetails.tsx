"use client";

import type { RefObject } from "react";
import {
  formatWindowDisplay,
  phase4OfficialsCopy,
  phase4OfficialsMachine,
  type AvailabilityWindowView,
  type OfficialView,
} from "@/lib/phase4-officials";
import styles from "./OfficialsRosterView.module.css";

export function OfficialDetails({
  official,
  assignmentCount,
  windowCount,
  windows = [],
  timeZone = phase4OfficialsMachine.defaultTimeZone,
  canEdit,
  busy,
  workspaceOutOfSync,
  isArchiveConfirm,
  onOpenEdit,
  onOpenAvailabilityEdit,
  onRequestArchive,
  onConfirmArchive,
  onCancelArchive,
  onRestore,
  headingRef,
  archiveButtonRef,
  editAvailabilityButtonRef,
}: {
  official: OfficialView | null;
  assignmentCount: number;
  windowCount: number;
  windows?: AvailabilityWindowView[];
  timeZone?: string;
  canEdit: boolean;
  busy: string | null;
  workspaceOutOfSync?: boolean;
  isArchiveConfirm: boolean;
  onOpenEdit: () => void;
  onOpenAvailabilityEdit?: () => void;
  onRequestArchive: () => void;
  onConfirmArchive: () => void;
  onCancelArchive: () => void;
  onRestore: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  archiveButtonRef?: RefObject<HTMLButtonElement | null>;
  editAvailabilityButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  if (!official) {
    return (
      <section className={styles.panel} aria-labelledby="details-heading">
        <div className={styles.detailsHeader}>
          <h3 id="details-heading">{phase4OfficialsCopy.detailsTitle}</h3>
        </div>
        <p className={styles.empty}>{phase4OfficialsCopy.selectOfficialPrompt}</p>
      </section>
    );
  }

  if (isArchiveConfirm) {
    return (
      <section className={styles.panel} aria-labelledby="archive-confirm-heading">
        <div className={styles.archiveConfirmBox}>
          <h3 id="archive-confirm-heading" className={styles.archiveConfirmTitle}>
            {phase4OfficialsCopy.archiveConfirmTitle(official.name)}
          </h3>
          <p className={styles.archiveNotice}>{phase4OfficialsCopy.archiveNoticeGeneral}</p>
          {assignmentCount > 0 ? (
            <p className={styles.archiveNotice}>{phase4OfficialsCopy.archiveNoticeAssignments(assignmentCount)}</p>
          ) : null}
          <div className={styles.archiveConfirmActions}>
            <button type="button" className={styles.secondaryButton} onClick={onCancelArchive} disabled={Boolean(busy)}>
              {phase4OfficialsCopy.cancel}
            </button>
            <button
              type="button"
              autoFocus
              className={styles.dangerButton}
              onClick={onConfirmArchive}
              disabled={Boolean(busy)}
            >
              {busy === "archive" ? phase4OfficialsCopy.archiving : phase4OfficialsCopy.confirmArchive}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="official-details-heading">
      <div className={styles.detailsHeader}>
        <h3 id="official-details-heading" tabIndex={-1} ref={headingRef}>
          {official.name}
        </h3>
        {official.archived ? <span className={styles.badge}>{phase4OfficialsCopy.archivedBadge}</span> : null}
      </div>

      <div className={styles.detailMetaList}>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>{phase4OfficialsCopy.roleLabel}:</span>
          <span className={styles.detailValue}>{official.defaultRole ?? phase4OfficialsCopy.unassignedRole}</span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>{phase4OfficialsCopy.availabilityLabel}:</span>
          <span className={styles.detailValue}>{phase4OfficialsCopy.windowsCount(windowCount)}</span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>{phase4OfficialsCopy.assignmentsLabel}:</span>
          <span className={styles.detailValue}>{phase4OfficialsCopy.assignmentsCount(assignmentCount)}</span>
        </div>
      </div>

      {canEdit ? (
        <div className={styles.detailActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onOpenEdit}
            disabled={Boolean(busy) || Boolean(workspaceOutOfSync)}
          >
            {phase4OfficialsCopy.editOfficial}
          </button>
          {!official.archived ? (
            <button
              type="button"
              ref={archiveButtonRef}
              className={styles.dangerButton}
              onClick={onRequestArchive}
              disabled={Boolean(busy) || Boolean(workspaceOutOfSync)}
            >
              {phase4OfficialsCopy.archiveOfficial}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onRestore}
              disabled={Boolean(busy) || Boolean(workspaceOutOfSync)}
            >
              {busy === "restore" ? phase4OfficialsCopy.restoring : phase4OfficialsCopy.restoreOfficial}
            </button>
          )}
        </div>
      ) : null}

      <div className={styles.availabilitySection}>
        <div className={styles.availabilitySectionHeader}>
          <h4 className={styles.availabilityTitle}>{phase4OfficialsCopy.availabilityTitle}</h4>
          <span className={styles.timezoneNotice}>{phase4OfficialsCopy.competitionTimezone(timeZone)}</span>
        </div>

        {official.archived ? (
          <p className={styles.readOnlyNotice}>{phase4OfficialsCopy.restoreToEditAvailability}</p>
        ) : null}

        {windows.length === 0 ? (
          <p className={styles.emptyAvailability}>{phase4OfficialsCopy.noAvailabilityWindows}</p>
        ) : (
          <ul className={styles.windowList} role="list">
            {windows.map((w, idx) => {
              const formatted = formatWindowDisplay(w.startsAt, w.endsAt, timeZone);
              return (
                <li key={`${w.startsAt}_${w.endsAt}_${idx}`} className={styles.windowItem}>
                  {formatted.crossMidnight ? (
                    <span className={styles.windowTime}>{formatted.text}</span>
                  ) : (
                    <div className={styles.windowRow}>
                      <span className={styles.windowDate}>{formatted.date}</span>
                      <span className={styles.windowTime}>{formatted.time}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canEdit && !official.archived && onOpenAvailabilityEdit ? (
          <div className={styles.availabilityActions}>
            <button
              type="button"
              ref={editAvailabilityButtonRef}
              className={styles.secondaryButton}
              onClick={onOpenAvailabilityEdit}
              disabled={Boolean(busy) || Boolean(workspaceOutOfSync)}
            >
              {phase4OfficialsCopy.editAvailability}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
