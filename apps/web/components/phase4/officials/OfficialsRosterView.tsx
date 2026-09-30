"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { opaqueId } from "@matchday/ui";
import {
  isAvailabilityMutationResponse,
  isMatchOfficialsMutationResponse,
  isOfficialMutationResponse,
  isOfficialResponse,
  officialCommandErrorMessage,
  parseOfficialWorkspaceResponse,
  phase4OfficialsCopy,
  phase4OfficialsMachine,
  type OfficialWorkspaceDocument,
} from "@/lib/phase4-officials";
import type { ScheduleDocument } from "@/lib/phase4-schedule";
import { MatchOfficialAssignments } from "./MatchOfficialAssignments";
import { OfficialAvailabilityEditor } from "./OfficialAvailabilityEditor";
import { OfficialDetails } from "./OfficialDetails";
import { OfficialForm } from "./OfficialForm";
import { OfficialRoster } from "./OfficialRoster";
import styles from "./OfficialsRosterView.module.css";

type WorkspaceMode = "view" | "create" | "edit" | "archive_confirm" | "availability_edit" | "assignment_edit";

export function OfficialsRosterView({
  document: initialDocument,
  scheduleDocument,
  timeZone = phase4OfficialsMachine.defaultTimeZone,
  initialMatchId,
}: {
  document: OfficialWorkspaceDocument;
  scheduleDocument?: ScheduleDocument;
  timeZone?: string;
  initialMatchId?: string;
}) {
  const [workspace, setWorkspace] = useState<OfficialWorkspaceDocument>(initialDocument);
  const [selectedOfficialId, setSelectedOfficialId] = useState<string | null>(
    () => initialDocument.officials.find((o) => !o.archived)?.id ?? null,
  );
  const validInitialMatch = scheduleDocument?.matches.some((m) => m.id === initialMatchId);
  const defaultMatchId = (validInitialMatch ? initialMatchId : scheduleDocument?.matches[0]?.id) ?? null;
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(defaultMatchId);
  const [showArchived, setShowArchived] = useState(false);
  const [mode, setMode] = useState<WorkspaceMode>(opaqueId("view"));
  const [busy, setBusy] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [scheduleWarning, setScheduleWarning] = useState(false);
  const [workspaceOutOfSync, setWorkspaceOutOfSync] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const archiveButtonRef = useRef<HTMLButtonElement | null>(null);
  const addOfficialButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeOfficialsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const editAvailabilityButtonRef = useRef<HTMLButtonElement | null>(null);
  const matchAssignmentsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const editMatchButtonRef = useRef<HTMLButtonElement | null>(null);

  const selectedOfficial =
    (selectedOfficialId ? workspace.officials.find((o) => o.id === selectedOfficialId) : null) ?? null;

  const refreshWorkspace = async (): Promise<OfficialWorkspaceDocument | null> => {
    try {
      const res = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(workspace.competitionId)}/officials/workspace`,
        {
          method: phase4OfficialsMachine.get,
          cache: phase4OfficialsMachine.noStore,
          headers: { accept: "application/json" },
        },
      );

      if (!res.ok) {
        return null;
      }

      const data = await res.json();
      const parsed = parseOfficialWorkspaceResponse(data, workspace.competitionId, workspace.canEdit);
      if (!parsed) {
        return null;
      }

      setWorkspace(parsed);
      setWorkspaceOutOfSync(false);
      return parsed;
    } catch {
      return null;
    }
  };

  const handleRetryRefresh = async () => {
    setBusy(opaqueId("refresh"));
    const refreshed = await refreshWorkspace();
    if (!refreshed) {
      setWorkspaceOutOfSync(true);
    } else {
      setWorkspaceOutOfSync(false);
      setErrorMessage(null);
    }
    setBusy(null);
  };

  const handleSelectOfficial = (id: string) => {
    if (mode === opaqueId("availability_edit") || mode === opaqueId("assignment_edit")) return;
    setSelectedOfficialId(id);
    setMode(opaqueId("view"));
    setFormError(null);
    setStatusMessage(null);
    setAvailabilityError(null);
  };

  const handleOpenCreate = () => {
    if (workspaceOutOfSync || mode === opaqueId("assignment_edit")) return;
    setMode(opaqueId("create"));
    setFormError(null);
    setStatusMessage(null);
    setAvailabilityError(null);
  };

  const handleOpenEdit = () => {
    if (workspaceOutOfSync || mode === opaqueId("assignment_edit")) return;
    setMode(opaqueId("edit"));
    setFormError(null);
    setStatusMessage(null);
    setAvailabilityError(null);
  };

  const handleCancelForm = () => {
    const wasCreate = mode === opaqueId("create");
    setMode(opaqueId("view"));
    setFormError(null);
    setTimeout(() => {
      if (wasCreate) {
        addOfficialButtonRef.current?.focus();
      } else {
        headingRef.current?.focus();
      }
    }, 0);
  };

  const handleSelectMatch = (matchId: string) => {
    if (mode === opaqueId("assignment_edit") || mode === opaqueId("availability_edit")) return;
    setSelectedMatchId(matchId);
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const handleOpenMatchAssignmentsEdit = () => {
    if (!selectedMatchId || !workspace.canEdit || workspaceOutOfSync) return;
    setMode(opaqueId("assignment_edit"));
    setStatusMessage(null);
    setErrorMessage(null);
    setFormError(null);
  };

  const handleCancelMatchAssignmentsEdit = () => {
    setMode(opaqueId("view"));
    setTimeout(() => {
      editMatchButtonRef.current?.focus();
    }, 0);
  };

  const handleSaveMatchOfficials = async (assignments: { official_id: string; assigned_role: string | null }[]) => {
    if (!selectedMatchId || workspaceOutOfSync) return;

    setBusy(opaqueId("save_match_assignments"));
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const res = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(workspace.competitionId)}/matches/${encodeURIComponent(selectedMatchId)}/officials`,
        {
          method: phase4OfficialsMachine.put,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ assignments }),
        },
      );

      const raw = await res.json().catch(() => null);

      if (!res.ok) {
        setWorkspaceOutOfSync(false);
        const code = raw?.error?.code ?? null;
        setErrorMessage(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isMatchOfficialsMutationResponse(raw)) {
        setWorkspaceOutOfSync(false);
        setErrorMessage(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      setMode(opaqueId("view"));

      // Monotonic sticky schedule warning: only update to true if bumped_revision is true
      if (raw.bumped_revision) {
        setScheduleWarning(true);
      }

      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setWorkspaceOutOfSync(false);
        setStatusMessage(phase4OfficialsCopy.assignmentsSaved);
        setTimeout(() => {
          if (matchAssignmentsHeadingRef.current) {
            matchAssignmentsHeadingRef.current.focus();
          } else {
            headingRef.current?.focus();
          }
        }, 0);
      } else {
        setWorkspaceOutOfSync(true);
      }
    } catch {
      setWorkspaceOutOfSync(false);
      setErrorMessage(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleOpenAvailabilityEdit = () => {
    if (!selectedOfficial || selectedOfficial.archived || !workspace.canEdit || workspaceOutOfSync) return;
    setMode(opaqueId("availability_edit"));
    setAvailabilityError(null);
    setStatusMessage(null);
  };

  const handleCancelAvailabilityEdit = () => {
    setMode(opaqueId("view"));
    setAvailabilityError(null);
    setTimeout(() => {
      editAvailabilityButtonRef.current?.focus();
    }, 0);
  };

  const handleSaveAvailability = async ({ windows }: { windows: { starts_at: string; ends_at: string }[] }) => {
    if (!selectedOfficial || workspaceOutOfSync) return;

    setBusy(opaqueId("save_availability"));
    setAvailabilityError(null);
    setStatusMessage(null);

    try {
      const res = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(workspace.competitionId)}/officials/${encodeURIComponent(selectedOfficial.id)}/availability`,
        {
          method: phase4OfficialsMachine.put,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ windows }),
        },
      );

      const raw = await res.json().catch(() => null);

      if (!res.ok) {
        setWorkspaceOutOfSync(false);
        const code = raw?.error?.code ?? null;
        setAvailabilityError(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isAvailabilityMutationResponse(raw)) {
        setWorkspaceOutOfSync(false);
        setAvailabilityError(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      setMode(opaqueId("view"));

      if (raw.bumped_revision) {
        setScheduleWarning(true);
      }

      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setWorkspaceOutOfSync(false);
        setStatusMessage(phase4OfficialsCopy.availabilitySaved);
        setTimeout(() => {
          if (editAvailabilityButtonRef.current) {
            editAvailabilityButtonRef.current.focus();
          } else {
            headingRef.current?.focus();
          }
        }, 0);
      } else {
        setWorkspaceOutOfSync(true);
      }
    } catch {
      setWorkspaceOutOfSync(false);
      setAvailabilityError(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleRequestArchive = () => {
    if (workspaceOutOfSync) return;
    setMode(opaqueId("archive_confirm"));
    setStatusMessage(null);
    setErrorMessage(null);
    setAvailabilityError(null);
  };

  const handleCancelArchive = () => {
    setMode(opaqueId("view"));
    setTimeout(() => {
      archiveButtonRef.current?.focus();
    }, 0);
  };

  const handleCreate = async ({ name, defaultRole }: { name: string; defaultRole?: string | null }) => {
    setBusy(opaqueId("create"));
    setFormError(null);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/phase4/competitions/${encodeURIComponent(workspace.competitionId)}/officials`, {
        method: phase4OfficialsMachine.post,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          default_role: defaultRole ?? null,
        }),
      });

      const raw = await res.json().catch(() => null);

      if (!res.ok) {
        setWorkspaceOutOfSync(false);
        const code = raw?.error?.code ?? null;
        setFormError(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialResponse(raw)) {
        setWorkspaceOutOfSync(false);
        setFormError(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      setMode(opaqueId("view"));
      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setWorkspaceOutOfSync(false);
        setSelectedOfficialId(raw.id);
        setStatusMessage(phase4OfficialsCopy.officialCreated);
        setTimeout(() => {
          headingRef.current?.focus();
        }, 0);
      } else {
        setWorkspaceOutOfSync(true);
      }
    } catch {
      setWorkspaceOutOfSync(false);
      setFormError(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleUpdate = async ({ name, defaultRole }: { name: string; defaultRole?: string | null }) => {
    if (!selectedOfficial || workspaceOutOfSync) return;

    const payload: Record<string, unknown> = {};
    if (name !== selectedOfficial.name) {
      payload.name = name;
    }
    const currentRole = selectedOfficial.defaultRole ?? null;
    const newRole = defaultRole ?? null;
    if (newRole !== currentRole) {
      payload.default_role = newRole;
    }

    if (Object.keys(payload).length === 0) {
      setMode(opaqueId("view"));
      return;
    }

    setBusy(opaqueId("save"));
    setFormError(null);
    setErrorMessage(null);

    try {
      const res = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(workspace.competitionId)}/officials/${encodeURIComponent(selectedOfficial.id)}`,
        {
          method: phase4OfficialsMachine.patch,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      const raw = await res.json().catch(() => null);

      if (!res.ok) {
        setWorkspaceOutOfSync(false);
        const code = raw?.error?.code ?? null;
        setFormError(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialResponse(raw)) {
        setWorkspaceOutOfSync(false);
        setFormError(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      setMode(opaqueId("view"));
      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setWorkspaceOutOfSync(false);
        setStatusMessage(phase4OfficialsCopy.officialUpdated);
        setTimeout(() => {
          headingRef.current?.focus();
        }, 0);
      } else {
        setWorkspaceOutOfSync(true);
      }
    } catch {
      setWorkspaceOutOfSync(false);
      setFormError(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleArchive = async () => {
    if (!selectedOfficial || workspaceOutOfSync) return;

    setBusy(opaqueId("archive"));
    setErrorMessage(null);

    try {
      const res = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(workspace.competitionId)}/officials/${encodeURIComponent(selectedOfficial.id)}/archive`,
        {
          method: phase4OfficialsMachine.post,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const raw = await res.json().catch(() => null);

      if (!res.ok) {
        setWorkspaceOutOfSync(false);
        const code = raw?.error?.code ?? null;
        setErrorMessage(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialMutationResponse(raw)) {
        setWorkspaceOutOfSync(false);
        setErrorMessage(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      setMode(opaqueId("view"));

      if (raw.bumped_revision) {
        setScheduleWarning(true);
      }

      const archivedId = selectedOfficial.id;
      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setWorkspaceOutOfSync(false);
        setStatusMessage(phase4OfficialsCopy.officialArchived);

        if (showArchived) {
          setSelectedOfficialId(archivedId);
          setTimeout(() => {
            headingRef.current?.focus();
          }, 0);
        } else {
          const remainingActive = refreshed.officials.filter((o) => !o.archived);
          if (remainingActive.length > 0) {
            setSelectedOfficialId(remainingActive[0]!.id);
            setTimeout(() => {
              headingRef.current?.focus();
            }, 0);
          } else {
            setSelectedOfficialId(null);
            setTimeout(() => {
              if (workspace.canEdit) {
                addOfficialButtonRef.current?.focus();
              } else {
                activeOfficialsHeadingRef.current?.focus();
              }
            }, 0);
          }
        }
      } else {
        setWorkspaceOutOfSync(true);
        if (showArchived) {
          setSelectedOfficialId(archivedId);
          setTimeout(() => {
            headingRef.current?.focus();
          }, 0);
        } else {
          const remainingActive = workspace.officials.filter((o) => !o.archived && o.id !== archivedId);
          if (remainingActive.length > 0) {
            setSelectedOfficialId(remainingActive[0]!.id);
            setTimeout(() => {
              headingRef.current?.focus();
            }, 0);
          } else {
            setSelectedOfficialId(null);
            setTimeout(() => {
              if (workspace.canEdit) {
                addOfficialButtonRef.current?.focus();
              } else {
                activeOfficialsHeadingRef.current?.focus();
              }
            }, 0);
          }
        }
      }
    } catch {
      setWorkspaceOutOfSync(false);
      setErrorMessage(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    if (!selectedOfficial || workspaceOutOfSync) return;

    setBusy(opaqueId("restore"));
    setErrorMessage(null);

    try {
      const res = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(workspace.competitionId)}/officials/${encodeURIComponent(selectedOfficial.id)}/restore`,
        {
          method: phase4OfficialsMachine.post,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const raw = await res.json().catch(() => null);

      if (!res.ok) {
        setWorkspaceOutOfSync(false);
        const code = raw?.error?.code ?? null;
        setErrorMessage(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialMutationResponse(raw)) {
        setWorkspaceOutOfSync(false);
        setErrorMessage(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      setMode(opaqueId("view"));

      if (raw.bumped_revision) {
        setScheduleWarning(true);
      }

      const restoredId = selectedOfficial.id;
      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setWorkspaceOutOfSync(false);
        setSelectedOfficialId(restoredId);
        setStatusMessage(phase4OfficialsCopy.officialRestored);
        setTimeout(() => {
          headingRef.current?.focus();
        }, 0);
      } else {
        setWorkspaceOutOfSync(true);
      }
    } catch {
      setWorkspaceOutOfSync(false);
      setErrorMessage(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const assignmentCount = selectedOfficial
    ? workspace.assignments.filter((a) => a.officialId === selectedOfficial.id).length
    : 0;

  const windowCount = selectedOfficial ? (workspace.availability[selectedOfficial.id] ?? []).length : 0;

  const hasBanners = Boolean(statusMessage || scheduleWarning || workspaceOutOfSync || errorMessage);

  return (
    <div className={styles.workspace}>
      {hasBanners ? (
        <div className={styles.bannerStack}>
          {statusMessage ? (
            <div className={styles.statusBanner} role="status" aria-live="polite">
              {statusMessage}
            </div>
          ) : null}
          {scheduleWarning ? (
            <div className={styles.warningBanner} role="status">
              <span>{phase4OfficialsCopy.scheduleInvalidatedNotice}</span>
              <Link
                href={`/organiser/competitions/${encodeURIComponent(workspace.competitionId)}/schedule`}
                className={styles.warningLink}
              >
                {phase4OfficialsCopy.reviewScheduleLink}
              </Link>
            </div>
          ) : null}
          {workspaceOutOfSync ? (
            <div className={styles.warningBanner} role="alert">
              <span>{phase4OfficialsCopy.reconciliationNotice}</span>
              <button
                type="button"
                className={styles.retryButton}
                onClick={handleRetryRefresh}
                disabled={busy === opaqueId("refresh")}
              >
                {busy === opaqueId("refresh") ? phase4OfficialsCopy.retryingRefresh : phase4OfficialsCopy.retryRefresh}
              </button>
            </div>
          ) : null}
          {errorMessage && !workspaceOutOfSync ? (
            <div className={styles.errorAlert} role="alert">
              {errorMessage}
            </div>
          ) : null}
        </div>
      ) : null}

      <OfficialRoster
        officials={workspace.officials}
        availability={workspace.availability}
        assignments={workspace.assignments}
        selectedOfficialId={selectedOfficial?.id ?? null}
        onSelectOfficial={handleSelectOfficial}
        showArchived={showArchived}
        onToggleShowArchived={() => setShowArchived((prev) => !prev)}
        canEdit={workspace.canEdit && mode !== opaqueId("assignment_edit")}
        onOpenCreate={handleOpenCreate}
        busy={busy}
        workspaceOutOfSync={workspaceOutOfSync}
        isSelectionDisabled={mode === opaqueId("availability_edit") || mode === opaqueId("assignment_edit")}
        addOfficialButtonRef={addOfficialButtonRef}
        activeOfficialsHeadingRef={activeOfficialsHeadingRef}
      />

      <div className={styles.workspaceColumn}>
        {mode === opaqueId("create") ? (
          <OfficialForm
            mode={opaqueId("create")}
            onSubmit={handleCreate}
            onCancel={handleCancelForm}
            busy={busy === opaqueId("create")}
            serverError={formError}
          />
        ) : mode === opaqueId("edit") ? (
          <OfficialForm
            mode={opaqueId("edit")}
            initialOfficial={selectedOfficial}
            onSubmit={handleUpdate}
            onCancel={handleCancelForm}
            busy={busy === opaqueId("save")}
            serverError={formError}
          />
        ) : mode === opaqueId("availability_edit") && selectedOfficial ? (
          <OfficialAvailabilityEditor
            official={selectedOfficial}
            initialWindows={workspace.availability[selectedOfficial.id] ?? []}
            timeZone={timeZone}
            onSubmit={handleSaveAvailability}
            onCancel={handleCancelAvailabilityEdit}
            busy={busy === opaqueId("save_availability")}
            serverError={availabilityError}
          />
        ) : (
          <OfficialDetails
            official={selectedOfficial}
            assignmentCount={assignmentCount}
            windowCount={windowCount}
            windows={selectedOfficial ? (workspace.availability[selectedOfficial.id] ?? []) : []}
            timeZone={timeZone}
            canEdit={workspace.canEdit && mode !== opaqueId("assignment_edit")}
            busy={busy}
            workspaceOutOfSync={workspaceOutOfSync}
            isArchiveConfirm={mode === opaqueId("archive_confirm")}
            onOpenEdit={handleOpenEdit}
            onOpenAvailabilityEdit={handleOpenAvailabilityEdit}
            onRequestArchive={handleRequestArchive}
            onConfirmArchive={handleArchive}
            onCancelArchive={handleCancelArchive}
            onRestore={handleRestore}
            headingRef={headingRef}
            archiveButtonRef={archiveButtonRef}
            editAvailabilityButtonRef={editAvailabilityButtonRef}
          />
        )}
      </div>

      <MatchOfficialAssignments
        selectedMatchId={selectedMatchId}
        onSelectMatch={handleSelectMatch}
        scheduleDocument={scheduleDocument}
        timeZone={timeZone}
        workspace={workspace}
        isEditing={mode === opaqueId("assignment_edit")}
        onOpenEdit={handleOpenMatchAssignmentsEdit}
        onCancelEdit={handleCancelMatchAssignmentsEdit}
        onSaveAssignments={handleSaveMatchOfficials}
        busy={busy}
        workspaceOutOfSync={workspaceOutOfSync}
        summaryHeadingRef={matchAssignmentsHeadingRef}
        editButtonRef={editMatchButtonRef}
      />
    </div>
  );
}
