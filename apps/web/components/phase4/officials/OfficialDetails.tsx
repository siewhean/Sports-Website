"use client";

import type { RefObject } from "react";
import { phase4OfficialsCopy, type OfficialView } from "@/lib/phase4-officials";
import styles from "./OfficialsRosterView.module.css";

export function OfficialDetails({
  official,
  assignmentCount,
  windowCount,
  canEdit,
  busy,
  isArchiveConfirm,
  onOpenEdit,
  onRequestArchive,
  onConfirmArchive,
  onCancelArchive,
  onRestore,
  headingRef,
  archiveButtonRef,
}: {
  official: OfficialView | null;
  assignmentCount: number;
  windowCount: number;
  canEdit: boolean;
  busy: string | null;
  isArchiveConfirm: boolean;
  onOpenEdit: () => void;
  onRequestArchive: () => void;
  onConfirmArchive: () => void;
  onCancelArchive: () => void;
  onRestore: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  archiveButtonRef?: RefObject<HTMLButtonElement | null>;
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
          <button type="button" className={styles.secondaryButton} onClick={onOpenEdit} disabled={Boolean(busy)}>
            {phase4OfficialsCopy.editOfficial}
          </button>
          {!official.archived ? (
            <button
              type="button"
              ref={archiveButtonRef}
              className={styles.dangerButton}
              onClick={onRequestArchive}
              disabled={Boolean(busy)}
            >
              {phase4OfficialsCopy.archiveOfficial}
            </button>
          ) : (
            <button type="button" className={styles.primaryButton} onClick={onRestore} disabled={Boolean(busy)}>
              {busy === "restore" ? phase4OfficialsCopy.restoring : phase4OfficialsCopy.restoreOfficial}
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}
