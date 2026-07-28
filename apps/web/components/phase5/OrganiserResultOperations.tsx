"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ClockCounterClockwise, ShieldWarning, X } from "@phosphor-icons/react";
import type { MatchView } from "@/lib/phase2";
import {
  buildAtomicSegmentWinnerCommands,
  buildCanonicalReplacementCommand,
  gateCResultsCopy as copy,
  gateCResultsMachine as machine,
  parseMatchScoringAudit,
  parseResultConflict,
  parseResultConflicts,
  parseResultMutationReceipt,
  type MatchScoringAudit,
  type ResultConflict,
} from "@/lib/gate-c-results";
import styles from "@/components/phase3/ResultsWorkspace.module.css";

type PendingResultCommand = Readonly<{
  fingerprint: string;
  clientEventId: string;
  events: readonly Readonly<Record<string, unknown>>[];
}>;

function demoAudit(match: MatchView): MatchScoringAudit {
  return {
    match: {
      id: match.id,
      label: match.label,
      sportCode: machine.canoePolo,
      state:
        match.status === "final" ? machine.finalised : match.status === "live" ? machine.inProgress : machine.scheduled,
      homeName: match.home,
      awayName: match.away,
      homeScore: match.homeScore ?? 0,
      awayScore: match.awayScore ?? 0,
      aggregateVersion: 9,
      resultVersion: 3,
    },
    segments: [],
    events: [
      {
        eventId: "70000000-0000-4000-8000-000000000007",
        sequence: 7,
        type: "goal",
        side: machine.home,
        participantLabel: match.home,
        reason: null,
        reversalTargetEventId: null,
        occurredAt: "2026-08-16T02:42:00.000Z",
        actorLabel: match.area,
        reversed: false,
        segmentNumber: 1,
        manualTimeSeconds: 120,
        unknownParticipant: false,
        reversible: true,
      },
      {
        eventId: "80000000-0000-4000-8000-000000000008",
        sequence: 8,
        type: "goal",
        side: machine.away,
        participantLabel: match.away,
        reason: null,
        reversalTargetEventId: null,
        occurredAt: "2026-08-16T02:45:00.000Z",
        actorLabel: match.area,
        reversed: false,
        segmentNumber: 1,
        manualTimeSeconds: 180,
        unknownParticipant: false,
        reversible: true,
      },
    ],
    audit: [
      {
        id: "90000000-0000-4000-8000-000000000009",
        action: machine.finalised,
        actorLabel: match.area,
        reason: null,
        occurredAt: "2026-08-16T02:50:00.000Z",
      },
    ],
    canManage: true,
  };
}

function mutationError(status: number): string {
  if (status === 401 || status === 403) return copy.readOnly;
  if (status === 409) return copy.conflictRefresh;
  return copy.unavailable;
}

export function OrganiserResultOperations({
  competitionId,
  matches,
  initialMatchId,
  enableRemote,
}: {
  competitionId: string;
  matches: readonly MatchView[];
  initialMatchId?: string;
  enableRemote: boolean;
}) {
  const completed = useMemo(
    () => matches.filter((match) => match.status === "final" || (match.status === "live" && match.resultVersion)),
    [matches],
  );
  const [matchId, setMatchId] = useState(
    initialMatchId && completed.some((match) => match.id === initialMatchId) ? initialMatchId : "",
  );
  const [document, setDocument] = useState<MatchScoringAudit | null>(null);
  const [conflicts, setConflicts] = useState<ResultConflict[]>([]);
  const [conflictState, setConflictState] = useState<(typeof machine)["loading" | "ready" | "error"]>(machine.loading);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [reason, setReason] = useState("");
  const [eventId, setEventId] = useState("");
  const [includeReplacement, setIncludeReplacement] = useState(false);
  const [flipSegmentWinner, setFlipSegmentWinner] = useState(false);
  const [additionalReversalIds, setAdditionalReversalIds] = useState<string[]>([]);
  const [replacementPointCount, setReplacementPointCount] = useState(1);
  const [replacementSide, setReplacementSide] = useState<"home" | "away">(machine.home);
  const [replacementParticipant, setReplacementParticipant] = useState("");
  const [conflict, setConflict] = useState<ResultConflict | null>(null);
  const [acknowledgementReason, setAcknowledgementReason] = useState("");
  const acknowledgementClientEventId = useRef("");
  const pendingResultCommand = useRef<PendingResultCommand | null>(null);
  const selectedMatchIdRef = useRef(matchId);
  const loadGeneration = useRef(0);
  const reopenDialog = useRef<HTMLDialogElement>(null);
  const correctionDialog = useRef<HTMLDialogElement>(null);
  const conflictDialog = useRef<HTMLDialogElement>(null);
  const reopenTrigger = useRef<HTMLButtonElement>(null);
  const correctionTrigger = useRef<HTMLButtonElement>(null);
  const conflictTrigger = useRef<HTMLButtonElement | null>(null);
  const matchStatus = useRef<HTMLDivElement>(null);
  const conflictStatus = useRef<HTMLElement>(null);

  function invalidatePendingResultCommand() {
    pendingResultCommand.current = null;
  }

  const loadConflicts = useCallback(async () => {
    setConflictState(machine.loading);
    try {
      if (!enableRemote) {
        const source = completed[0] ?? matches[0];
        setConflicts(
          source
            ? [
                {
                  id: "a0000000-0000-4000-8000-00000000000a",
                  sourceMatchId: source.id,
                  downstreamMatchId: matches.find((match) => match.status === "live")?.id ?? source.id,
                  reason: machine.inProgress,
                  status: machine.open,
                  revision: 1,
                  createdAt: "2026-08-16T03:00:00.000Z",
                  acknowledgementReason: null,
                  acknowledgedAt: null,
                },
              ]
            : [],
        );
        setConflictState(machine.ready);
        return;
      }
      const response = await fetch(`/api/gate-c/competitions/${encodeURIComponent(competitionId)}/result-conflicts`);
      const payload: unknown = await response.json().catch(() => null);
      const parsed = response.ok ? parseResultConflicts(payload) : null;
      if (!parsed) {
        setConflictState(machine.error);
        return;
      }
      setConflicts([...parsed]);
      setConflictState(machine.ready);
    } catch {
      setConflictState(machine.error);
    }
  }, [competitionId, completed, enableRemote, matches]);

  const load = useCallback(
    async (selectedMatchId: string, announce = false, errorTarget: "page" | "dialog" = machine.loadPage) => {
      const selected = matches.find((match) => match.id === selectedMatchId);
      if (!selected) return false;
      const generation = ++loadGeneration.current;
      setBusy(true);
      setError("");
      if (errorTarget === machine.loadDialog) setOperationError("");
      const reportError = (message: string) =>
        errorTarget === machine.loadDialog ? setOperationError(message) : setError(message);
      try {
        if (!enableRemote) {
          if (generation !== loadGeneration.current || selectedMatchId !== selectedMatchIdRef.current) return false;
          setDocument(demoAudit(selected));
          if (announce) setAnnouncement(copy.refreshed);
          return true;
        }
        const auditResponse = await fetch(
          `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(selectedMatchId)}/scoring-audit`,
        );
        const auditPayload: unknown = await auditResponse.json().catch(() => null);
        if (generation !== loadGeneration.current || selectedMatchId !== selectedMatchIdRef.current) return false;
        if (!auditResponse.ok) {
          reportError(mutationError(auditResponse.status));
          return false;
        }
        const audit = parseMatchScoringAudit(auditPayload);
        if (!audit || audit.match.id !== selectedMatchId) {
          reportError(copy.malformed);
          return false;
        }
        setDocument(audit);
        if (announce) setAnnouncement(copy.refreshed);
        return true;
      } catch {
        if (generation !== loadGeneration.current || selectedMatchId !== selectedMatchIdRef.current) return false;
        reportError(copy.unavailable);
        return false;
      } finally {
        if (generation === loadGeneration.current) setBusy(false);
      }
    },
    [competitionId, enableRemote, matches],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadConflicts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadConflicts]);

  useEffect(() => {
    if (!matchId) return;
    const timer = window.setTimeout(() => void load(matchId), 0);
    return () => window.clearTimeout(timer);
  }, [load, matchId]);

  function selectMatch(value: string) {
    invalidatePendingResultCommand();
    selectedMatchIdRef.current = value;
    loadGeneration.current += 1;
    setBusy(false);
    setMatchId(value);
    setDocument(null);
    setAnnouncement("");
    setError("");
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(machine.matchQuery, value);
    else url.searchParams.delete(machine.matchQuery);
    window.history.replaceState(window.history.state, "", url);
  }

  function closeDialog(dialog: React.RefObject<HTMLDialogElement | null>, trigger: HTMLElement | null) {
    dialog.current?.close();
    requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  }

  async function mutate(kind: "reopen" | "correction") {
    if (!document || document.match.id !== matchId || busy || reason.trim().length < 3) return;
    if (kind === "correction" && !eventId) return;
    setBusy(true);
    setOperationError("");
    const path =
      kind === "reopen"
        ? `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/reopen`
        : `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/corrections`;
    const targetEvent = document.events.find((event) => event.eventId === eventId);
    const nextDemoSequence = Math.max(0, ...document.events.map((event) => event.sequence)) + 1;
    const reversalTargets = targetEvent
      ? [targetEvent, ...document.events.filter((event) => additionalReversalIds.includes(event.eventId))].slice(0, 10)
      : [];
    const fingerprint = JSON.stringify({
      kind,
      matchId,
      aggregateVersion: document.match.aggregateVersion,
      reason: reason.trim(),
      eventIds: reversalTargets.map((event) => event.eventId),
      includeReplacement,
      flipSegmentWinner,
      replacementSide,
      replacementParticipant: replacementParticipant.trim(),
      replacementPointCount,
    });
    let command = pendingResultCommand.current;
    if (!command || command.fingerprint !== fingerprint) {
      const occurredAt = new Date().toISOString();
      let correctionEvents: readonly Readonly<Record<string, unknown>>[] = reversalTargets.map((event) => ({
        client_event_id: crypto.randomUUID(),
        type: "reversal",
        occurred_at: occurredAt,
        reversal_target_event_id: event.eventId,
        reason: reason.trim(),
      }));
      if (targetEvent && flipSegmentWinner) {
        const atomic = buildAtomicSegmentWinnerCommands({
          targets: reversalTargets,
          replacementSide,
          replacementParticipant,
          replacementPointCount,
          sportCode: document.match.sportCode,
          reason,
          occurredAt,
          clientEventIds: Array.from({ length: reversalTargets.length + replacementPointCount + 1 }, () =>
            crypto.randomUUID(),
          ),
        });
        if (!atomic) {
          setOperationError(copy.correctionEventInvalid);
          setBusy(false);
          return;
        }
        correctionEvents = atomic;
      } else if (targetEvent && includeReplacement) {
        correctionEvents = [
          ...correctionEvents,
          buildCanonicalReplacementCommand(targetEvent, {
            clientEventId: crypto.randomUUID(),
            occurredAt,
            side: replacementSide,
            participantId: replacementParticipant,
          }),
        ];
      }
      command = {
        fingerprint,
        clientEventId: crypto.randomUUID(),
        events: correctionEvents,
      };
      pendingResultCommand.current = command;
    }
    try {
      if (enableRemote) {
        const response = await fetch(path, {
          method: machine.post,
          headers: { "content-type": machine.json },
          body: JSON.stringify({
            clientEventId: command.clientEventId,
            reason: reason.trim(),
            expectedAggregateVersion: document.match.aggregateVersion,
            ...(kind === "correction"
              ? {
                  events: command.events,
                }
              : {}),
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setOperationError(mutationError(response.status));
          return;
        }
        const receipt = parseResultMutationReceipt(payload);
        if (!receipt || receipt.matchId !== matchId) {
          setOperationError(copy.malformed);
          return;
        }
        if (!(await load(matchId, false, machine.loadDialog))) return;
      } else {
        setDocument((current) =>
          current
            ? {
                ...current,
                match: {
                  ...current.match,
                  state: kind === machine.reopen ? machine.inProgress : machine.corrected,
                  aggregateVersion: current.match.aggregateVersion + 1,
                  resultVersion: kind === "correction" ? current.match.resultVersion + 1 : current.match.resultVersion,
                },
                events:
                  kind === machine.correction
                    ? [
                        ...current.events.map((event) =>
                          event.eventId === eventId ? { ...event, reversed: true } : event,
                        ),
                        {
                          eventId: crypto.randomUUID(),
                          sequence: nextDemoSequence,
                          type: machine.reversal,
                          side: null,
                          participantLabel: null,
                          reason: reason.trim(),
                          reversalTargetEventId: eventId,
                          occurredAt: new Date().toISOString(),
                          actorLabel: copy.eyebrow,
                          reversed: false,
                          segmentNumber: targetEvent?.segmentNumber ?? null,
                          manualTimeSeconds: targetEvent?.manualTimeSeconds ?? null,
                          unknownParticipant: false,
                          reversible: false,
                        },
                        ...(includeReplacement && targetEvent
                          ? [
                              {
                                ...targetEvent,
                                eventId: crypto.randomUUID(),
                                sequence: nextDemoSequence + 1,
                                side: replacementSide,
                                participantLabel: replacementParticipant.trim() || null,
                                reversed: false,
                                reversible: true,
                                occurredAt: new Date().toISOString(),
                              },
                            ]
                          : []),
                        {
                          eventId: crypto.randomUUID(),
                          sequence: nextDemoSequence + (includeReplacement ? 2 : 1),
                          type: machine.matchFinalised,
                          side: null,
                          participantLabel: null,
                          reason: reason.trim(),
                          reversalTargetEventId: null,
                          occurredAt: new Date().toISOString(),
                          actorLabel: copy.eyebrow,
                          reversed: false,
                          segmentNumber: targetEvent?.segmentNumber ?? null,
                          manualTimeSeconds: targetEvent?.manualTimeSeconds ?? null,
                          unknownParticipant: false,
                          reversible: false,
                        },
                      ]
                    : [
                        ...current.events,
                        {
                          eventId: crypto.randomUUID(),
                          sequence: nextDemoSequence,
                          type: machine.matchReopened,
                          side: null,
                          participantLabel: null,
                          reason: reason.trim(),
                          reversalTargetEventId: null,
                          occurredAt: new Date().toISOString(),
                          actorLabel: copy.eyebrow,
                          reversed: false,
                          segmentNumber: null,
                          manualTimeSeconds: current.events.at(-1)?.manualTimeSeconds ?? null,
                          unknownParticipant: false,
                          reversible: false,
                        },
                      ],
                audit: [
                  ...current.audit,
                  {
                    id: crypto.randomUUID(),
                    action: kind === machine.reopen ? copy.reopened : copy.corrected,
                    actorLabel: copy.eyebrow,
                    reason: reason.trim(),
                    occurredAt: new Date().toISOString(),
                  },
                ],
              }
            : current,
        );
      }
      pendingResultCommand.current = null;
      setAnnouncement(kind === "reopen" ? copy.reopened : copy.corrected);
      setReason("");
      setEventId("");
      setIncludeReplacement(false);
      setFlipSegmentWinner(false);
      setAdditionalReversalIds([]);
      setReplacementPointCount(1);
      setReplacementParticipant("");
      closeDialog(
        kind === "reopen" ? reopenDialog : correctionDialog,
        kind === "reopen" ? correctionTrigger.current : matchStatus.current,
      );
    } catch {
      setOperationError(copy.unavailable);
    } finally {
      setBusy(false);
    }
  }

  async function acknowledgeConflict() {
    if (!conflict || busy || acknowledgementReason.trim().length < 3) return;
    setBusy(true);
    setOperationError("");
    try {
      if (enableRemote) {
        const response = await fetch(
          `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/result-conflicts/${encodeURIComponent(conflict.id)}/acknowledge`,
          {
            method: machine.post,
            headers: { "content-type": machine.json },
            body: JSON.stringify({
              clientEventId: acknowledgementClientEventId.current,
              reason: acknowledgementReason.trim(),
              expectedRevision: conflict.revision,
            }),
          },
        );
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setOperationError(mutationError(response.status));
          return;
        }
        const acknowledged = parseResultConflict(payload);
        if (!acknowledged || acknowledged.id !== conflict.id || acknowledged.status !== "acknowledged") {
          setOperationError(copy.malformed);
          return;
        }
      }
      setConflicts((current) => current.filter((item) => item.id !== conflict.id));
      setAnnouncement(copy.acknowledged);
      setAcknowledgementReason("");
      acknowledgementClientEventId.current = "";
      setConflict(null);
      closeDialog(conflictDialog, conflictStatus.current);
    } catch {
      setOperationError(copy.unavailable);
    } finally {
      setBusy(false);
    }
  }

  const reversibleEvents = document?.events.filter((event) => event.reversible && !event.reversed) ?? [];
  const selectedEvent = reversibleEvents.find((event) => event.eventId === eventId);
  const segmentedSport =
    document?.match.sportCode === "badminton" ||
    document?.match.sportCode === "table_tennis" ||
    document?.match.sportCode === "volleyball";
  const latestScoredSegment = Math.max(0, ...reversibleEvents.map((event) => event.segmentNumber ?? 0));
  const selectedSegment = document?.segments.find((segment) => segment.number === selectedEvent?.segmentNumber);
  const canFlipSegmentWinner = Boolean(
    segmentedSport &&
    selectedEvent?.type === "point" &&
    selectedEvent.segmentNumber !== null &&
    selectedEvent.segmentNumber === latestScoredSegment &&
    selectedEvent.side &&
    selectedSegment?.winner === selectedEvent.side,
  );
  const additionalReversalCandidates = selectedEvent
    ? reversibleEvents.filter(
        (event) =>
          event.eventId !== selectedEvent.eventId &&
          event.type === selectedEvent.type &&
          event.segmentNumber === selectedEvent.segmentNumber &&
          event.side === selectedEvent.side,
      )
    : [];
  const completionLabel = document?.match.sportCode === "volleyball" ? copy.completionSet : copy.completionGame;
  return (
    <section className={styles.operations} aria-labelledby="result-operations-title">
      <p className={styles.live} aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <header className={styles.operationsHeading}>
        <div>
          <p>{copy.eyebrow}</p>
          <h2 id="result-operations-title">{copy.title}</h2>
          <span>{copy.intro}</span>
        </div>
        {document ? (
          <button type="button" disabled={busy} onClick={() => void load(matchId, true)}>
            <ArrowClockwise aria-hidden="true" />
            {copy.refresh}
          </button>
        ) : null}
      </header>

      <label className={styles.matchPicker}>
        <span>{copy.choose}</span>
        <select value={matchId} onChange={(event) => selectMatch(event.target.value)}>
          <option value="">{copy.choose}</option>
          {completed.map((match) => (
            <option key={match.id} value={match.id}>
              {match.label} · {match.home} {copy.versus} {match.away}
            </option>
          ))}
        </select>
        {!matchId ? <small>{copy.chooseBody}</small> : null}
      </label>

      {error ? (
        <p className={styles.commandError} role="alert">
          <ShieldWarning aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {document ? (
        <>
          <div ref={matchStatus} className={styles.matchSummary} tabIndex={-1}>
            <div>
              <span>{copy.status}</span>
              <strong>{document.match.state.replaceAll("_", " ")}</strong>
            </div>
            <div>
              <span>{copy.score}</span>
              <strong>
                {document.match.homeName} {document.match.homeScore}–{document.match.awayScore}{" "}
                {document.match.awayName}
              </strong>
            </div>
            <div className={styles.operationActions}>
              <button
                ref={reopenTrigger}
                type="button"
                disabled={
                  busy ||
                  !document.canManage ||
                  (document.match.state !== machine.finalised && document.match.state !== machine.corrected)
                }
                onClick={() => {
                  invalidatePendingResultCommand();
                  setOperationError("");
                  reopenDialog.current?.showModal();
                }}
              >
                <ClockCounterClockwise aria-hidden="true" />
                {copy.reopen}
              </button>
              <button
                ref={correctionTrigger}
                type="button"
                disabled={
                  busy || !document.canManage || document.match.state !== machine.inProgress || !reversibleEvents.length
                }
                onClick={() => {
                  invalidatePendingResultCommand();
                  setOperationError("");
                  correctionDialog.current?.showModal();
                }}
              >
                {copy.correct}
              </button>
            </div>
            {!document.canManage ? <p>{copy.readOnly}</p> : null}
          </div>

          <div className={styles.historyColumns}>
            <section aria-labelledby="score-events-title">
              <h3 id="score-events-title">{copy.eventHistory}</h3>
              <ol>
                {document.events.map((event) => (
                  <li key={event.eventId}>
                    <strong>
                      #{event.sequence} · {event.type.replaceAll("_", " ")}
                      {event.reversed ? ` · ${copy.reversed}` : ""}
                    </strong>
                    <span>
                      {event.side ?? copy.matchEvent} · {event.participantLabel ?? copy.noParticipant} ·{" "}
                      {event.actorLabel}
                    </span>
                    <small>
                      {copy.eventId}: {event.eventId}
                      {event.manualTimeSeconds !== null ? ` · ${copy.manualTime}: ${event.manualTimeSeconds}s` : ""}
                    </small>
                    {event.reversalTargetEventId ? (
                      <small>
                        {copy.reversalTarget}: {event.reversalTargetEventId}
                      </small>
                    ) : null}
                    {event.reason ? <p>{event.reason}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
            <section aria-labelledby="match-audit-title">
              <h3 id="match-audit-title">{copy.audit}</h3>
              <ol>
                {document.audit.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.action.replaceAll(".", " ")}</strong>
                    <span>
                      {entry.actorLabel} · {new Date(entry.occurredAt).toLocaleString()}
                    </span>
                    {entry.reason ? <p>{entry.reason}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </>
      ) : null}

      <section
        ref={conflictStatus}
        className={styles.criticalConflicts}
        aria-labelledby="critical-conflicts-title"
        tabIndex={-1}
      >
        <h3 id="critical-conflicts-title">{copy.conflicts}</h3>
        {conflictState === machine.loading ? (
          <p role="status">{copy.conflictsLoading}</p>
        ) : conflictState === machine.error ? (
          <div className={styles.conflictLoadError} role="alert">
            <p>{copy.conflictsError}</p>
            <button type="button" onClick={() => void loadConflicts()}>
              {copy.retryConflicts}
            </button>
          </div>
        ) : conflicts.length ? (
          <ol>
            {conflicts.map((item) => (
              <li key={item.id}>
                <ShieldWarning aria-hidden="true" />
                <div>
                  <strong>
                    {copy.downstreamMatch} {item.downstreamMatchId}
                  </strong>
                  <p>{copy.conflictWarning}</p>
                  <small>{item.reason.replaceAll("_", " ")}</small>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    conflictTrigger.current = event.currentTarget;
                    acknowledgementClientEventId.current = crypto.randomUUID();
                    setAcknowledgementReason("");
                    setOperationError("");
                    setConflict(item);
                    conflictDialog.current?.showModal();
                  }}
                >
                  {copy.acknowledge}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p>{copy.noConflicts}</p>
        )}
      </section>

      <dialog
        ref={reopenDialog}
        className={styles.operationDialog}
        aria-labelledby="reopen-result-title"
        onCancel={(event) => {
          event.preventDefault();
          setOperationError("");
          closeDialog(reopenDialog, reopenTrigger.current);
        }}
      >
        <form method={machine.dialog} onSubmit={(event) => event.preventDefault()}>
          <header>
            <h2 id="reopen-result-title">{copy.reopen}</h2>
            <button
              type="button"
              aria-label={copy.cancel}
              onClick={() => {
                setOperationError("");
                closeDialog(reopenDialog, reopenTrigger.current);
              }}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <label>
            <span>{copy.reason}</span>
            <textarea
              value={reason}
              onChange={(event) => {
                invalidatePendingResultCommand();
                setReason(event.target.value);
              }}
              maxLength={500}
            />
            <small>{copy.reasonHint}</small>
          </label>
          {operationError ? (
            <p className={styles.commandError} role="alert">
              <ShieldWarning aria-hidden="true" />
              {operationError}
            </p>
          ) : null}
          <footer>
            <button
              type="button"
              onClick={() => {
                setOperationError("");
                closeDialog(reopenDialog, reopenTrigger.current);
              }}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void mutate(machine.reopen)}
            >
              {copy.confirmReopen}
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={correctionDialog}
        className={styles.operationDialog}
        aria-labelledby="correct-result-title"
        onCancel={(event) => {
          event.preventDefault();
          setOperationError("");
          closeDialog(correctionDialog, correctionTrigger.current);
        }}
      >
        <form method={machine.dialog} onSubmit={(event) => event.preventDefault()}>
          <header>
            <h2 id="correct-result-title">{copy.finalise}</h2>
            <button
              type="button"
              aria-label={copy.cancel}
              onClick={() => {
                setOperationError("");
                closeDialog(correctionDialog, correctionTrigger.current);
              }}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <label>
            <span>{copy.selectEvent}</span>
            <select
              value={eventId}
              onChange={(event) => {
                const nextId = event.target.value;
                const selected = reversibleEvents.find((item) => item.eventId === nextId);
                invalidatePendingResultCommand();
                setEventId(nextId);
                setIncludeReplacement(false);
                setFlipSegmentWinner(false);
                setAdditionalReversalIds([]);
                setReplacementPointCount(1);
                setReplacementSide(selected?.side === machine.away ? machine.away : machine.home);
                setReplacementParticipant(selected?.participantLabel ?? "");
              }}
            >
              <option value="">{copy.selectEvent}</option>
              {reversibleEvents.map((event) => (
                <option key={event.eventId} value={event.eventId}>
                  #{event.sequence} · {event.type.replaceAll("_", " ")} · {event.side ?? "match"}
                </option>
              ))}
            </select>
          </label>
          {eventId ? (
            <>
              {canFlipSegmentWinner ? (
                <label className={styles.replacementToggle}>
                  <input
                    type="checkbox"
                    checked={flipSegmentWinner}
                    onChange={(event) => {
                      invalidatePendingResultCommand();
                      const checked = event.target.checked;
                      setFlipSegmentWinner(checked);
                      setIncludeReplacement(checked);
                      setAdditionalReversalIds([]);
                      setReplacementPointCount(1);
                      if (checked && selectedEvent?.side) {
                        setReplacementSide(selectedEvent.side === machine.home ? machine.away : machine.home);
                      }
                    }}
                  />
                  <span>{copy.flipSegmentWinner}</span>
                </label>
              ) : null}
              {!flipSegmentWinner ? (
                <label className={styles.replacementToggle}>
                  <input
                    type="checkbox"
                    checked={includeReplacement}
                    onChange={(event) => {
                      invalidatePendingResultCommand();
                      setIncludeReplacement(event.target.checked);
                    }}
                  />
                  <span>{copy.addReplacement}</span>
                </label>
              ) : null}
              {flipSegmentWinner ? (
                <fieldset className={styles.atomicCorrection}>
                  <legend>{copy.atomicCorrection}</legend>
                  {additionalReversalCandidates.length ? (
                    <fieldset>
                      <legend>{copy.additionalReversals}</legend>
                      {additionalReversalCandidates.map((candidate) => (
                        <label key={candidate.eventId} className={styles.replacementToggle}>
                          <input
                            type="checkbox"
                            checked={additionalReversalIds.includes(candidate.eventId)}
                            onChange={(event) => {
                              invalidatePendingResultCommand();
                              setAdditionalReversalIds((current) =>
                                event.target.checked
                                  ? [...current, candidate.eventId].slice(0, 9)
                                  : current.filter((id) => id !== candidate.eventId),
                              );
                            }}
                          />
                          <span>
                            #{candidate.sequence} · {candidate.type.replaceAll("_", " ")} · {candidate.side}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  <label>
                    <span>{copy.replacementPoints}</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      step={1}
                      value={replacementPointCount}
                      onChange={(event) => {
                        invalidatePendingResultCommand();
                        const count = Number(event.target.value);
                        setReplacementPointCount(Number.isInteger(count) ? Math.min(10, Math.max(1, count)) : 1);
                      }}
                    />
                  </label>
                  <section aria-labelledby="correction-command-review">
                    <h3 id="correction-command-review">{copy.correctionReview}</h3>
                    <ul>
                      <li>
                        {copy.reversalsReview}: {1 + additionalReversalIds.length}
                      </li>
                      <li>
                        {copy.replacementsReview}: {replacementPointCount}
                      </li>
                      <li>
                        {copy.completionReview}: {completionLabel}
                      </li>
                    </ul>
                  </section>
                </fieldset>
              ) : null}
              {includeReplacement || flipSegmentWinner ? (
                <div className={styles.replacementFields}>
                  {selectedEvent?.side ? (
                    <label>
                      <span>{copy.replacementSide}</span>
                      <select
                        value={replacementSide}
                        onChange={(event) => {
                          invalidatePendingResultCommand();
                          setReplacementSide(event.target.value as "home" | "away");
                        }}
                      >
                        {!flipSegmentWinner || selectedEvent.side !== machine.home ? (
                          <option value={machine.home}>{document?.match.homeName}</option>
                        ) : null}
                        {!flipSegmentWinner || selectedEvent.side !== machine.away ? (
                          <option value={machine.away}>{document?.match.awayName}</option>
                        ) : null}
                      </select>
                    </label>
                  ) : null}
                  {selectedEvent?.participantLabel ? (
                    <label>
                      <span>{copy.replacementParticipant}</span>
                      <input
                        value={replacementParticipant}
                        onChange={(event) => {
                          invalidatePendingResultCommand();
                          setReplacementParticipant(event.target.value);
                        }}
                        maxLength={120}
                      />
                      <small>{copy.replacementParticipantHint}</small>
                    </label>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          <label>
            <span>{copy.reason}</span>
            <textarea
              value={reason}
              onChange={(event) => {
                invalidatePendingResultCommand();
                setReason(event.target.value);
              }}
              maxLength={500}
            />
            <small>{copy.reasonHint}</small>
          </label>
          {operationError ? (
            <p className={styles.commandError} role="alert">
              <ShieldWarning aria-hidden="true" />
              {operationError}
            </p>
          ) : null}
          <footer>
            <button
              type="button"
              onClick={() => {
                setOperationError("");
                closeDialog(correctionDialog, correctionTrigger.current);
              }}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              disabled={busy || !eventId || reason.trim().length < 3}
              onClick={() => void mutate(machine.correction)}
            >
              {copy.confirmCorrection}
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={conflictDialog}
        className={styles.operationDialog}
        aria-labelledby="acknowledge-conflict-title"
        onCancel={(event) => {
          event.preventDefault();
          setOperationError("");
          closeDialog(conflictDialog, conflictTrigger.current);
        }}
      >
        <form method={machine.dialog} onSubmit={(event) => event.preventDefault()}>
          <header>
            <h2 id="acknowledge-conflict-title">{copy.acknowledge}</h2>
            <button
              type="button"
              aria-label={copy.cancel}
              onClick={() => {
                setOperationError("");
                closeDialog(conflictDialog, conflictTrigger.current);
              }}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <p>{copy.conflictWarning}</p>
          <label>
            <span>{copy.acknowledgeReason}</span>
            <textarea
              value={acknowledgementReason}
              onChange={(event) => {
                acknowledgementClientEventId.current = crypto.randomUUID();
                setAcknowledgementReason(event.target.value);
              }}
              maxLength={500}
            />
          </label>
          {operationError ? (
            <p className={styles.commandError} role="alert">
              <ShieldWarning aria-hidden="true" />
              {operationError}
            </p>
          ) : null}
          <footer>
            <button
              type="button"
              onClick={() => {
                setOperationError("");
                closeDialog(conflictDialog, conflictTrigger.current);
              }}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              disabled={busy || acknowledgementReason.trim().length < 3}
              onClick={() => void acknowledgeConflict()}
            >
              {copy.acknowledgeAction}
            </button>
          </footer>
        </form>
      </dialog>
    </section>
  );
}
