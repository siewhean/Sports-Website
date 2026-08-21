"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [divisions, setDivisions] = useState(initialDivisions);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const commandRef = useRef<string | null>(null);
  const divisionCommandRef = useRef<PendingCommand | null>(null);
  const entryCommandRefs = useRef(new Map<string, PendingCommand>());
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
    router.refresh();
  }

  async function addEntry(event: FormEvent<HTMLFormElement>, divisionId: string) {
    event.preventDefault();
    if (!canEdit) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get(phase3EntriesMachine.entryNameField) ?? "").trim();
    const seed = Number(data.get(phase3EntriesMachine.entrySeedField));
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
            seed,
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
                  {phase3EntriesCopy.seed}
                  <input
                    name={phase3EntriesMachine.entrySeedField}
                    type="number"
                    min={1}
                    max={48}
                    defaultValue={nextSeed}
                    required
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

      <p className={error ? styles.error : styles.status} role={error ? "alert" : "status"} aria-live="polite">
        {error || message}
      </p>
    </div>
  );
}
