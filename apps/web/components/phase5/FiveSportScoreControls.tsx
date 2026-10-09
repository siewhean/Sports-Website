"use client";

import { useId } from "react";
import type { FiveSportScorecardDefinition, ScorecardControlKind } from "../../lib/five-sport-scorecard";
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
  groupLabels: Readonly<Record<ScorecardControlKind, string>>;
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
  /** Hide the built-in scoreboard when the host screen already shows a big live score. */
  showScoreboard?: boolean;
  onActivate: (action: ScoreControlAction, trigger: HTMLButtonElement) => void;
}>;

export function FiveSportScoreControls({
  definition,
  homeLabel,
  awayLabel,
  score,
  copy,
  readOnly,
  pending,
  statusMessage,
  showScoreboard = true,
  onActivate,
}: FiveSportScoreControlsProps) {
  const headingId = useId();
  const statusId = useId();
  const groups = buildFiveSportScoreControlGroups(definition);
  const disabled = readOnly || pending;

  const sideLabel = (side: ScoreControlSide | null) =>
    side === "home" ? homeLabel : side === "away" ? awayLabel : null;

  return (
    <section className={styles.surface} aria-labelledby={headingId} aria-describedby={statusId}>
      <header className={styles.header}>
        <div>
          <h2 id={headingId}>{copy.title}</h2>
          <p>{definition.displayName}</p>
        </div>
        <p className={styles.clockNotice}>{copy.manualTimeOnlyNotice}</p>
      </header>

      {showScoreboard ? (
        <dl className={styles.scoreboard}>
          <div>
            <dt>{homeLabel}</dt>
            <dd>{score.home}</dd>
          </div>
          <div>
            <dt>{awayLabel}</dt>
            <dd>{score.away}</dd>
          </div>
        </dl>
      ) : null}

      <div id={statusId} className={styles.status}>
        {pending ? copy.pendingNotice : readOnly ? copy.readOnlyNotice : (statusMessage ?? "")}
      </div>

      <div className={styles.groups}>
        {groups.map((group) => {
          const actions = (
            <div className={styles.actions}>
              {group.actions.map((action) => {
                const target = sideLabel(action.side);
                return (
                  <button
                    type="button"
                    key={action.key}
                    className={styles.action}
                    aria-label={copy.formatActionLabel(action.control.label, target)}
                    data-control-id={action.control.id}
                    data-control-kind={action.group}
                    data-side={action.side ?? "global"}
                    disabled={disabled}
                    onClick={(event) => onActivate(action, event.currentTarget)}
                  >
                    <span>{action.control.label}</span>
                    {target ? <strong>{target}</strong> : null}
                  </button>
                );
              })}
            </div>
          );
          return group.kind === "score" ? (
            <fieldset className={`${styles.group} ${styles.primaryGroup}`} key={group.kind}>
              <legend>{copy.groupLabels[group.kind]}</legend>
              {actions}
            </fieldset>
          ) : (
            <details className={styles.secondaryGroup} key={group.kind}>
              <summary>
                {copy.groupLabels[group.kind]} <span>{group.actions.length}</span>
              </summary>
              {actions}
            </details>
          );
        })}
      </div>
    </section>
  );
}
