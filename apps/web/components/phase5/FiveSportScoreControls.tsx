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
  presentation?: "full" | "remote";
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
  presentation,
  onActivate,
}: FiveSportScoreControlsProps) {
  const headingId = useId();
  const statusId = useId();
  const groups = buildFiveSportScoreControlGroups(definition);
  const disabled = readOnly || pending;
  const scoreActions = groups.find((group) => group.kind === "score")?.actions ?? [];
  const supportingGroups = groups.filter((group) => group.kind !== "score");

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

      <div id={statusId} className={styles.status}>
        {pending ? copy.pendingNotice : readOnly ? copy.readOnlyNotice : (statusMessage ?? "")}
      </div>

      {presentation === "remote" ? (
        <>
          <div className={styles.remoteScoreActions} aria-label={copy.groupLabels.score}>
            {scoreActions.map((action) => {
              const target = sideLabel(action.side);
              return (
                <button
                  type="button"
                  key={action.key}
                  className={styles.remoteScoreAction}
                  disabled={disabled}
                  aria-label={copy.formatActionLabel(action.control.label, target)}
                  data-control-id={action.control.id}
                  data-control-kind={action.group}
                  data-side={action.side ?? "global"}
                  onClick={(event) => onActivate(action, event.currentTarget)}
                >
                  <span>{action.control.label}</span>
                  {target ? <strong>{target}</strong> : null}
                </button>
              );
            })}
          </div>
          {supportingGroups.length ? (
            <details className={styles.moreActions}>
              <summary>{copy.groupLabels.operational}</summary>
              <div className={styles.groups}>
                {supportingGroups.map((group) => (
                  <fieldset className={styles.group} disabled={disabled} key={group.kind}>
                    <legend>{copy.groupLabels[group.kind]}</legend>
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
                            onClick={(event) => onActivate(action, event.currentTarget)}
                          >
                            <span>{action.control.label}</span>
                            {target ? <strong>{target}</strong> : null}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <div className={styles.groups}>
          {groups.map((group) => (
            <fieldset className={styles.group} disabled={disabled} key={group.kind}>
              <legend>{copy.groupLabels[group.kind]}</legend>
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
                      onClick={(event) => onActivate(action, event.currentTarget)}
                    >
                      <span>{action.control.label}</span>
                      {target ? <strong>{target}</strong> : null}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </section>
  );
}
