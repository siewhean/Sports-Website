"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { placeholderLabel } from "@matchday/domain";
import { NumberField } from "@matchday/ui/react";
import {
  isPlaceholderEntry,
  normalisePlannedCount,
  parseCreatedDivision,
  parseCreatedEntry,
  parsePlannedEntries,
  phase3EntriesCopy,
  phase3EntriesMachine,
  totalActiveEntries,
  validateDivisionInput,
  validateEntryInput,
  type EntryEditorDivision,
  type EntryEditorEntry,
} from "@/lib/phase3-entries";
import styles from "./EntriesEditor.module.css";

type ErrorEnvelope = { error?: { code?: unknown; message?: unknown } };
type PendingCommand = { fingerprint: string; key: string };
type CommandResult = { payload: unknown | null; clearKey: boolean };

function responseMessage(status: number, payload: unknown): string {
  if (status === 401 || status === 403) return phase3EntriesCopy.authRequired;
  const value = payload as ErrorEnvelope | null;
  const upstream = typeof value?.error?.message === "string" ? value.error.message : null;
  const code = typeof value?.error?.code === "string" ? value.error.code : null;
  if (status === 409 && code === phase3EntriesMachine.lockedByFormatCode) return phase3EntriesCopy.lockedByFormat;
  if (status === 409 && code === phase3EntriesMachine.archivedCode) return phase3EntriesCopy.archived;
  if (status === 409 && code === phase3EntriesMachine.revisionConflictCode) return phase3EntriesCopy.revisionConflict;
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
  const router = useRouter();
  const [divisions, setDivisions] = useState(initialDivisions);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const commandRef = useRef<string | null>(null);
  const divisionCommandRef = useRef<PendingCommand | null>(null);
  const entryCommandRefs = useRef(new Map<string, PendingCommand>());
  const planCommandRefs = useRef(new Map<string, PendingCommand>());
  const renameCommandRefs = useRef(new Map<string, PendingCommand>());
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

  /** Reuses the idempotency key while the same command is retried; a changed command gets a fresh key. */
  function pendingFor(store: Map<string, PendingCommand>, id: string, fingerprint: string): PendingCommand {
    const existing = store.get(id);
    const pending = existing?.fingerprint === fingerprint ? existing : { fingerprint, key: crypto.randomUUID() };
    store.set(id, pending);
    return pending;
  }

  function entriesUrl(divisionId: string, suffix = ""): string {
    return `/api/phase3/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/entries${suffix}`;
  }

  async function addDivision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const rawName = data.get(phase3EntriesMachine.divisionNameField);
    const code = String(data.get(phase3EntriesMachine.divisionCodeField) ?? "").trim();
    const rawLimit = data.get(phase3EntriesMachine.divisionLimitField);

    const validation = validateDivisionInput(rawName, rawLimit);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    const { name, entryLimit } = validation.value;
    const planned = normalisePlannedCount(data.get(phase3EntriesMachine.plannedCountField), entryLimit);
    if (!planned.ok) {
      setError(planned.error);
      return;
    }
    const plannedCount = planned.value;

    const fingerprint = JSON.stringify({ name, code, entryLimit, plannedCount });
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
          ...(plannedCount === null ? {} : { planned_entry_count: plannedCount }),
          idempotency_key: pending.key,
        }),
      }),
    );
    if (result.clearKey) divisionCommandRef.current = null;
    const division = parseCreatedDivision(result.payload, competitionId, entryLimit, plannedCount ?? undefined);
    if (!division) {
      if (result.payload !== null) setError(phase3EntriesCopy.invalidResponse);
      return;
    }
    divisionCommandRef.current = null;
    setDivisions((current) => [...current, division]);
    setMessage(phase3EntriesCopy.divisionCreated);
    form.reset();
    router.refresh();
  }

  async function addEntry(event: FormEvent<HTMLFormElement>, divisionId: string) {
    event.preventDefault();
    if (!canEdit) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const rawName = data.get(phase3EntriesMachine.entryNameField);
    const rawSeed = data.get(phase3EntriesMachine.entrySeedField);

    const validation = validateEntryInput(rawName, rawSeed);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    // The server is the source of truth for the free-plan entry limit; its
    // FREE_ENTRY_LIMIT_REACHED (422) response is mapped by responseMessage().
    const { name, seed } = validation.value;

    const pending = pendingFor(entryCommandRefs.current, divisionId, JSON.stringify({ divisionId, name, seed }));
    const result = await runCommand(pending.key, () =>
      fetch(entriesUrl(divisionId), {
        method: phase3EntriesMachine.post,
        headers: { "content-type": phase3EntriesMachine.applicationJson },
        body: JSON.stringify({
          name,
          entry_type: phase3EntriesMachine.teamEntryType,
          seed,
          idempotency_key: pending.key,
        }),
      }),
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
    router.refresh();
  }

  async function planEntries(event: FormEvent<HTMLFormElement>, divisionId: string, placesLeft: number) {
    event.preventDefault();
    if (!canEdit) return;
    const form = event.currentTarget;
    const planned = normalisePlannedCount(new FormData(form).get(phase3EntriesMachine.planCountField), placesLeft);
    if (!planned.ok || planned.value === null) {
      setError(planned.ok ? phase3EntriesCopy.planCountRequired : planned.error);
      return;
    }
    const count = planned.value;
    const pending = pendingFor(planCommandRefs.current, divisionId, JSON.stringify({ divisionId, count }));
    const result = await runCommand(pending.key, () =>
      fetch(entriesUrl(divisionId, "/plan"), {
        method: phase3EntriesMachine.post,
        headers: { "content-type": phase3EntriesMachine.applicationJson },
        body: JSON.stringify({ count, idempotency_key: pending.key }),
      }),
    );
    if (result.clearKey) planCommandRefs.current.delete(divisionId);
    const entries = parsePlannedEntries(result.payload, divisionId);
    if (!entries) {
      if (result.payload !== null) setError(phase3EntriesCopy.invalidResponse);
      return;
    }
    planCommandRefs.current.delete(divisionId);
    setDivisions((current) =>
      current.map((division) =>
        division.id === divisionId ? { ...division, entries: [...division.entries, ...entries] } : division,
      ),
    );
    setMessage(phase3EntriesCopy.planned);
    form.reset();
    router.refresh();
  }

  // Naming a placeholder converts it to a team. The API allows this after a format or schedule exists.
  async function renameEntry(event: FormEvent<HTMLFormElement>, divisionId: string, entry: EntryEditorEntry) {
    event.preventDefault();
    if (!canEdit) return;
    const validation = validateEntryInput(new FormData(event.currentTarget).get(phase3EntriesMachine.renameField));
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    const { name } = validation.value;
    const revision = entry.revision ?? 1;
    const pending = pendingFor(renameCommandRefs.current, entry.id, JSON.stringify({ name, revision }));
    const result = await runCommand(pending.key, () =>
      fetch(entriesUrl(divisionId, `/${encodeURIComponent(entry.id)}`), {
        method: phase3EntriesMachine.patch,
        headers: { "content-type": phase3EntriesMachine.applicationJson },
        body: JSON.stringify({
          revision,
          name,
          entry_type: phase3EntriesMachine.teamEntryType,
          idempotency_key: pending.key,
        }),
      }),
    );
    if (result.clearKey) renameCommandRefs.current.delete(entry.id);
    const updated = parseCreatedEntry(result.payload, divisionId);
    if (!updated || updated.id !== entry.id) {
      if (result.payload !== null) setError(phase3EntriesCopy.invalidResponse);
      return;
    }
    renameCommandRefs.current.delete(entry.id);
    setDivisions((current) =>
      current.map((division) =>
        division.id === divisionId
          ? { ...division, entries: division.entries.map((item) => (item.id === updated.id ? updated : item)) }
          : division,
      ),
    );
    setMessage(phase3EntriesCopy.renamed);
    router.refresh();
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
        <label>
          {phase3EntriesCopy.plannedTeams}
          <NumberField
            name={phase3EntriesMachine.plannedCountField}
            aria-describedby="planned-teams-hint"
            disabled={!canEdit}
          />
          <small id="planned-teams-hint" className={styles.hint}>
            {phase3EntriesCopy.plannedTeamsHint}
          </small>
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
          const placesLeft = Math.max(0, division.entryLimit - activeEntries.length);
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
                  {activeEntries.map((entry) => {
                    const placeholder = isPlaceholderEntry(entry);
                    const displayName = placeholder
                      ? placeholderLabel({
                          entry: {
                            id: entry.id,
                            name: entry.name,
                            entry_type: phase3EntriesMachine.placeholderEntryType,
                            seed: entry.seed,
                          },
                          divisionShortCode: division.shortCode ?? division.code,
                          multiDivision: divisions.length > 1,
                          fallbackIndex: entry.seed ?? undefined,
                        })
                      : entry.name;
                    return (
                      <li key={entry.id}>
                        <span>{entry.seed ?? "—"}</span>
                        <strong>
                          {placeholder ? <span className={styles.placeholderName}>{displayName}</span> : displayName}
                          {placeholder ? (
                            <span className={styles.placeholderBadge}>{phase3EntriesCopy.unnamedBadge}</span>
                          ) : null}
                        </strong>
                        <small>{entry.status}</small>
                        {placeholder ? (
                          <form
                            className={styles.renameEntry}
                            noValidate
                            onSubmit={(event) => renameEntry(event, division.id, entry)}
                          >
                            <label>
                              {phase3EntriesCopy.rename}
                              <input
                                name={phase3EntriesMachine.renameField}
                                maxLength={120}
                                autoComplete="off"
                                required
                                disabled={!canEdit}
                              />
                            </label>
                            <button type="submit" disabled={busy || !canEdit}>
                              {busy ? phase3EntriesCopy.busy : phase3EntriesCopy.renameSave}
                            </button>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p>{phase3EntriesCopy.empty}</p>
              )}
              <form
                className={styles.planEntries}
                noValidate
                onSubmit={(event) => planEntries(event, division.id, placesLeft)}
              >
                <label>
                  {phase3EntriesCopy.planMoreCount}
                  <NumberField name={phase3EntriesMachine.planCountField} disabled={!canEdit || divisionFull} />
                </label>
                <button type="submit" disabled={busy || divisionFull || !canEdit}>
                  {busy ? phase3EntriesCopy.busy : phase3EntriesCopy.planMore}
                </button>
              </form>
              <form className={styles.createEntry} noValidate onSubmit={(event) => addEntry(event, division.id)}>
                <label>
                  {phase3EntriesCopy.entryName}
                  <input name={phase3EntriesMachine.entryNameField} maxLength={120} required disabled={!canEdit} />
                </label>
                <label>
                  {phase3EntriesCopy.seed}
                  <NumberField name={phase3EntriesMachine.entrySeedField} defaultValue={nextSeed} disabled={!canEdit} />
                </label>
                <button type="submit" disabled={busy || divisionFull || !canEdit}>
                  {busy ? phase3EntriesCopy.busy : phase3EntriesCopy.addEntry}
                </button>
              </form>
            </section>
          );
        })}
      </div>

      <p className={error ? styles.error : styles.status} role={error ? "alert" : "status"} aria-live="polite">
        {error || message}
      </p>
    </div>
  );
}
