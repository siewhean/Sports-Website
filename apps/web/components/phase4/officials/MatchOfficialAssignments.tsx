"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { opaqueId } from "@matchday/ui";
import {
  formatMatchOptionLabel,
  formatScheduledMatchSummary,
  getMatchScheduledInterval,
  officialAvailabilityConflict,
  officialOverlapConflicts,
  type MatchTimeInterval,
} from "@/lib/phase4-official-conflicts";
import {
  phase4OfficialsCopy,
  phase4OfficialsMachine,
  type OfficialView,
  type OfficialWorkspaceDocument,
} from "@/lib/phase4-officials";
import type { ScheduleDocument, ScheduleMatch } from "@/lib/phase4-schedule";
import styles from "./OfficialsRosterView.module.css";

export function MatchOfficialAssignments({
  selectedMatchId,
  onSelectMatch,
  scheduleDocument,
  timeZone = phase4OfficialsMachine.defaultTimeZone,
  workspace,
  isEditing,
  onOpenEdit,
  onCancelEdit,
  onSaveAssignments,
  busy,
  workspaceOutOfSync,
  summaryHeadingRef,
  editButtonRef,
}: {
  selectedMatchId: string | null;
  onSelectMatch: (matchId: string) => void;
  scheduleDocument?: ScheduleDocument;
  timeZone?: string;
  workspace: OfficialWorkspaceDocument;
  isEditing: boolean;
  onOpenEdit: () => void;
  onCancelEdit: () => void;
  onSaveAssignments: (assignments: { official_id: string; assigned_role: string | null }[]) => Promise<void>;
  busy: string | null;
  workspaceOutOfSync: boolean;
  summaryHeadingRef?: React.RefObject<HTMLHeadingElement | null>;
  editButtonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const matchSelectorId = useId();

  const matches: readonly ScheduleMatch[] = useMemo(() => scheduleDocument?.matches ?? [], [scheduleDocument?.matches]);
  const selectedMatch = useMemo(
    () => matches.find((m) => m.id === selectedMatchId) ?? null,
    [matches, selectedMatchId],
  );

  // Current canonical assignments for selected match
  const currentMatchAssignments = useMemo(
    () => (selectedMatchId ? workspace.assignments.filter((a) => a.matchId === selectedMatchId) : []),
    [workspace.assignments, selectedMatchId],
  );

  const initiallyAssignedOfficialIds = useMemo(
    () => new Set(currentMatchAssignments.map((a) => a.officialId)),
    [currentMatchAssignments],
  );

  // Candidates: active officials + archived officials currently assigned to this match
  const candidates: OfficialView[] = useMemo(() => {
    const active = workspace.officials.filter((o) => !o.archived);
    const assignedArchived = workspace.officials.filter((o) => o.archived && initiallyAssignedOfficialIds.has(o.id));
    return [...active, ...assignedArchived];
  }, [workspace.officials, initiallyAssignedOfficialIds]);

  // Scheduled assignment info
  const scheduledAssignment = useMemo(
    () =>
      selectedMatchId
        ? (scheduleDocument?.currentRevision?.assignments.find((a) => a.matchId === selectedMatchId) ?? null)
        : null,
    [scheduleDocument?.currentRevision?.assignments, selectedMatchId],
  );

  const scheduledSummary = useMemo(
    () => formatScheduledMatchSummary(scheduledAssignment, scheduleDocument?.areas, timeZone),
    [scheduledAssignment, scheduleDocument?.areas, timeZone],
  );

  const scheduledInterval = useMemo(
    () => getMatchScheduledInterval(selectedMatchId ?? "", scheduleDocument?.currentRevision?.assignments),
    [selectedMatchId, scheduleDocument?.currentRevision?.assignments],
  );

  // Evaluate conflict hints for view mode (currently assigned officials)
  const viewConflictHints = useMemo(() => {
    if (!selectedMatchId || !scheduledInterval || isEditing) return [];

    const hints: string[] = [];
    for (const assignment of currentMatchAssignments) {
      const official = workspace.officials.find((o) => o.id === assignment.officialId);
      if (!official) continue;

      const availWarning = officialAvailabilityConflict(
        official,
        workspace.availability[official.id],
        scheduledInterval,
      );
      if (availWarning) hints.push(availWarning);

      const overlapWarnings = officialOverlapConflicts(
        official,
        selectedMatchId,
        scheduledInterval,
        workspace.assignments,
        scheduleDocument?.currentRevision?.assignments,
        matches,
      );
      hints.push(...overlapWarnings);
    }

    return hints;
  }, [
    selectedMatchId,
    scheduledInterval,
    isEditing,
    currentMatchAssignments,
    workspace.officials,
    workspace.availability,
    workspace.assignments,
    scheduleDocument?.currentRevision?.assignments,
    matches,
  ]);

  return (
    <section className={styles.assignmentsSection} aria-labelledby="match-assignments-heading">
      <div className={styles.panel}>
        <div className={styles.header}>
          <h2 id="match-assignments-heading" ref={summaryHeadingRef} tabIndex={-1}>
            {phase4OfficialsCopy.matchAssignmentsTitle}
          </h2>
          {!isEditing && workspace.canEdit && !workspaceOutOfSync && selectedMatchId !== null ? (
            <button type="button" ref={editButtonRef} className={styles.secondaryButton} onClick={onOpenEdit}>
              {phase4OfficialsCopy.editMatchOfficials}
            </button>
          ) : null}
        </div>

        {/* Match selector & scheduled summary */}
        <div className={styles.matchControlsRow}>
          <div className={styles.matchSelectorGroup}>
            <label htmlFor={matchSelectorId} className={styles.label}>
              {phase4OfficialsCopy.selectMatchLabel}
            </label>
            {matches.length === 0 ? (
              <p className={styles.emptyNotice}>{phase4OfficialsCopy.noMatchesAvailable}</p>
            ) : (
              <select
                id={matchSelectorId}
                className={styles.select}
                value={selectedMatchId ?? ""}
                onChange={(e) => onSelectMatch(e.target.value)}
                disabled={isEditing || matches.length === 0}
              >
                {matches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {formatMatchOptionLabel(m)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedMatch ? (
            <div className={styles.scheduledInfoBox}>
              <span className={styles.scheduledLabel}>{phase4OfficialsCopy.scheduledTimeLabel}</span>
              <span className={styles.scheduledValue}>{scheduledSummary.text}</span>
            </div>
          ) : null}
        </div>

        {/* Unscheduled match notice or View mode conflict hints */}
        {selectedMatch ? (
          !scheduledSummary.isScheduled ? (
            <div className={styles.conflictInfoNotice}>{phase4OfficialsCopy.scheduleMatchForConflictsNotice}</div>
          ) : !isEditing && viewConflictHints.length > 0 ? (
            <div className={styles.conflictAdvisoryBox} role="status">
              <h4 className={styles.conflictAdvisoryTitle}>{phase4OfficialsCopy.currentScheduleCheckTitle}</h4>
              <p className={styles.conflictAdvisoryNotice}>{phase4OfficialsCopy.currentScheduleCheckNotice}</p>
              <ul className={styles.conflictList}>
                {viewConflictHints.map((hint, idx) => (
                  <li key={idx} className={styles.conflictItem}>
                    {hint}
                  </li>
                ))}
              </ul>
            </div>
          ) : null
        ) : null}

        {/* View mode vs Edit mode */}
        {!isEditing ? (
          <div className={styles.assignedOfficialsView}>
            <div className={styles.assignedCountHeader}>
              <h3 className={styles.subHeading}>
                {phase4OfficialsCopy.assignedOfficialsCount(currentMatchAssignments.length)}
              </h3>
            </div>

            {currentMatchAssignments.length === 0 ? (
              <p className={styles.emptyNotice}>{phase4OfficialsCopy.noAssignedOfficials}</p>
            ) : (
              <ul className={styles.assignmentsList}>
                {currentMatchAssignments.map((assignment) => {
                  const official = workspace.officials.find((o) => o.id === assignment.officialId);
                  const officialName = official?.name ?? assignment.official?.name ?? assignment.officialId;
                  const isArchived = official?.archived ?? assignment.official?.archived ?? false;

                  return (
                    <li key={assignment.officialId} className={styles.assignmentCard} data-testid="assignment-card">
                      <div className={styles.assignmentDetails}>
                        <div className={styles.assignmentNameRow}>
                          <span className={styles.officialName}>{officialName}</span>
                          {isArchived ? (
                            <span className={styles.badge}>{phase4OfficialsCopy.archivedBadge}</span>
                          ) : null}
                        </div>
                        <span className={styles.assignedRoleText}>
                          {assignment.assignedRole
                            ? `${phase4OfficialsCopy.assignedRoleLabel}: ${assignment.assignedRole}`
                            : official?.defaultRole
                              ? `${phase4OfficialsCopy.defaultRoleHelper(official.defaultRole)}`
                              : phase4OfficialsCopy.unassignedRole}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <MatchOfficialAssignmentEditor
            selectedMatchId={selectedMatchId!}
            candidates={candidates}
            initialAssignments={currentMatchAssignments}
            scheduledInterval={scheduledInterval}
            scheduleAssignments={scheduleDocument?.currentRevision?.assignments}
            workspace={workspace}
            matches={matches}
            onSave={onSaveAssignments}
            onCancel={onCancelEdit}
            busy={busy}
            workspaceOutOfSync={workspaceOutOfSync}
          />
        )}
      </div>
    </section>
  );
}

function MatchOfficialAssignmentEditor({
  selectedMatchId,
  candidates,
  initialAssignments,
  scheduledInterval,
  scheduleAssignments,
  workspace,
  matches,
  onSave,
  onCancel,
  busy,
  workspaceOutOfSync,
}: {
  selectedMatchId: string;
  candidates: OfficialView[];
  initialAssignments: { matchId: string; officialId: string; assignedRole: string | null }[];
  scheduledInterval: MatchTimeInterval | null;
  scheduleAssignments?: readonly { matchId: string; startsAt: string; endsAt: string }[] | null;
  workspace: OfficialWorkspaceDocument;
  matches: readonly ScheduleMatch[];
  onSave: (assignments: { official_id: string; assigned_role: string | null }[]) => Promise<void>;
  onCancel: () => void;
  busy: string | null;
  workspaceOutOfSync: boolean;
}) {
  const editHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const firstCheckboxRef = useRef<HTMLInputElement | null>(null);
  const roleInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [formError, setFormError] = useState<string | null>(null);

  // Draft state initialized directly from initialAssignments
  const [drafts, setDrafts] = useState<Record<string, { selected: boolean; assignedRole: string }>>(() => {
    const initial: Record<string, { selected: boolean; assignedRole: string }> = {};
    for (const candidate of candidates) {
      const existing = initialAssignments.find((a) => a.officialId === candidate.id);
      initial[candidate.id] = {
        selected: existing !== undefined,
        assignedRole: existing?.assignedRole ?? "",
      };
    }
    return initial;
  });

  // Focus management on mount
  useEffect(() => {
    if (firstCheckboxRef.current) {
      firstCheckboxRef.current.focus();
    } else if (editHeadingRef.current) {
      editHeadingRef.current.focus();
    }
  }, []);

  // Real-time conflict hints evaluated against current draft selection
  const editConflictHints = useMemo(() => {
    if (!scheduledInterval) return [];

    const hints: string[] = [];
    for (const candidate of candidates) {
      if (!drafts[candidate.id]?.selected) continue;

      const availWarning = officialAvailabilityConflict(
        candidate,
        workspace.availability[candidate.id],
        scheduledInterval,
      );
      if (availWarning) hints.push(availWarning);

      const overlapWarnings = officialOverlapConflicts(
        candidate,
        selectedMatchId,
        scheduledInterval,
        workspace.assignments,
        scheduleAssignments,
        matches,
      );
      hints.push(...overlapWarnings);
    }

    return hints;
  }, [
    scheduledInterval,
    candidates,
    drafts,
    workspace.availability,
    selectedMatchId,
    workspace.assignments,
    scheduleAssignments,
    matches,
  ]);

  const handleToggleOfficial = (official: OfficialView) => {
    const current = drafts[official.id] ?? { selected: false, assignedRole: "" };
    if (official.archived && !current.selected) {
      // Archived officials cannot be re-checked once unassigned
      return;
    }
    setDrafts((prev) => ({
      ...prev,
      [official.id]: {
        ...current,
        selected: !current.selected,
      },
    }));
  };

  const handleChangeRole = (officialId: string, role: string) => {
    setDrafts((prev) => ({
      ...prev,
      [officialId]: {
        ...(prev[officialId] ?? { selected: true, assignedRole: "" }),
        assignedRole: role,
      },
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const selectedOfficials = candidates.filter((c) => drafts[c.id]?.selected);

    if (selectedOfficials.length > 64) {
      setFormError(phase4OfficialsCopy.maxAssignmentsReached);
      return;
    }

    // Role length validation
    for (const off of selectedOfficials) {
      const roleText = (drafts[off.id]?.assignedRole ?? "").trim();
      if (roleText.length > 40) {
        setFormError(phase4OfficialsCopy.roleTooLongAssignment);
        roleInputRefs.current[off.id]?.focus();
        return;
      }
    }

    const assignmentsPayload = selectedOfficials.map((off) => {
      const trimmed = (drafts[off.id]?.assignedRole ?? "").trim();
      return {
        official_id: off.id,
        assigned_role: trimmed.length > 0 ? trimmed : null,
      };
    });

    await onSave(assignmentsPayload);
  };

  return (
    <>
      {/* Real-time conflict hint advisory callout */}
      {editConflictHints.length > 0 ? (
        <div className={styles.conflictAdvisoryBox} role="status">
          <h4 className={styles.conflictAdvisoryTitle}>{phase4OfficialsCopy.currentScheduleCheckTitle}</h4>
          <p className={styles.conflictAdvisoryNotice}>{phase4OfficialsCopy.currentScheduleCheckNotice}</p>
          <ul className={styles.conflictList}>
            {editConflictHints.map((hint, idx) => (
              <li key={idx} className={styles.conflictItem}>
                {hint}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form className={styles.assignmentEditorForm} onSubmit={handleSave}>
        <div className={styles.editorHeader}>
          <h3 ref={editHeadingRef} tabIndex={-1} className={styles.subHeading}>
            {phase4OfficialsCopy.editMatchOfficials}
          </h3>
        </div>

        {formError ? (
          <div id="match-assignments-form-error" className={styles.errorAlert} role="alert">
            {formError}
          </div>
        ) : null}

        <div className={styles.candidateChecklist}>
          {candidates.length === 0 ? (
            <p className={styles.emptyNotice}>{phase4OfficialsCopy.noOfficials}</p>
          ) : (
            candidates.map((candidate, idx) => {
              const draft = drafts[candidate.id] ?? { selected: false, assignedRole: "" };
              const isChecked = draft.selected;
              const isArchived = candidate.archived;
              const checkboxDisabled = isArchived && !isChecked;

              return (
                <div key={candidate.id} className={styles.candidateRow}>
                  <div className={styles.candidateCheckboxCol}>
                    <input
                      type="checkbox"
                      id={`match-official-${candidate.id}`}
                      ref={idx === 0 ? firstCheckboxRef : undefined}
                      checked={isChecked}
                      disabled={checkboxDisabled}
                      onChange={() => handleToggleOfficial(candidate)}
                      className={styles.checkbox}
                    />
                    <label htmlFor={`match-official-${candidate.id}`} className={styles.candidateLabel}>
                      <span className={styles.candidateName}>{candidate.name}</span>
                      {isArchived ? <span className={styles.badge}>{phase4OfficialsCopy.archivedBadge}</span> : null}
                    </label>
                  </div>

                  {isChecked ? (
                    <div className={styles.candidateRoleCol}>
                      <label htmlFor={`match-role-${candidate.id}`} className={styles.srOnly}>
                        {phase4OfficialsCopy.assignedRoleFor(candidate.name)}
                      </label>
                      <input
                        type="text"
                        id={`match-role-${candidate.id}`}
                        ref={(el) => {
                          roleInputRefs.current[candidate.id] = el;
                        }}
                        aria-label={phase4OfficialsCopy.assignedRoleFor(candidate.name)}
                        placeholder={phase4OfficialsCopy.rolePlaceholderShort}
                        maxLength={40}
                        value={draft.assignedRole}
                        onChange={(e) => handleChangeRole(candidate.id, e.target.value)}
                        className={styles.input}
                      />
                      {candidate.defaultRole ? (
                        <span className={styles.roleHelperText}>
                          {phase4OfficialsCopy.defaultRoleHelper(candidate.defaultRole)}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <div className={styles.formActions}>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={busy === opaqueId("save_match_assignments") || workspaceOutOfSync}
          >
            {busy === opaqueId("save_match_assignments")
              ? phase4OfficialsCopy.savingAssignments
              : phase4OfficialsCopy.saveAssignments}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy !== null}>
            {phase4OfficialsCopy.cancel}
          </button>
        </div>
      </form>
    </>
  );
}
