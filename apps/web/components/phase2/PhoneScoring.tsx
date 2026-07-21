"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Clock,
  CloudCheck,
  LockKey,
  NotePencil,
  ShieldWarning,
  UserCircle,
  Warning,
} from "@phosphor-icons/react";
import { phase2Copy, phase2Machine, type ScoringEventCommand, type ScoringSessionView } from "@/lib/phase2";
import { createScoringCommandPort, ScoringTransportError } from "@/lib/phase2-scoring";

type ScoringPhase = "access" | "confirm" | "live" | "review" | "receipt";
type WriterState = "active" | "read-only" | "conflict";
type ScoreEvent = ScoringEventCommand;

type PhoneScoringProps = { initialWriterState?: WriterState; mode?: "api" | "demo" };

export function PhoneScoring({
  initialWriterState = phase2Machine.active,
  mode = phase2Machine.scoringApiMode,
}: PhoneScoringProps) {
  const port = useMemo(() => createScoringCommandPort(mode), [mode]);
  const [phase, setPhase] = useState<ScoringPhase>(phase2Machine.access);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scorer, setScorer] = useState("");
  const [scorerError, setScorerError] = useState("");
  const [period, setPeriod] = useState("1");
  const [eventTime, setEventTime] = useState("09:42");
  const [writerState, setWriterState] = useState<WriterState>(initialWriterState);
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [pendingSync, setPendingSync] = useState(false);
  const [competitionSlug, setCompetitionSlug] = useState<string | null>(
    mode === phase2Machine.scoringDemoMode ? phase2Machine.singaporeOpenSlug : null,
  );
  const [matchId, setMatchId] = useState(phase2Machine.matchTwelveId);
  const [matchLabel, setMatchLabel] = useState<string>(phase2Copy.matchTwelve);
  const [stage, setStage] = useState<string>(phase2Copy.groupB);
  const [home, setHome] = useState<string>(phase2Copy.marinaBlue);
  const [away, setAway] = useState<string>(phase2Copy.harbourGold);
  const [finalReceipt, setFinalReceipt] = useState<{ receiptId: string; publishedAt: string } | null>(null);
  const [pendingGoal, setPendingGoal] = useState<"home" | "away" | null>(null);
  const goalDialogRef = useRef<HTMLDialogElement>(null);
  const scorerInputRef = useRef<HTMLInputElement>(null);
  const homeGoalRef = useRef<HTMLButtonElement>(null);
  const awayGoalRef = useRef<HTMLButtonElement>(null);
  const bootstrappedRef = useRef(false);

  const score = useMemo(
    () => ({
      home: events.filter((event) => event.eventType === phase2Machine.goal && event.team === phase2Machine.home)
        .length,
      away: events.filter((event) => event.eventType === phase2Machine.goal && event.team === phase2Machine.away)
        .length,
    }),
    [events],
  );
  const locked = writerState !== "active";

  const applySession = useCallback((session: ScoringSessionView | null) => {
    if (!session) return;
    setCompetitionSlug(session.competitionSlug);
    setMatchId(session.matchId);
    setMatchLabel(session.matchLabel);
    setStage(session.stage);
    setHome(session.home);
    setAway(session.away);
    setEvents(session.events);
    setWriterState(session.readOnly ? "read-only" : "active");
  }, []);

  const handleTransportError = useCallback((error: unknown, accessMessage: string = phase2Copy.serviceUnavailable) => {
    if (error instanceof ScoringTransportError && error.state === "conflict") {
      setWriterState("conflict");
      return;
    }
    setPhase("access");
    setCodeError(accessMessage);
  }, []);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const tokenMatch = window.location.pathname.match(/^\/score\/([^/]+)$/);
    if (tokenMatch?.[1]) {
      let token: string;
      try {
        token = decodeURIComponent(tokenMatch[1]);
      } catch {
        window.queueMicrotask(() => setCodeError(phase2Copy.codeError));
        return;
      }
      void port
        .exchangeAccess({ token })
        .then((session) => {
          window.history.replaceState(window.history.state, "", "/score");
          applySession(session);
          setPhase("confirm");
        })
        .catch((error: unknown) => {
          window.history.replaceState(window.history.state, "", "/score");
          handleTransportError(error, phase2Copy.codeError);
        });
      return;
    }
    void port
      .recoverSession()
      .then((session) => {
        if (!session) return;
        applySession(session);
        setPhase("live");
      })
      .catch((error: unknown) => handleTransportError(error));
  }, [applySession, handleTransportError, port]);

  useEffect(() => {
    if (!pendingGoal || !goalDialogRef.current) return;
    const dialog = goalDialogRef.current;
    if (!dialog.open) dialog.showModal();
    const focusFrame = window.requestAnimationFrame(() => scorerInputRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [pendingGoal]);

  const validate = async () => {
    try {
      const session = await port.exchangeAccess({ shortCode: code.trim() });
      applySession(session);
      setCodeError("");
      setPhase("confirm");
    } catch (error) {
      handleTransportError(error, phase2Copy.codeError);
    }
  };

  const startScoring = async () => {
    setStarting(true);
    try {
      const receipt = await port.appendEvent({
        clientEventId: crypto.randomUUID(),
        matchId,
        eventType: phase2Machine.matchStarted,
        scorer: "",
        period: 1,
        manualTime: "00:00",
      });
      setPendingSync(receipt.syncState === "pending");
      setPhase("live");
    } catch (error) {
      handleTransportError(error);
    } finally {
      setStarting(false);
    }
  };

  const record = async (type: string, team?: "home" | "away") => {
    if (!scorer.trim()) {
      setScorerError(phase2Copy.scorerMissing);
      return false;
    }
    if (!period || !eventTime) {
      setScorerError(phase2Copy.periodRequired);
      return false;
    }
    setScorerError("");
    const command: ScoringEventCommand = {
      clientEventId: crypto.randomUUID(),
      matchId,
      eventType: type,
      team,
      scorer: scorer.trim(),
      period: Number(period),
      manualTime: eventTime,
    };
    try {
      const receipt = await port.appendEvent(command);
      setEvents((current) => [command, ...current]);
      setPendingSync(receipt.syncState === "pending");
      return true;
    } catch (error) {
      handleTransportError(error);
      return false;
    }
  };

  const openGoalSheet = (team: "home" | "away") => {
    setScorerError("");
    setPendingGoal(team);
  };

  const closeGoalSheet = () => {
    const returnTarget = pendingGoal === "home" ? homeGoalRef : awayGoalRef;
    if (goalDialogRef.current?.open) goalDialogRef.current.close();
    setPendingGoal(null);
    setScorerError("");
    window.requestAnimationFrame(() => returnTarget.current?.focus());
  };

  const confirmGoal = async () => {
    if (!pendingGoal || !(await record(phase2Machine.goal, pendingGoal))) return;
    closeGoalSheet();
  };

  const finalize = async () => {
    try {
      const receipt = await port.finalizeResult({
        matchId,
        homeScore: score.home,
        awayScore: score.away,
        scorer: scorer.trim(),
      });
      setFinalReceipt(receipt);
      setPhase("receipt");
    } catch (error) {
      handleTransportError(error);
    }
  };

  if (phase === "access" || phase === "confirm") {
    return (
      <main className="p2-score-access" id="score-main">
        <header>
          <span className="p2-score-brand">{phase2Copy.brand}</span>
          <span>{phase2Copy.scoringAccess}</span>
        </header>
        <section>
          <p className="p2-eyebrow">
            {matchLabel} · {stage}
          </p>
          <h1>
            {home}
            <span>{phase2Copy.versus}</span>
            {away}
          </h1>
          {phase === "access" ? (
            <div className="p2-score-form">
              <label>
                <span>{phase2Copy.codeLabel}</span>
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoCapitalize="characters"
                  aria-invalid={Boolean(codeError)}
                  aria-describedby="scoring-code-hint scoring-code-error"
                />
                <small id="scoring-code-hint">{phase2Copy.codeHint}</small>
                {codeError ? <em id="scoring-code-error">{codeError}</em> : null}
              </label>
              <button className="p2-score-primary" type="button" onClick={validate}>
                {phase2Copy.validateAccess}
                <ArrowRight />
              </button>
            </div>
          ) : (
            <div className="p2-score-form">
              <dl>
                <div>
                  <dt>{phase2Copy.schedule}</dt>
                  <dd>{phase2Copy.courtTwoStart}</dd>
                </div>
                <div>
                  <dt>{phase2Copy.publicVersion}</dt>
                  <dd>{phase2Copy.scheduleRevisionCode}</dd>
                </div>
              </dl>
              <label className="p2-check">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>{phase2Copy.confirmMatch}</span>
              </label>
              <button
                className="p2-score-primary"
                type="button"
                disabled={!confirmed || starting}
                onClick={() => void startScoring()}
              >
                {phase2Copy.startScoring}
                <ArrowRight />
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }

  if (phase === "receipt") {
    return (
      <main className="p2-score-receipt" id="score-main">
        <span aria-hidden="true">
          <Check />
        </span>
        <p>{phase2Copy.publicFinal}</p>
        <h1>{phase2Copy.finalReceipt}</h1>
        <div className="p2-score-receipt__score">
          <span>{home}</span>
          <strong>
            {score.home}–{score.away}
          </strong>
          <span>{away}</span>
        </div>
        <p>
          {mode === "demo"
            ? phase2Copy.finalReceiptBody
            : `${phase2Copy.finalReceipt}: ${finalReceipt?.receiptId ?? "—"} · ${phase2Copy.publishedLabel} ${finalReceipt?.publishedAt ?? "—"}`}
        </p>
        {competitionSlug ? (
          <Link className="p2-score-primary" href={`/competitions/${encodeURIComponent(competitionSlug)}`}>
            {phase2Copy.openPublic}
            <ArrowRight />
          </Link>
        ) : null}
      </main>
    );
  }

  return (
    <main className="p2-score" id="score-main" data-writer-state={writerState}>
      <header className="p2-score__header">
        <div>
          <p>{stage}</p>
          <h1>{matchLabel}</h1>
        </div>
        <div className={`p2-writer p2-writer--${writerState}`} role="status">
          {writerState === "active" ? <CloudCheck /> : writerState === "conflict" ? <ShieldWarning /> : <LockKey />}
          <span>
            <strong>
              {writerState === "active"
                ? phase2Copy.writerActive
                : writerState === "conflict"
                  ? phase2Copy.writerConflict
                  : phase2Copy.readOnly}
            </strong>
            <small>{writerState === "active" ? phase2Copy.synced : phase2Copy.currentRevision}</small>
          </span>
        </div>
      </header>
      {writerState === "conflict" ? (
        <section className="p2-score-warning" role="alert">
          <Warning />
          <div>
            <strong>{phase2Copy.writerConflict}</strong>
            <p>{phase2Copy.writerConflictBody}</p>
          </div>
        </section>
      ) : null}
      <section className="p2-scoreboard" aria-label={matchLabel}>
        <div aria-label={`${home} ${score.home}`}>
          <span>{home}</span>
          <strong>{score.home}</strong>
        </div>
        <p>
          <span>
            {phase2Copy.periodPrefix}
            {period}
          </span>
          <strong>{eventTime}</strong>
          <small>{phase2Copy.manualTime}</small>
        </p>
        <div aria-label={`${away} ${score.away}`}>
          <span>{away}</span>
          <strong>{score.away}</strong>
        </div>
      </section>
      {phase === "review" ? (
        <section className="p2-final-review">
          <p className="p2-eyebrow">{phase2Copy.reviewFinal}</p>
          <h2>
            {home} {score.home}–{score.away} {away}
          </h2>
          <p>{phase2Copy.finalReviewBody}</p>
          <button className="p2-score-primary" type="button" disabled={locked} onClick={finalize}>
            {phase2Copy.finalise}
            <Check />
          </button>
          <button className="p2-score-secondary" type="button" onClick={() => setPhase("live")}>
            {phase2Copy.edit}
          </button>
        </section>
      ) : (
        <>
          <section className="p2-event-controls">
            <div className="p2-event-context">
              <label>
                <span>{phase2Copy.scorerLabel}</span>
                <span className="p2-input-icon">
                  <UserCircle />
                  <input
                    value={scorer}
                    onChange={(event) => setScorer(event.target.value)}
                    aria-invalid={Boolean(scorerError)}
                  />
                </span>
                <small>{phase2Copy.scorerHint}</small>
              </label>
              <div>
                <label>
                  <span>{phase2Copy.periodLabel}</span>
                  <select value={period} onChange={(event) => setPeriod(event.target.value)}>
                    <option value="1">{phase2Copy.firstPeriod}</option>
                    <option value="2">{phase2Copy.secondPeriod}</option>
                  </select>
                </label>
                <label>
                  <span>{phase2Copy.eventTimeLabel}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={eventTime}
                    onChange={(event) => setEventTime(event.target.value)}
                  />
                </label>
              </div>
              {scorerError ? (
                <p role="alert">
                  <Warning />
                  {scorerError}
                </p>
              ) : null}
            </div>
            <div className="p2-goal-controls">
              <button
                ref={homeGoalRef}
                type="button"
                disabled={locked}
                onClick={() => openGoalSheet(phase2Machine.home)}
              >
                <span>{phase2Copy.goal}</span>
                <strong>{home}</strong>
              </button>
              <button
                ref={awayGoalRef}
                type="button"
                disabled={locked}
                onClick={() => openGoalSheet(phase2Machine.away)}
              >
                <span>{phase2Copy.goal}</span>
                <strong>{away}</strong>
              </button>
            </div>
            <div className="p2-other-controls">
              <button
                type="button"
                disabled={locked}
                onClick={() => record(phase2Machine.greenCard, phase2Machine.home)}
              >
                {phase2Copy.greenCard}
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => record(phase2Machine.yellowCard, phase2Machine.home)}
              >
                {phase2Copy.yellowCard}
              </button>
              <button type="button" disabled={locked} onClick={() => record(phase2Machine.redCard, phase2Machine.home)}>
                {phase2Copy.redCard}
              </button>
              <button type="button" disabled={locked} onClick={() => record(phase2Machine.timeout, phase2Machine.home)}>
                {phase2Copy.timeout}
              </button>
              <button type="button" disabled={locked} onClick={() => record(phase2Machine.incident)}>
                <NotePencil />
                {phase2Copy.addIncident}
              </button>
            </div>
          </section>
          <section className="p2-event-log" aria-labelledby="event-log-title">
            <header>
              <h2 id="event-log-title">{phase2Copy.eventLog}</h2>
              <span>
                <Clock />
                {pendingSync ? phase2Copy.syncPending : phase2Copy.synced}
              </span>
            </header>
            {events.length ? (
              <ol>
                {events.map((event) => (
                  <li key={event.clientEventId}>
                    <time>
                      {phase2Copy.periodPrefix}
                      {event.period} {event.manualTime}
                    </time>
                    <span>
                      <strong>{event.eventType}</strong>
                      <small>
                        {event.team === phase2Machine.home
                          ? home
                          : event.team === phase2Machine.away
                            ? away
                            : phase2Copy.incident}
                      </small>
                    </span>
                    <span>
                      {phase2Copy.scorer}: {event.scorer}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>{phase2Copy.noEvents}</p>
            )}
          </section>
          <button
            className="p2-score-primary p2-score-final"
            type="button"
            disabled={locked}
            onClick={() => setPhase("review")}
          >
            {phase2Copy.reviewFinal}
            <ArrowRight />
          </button>
          {pendingGoal ? (
            <dialog
              className="p2-goal-sheet"
              ref={goalDialogRef}
              aria-labelledby="goal-sheet-title"
              aria-describedby="goal-sheet-description"
              onCancel={(event) => {
                event.preventDefault();
                closeGoalSheet();
              }}
            >
              <div className="p2-goal-sheet__handle" aria-hidden="true" />
              <header>
                <p className="p2-eyebrow">{phase2Copy.selectedTeam}</p>
                <h2 id="goal-sheet-title">{phase2Copy.confirmGoalTitle}</h2>
                <p id="goal-sheet-description">{phase2Copy.confirmGoalBody}</p>
              </header>
              <section className="p2-goal-sheet__team">
                <span>{pendingGoal === phase2Machine.home ? home : away}</span>
                <strong>{phase2Copy.goal}</strong>
              </section>
              <dl>
                <div>
                  <dt>{phase2Copy.periodLabel}</dt>
                  <dd>{pendingGoal ? `${phase2Copy.periodPrefix}${period}` : null}</dd>
                </div>
                <div>
                  <dt>{phase2Copy.eventTimeLabel}</dt>
                  <dd>{eventTime}</dd>
                </div>
              </dl>
              <label>
                <span>{phase2Copy.scorerLabel}</span>
                <span className="p2-input-icon">
                  <UserCircle />
                  <input
                    ref={scorerInputRef}
                    value={scorer}
                    onChange={(event) => setScorer(event.target.value)}
                    aria-invalid={Boolean(scorerError)}
                    aria-describedby="goal-sheet-scorer-hint goal-sheet-scorer-error"
                  />
                </span>
                <small id="goal-sheet-scorer-hint">{phase2Copy.goalSheetScorerHint}</small>
                {scorerError ? (
                  <em id="goal-sheet-scorer-error" role="alert">
                    {scorerError}
                  </em>
                ) : null}
              </label>
              <footer>
                <button className="p2-score-secondary" type="button" onClick={closeGoalSheet}>
                  {phase2Copy.cancel}
                </button>
                <button className="p2-score-primary" type="button" onClick={confirmGoal}>
                  {phase2Copy.recordGoalFor} {pendingGoal === phase2Machine.home ? home : away}
                  <Check />
                </button>
              </footer>
            </dialog>
          ) : null}
        </>
      )}
    </main>
  );
}
