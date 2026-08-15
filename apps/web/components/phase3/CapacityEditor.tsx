"use client";

import { useMemo, useState } from "react";
import { Gauge, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { translate as t } from "@matchday/ui";
import {
  capacityMutationBody,
  parseCapacityResponse,
  phase3CapacityCopy,
  phase3CapacityMachine,
  removeAreaLabel,
  validateCapacityDraft,
  type CapacityAreaDraft,
  type CapacityDocument,
  type CapacitySurfaceState,
  type CapacityWindowDraft,
} from "@/lib/phase3-capacity";
import styles from "./CapacityEditor.module.css";

function newWindow(): CapacityWindowDraft {
  return { id: crypto.randomUUID(), date: "", startTime: "09:00", endTime: "17:00", crossMidnight: false };
}

const stateCopy: Record<
  Exclude<CapacitySurfaceState, "ready" | "loading" | "empty">,
  { title: string; body: string }
> = {
  error: { title: phase3CapacityCopy.errorTitle, body: phase3CapacityCopy.errorBody },
  offline: { title: phase3CapacityCopy.offlineTitle, body: phase3CapacityCopy.offlineBody },
  permission: { title: phase3CapacityCopy.permissionTitle, body: phase3CapacityCopy.permissionBody },
  "read-only": { title: phase3CapacityCopy.permissionTitle, body: phase3CapacityCopy.permissionBody },
  conflict: { title: phase3CapacityCopy.conflictTitle, body: phase3CapacityCopy.conflictBody },
};

function newArea(index: number): CapacityAreaDraft {
  return {
    id: crypto.randomUUID(),
    name: `Area ${index + 1}`,
    sortOrder: index,
    slotMinutes: 30,
    fixedReserveSlots: 0,
    availability: [newWindow()],
    unavailable: [],
  };
}

export function CapacityEditor({ document }: { document: CapacityDocument }) {
  const [areas, setAreas] = useState<readonly CapacityAreaDraft[]>(() =>
    document.areas.length ? document.areas : [newArea(0)],
  );
  const [summary, setSummary] = useState(document.summary);
  const [revision, setRevision] = useState(document.revision);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [commandState, setCommandState] = useState<CapacitySurfaceState | null>(null);
  const issues = useMemo(() => validateCapacityDraft(areas), [areas]);
  const viewState = commandState ?? document.state;

  if (viewState === "loading") return <CapacitySkeleton />;

  if (viewState !== "ready" && viewState !== "empty" && viewState !== "read-only") {
    const copy = stateCopy[viewState as keyof typeof stateCopy];
    return <CapacityState title={copy.title} body={copy.body} />;
  }

  const editable = document.canEdit && viewState !== "read-only";

  function updateArea(index: number, patch: Partial<CapacityAreaDraft>) {
    setAreas((current) => current.map((area, areaIndex) => (areaIndex === index ? { ...area, ...patch } : area)));
    setDirty(true);
    setMessage("");
  }

  function updateWindow(
    areaIndex: number,
    kind: "availability" | "unavailable",
    windowIndex: number,
    patch: Partial<CapacityWindowDraft>,
  ) {
    const area = areas[areaIndex];
    if (!area) return;
    updateArea(areaIndex, {
      [kind]: area[kind].map((window, index) => (index === windowIndex ? { ...window, ...patch } : window)),
    });
  }

  function removeWindow(areaIndex: number, kind: "availability" | "unavailable", windowIndex: number) {
    const area = areas[areaIndex];
    if (!area) return;
    updateArea(areaIndex, { [kind]: area[kind].filter((_, index) => index !== windowIndex) });
  }

  async function save() {
    if (!editable || busy || Object.keys(issues).length) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/phase3/competitions/${encodeURIComponent(document.competitionId)}/capacity`, {
        method: phase3CapacityMachine.put,
        headers: { "content-type": phase3CapacityMachine.applicationJson },
        body: JSON.stringify(capacityMutationBody(revision, document.timezone, areas)),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setCommandState(phase3CapacityMachine.permission);
        else if (response.status === 409) setCommandState(phase3CapacityMachine.conflict);
        else setMessage(phase3CapacityCopy.commandFailed);
        return;
      }
      const parsed = parseCapacityResponse(await response.json().catch(() => null), document.competitionId);
      if (!parsed) {
        setMessage(phase3CapacityCopy.commandFailed);
        return;
      }
      setSummary(parsed.effective);
      setAreas(parsed.areas);
      setRevision(parsed.revision);
      setDirty(false);
      setMessage(phase3CapacityCopy.saved);
    } catch {
      setCommandState(phase3CapacityMachine.offline);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.layout} data-testid="phase3-capacity">
      <p className={styles.live} aria-live="polite">
        {message}
      </p>
      <form
        className={styles.editor}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className={styles.editorHeader}>
          <div>
            <p className={styles.kicker}>{phase3CapacityCopy.playingAreas}</p>
            <h2>{document.competitionName}</h2>
            <p>{phase3CapacityCopy.intro}</p>
          </div>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={!editable || busy}
            onClick={() => {
              setAreas((current) => [...current, newArea(current.length)]);
              setDirty(true);
            }}
          >
            <Plus aria-hidden="true" />
            {phase3CapacityCopy.addArea}
          </button>
        </header>

        <dl className={styles.sourceMeta}>
          <div>
            <dt>{phase3CapacityCopy.revision}</dt>
            <dd>{revision}</dd>
          </div>
          <div>
            <dt>{phase3CapacityCopy.timezone}</dt>
            <dd>{document.timezone}</dd>
          </div>
        </dl>

        <div className={styles.areaList}>
          {areas.map((area, areaIndex) => (
            <fieldset className={styles.area} key={area.id} disabled={!editable || busy}>
              <legend>{area.name || `Area ${areaIndex + 1}`}</legend>
              <div className={styles.areaFields}>
                <Field label={phase3CapacityCopy.areaName} error={issues[`area-${areaIndex}-name`]}>
                  <input value={area.name} onChange={(event) => updateArea(areaIndex, { name: event.target.value })} />
                </Field>
                <Field label={phase3CapacityCopy.slotMinutes} error={issues[`area-${areaIndex}-slot`]}>
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={area.slotMinutes}
                    onChange={(event) => updateArea(areaIndex, { slotMinutes: Number(event.target.value) })}
                  />
                </Field>
                <Field label={phase3CapacityCopy.reserveSlots} error={issues[`area-${areaIndex}-reserve`]}>
                  <input
                    type="number"
                    min={0}
                    value={area.fixedReserveSlots}
                    onChange={(event) => updateArea(areaIndex, { fixedReserveSlots: Number(event.target.value) })}
                  />
                </Field>
              </div>

              <WindowGroup
                title={phase3CapacityCopy.availableWindows}
                windows={area.availability}
                areaIndex={areaIndex}
                kind="availability"
                error={issues[`area-${areaIndex}-availability`]}
                windowErrors={area.availability.map(
                  (_, windowIndex) => issues[`area-${areaIndex}-availability-${windowIndex}`],
                )}
                onUpdate={updateWindow}
                onRemove={removeWindow}
                onAdd={() => updateArea(areaIndex, { availability: [...area.availability, newWindow()] })}
              />
              <WindowGroup
                title={phase3CapacityCopy.unavailableWindows}
                windows={area.unavailable}
                areaIndex={areaIndex}
                kind="unavailable"
                windowErrors={area.unavailable.map(
                  (_, windowIndex) => issues[`area-${areaIndex}-unavailable-${windowIndex}`],
                )}
                onUpdate={updateWindow}
                onRemove={removeWindow}
                onAdd={() => updateArea(areaIndex, { unavailable: [...area.unavailable, newWindow()] })}
              />
              <button
                className={styles.removeArea}
                type="button"
                disabled={!editable || busy || areas.length === 1}
                onClick={() => {
                  setAreas((current) => current.filter((_, index) => index !== areaIndex));
                  setDirty(true);
                }}
              >
                <Trash aria-hidden="true" />
                {removeAreaLabel(area.name || `Area ${areaIndex + 1}`)}
              </button>
            </fieldset>
          ))}
        </div>

        {Object.keys(issues).length ? (
          <p className={styles.formError} role="alert">
            {phase3CapacityCopy.reviewFields}
          </p>
        ) : null}
        {message === phase3CapacityCopy.commandFailed ? (
          <p className={styles.formError} role="alert">
            {message}
          </p>
        ) : null}
        <footer className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="submit"
            disabled={!editable || busy || !dirty || Object.keys(issues).length > 0}
          >
            {busy ? phase3CapacityCopy.saving : phase3CapacityCopy.save}
          </button>
          <span>{dirty ? phase3CapacityCopy.unsaved : phase3CapacityCopy.saved}</span>
        </footer>
      </form>

      <CapacityRail summary={summary} />
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
      {error ? <small role="alert">{error}</small> : null}
    </label>
  );
}

function WindowGroup({
  title,
  windows,
  areaIndex,
  kind,
  error,
  windowErrors,
  onUpdate,
  onRemove,
  onAdd,
}: {
  title: string;
  windows: readonly CapacityWindowDraft[];
  areaIndex: number;
  kind: "availability" | "unavailable";
  error?: string;
  windowErrors: readonly (string | undefined)[];
  onUpdate(
    areaIndex: number,
    kind: "availability" | "unavailable",
    windowIndex: number,
    patch: Partial<CapacityWindowDraft>,
  ): void;
  onRemove(areaIndex: number, kind: "availability" | "unavailable", windowIndex: number): void;
  onAdd(): void;
}) {
  return (
    <section className={styles.windowGroup} aria-label={title}>
      <header>
        <h3>{title}</h3>
        <button className={styles.textButton} type="button" onClick={onAdd}>
          <Plus aria-hidden="true" />
          {kind === "availability" ? phase3CapacityCopy.addWindow : phase3CapacityCopy.addBreak}
        </button>
      </header>
      {windows.map((window, windowIndex) => {
        const crossMidnightHelpId = `${kind}-${areaIndex}-${windowIndex}-cross-midnight-help`;
        return (
          <div className={styles.windowRow} key={window.id}>
            <div className={styles.window}>
              <Field label={phase3CapacityCopy.date}>
                <input
                  type="date"
                  value={window.date}
                  aria-invalid={Boolean(windowErrors[windowIndex])}
                  aria-describedby={windowErrors[windowIndex] ? `${kind}-${areaIndex}-${windowIndex}-error` : undefined}
                  onChange={(event) => onUpdate(areaIndex, kind, windowIndex, { date: event.target.value })}
                />
              </Field>
              <Field label={phase3CapacityCopy.starts}>
                <input
                  type="time"
                  value={window.startTime}
                  aria-invalid={Boolean(windowErrors[windowIndex])}
                  aria-describedby={windowErrors[windowIndex] ? `${kind}-${areaIndex}-${windowIndex}-error` : undefined}
                  onChange={(event) => onUpdate(areaIndex, kind, windowIndex, { startTime: event.target.value })}
                />
              </Field>
              <Field label={phase3CapacityCopy.ends}>
                <input
                  type="time"
                  value={window.endTime}
                  aria-invalid={Boolean(windowErrors[windowIndex])}
                  aria-describedby={windowErrors[windowIndex] ? `${kind}-${areaIndex}-${windowIndex}-error` : undefined}
                  onChange={(event) => onUpdate(areaIndex, kind, windowIndex, { endTime: event.target.value })}
                />
              </Field>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={window.crossMidnight}
                  aria-describedby={crossMidnightHelpId}
                  onChange={(event) => onUpdate(areaIndex, kind, windowIndex, { crossMidnight: event.target.checked })}
                />
                <span>
                  {phase3CapacityCopy.crossMidnight}
                  <br />
                  <small id={crossMidnightHelpId}>{t("prototype.813643f18b43")}</small>
                </span>
              </label>
              <button
                className={styles.iconButton}
                type="button"
                aria-label={`${phase3CapacityCopy.remove} ${title.toLowerCase()} ${windowIndex + 1}`}
                onClick={() => onRemove(areaIndex, kind, windowIndex)}
              >
                <Trash aria-hidden="true" />
              </button>
            </div>
            {windowErrors[windowIndex] ? (
              <p id={`${kind}-${areaIndex}-${windowIndex}-error`} className={styles.formError} role="alert">
                {windowErrors[windowIndex]}
              </p>
            ) : null}
          </div>
        );
      })}
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function CapacityRail({ summary }: { summary: CapacityDocument["summary"] }) {
  return (
    <aside className={styles.rail} aria-label={phase3CapacityCopy.status}>
      <Gauge aria-hidden="true" />
      <p className={styles.kicker}>{phase3CapacityCopy.status}</p>
      <h2>{summary ? phase3CapacityCopy[summary.status] : phase3CapacityCopy.emptyTitle}</h2>
      {summary ? (
        <dl>
          <div>
            <dt>{phase3CapacityCopy.available}</dt>
            <dd>{summary.availableMatchSlots}</dd>
          </div>
          <div>
            <dt>{phase3CapacityCopy.required}</dt>
            <dd>{summary.requiredMatchSlots}</dd>
          </div>
          <div>
            <dt>{phase3CapacityCopy.remaining}</dt>
            <dd>{summary.remainingMatchSlots}</dd>
          </div>
        </dl>
      ) : (
        <p>{phase3CapacityCopy.emptyBody}</p>
      )}
    </aside>
  );
}

function CapacityState({ title, body }: { title: string; body: string }) {
  return (
    <section className={styles.state}>
      <WarningCircle aria-hidden="true" />
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

function CapacitySkeleton() {
  return (
    <section className={styles.state} aria-busy="true" aria-label={phase3CapacityCopy.loading}>
      <Gauge aria-hidden="true" />
      <h2>{phase3CapacityCopy.loading}</h2>
    </section>
  );
}
