"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Check, UserCircle } from "@phosphor-icons/react";
import { phase2Copy, phase2Machine, type ScoringSessionView } from "@/lib/phase2";
import type { ScoreControlAction } from "@/lib/five-sport-score-control-actions";
import type { FiveSportScorecardDefinition } from "@/lib/five-sport-scorecard";

export type ScoreActionDialogProps = {
  isOpen: boolean;
  definition: FiveSportScorecardDefinition;
  reversalTarget: ScoringSessionView["scoreState"]["actions"][number] | null;
  pendingAction: ScoreControlAction | null;
  home: string;
  away: string;
  matchLabel: string;
  period: string;
  setPeriod: (period: string) => void;
  eventTime: string;
  setEventTime: (time: string) => void;
  scorer: string;
  setScorer: (scorer: string) => void;
  reversalReason: string;
  setReversalReason: (reason: string) => void;
  scorerError: string;
  setScorerError: (error: string) => void;
  unknownParticipant: boolean;
  setUnknownParticipant: (unknown: boolean) => void;
  allowUnknownScorer: boolean;
  manualTimeEnabled: boolean;
  useSimpleCanoeControls: boolean;
  actionPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel?: () => void;
};

export function ScoreActionDialog({
  isOpen,
  definition,
  reversalTarget,
  pendingAction,
  home,
  away,
  matchLabel,
  period,
  setPeriod,
  eventTime,
  setEventTime,
  scorer,
  setScorer,
  reversalReason,
  setReversalReason,
  scorerError,
  setScorerError,
  unknownParticipant,
  setUnknownParticipant,
  allowUnknownScorer,
  manualTimeEnabled,
  useSimpleCanoeControls,
  actionPending,
  onClose,
  onConfirm,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: ScoreActionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (inputRef.current && !unknownParticipant) {
        inputRef.current.focus();
      } else {
        titleRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, unknownParticipant]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className="p2-goal-sheet p2-goal-sheet--open"
      open
      aria-labelledby="score-action-title"
      aria-describedby="score-action-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!actionPending) onClose();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="p2-goal-sheet__handle" aria-hidden="true" onPointerDown={onPointerDown} />
      <header>
        <p className="p2-eyebrow">{definition.displayName}</p>
        <h2 id="score-action-title" ref={titleRef} tabIndex={-1}>
          {reversalTarget
            ? phase2Copy.reversalTitle
            : pendingAction?.control.id === phase2Machine.goal
              ? phase2Copy.confirmGoalTitle
              : `${phase2Copy.recordEvent}: ${pendingAction?.control.label ?? ""}`}
        </h2>
        <p id="score-action-description">{reversalTarget ? phase2Copy.reversalBody : phase2Copy.actionDialogBody}</p>
      </header>
      <section className="p2-goal-sheet__team">
        <span>
          {(pendingAction?.side ?? reversalTarget?.side) === phase2Machine.home
            ? home
            : (pendingAction?.side ?? reversalTarget?.side) === phase2Machine.away
              ? away
              : matchLabel}
        </span>
        <strong>{reversalTarget?.label ?? pendingAction?.control.label}</strong>
      </section>
      <dl>
        <div>
          <dt>{definition.segmentLabel}</dt>
          <dd>{period}</dd>
        </div>
        {manualTimeEnabled ? (
          <div>
            <dt>{phase2Copy.eventTimeLabel}</dt>
            <dd>{eventTime}</dd>
          </div>
        ) : null}
      </dl>
      {useSimpleCanoeControls && !reversalTarget ? (
        <div className="p2-goal-sheet__details">
          <label>
            <span>{definition.segmentLabel}</span>
            <select value={period} onChange={(event) => setPeriod(event.target.value)}>
              {definition.segments.map((segment) => (
                <option key={segment.number} value={segment.number}>
                  {definition.segmentLabel} {segment.number}
                </option>
              ))}
            </select>
          </label>
          {manualTimeEnabled ? (
            <label>
              <span>{phase2Copy.eventTimeLabel}</span>
              <input
                type="text"
                inputMode="numeric"
                value={eventTime}
                onChange={(event) => setEventTime(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {reversalTarget || pendingAction?.control.participantAttribution !== "none" ? (
        <>
          <label>
            <span>{reversalTarget ? phase2Copy.reversalReason : phase2Copy.participantLabel}</span>
            <span className="p2-input-icon">
              <UserCircle />
              <input
                ref={inputRef}
                value={reversalTarget ? reversalReason : scorer}
                onChange={(event) =>
                  reversalTarget ? setReversalReason(event.target.value) : setScorer(event.target.value)
                }
                aria-invalid={Boolean(scorerError)}
                aria-describedby={scorerError ? "score-action-hint score-action-error" : "score-action-hint"}
                disabled={unknownParticipant}
                required={
                  Boolean(reversalTarget) ||
                  (pendingAction?.control.participantAttribution === "required" && !unknownParticipant)
                }
              />
            </span>
            <small id="score-action-hint">
              {reversalTarget ? phase2Copy.reversalReasonHint : phase2Copy.participantHint}
            </small>
            {scorerError ? (
              <em id="score-action-error" role="alert">
                {scorerError}
              </em>
            ) : null}
          </label>
          {!reversalTarget && allowUnknownScorer && pendingAction?.control.id === phase2Machine.goal ? (
            <label className="p2-check">
              <input
                type="checkbox"
                checked={unknownParticipant}
                onChange={(event) => {
                  setUnknownParticipant(event.target.checked);
                  if (event.target.checked) setScorerError("");
                }}
              />
              <span>
                {phase2Copy.unknownParticipant}
                <small>{phase2Copy.unknownParticipantHint}</small>
              </span>
            </label>
          ) : null}
        </>
      ) : null}
      <footer>
        <button className="p2-score-secondary" type="button" disabled={actionPending} onClick={onClose}>
          {phase2Copy.cancel}
        </button>
        <button className="p2-score-primary" type="button" disabled={actionPending} onClick={onConfirm}>
          {reversalTarget
            ? phase2Copy.confirmReversal
            : pendingAction?.control.id === phase2Machine.goal
              ? `${phase2Copy.recordGoalFor} ${pendingAction.side === phase2Machine.home ? home : away}`
              : phase2Copy.recordEvent}
          <Check />
        </button>
      </footer>
    </dialog>
  );
}
