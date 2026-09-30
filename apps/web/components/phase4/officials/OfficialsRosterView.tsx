"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { opaqueId } from "@matchday/ui";
import {
  isOfficialMutationResponse,
  isOfficialResponse,
  officialCommandErrorMessage,
  parseOfficialWorkspaceResponse,
  phase4OfficialsCopy,
  phase4OfficialsMachine,
  type OfficialWorkspaceDocument,
} from "@/lib/phase4-officials";
import type { ScheduleDocument } from "@/lib/phase4-schedule";
import { OfficialDetails } from "./OfficialDetails";
import { OfficialForm } from "./OfficialForm";
import { OfficialRoster } from "./OfficialRoster";
import styles from "./OfficialsRosterView.module.css";

type WorkspaceMode = "view" | "create" | "edit" | "archive_confirm";

export function OfficialsRosterView({
  document: initialDocument,
}: {
  document: OfficialWorkspaceDocument;
  scheduleDocument?: ScheduleDocument;
}) {
  const [workspace, setWorkspace] = useState<OfficialWorkspaceDocument>(initialDocument);
  const [selectedOfficialId, setSelectedOfficialId] = useState<string | null>(
    () => initialDocument.officials.find((o) => !o.archived)?.id ?? null,
  );
  const [showArchived, setShowArchived] = useState(false);
  const [mode, setMode] = useState<WorkspaceMode>(opaqueId("view"));
  const [busy, setBusy] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [scheduleWarning, setScheduleWarning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const archiveButtonRef = useRef<HTMLButtonElement | null>(null);

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
        setErrorMessage(phase4OfficialsCopy.refreshFailed);
        return null;
      }

      const data = await res.json();
      const parsed = parseOfficialWorkspaceResponse(data, workspace.competitionId, workspace.canEdit);
      if (!parsed) {
        setErrorMessage(phase4OfficialsCopy.commandResponseInvalid);
        return null;
      }

      setWorkspace(parsed);
      return parsed;
    } catch {
      setErrorMessage(phase4OfficialsCopy.refreshFailed);
      return null;
    }
  };

  const handleSelectOfficial = (id: string) => {
    setSelectedOfficialId(id);
    setMode(opaqueId("view"));
    setFormError(null);
    setStatusMessage(null);
  };

  const handleOpenCreate = () => {
    setMode(opaqueId("create"));
    setFormError(null);
    setStatusMessage(null);
  };

  const handleOpenEdit = () => {
    setMode(opaqueId("edit"));
    setFormError(null);
    setStatusMessage(null);
  };

  const handleCancelForm = () => {
    setMode(opaqueId("view"));
    setFormError(null);
  };

  const handleRequestArchive = () => {
    setMode(opaqueId("archive_confirm"));
    setStatusMessage(null);
    setErrorMessage(null);
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
        const code = raw?.error?.code ?? null;
        setFormError(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialResponse(raw)) {
        setFormError(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setSelectedOfficialId(raw.id);
        setMode(opaqueId("view"));
        setStatusMessage(phase4OfficialsCopy.officialCreated);
        setScheduleWarning(false);
        setTimeout(() => {
          headingRef.current?.focus();
        }, 0);
      }
    } catch {
      setFormError(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleUpdate = async ({ name, defaultRole }: { name: string; defaultRole?: string | null }) => {
    if (!selectedOfficial) return;

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
        const code = raw?.error?.code ?? null;
        setFormError(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialResponse(raw)) {
        setFormError(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setMode(opaqueId("view"));
        setStatusMessage(phase4OfficialsCopy.officialUpdated);
        setScheduleWarning(false);
        setTimeout(() => {
          headingRef.current?.focus();
        }, 0);
      }
    } catch {
      setFormError(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleArchive = async () => {
    if (!selectedOfficial) return;

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
        const code = raw?.error?.code ?? null;
        setErrorMessage(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialMutationResponse(raw)) {
        setErrorMessage(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      if (raw.bumped_revision) {
        setScheduleWarning(true);
      } else {
        setScheduleWarning(false);
      }

      const archivedId = selectedOfficial.id;
      const refreshed = await refreshWorkspace();
      if (refreshed) {
        if (!showArchived) {
          const firstActive = refreshed.officials.find((o) => !o.archived);
          setSelectedOfficialId(firstActive?.id ?? null);
        } else {
          setSelectedOfficialId(archivedId);
        }
        setMode(opaqueId("view"));
        setStatusMessage(phase4OfficialsCopy.officialArchived);
        setTimeout(() => {
          headingRef.current?.focus();
        }, 0);
      }
    } catch {
      setErrorMessage(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    if (!selectedOfficial) return;

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
        const code = raw?.error?.code ?? null;
        setErrorMessage(officialCommandErrorMessage(res.status, code));
        setBusy(null);
        return;
      }

      if (!isOfficialMutationResponse(raw)) {
        setErrorMessage(phase4OfficialsCopy.commandResponseInvalid);
        setBusy(null);
        return;
      }

      if (raw.bumped_revision) {
        setScheduleWarning(true);
      } else {
        setScheduleWarning(false);
      }

      const restoredId = selectedOfficial.id;
      const refreshed = await refreshWorkspace();
      if (refreshed) {
        setSelectedOfficialId(restoredId);
        setMode(opaqueId("view"));
        setStatusMessage(phase4OfficialsCopy.officialRestored);
        setTimeout(() => {
          headingRef.current?.focus();
        }, 0);
      }
    } catch {
      setErrorMessage(phase4OfficialsCopy.genericMutationError);
    } finally {
      setBusy(null);
    }
  };

  const assignmentCount = selectedOfficial
    ? workspace.assignments.filter((a) => a.officialId === selectedOfficial.id).length
    : 0;

  const windowCount = selectedOfficial ? (workspace.availability[selectedOfficial.id] ?? []).length : 0;

  const hasBanners = Boolean(statusMessage || scheduleWarning || errorMessage);

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
          {errorMessage ? (
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
        canEdit={workspace.canEdit}
        onOpenCreate={handleOpenCreate}
        busy={busy}
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
        ) : (
          <OfficialDetails
            official={selectedOfficial}
            assignmentCount={assignmentCount}
            windowCount={windowCount}
            canEdit={workspace.canEdit}
            busy={busy}
            isArchiveConfirm={mode === opaqueId("archive_confirm")}
            onOpenEdit={handleOpenEdit}
            onRequestArchive={handleRequestArchive}
            onConfirmArchive={handleArchive}
            onCancelArchive={handleCancelArchive}
            onRestore={handleRestore}
            headingRef={headingRef}
            archiveButtonRef={archiveButtonRef}
          />
        )}
      </div>
    </div>
  );
}
