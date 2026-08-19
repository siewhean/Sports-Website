import type { RefObject } from "react";
import type { ScoringSessionView } from "@/lib/phase2";

type ScoreHistoryDialogProps = {
  dialogRef: RefObject<HTMLDialogElement | null>;
  segmentLabel: string;
  actions: ScoringSessionView["scoreState"]["actions"];
  eventLogTitle: string;
  closeEventsLabel: string;
  scorerLabel: string;
  incidentLabel: string;
  noEventsLabel: string;
  onClose: () => void;
};

export function ScoreHistoryDialog({
  dialogRef,
  segmentLabel,
  actions,
  eventLogTitle,
  closeEventsLabel,
  scorerLabel,
  incidentLabel,
  noEventsLabel,
  onClose,
}: ScoreHistoryDialogProps) {
  return (
    <dialog
      className="p2-score-history-sheet"
      ref={dialogRef}
      aria-labelledby="event-log-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="event-log-title">{eventLogTitle}</h2>
        <button className="p2-score-secondary" type="button" onClick={onClose}>
          {closeEventsLabel}
        </button>
      </header>
      <section className="p2-event-log">
        {actions.length ? (
          <ol>
            {[...actions].reverse().map((action) => (
              <li key={action.eventId}>
                <time dateTime={action.occurredAt}>
                  {segmentLabel} {action.segmentNumber}
                </time>
                <span>
                  <strong>{action.label}</strong>
                  <small>
                    {action.participantId ? `${scorerLabel}: ${action.participantId}` : (action.side ?? incidentLabel)}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>{noEventsLabel}</p>
        )}
      </section>
    </dialog>
  );
}
