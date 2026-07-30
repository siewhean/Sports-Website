"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FiveSportScorecardDefinition } from "../../lib/five-sport-scorecard";
import {
  buildFiveSportScoreControlGroups,
  type ScoreControlAction,
  type ScoreControlSide,
} from "../../lib/five-sport-score-control-actions";
import { scoringControlPanelCopy } from "../../lib/scoring-control-panel-copy";
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

type LauncherModel = Readonly<{
  directScoreActions: readonly ScoreControlAction[];
  categoryActions: Readonly<Record<LauncherCategory, readonly ScoreControlAction[]>>;
  launcherCategories: readonly LauncherCategory[];
}>;

const launcherCategoriesInOrder: readonly LauncherCategory[] = ["score", "card", "timeout", "event", "other"];

const launcherCopy: Readonly<Record<LauncherCategory, { label: string; hint: string }>> = Object.freeze({
  score: { label: scoringControlPanelCopy.score, hint: scoringControlPanelCopy.scoreHint },
  card: { label: scoringControlPanelCopy.card, hint: scoringControlPanelCopy.cardHint },
  timeout: { label: scoringControlPanelCopy.timeout, hint: scoringControlPanelCopy.timeoutHint },
  event: { label: scoringControlPanelCopy.event, hint: scoringControlPanelCopy.eventHint },
  other: { label: scoringControlPanelCopy.other, hint: scoringControlPanelCopy.otherHint },
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

function buildLauncherModel(definition: FiveSportScorecardDefinition): LauncherModel {
  const actions = buildFiveSportScoreControlGroups(definition).flatMap((group) => group.actions);
  const scoreActions = actions.filter((action) => action.group === "score");
  const directScoreActions =
    scoreActions.length === 2 && new Set(scoreActions.map((action) => action.control.id)).size === 1
      ? scoreActions
      : [];
  const directKeys = new Set(directScoreActions.map((action) => action.key));
  const categoryActions: Record<LauncherCategory, ScoreControlAction[]> = {
    score: [],
    card: [],
    timeout: [],
    event: [],
    other: [],
  };

  for (const action of actions) {
    if (directKeys.has(action.key)) continue;
    categoryActions[categoryForAction(action)].push(action);
  }

  return Object.freeze({
    directScoreActions: Object.freeze([...directScoreActions]),
    categoryActions: Object.freeze(
      Object.fromEntries(
        launcherCategoriesInOrder.map((category) => [category, Object.freeze([...categoryActions[category]])]),
      ) as Record<LauncherCategory, readonly ScoreControlAction[]>,
    ),
    launcherCategories: Object.freeze(
      launcherCategoriesInOrder.filter((category) => categoryActions[category].length > 0),
    ),
  });
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
  const launcherModel = useMemo(() => buildLauncherModel(definition), [definition]);
  const disabled = readOnly || pending;

  const sideLabel = (side: ScoreControlSide | null) =>
    side === "home" ? homeLabel : side === "away" ? awayLabel : null;

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

  const pickerActions = pickerCategory ? launcherModel.categoryActions[pickerCategory] : [];
  const pickerLabel = pickerCategory ? launcherCopy[pickerCategory].label : scoringControlPanelCopy.event;

  return (
    <section className={styles.surface} aria-labelledby={headingId} aria-describedby={statusId}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>{scoringControlPanelCopy.liveControls}</span>
          <h2 id={headingId}>{scoringControlPanelCopy.controlPanel}</h2>
          <p>{definition.displayName}</p>
        </div>
        <p id={statusId} className={styles.status} data-state={pending ? "pending" : readOnly ? "locked" : "ready"}>
          {pending ? copy.pendingNotice : readOnly ? copy.readOnlyNotice : (statusMessage ?? copy.manualTimeOnlyNotice)}
        </p>
      </header>

      <dl className={styles.scoreboard} aria-label={scoringControlPanelCopy.currentScore}>
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
        {launcherModel.directScoreActions.map((action) => {
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
              <small>{scoringControlPanelCopy.addTimeAndPlayer}</small>
            </button>
          );
        })}

        {launcherModel.launcherCategories.map((category) => (
          <button
            type="button"
            key={category}
            className={styles.launcher}
            data-launcher-category={category}
            disabled={disabled}
            onClick={(event) => openPicker(category, event.currentTarget)}
          >
            <span>{launcherCopy[category].label}</span>
            <strong>{launcherModel.categoryActions[category].length}</strong>
            <small>{launcherCopy[category].hint}</small>
          </button>
        ))}
      </div>

      <p className={styles.detailsHint}>{scoringControlPanelCopy.detailsHint}</p>

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
          <span>{scoringControlPanelCopy.controlPanel}</span>
          <h3 id={pickerHeadingId}>{scoringControlPanelCopy.chooseCategory(pickerLabel)}</h3>
          <p id={pickerDescriptionId}>{scoringControlPanelCopy.pickerDescription}</p>
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
                <strong>{target ?? scoringControlPanelCopy.wholeMatch}</strong>
              </button>
            );
          })}
        </div>
        <footer>
          <button type="button" onClick={closePicker}>
            {scoringControlPanelCopy.close}
          </button>
        </footer>
      </dialog>
    </section>
  );
}
