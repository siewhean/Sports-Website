"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FiveSportScorecardDefinition } from "../../lib/five-sport-scorecard";
import {
  buildFiveSportScoreControlGroups,
  type ScoreControlAction,
  type ScoreControlSide,
} from "../../lib/five-sport-score-control-actions";
import styles from "./FiveSportScoreControls.module.css";

export type FiveSportScoreControlsCopy = Readonly<{
  title: string;
  manualTimeOnlyNotice: string;
  readOnlyNotice: string;
  pendingNotice: string;
  groupLabels: Readonly<Record<ScoreControlAction["group"], string>>;
  formatActionLabel: (controlLabel: string, sideLabel: string | null) => string;
}>;

export type FiveSportScoreControlsProps = Readonly<{
  definition: FiveSportScorecardDefinition;
  homeLabel: string;
  awayLabel: string;
  score: Readonly<Record<ScoreControlSide, number>>;
  copy: FiveSportScoreControlsCopy;
  readOnly: boolean;
  pending: boolean;
  statusMessage?: string | null;
  onActivate: (action: ScoreControlAction, trigger: HTMLButtonElement) => void;
}>;

type LauncherCategory = "score" | "card" | "timeout" | "event" | "other";

const launcherCopy: Readonly<Record<LauncherCategory, { label: string; hint: string }>> = Object.freeze({
  score: { label: "Score", hint: "Choose scoring action" },
  card: { label: "Card", hint: "Select card and team" },
  timeout: { label: "Timeout", hint: "Select timeout and team" },
  event: { label: "Event", hint: "Record an incident or match event" },
  other: { label: "Other", hint: "Segment and exceptional outcomes" },
});

function categoryForAction(action: ScoreControlAction): LauncherCategory {
  if (action.group === "score") return "score";
  const id = action.control.id.toLowerCase();
  const label = action.control.label.toLowerCase();
  if (id.includes("card") || label.includes("card")) return "card";
  if (id.includes("timeout") || label.includes("timeout")) return "timeout";
  if (action.group === "operational") return "event";
  return "other";
}

export function FiveSportScoreControls({
  definition,
  homeLabel,
  awayLabel,
  score,
  copy,
  readOnly,
  pending,
  statusMessage,
  onActivate,
}: FiveSportScoreControlsProps) {
  const headingId = useId();
  const statusId = useId();
  const pickerHeadingId = useId();
  const pickerDescriptionId = useId();
  const [pickerCategory, setPickerCategory] = useState<LauncherCategory | null>(null);
  const pickerRef = useRef<HTMLDialogElement>(null);
  const categoryReturnTargetRef = useRef<HTMLButtonElement | null>(null);
  const groups = useMemo(() => buildFiveSportScoreControlGroups(definition), [definition]);
  const actions = useMemo(() => groups.flatMap((group) => group.actions), [groups]);
  const disabled = readOnly || pending;

  const sideLabel = (side: ScoreControlSide | null) =>
    side === "home" ? homeLabel : side === "away" ? awayLabel : null;

  const scoreActions = actions.filter((action) => action.group === "score");
  const directScoreActions =
    scoreActions.length === 2 && new Set(scoreActions.map((action) => action.control.id)).size === 1
      ? scoreActions
      : [];

  const categoryActions = useMemo(() => {
    const result: Record<LauncherCategory, ScoreControlAction[]> = {
      score: [],
      card: [],
      timeout: [],
      event: [],
      other: [],
    };
    for (const action of actions) {
      if (directScoreActions.includes(action)) continue;
      result[categoryForAction(action)].push(action);
    }
    return result;
  }, [actions, directScoreActions]);

  const launcherCategories = (Object.keys(categoryActions) as LauncherCategory[]).filter(
    (category) => categoryActions[category].length > 0,
  );

  useEffect(() => {
    const dialog = pickerRef.current;
    if (!dialog) return;
    if (pickerCategory && !dialog.open) dialog.showModal();
    if (!pickerCategory && dialog.open) dialog.close();
  }, [pickerCategory]);

  const openPicker = (category: LauncherCategory, trigger: HTMLButtonElement) => {
    categoryReturnTargetRef.current = trigger;
    setPickerCategory(category);
  };

  const closePicker = () => {
    pickerRef.current?.close();
    setPickerCategory(null);
    window.requestAnimationFrame(() => categoryReturnTargetRef.current?.focus({ preventScroll: true }));
  };

  const chooseAction = (action: ScoreControlAction, trigger: HTMLButtonElement) => {
    const returnTarget = categoryReturnTargetRef.current ?? trigger;
    pickerRef.current?.close();
    setPickerCategory(null);
    window.requestAnimationFrame(() => onActivate(action, returnTarget));
  };

  const pickerActions = pickerCategory ? categoryActions[pickerCategory] : [];
  const pickerLabel = pickerCategory ? launcherCopy[pickerCategory].label : "Event";

  return (
    <section className={styles.surface} aria-labelledby={headingId} aria-describedby={statusId}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Live controls</span>
          <h2 id={headingId}>Control panel</h2>
          <p>{definition.displayName}</p>
        </div>
        <p id={statusId} className={styles.status} data-state={pending ? "pending" : readOnly ? "locked" : "ready"}>
          {pending ? copy.pendingNotice : readOnly ? copy.readOnlyNotice : (statusMessage ?? copy.manualTimeOnlyNotice)}
        </p>
      </header>

      <dl className={styles.scoreboard} aria-label="Current score">
        <div>
          <dt>{homeLabel}</dt>
          <dd>{score.home}</dd>
        </div>
        <span aria-hidden="true">–</span>
        <div>
          <dt>{awayLabel}</dt>
          <dd>{score.away}</dd>
        </div>
      </dl>

      <div className={styles.launchers} role="group" aria-label={copy.title}>
        {directScoreActions.map((action) => {
          const target = sideLabel(action.side);
          return (
            <button
              type="button"
              key={action.key}
              className={`${styles.launcher} ${styles.primaryLauncher}`}
              aria-label={copy.formatActionLabel(action.control.label, target)}
              data-control-id={action.control.id}
              data-control-kind={action.group}
              data-side={action.side ?? "global"}
              disabled={disabled}
              onClick={(event) => onActivate(action, event.currentTarget)}
            >
              <span>{action.control.label}</span>
              <strong>{target}</strong>
              <small>Add time and player</small>
            </button>
          );
        })}

        {launcherCategories.map((category) => (
          <button
            type="button"
            key={category}
            className={styles.launcher}
            data-launcher-category={category}
            disabled={disabled}
            onClick={(event) => openPicker(category, event.currentTarget)}
          >
            <span>{launcherCopy[category].label}</span>
            <strong>{categoryActions[category].length}</strong>
            <small>{launcherCopy[category].hint}</small>
          </button>
        ))}
      </div>

      <p className={styles.detailsHint}>Tap an event. The next card collects the time, team and player details.</p>

      <dialog
        ref={pickerRef}
        className={styles.picker}
        aria-labelledby={pickerHeadingId}
        aria-describedby={pickerDescriptionId}
        onClose={() => setPickerCategory(null)}
        onCancel={(event) => {
          event.preventDefault();
          closePicker();
        }}
      >
        <div className={styles.pickerHandle} aria-hidden="true" />
        <header>
          <span>Control panel</span>
          <h3 id={pickerHeadingId}>Choose {pickerLabel.toLowerCase()}</h3>
          <p id={pickerDescriptionId}>Select the exact event, then add the match time and participant details.</p>
        </header>
        <div className={styles.pickerActions}>
          {pickerActions.map((action) => {
            const target = sideLabel(action.side);
            return (
              <button
                type="button"
                key={action.key}
                aria-label={copy.formatActionLabel(action.control.label, target)}
                data-control-id={action.control.id}
                data-control-kind={action.group}
                data-side={action.side ?? "global"}
                onClick={(event) => chooseAction(action, event.currentTarget)}
              >
                <span>{action.control.label}</span>
                <strong>{target ?? "Whole match"}</strong>
              </button>
            );
          })}
        </div>
        <footer>
          <button type="button" onClick={closePicker}>
            Close
          </button>
        </footer>
      </dialog>
    </section>
  );
}
