"use client";

import { type FormEvent, useRef, useState } from "react";
import {
  parseCreatedDivision,
  parseCreatedEntry,
  phase3EntriesCopy,
  phase3EntriesMachine,
  totalActiveEntries,
  type EntryEditorDivision,
} from "@/lib/phase3-entries";
import styles from "./EntriesEditor.module.css";

type ErrorEnvelope = { error?: { code?: unknown; message?: unknown } };
type PendingCommand = { fingerprint: string; key: string };
type CommandResult = { payload: unknown | null; clearKey: boolean };
type PendingDelete = { divisionId: string; entryId: string; entryName: string; revision: number };

function responseMessage(status: number, payload: unknown): string {
  if (status === 401 || status === 403) return phase3EntriesCopy.authRequired;
  const value = payload as ErrorEnvelope | null;
  const upstream = typeof value?.error?.message === "string" ? value.error.message : null;
  if (status === 422 && upstream?.toLowerCase().includes(phase3EntriesMachine.freePlanMessageFragment))
    return phase3EntriesCopy.freeLimitReached;
  return upstream ?? phase3EntriesCopy.commandFailed;
}

export function EntriesEditor({
  competitionId,
  initialDivisions,
  canEdit,
}: {
  competitionId: string;
  initialDivisions: readonly EntryEditorDivision[];
  canEdit: boolean;
}) {
  const [divisions, setDivisions] = useState(initialDivisions);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const commandRef = useRef<string | null>(null);
  const divisionCommandRef = useRef<PendingCommand | null>(null);
  const entryCommandRefs = useRef(new Map<string, PendingCommand>());
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const activeCount = totalActiveEntries(divisions);

  async function runCommand(commandId: string, operation: () => Promise<Response>): Promise<CommandResult> {
    if (busy || commandRef.current) return { payload: null, clearKey: false };
    commandRef.current = commandId;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await operation();
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(responseMessage(response.status, payload));
        return { payload: null, clearKey: response.status >= 400 && response.status < 500 };
      }
      return { payload, clearKey: false };
    } catch {
      setError(phase3EntriesCopy.commandFailed);
      return { payload: null, clearKey: false };
    } finally {
      commandRef.current = null;
      setBusy(false);
    }
  }

  async function addDivision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get(phase3EntriesMachine.divisionNameField) ?? "").trim();
    const code = String(data.get(phase3EntriesMachine.divisionCodeField) ?? "").trim();
    const entryLimit = Number(data.get(phase3EntriesMachine.divisionLimitField));
    const fingerprint = JSON.stringify({ name, code, entryLimit });
    const pending =
      divisionCommandRef.current?.fingerprint === fingerprint
        ? divisionCommandRef.current
        : { fingerprint, key: crypto.randomUUID() };
    divisionCommandRef.current = pending;
    const result = await runCommand(pending.key, () =>
      fetch(`/api/phase3/competitions/${encodeURIComponent(competitionId)}/divisions`, {
        method: phase3EntriesMachine.post,
        headers: { "content-type": phase3EntriesMachine.applicationJson },
        body: JSON.stringify({
          name,
          ...(code ? { code } : {}),
          entry_limit: entryLimit,
          idempotency_key: pending.key,
        }),
      }),
    );
    if (result.clearKey) divisionCommandRef.current = null;
    const division = parseCreatedDivision(result.payload, competitionId, entryLimit);
    if (!division) {
      if (result.payload !== null) setError(phase3EntriesCopy.invalidResponse);
      return;
    }
    divisionCommandRef.current = null;
    setDivisions((current) => [...current, division]);
    setMessage(phase3EntriesCopy.divisionCreated);
    form.reset();
  }

  async function addEntry(event: FormEvent<HTMLFormElement>, divisionId: string) {
    event.preventDefault();
    if (!canEdit) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get(phase3EntriesMachine.entryNameField) ?? "").trim();
    const rawSeed = String(data.get(phase3EntriesMachine.entrySeedField) ?? "").trim();
    const seed = rawSeed ? Number(rawSeed) : null;
    const fingerprint = JSON.stringify({ divisionId, name, seed });
    const existing = entryCommandRefs.current.get(divisionId);
    const pending = existing?.fingerprint === fingerprint ? existing : { fingerprint, key: crypto.randomUUID() };
    entryCommandRefs.current.set(divisionId, pending);
    const result = await runCommand(pending.key, () =>
      fetch(
        `/api/phase3/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/entries`,
        {
          method: phase3EntriesMachine.post,
          headers: { "content-type": phase3EntriesMachine.applicationJson },
          body: JSON.stringify({
            name,
            entry_type: phase3EntriesMachine.teamEntryType,
            ...(seed === null ? {} : { seed }),
            idempotency_key: pending.key,
          }),
        },
      ),
    );
    if (result.clearKey) entryCommandRefs.current.delete(divisionId);
    const entry = parseCreatedEntry(result.payload, divisionId);
    if (!entry) {
      if (result.payload !== null) setError(phase3EntriesCopy.invalidResponse);
      return;
    }
    entryCommandRefs.current.delete(divisionId);
    setDivisions((current) =>
      current.map((division) =>
        division.id === divisionId ? { ...division, entries: [...division.entries, entry] } : division,
      ),
    );
    setMessage(phase3EntriesCopy.entryCreated);
    form.reset();
  }

  async function updateEntry(event: FormEvent<HTMLFormElement>, divisionId: string, entryId: string, revision: number) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get(phase3EntriesMachine.entryNameField) ?? "").trim();
    const rawSeed = String(data.get(phase3EntriesMachine.entrySeedField) ?? "").trim();
    const seed = rawSeed ? Number(rawSeed) : null;
    const fingerprint = JSON.stringify({ divisionId, entryId, revision, name, seed });
    const existing = entryCommandRefs.current.get(`update:${entryId}`);
    const pending = existing?.fingerprint === fingerprint ? existing : { fingerprint, key: crypto.randomUUID() };
    entryCommandRefs.current.set(`update:${entryId}`, pending);
    const result = await runCommand(pending.key, () =>
      fetch(
        `/api/phase3/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/entries/${encodeURIComponent(entryId)}`,
        {
          method: phase3EntriesMachine.patch,
          headers: { "content-type": phase3EntriesMachine.applicationJson },
          body: JSON.stringify({ revision, name, seed, idempotency_key: pending.key }),
        },
      ),
    );
    const updated = parseCreatedEntry(result.payload, divisionId);
    if (!updated || updated.id !== entryId) {
      if (result.clearKey) entryCommandRefs.current.delete(`update:${entryId}`);
      return;
    }
    entryCommandRefs.current.delete(`update:${entryId}`);
    setDivisions((current) =>
      current.map((division) =>
        division.id === divisionId
          ? { ...division, entries: division.entries.map((entry) => (entry.id === entryId ? updated : entry)) }
          : division,
      ),
    );
    setMessage(phase3EntriesCopy.entryUpdated);
  }

  async function removeEntry(divisionId: string, entryId: string, revision: number) {
    if (!canEdit) return;
    const fingerprint = JSON.stringify({ divisionId, entryId, revision });
    const existing = entryCommandRefs.current.get(`delete:${entryId}`);
    const pending = existing?.fingerprint === fingerprint ? existing : { fingerprint, key: crypto.randomUUID() };
    entryCommandRefs.current.set(`delete:${entryId}`, pending);
    const result = await runCommand(pending.key, () =>
      fetch(
        `/api/phase3/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/entries/${encodeURIComponent(entryId)}`,
        {
          method: phase3EntriesMachine.delete,
          headers: { "content-type": phase3EntriesMachine.applicationJson },
          body: JSON.stringify({ revision, idempotency_key: pending.key }),
        },
      ),
    );
    if (
      !result.payload ||
      typeof result.payload !== "object" ||
      (result.payload as { deleted?: unknown }).deleted !== true
    ) {
      if (result.clearKey) entryCommandRefs.current.delete(`delete:${entryId}`);
      return;
    }
    entryCommandRefs.current.delete(`delete:${entryId}`);
    setDivisions((current) =>
      current.map((division) =>
        division.id === divisionId
          ? { ...division, entries: division.entries.filter((entry) => entry.id !== entryId) }
          : division,
      ),
    );
    setMessage(phase3EntriesCopy.entryRemoved);
  }

  function openDeleteDialog(deleteRequest: PendingDelete) {
    setPendingDelete(deleteRequest);
    queueMicrotask(() => {
      if (!deleteDialogRef.current?.open) deleteDialogRef.current?.showModal();
    });
  }

  function cancelDelete() {
    deleteDialogRef.current?.close();
  }

  function confirmDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = pendingDelete;
    if (!request) return;
    deleteDialogRef.current?.close();
    void removeEntry(request.divisionId, request.entryId, request.revision);
  }

  return (
    <div className={styles.workspace}>
      {!canEdit ? (
        <p className={styles.readOnly} role="status">
          {phase3EntriesCopy.readOnly}
        </p>
      ) : null}
      <section className={styles.usage} aria-labelledby="entry-usage-title">
        <div>
          <p id="entry-usage-title">{phase3EntriesCopy.freeUsage}</p>
          <strong>
            {activeCount} / {phase3EntriesMachine.maximumFreeEntries}
          </strong>
        </div>
        <p>{phase3EntriesCopy.freeLimit}</p>
        <progress
          aria-label={phase3EntriesCopy.freeUsage}
          max={phase3EntriesMachine.maximumFreeEntries}
          value={activeCount}
        />
      </section>

      <form className={styles.createDivision} onSubmit={addDivision}>
        <label>
          {phase3EntriesCopy.divisionName}
          <input name={phase3EntriesMachine.divisionNameField} maxLength={100} required disabled={!canEdit} />
        </label>
        <label>
          {phase3EntriesCopy.divisionCode}
          <input name={phase3EntriesMachine.divisionCodeField} maxLength={24} disabled={!canEdit} />
        </label>
        <label>
          {phase3EntriesCopy.divisionLimit}
          <select
            name={phase3EntriesMachine.divisionLimitField}
            defaultValue={phase3EntriesMachine.defaultDivisionLimit}
            disabled={!canEdit}
          >
            {[8, 12, 16, 24, 48].map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || !canEdit}>
          {busy ? phase3EntriesCopy.busy : phase3EntriesCopy.addDivision}
        </button>
      </form>

      <div className={styles.divisions}>
        {divisions.map((division) => {
          const activeEntries = division.entries.filter(
            (entry) => entry.status === "active" || entry.status === "confirmed",
          );
          const usedSeeds = new Set(activeEntries.flatMap((entry) => (entry.seed === null ? [] : [entry.seed])));
          const nextSeed =
            Array.from({ length: 48 }, (_, index) => index + 1).find((seed) => !usedSeeds.has(seed)) ?? 48;
          const divisionFull = activeEntries.length >= division.entryLimit;
          return (
            <section className={styles.division} key={division.id} aria-labelledby={`division-${division.id}`}>
              <header>
                <div>
                  <h2 id={`division-${division.id}`}>{division.name}</h2>
                  <p>
                    {activeEntries.length} / {division.entryLimit} {phase3EntriesCopy.confirmed}
                  </p>
                </div>
              </header>
              {activeEntries.length ? (
                <ol className={styles.entries}>
                  {activeEntries.map((entry) => (
                    <li key={entry.id}>
                      <span>{entry.seed ?? "—"}</span>
                      <strong>{entry.name}</strong>
                      <small>{entry.status}</small>
                      {canEdit ? (
                        <details>
                          <summary>{phase3EntriesCopy.editEntry}</summary>
                          <form onSubmit={(event) => void updateEntry(event, division.id, entry.id, entry.revision)}>
                            <label>
                              {phase3EntriesCopy.entryName}
                              <input
                                name={phase3EntriesMachine.entryNameField}
                                defaultValue={entry.name}
                                maxLength={120}
                                required
                              />
                            </label>
                            <label>
                              {phase3EntriesCopy.optionalSeed}
                              <input
                                name={phase3EntriesMachine.entrySeedField}
                                type="number"
                                min={1}
                                max={48}
                                defaultValue={entry.seed ?? ""}
                              />
                            </label>
                            <button type="submit" disabled={busy}>
                              {phase3EntriesCopy.saveEntry}
                            </button>
                          </form>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              openDeleteDialog({
                                divisionId: division.id,
                                entryId: entry.id,
                                entryName: entry.name,
                                revision: entry.revision,
                              })
                            }
                          >
                            {phase3EntriesCopy.removeEntry}
                          </button>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>{phase3EntriesCopy.empty}</p>
              )}
              <form className={styles.createEntry} onSubmit={(event) => addEntry(event, division.id)}>
                <label>
                  {phase3EntriesCopy.entryName}
                  <input name={phase3EntriesMachine.entryNameField} maxLength={120} required disabled={!canEdit} />
                </label>
                <label>
                  {phase3EntriesCopy.optionalSeed}
                  <input
                    name={phase3EntriesMachine.entrySeedField}
                    type="number"
                    min={1}
                    max={48}
                    placeholder={String(nextSeed)}
                    disabled={!canEdit}
                  />
                </label>
                <button type="submit" disabled={busy || divisionFull || !canEdit}>
                  {busy ? phase3EntriesCopy.busy : phase3EntriesCopy.addEntry}
                </button>
              </form>
            </section>
          );
        })}
      </div>

      <dialog
        ref={deleteDialogRef}
        onClose={() => setPendingDelete(null)}
        aria-describedby="entry-delete-description"
        aria-labelledby="entry-delete-title"
      >
        <form onSubmit={confirmDelete}>
          <h2 id="entry-delete-title">{phase3EntriesCopy.confirmRemoveEntry}</h2>
          <p id="entry-delete-description">
            {pendingDelete
              ? phase3EntriesCopy.removeEntryDescription.replace(
                  phase3EntriesMachine.entryNameToken,
                  pendingDelete.entryName,
                )
              : ""}
          </p>
          <button type="button" onClick={cancelDelete} disabled={busy}>
            {phase3EntriesCopy.cancel}
          </button>
          <button type="submit" disabled={busy || !pendingDelete}>
            {phase3EntriesCopy.removeEntry}
          </button>
        </form>
      </dialog>

      <p className={error ? styles.error : styles.status} role={error ? "alert" : "status"} aria-live="polite">
        {error || message}
      </p>
    </div>
  );
}
