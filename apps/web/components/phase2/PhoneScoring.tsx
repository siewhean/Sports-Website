"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Clock,
  CloudCheck,
  LockKey,
  ShieldWarning,
  UserCircle,
  Warning,
} from "@phosphor-icons/react";
import type { SportId } from "@matchday/domain";
import { translate as t } from "@matchday/ui";
import { phase2Copy, phase2Machine, type ScoringEventCommand, type ScoringSessionView } from "@/lib/phase2";
import { FiveSportScoreControls, type FiveSportScoreControlsCopy } from "@/components/phase5/FiveSportScoreControls";
import { buildFiveSportScorecardDefinition } from "@/lib/five-sport-scorecard";
import type { ScoreControlAction } from "@/lib/five-sport-score-control-actions";
import { getScoringDeviceIdentity, renameScoringDevice } from "@/lib/scoring-device";
import {
  canonicalSegmentNumber,
  createScoringCommandPort,
  refreshScoringSessionAccess,
  scoringSessionAnnouncement,
  scoringWriterAvailability,
  ScoringTransportError,
} from "@/lib/phase2-scoring";
import { LatestRequestFence } from "@/lib/latest-request";

type ScoringPhase = "access" | "confirm" | "live" | "review" | "receipt";
type WriterState =
  | "active"
  | "candidate"
  | "checking"
  | "conflict"
  | "expired"
  | "expiring"
  | "rate-limited"
  | "read-only"
  | "revoked"
  | "transferred";
type PhoneScoringProps = {
  initialWriterState?: WriterState;
  mode?: "api" | "demo";
  recoverOnLoad?: boolean;
  demoSportId?: SportId;
};

const scoreControlsCopy: FiveSportScoreControlsCopy = {
  title: phase2Copy.scoreControlsTitle,
  manualTimeOnlyNotice: phase2Copy.manualTimeOnly,
  readOnlyNotice: phase2Copy.scoreControlsReadOnly,
  pendingNotice: phase2Copy.scoreControlsPending,
  groupLabels: {
    score: phase2Copy.scoreGroup,
    segment_completion: phase2Copy.segmentGroup,
    operational: phase2Copy.operationalGroup,
    exceptional_outcome: phase2Copy.exceptionalGroup,
  },
  formatActionLabel: (controlLabel, sideLabel) => (sideLabel ? `${controlLabel} ${sideLabel}` : controlLabel),
};

function timeSeconds(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const total = minutes * 60 + seconds;
  return total <= 3_599 ? total : null;
}

function initialScoreState(): ScoringSessionView["scoreState"] {
  return {
    home: 0,
    away: 0,
    lifecycle: phase2Machine.notStarted,
    currentSegment: 1,
    totalPoints: { home: 0, away: 0 },
    segmentWins: { home: 0, away: 0 },
    segments: [],
    actions: [],
    conflicts: [],
  };
}

export function PhoneScoring({
  initialWriterState = phase2Machine.active,
  mode = phase2Machine.scoringApiMode,
  recoverOnLoad = true,
  demoSportId = phase2Machine.canoePolo,
}: PhoneScoringProps) {
  const port = useMemo(() => createScoringCommandPort(mode, demoSportId), [demoSportId, mode]);
  const [phase, setPhase] = useState<ScoringPhase>(phase2Machine.access);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [accessChecking, setAccessChecking] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scorer, setScorer] = useState("");
  const [scorerError, setScorerError] = useState("");
  const [period, setPeriod] = useState("1");
  const [eventTime, setEventTime] = useState("09:42");
  const [scorecardDefinition, setScorecardDefinition] = useState(() => buildFiveSportScorecardDefinition(demoSportId));
  const [allowUnknownScorer, setAllowUnknownScorer] = useState(false);
  const [unknownParticipant, setUnknownParticipant] = useState(false);
  const [scoreState, setScoreState] = useState<ScoringSessionView["scoreState"]>(initialScoreState);
  const [writerState, setWriterState] = useState<WriterState>(initialWriterState);
  const [pendingSync, setPendingSync] = useState(false);
  const [throughSequence, setThroughSequence] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [interactionError, setInteractionError] = useState("");
  const [takeoverPending, setTakeoverPending] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [deviceLabelDraft, setDeviceLabelDraft] = useState("");
  const [editingDeviceLabel, setEditingDeviceLabel] = useState(false);
  const [competitionSlug, setCompetitionSlug] = useState<string | null>(
    mode === phase2Machine.scoringDemoMode ? phase2Machine.singaporeOpenSlug : null,
  );
  const [matchId, setMatchId] = useState(phase2Machine.matchTwelveId);
  const [matchLabel, setMatchLabel] = useState<string>(phase2Copy.matchTwelve);
  const [stage, setStage] = useState<string>(phase2Copy.groupB);
  const [home, setHome] = useState<string>(phase2Copy.marinaBlue);
  const [away, setAway] = useState<string>(phase2Copy.harbourGold);
  const [finalReceipt, setFinalReceipt] = useState<{ receiptId: string; publishedAt: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<ScoreControlAction | null>(null);
  const [reversalTarget, setReversalTarget] = useState<ScoringSessionView["scoreState"]["actions"][number] | null>(
    null,
  );
  const [reversalReason, setReversalReason] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [reversedFocusId, setReversedFocusId] = useState<string | null>(null);
  const actionDialogRef = useRef<HTMLDialogElement>(null);
  const actionReturnTargetRef = useRef<HTMLButtonElement | null>(null);
  const scorerInputRef = useRef<HTMLInputElement>(null);
  const actionDialogTitleRef = useRef<HTMLHeadingElement>(null);
  const scoreControlsRef = useRef<HTMLDivElement>(null);
  const finalReviewRef = useRef<HTMLElement>(null);
  const timelineActionRefs = useRef(new Map<string, HTMLLIElement>());
  const bootstrappedRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const writerStateRef = useRef<WriterState>(initialWriterState);
  const pendingWriterFocusRef = useRef<WriterState | null>(null);
  const sessionRefreshFenceRef = useRef(new LatestRequestFence());
  const mutationInFlightRef = useRef(0);
  const writerStatusRef = useRef<HTMLDivElement>(null);
  const interactionErrorRef = useRef<HTMLElement>(null);
  const editDeviceButtonRef = useRef<HTMLButtonElement>(null);
  const deviceLabelInputRef = useRef<HTMLInputElement>(null);

  const definition = scorecardDefinition;
  const manualTimeEnabled = definition.fields.some((field) => field.id === "manual_event_time" && field.enabled);
  const score = { home: scoreState.home, away: scoreState.away };
  const locked = writerState !== "active";
  const writerTitle =
    writerState === phase2Machine.active
      ? phase2Copy.writerActive
      : writerState === phase2Machine.expired
        ? phase2Copy.sessionExpired
        : writerState === phase2Machine.expiring
          ? phase2Copy.leaseExpiring
          : writerState === phase2Machine.revoked
            ? phase2Copy.sessionRevoked
            : writerState === phase2Machine.rateLimited
              ? phase2Copy.rateLimited
              : writerState === phase2Machine.candidate
                ? phase2Copy.candidate
                : writerState === phase2Machine.transferred
                  ? phase2Copy.transferred
                  : writerState === phase2Machine.checking
                    ? phase2Copy.checkingAccess
                    : writerState === phase2Machine.conflict
                      ? phase2Copy.writerConflict
                      : phase2Copy.readOnly;

  const applySession = useCallback((session: ScoringSessionView | null) => {
    if (!session) return;
    const previousState = writerStateRef.current;
    setCompetitionSlug(session.competitionSlug);
    setScorecardDefinition(buildFiveSportScorecardDefinition(session.sportId, session.sportSettings));
    setAllowUnknownScorer(
      session.sportId === phase2Machine.canoePolo && session.sportSettings.allowUnknownScorer === true,
    );
    setMatchId(session.matchId);
    setMatchLabel(session.matchLabel);
    setStage(session.stage);
    setHome(session.home);
    setAway(session.away);
    setScoreState(session.scoreState);
    setPeriod(String(session.scoreState.currentSegment));
    setThroughSequence(session.throughSequence);
    const nextState: WriterState =
      session.mode === "writer"
        ? scoringWriterAvailability(session)
        : session.mode === "candidate"
          ? phase2Machine.candidate
          : session.mode === "transferred"
            ? phase2Machine.transferred
            : phase2Machine.readOnly;
    sessionActiveRef.current = true;
    writerStateRef.current = nextState;
    setWriterState(nextState);
    setTakeoverPending(session.takeoverStatus === "pending");
    if (
      ((previousState === phase2Machine.candidate || previousState === phase2Machine.expiring) &&
        nextState === phase2Machine.active) ||
      (previousState !== phase2Machine.expiring && nextState === phase2Machine.expiring) ||
      (previousState !== phase2Machine.transferred && nextState === phase2Machine.transferred)
    ) {
      setAnnouncement(
        nextState === phase2Machine.active
          ? phase2Copy.accessRestored
          : nextState === phase2Machine.expiring
            ? phase2Copy.leaseExpiring
            : phase2Copy.transferred,
      );
      pendingWriterFocusRef.current =
        nextState === phase2Machine.active
          ? phase2Machine.active
          : nextState === phase2Machine.expiring
            ? phase2Machine.expiring
            : phase2Machine.transferred;
    }
  }, []);

  useEffect(() => {
    const pendingFocus = pendingWriterFocusRef.current;
    if (pendingFocus !== writerState) return;
    pendingWriterFocusRef.current = null;
    const focusFrame = window.requestAnimationFrame(() => {
      if (pendingFocus === phase2Machine.active) scoreControlsRef.current?.focus();
      else writerStatusRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [writerState]);

  const handleTransportError = useCallback((error: unknown, accessMessage: string = phase2Copy.serviceUnavailable) => {
    sessionRefreshFenceRef.current.cancel();
    if (error instanceof ScoringTransportError) {
      if (error.state === phase2Machine.conflict) {
        writerStateRef.current = phase2Machine.conflict;
        setWriterState(phase2Machine.conflict);
        return;
      }
      if (error.state === "invalid") {
        if (actionDialogRef.current?.open) {
          setScorerError(phase2Copy.semanticRejected);
          setInteractionError("");
        } else {
          setInteractionError(phase2Copy.semanticRejected);
          setAnnouncement(phase2Copy.semanticRejected);
          window.requestAnimationFrame(() => interactionErrorRef.current?.focus({ preventScroll: true }));
        }
        return;
      }
      if (error.state === "expired" || error.state === "revoked" || error.state === "rate_limited") {
        sessionActiveRef.current = false;
        const state = error.state === "rate_limited" ? phase2Machine.rateLimited : error.state;
        writerStateRef.current = state;
        setWriterState(state);
        setCodeError(
          error.state === "expired"
            ? phase2Copy.sessionExpired
            : error.state === "revoked"
              ? phase2Copy.sessionRevoked
              : phase2Copy.rateLimited,
        );
        setAnnouncement(
          error.state === "expired"
            ? phase2Copy.sessionExpired
            : error.state === "revoked"
              ? phase2Copy.sessionRevoked
              : phase2Copy.rateLimited,
        );
        setPhase("access");
        return;
      }
    }
    setPhase("access");
    setCodeError(accessMessage);
  }, []);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get(phase2Machine.access);
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }
    const device = getScoringDeviceIdentity().then((identity) => {
      setDeviceLabel(identity.label);
      setDeviceLabelDraft(identity.label);
      return identity;
    });
    if (token) {
      void device
        .then((identity) => port.exchangeAccess({ token, device: identity }))
        .then((session) => {
          applySession(session);
          setPhase(session.mode === phase2Machine.writer ? "confirm" : "live");
          setAnnouncement(scoringSessionAnnouncement(session));
        })
        .catch((error: unknown) => {
          handleTransportError(error, phase2Copy.codeError);
        })
        .finally(() => setAccessChecking(false));
      return;
    }
    if (!recoverOnLoad) {
      void device.finally(() => setAccessChecking(false));
      return;
    }
    void port
      .recoverSession()
      .then((session) => {
        if (!session) return;
        applySession(session);
        setPhase("live");
      })
      .catch((error: unknown) => handleTransportError(error))
      .finally(() => setAccessChecking(false));
  }, [applySession, handleTransportError, port, recoverOnLoad]);

  useEffect(() => {
    if (phase !== "live" && phase !== "review") return;
    const sessionRefreshFence = sessionRefreshFenceRef.current;
    const refresh = async (forceAuthoritative = false) => {
      if (!sessionActiveRef.current || document.visibilityState !== "visible" || mutationInFlightRef.current > 0) {
        return;
      }
      try {
        const recoverAuthoritatively =
          forceAuthoritative ||
          writerStateRef.current === phase2Machine.candidate ||
          writerStateRef.current === phase2Machine.expiring;
        await sessionRefreshFence.run(
          (signal) =>
            refreshScoringSessionAccess(
              port,
              {
                lastAcknowledgedSequence: throughSequence,
                pendingEventCount: pendingSync ? 1 : 0,
                pendingThroughSequence: pendingSync ? throughSequence : null,
              },
              recoverAuthoritatively,
              signal,
            ),
          (session) => {
            applySession(session);
          },
        );
      } catch (error) {
        handleTransportError(error);
      }
    };
    let active = true;
    let refreshTimer = 0;
    const scheduleRefresh = () => {
      if (!active) return;
      const delay =
        writerStateRef.current === phase2Machine.candidate || writerStateRef.current === phase2Machine.expiring
          ? 2_000
          : 15_000;
      refreshTimer = window.setTimeout(() => {
        void refresh().finally(scheduleRefresh);
      }, delay);
    };
    scheduleRefresh();
    const visibility = () => {
      if (document.visibilityState !== "visible") return;
      if (writerStateRef.current === phase2Machine.active) {
        writerStateRef.current = phase2Machine.expiring;
        setWriterState(phase2Machine.expiring);
        setAnnouncement(phase2Copy.leaseExpiring);
        pendingWriterFocusRef.current = phase2Machine.expiring;
      }
      void refresh(true);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      sessionRefreshFence.cancel();
      window.clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [applySession, handleTransportError, pendingSync, phase, port, throughSequence]);

  useEffect(() => {
    if ((!pendingAction && !reversalTarget) || !actionDialogRef.current) return;
    const dialog = actionDialogRef.current;
    if (!dialog.open) dialog.showModal();
    const focusFrame = window.requestAnimationFrame(() => {
      const needsParticipant = Boolean(reversalTarget) || pendingAction?.control.participantAttribution !== "none";
      if (needsParticipant) scorerInputRef.current?.focus();
      else actionDialogTitleRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [pendingAction, reversalTarget]);

  useEffect(() => {
    if (phase !== "review") return;
    const frame = window.requestAnimationFrame(() => {
      finalReviewRef.current?.focus({ preventScroll: true });
      finalReviewRef.current?.scrollIntoView({ block: phase2Machine.scrollNearest });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (!reversedFocusId) return;
    const frame = window.requestAnimationFrame(() => {
      timelineActionRefs.current.get(reversedFocusId)?.focus({ preventScroll: true });
      setReversedFocusId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reversedFocusId, scoreState.actions]);

  const validate = async () => {
    setAccessChecking(true);
    try {
      const device = await getScoringDeviceIdentity();
      setDeviceLabel(device.label);
      setDeviceLabelDraft(device.label);
      const session = await port.exchangeAccess({ shortCode: code.trim(), device });
      applySession(session);
      setCodeError("");
      setPhase(session.mode === phase2Machine.writer ? "confirm" : "live");
      setAnnouncement(scoringSessionAnnouncement(session));
    } catch (error) {
      handleTransportError(error, phase2Copy.codeError);
    } finally {
      setAccessChecking(false);
    }
  };

  const editDeviceLabel = () => {
    setDeviceLabelDraft(deviceLabel);
    setEditingDeviceLabel(true);
    window.requestAnimationFrame(() => deviceLabelInputRef.current?.focus());
  };

  const cancelDeviceLabel = () => {
    setDeviceLabelDraft(deviceLabel);
    setEditingDeviceLabel(false);
    window.requestAnimationFrame(() => editDeviceButtonRef.current?.focus());
  };

  const saveDeviceLabel = async () => {
    try {
      const identity = await renameScoringDevice(deviceLabelDraft);
      setDeviceLabel(identity.label);
      setDeviceLabelDraft(identity.label);
      setEditingDeviceLabel(false);
      setAnnouncement(t("prototype.d9ff75e574c6"));
      window.requestAnimationFrame(() => editDeviceButtonRef.current?.focus());
    } catch {
      setAnnouncement(phase2Copy.serviceUnavailable);
    }
  };

  const requestTakeover = async () => {
    mutationInFlightRef.current += 1;
    sessionRefreshFenceRef.current.cancel();
    try {
      const result = await port.requestTakeover({
        pendingEventCount: pendingSync ? 1 : 0,
        pendingThroughSequence: pendingSync ? throughSequence : null,
      });
      setTakeoverPending(result.status === "pending");
      setAnnouncement(phase2Copy.takeoverRequested);
    } catch (error) {
      handleTransportError(error);
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
    }
  };

  const startScoring = async () => {
    mutationInFlightRef.current += 1;
    sessionRefreshFenceRef.current.cancel();
    setStarting(true);
    setInteractionError("");
    setAnnouncement(phase2Copy.scoreControlsPending);
    try {
      const receipt = await port.appendEvent({
        clientEventId: crypto.randomUUID(),
        expectedSequence: throughSequence,
        matchId,
        eventType: phase2Machine.matchStarted,
        canonical: true,
        scorer: "",
        period: 1,
        manualTime: "00:00",
      });
      setPendingSync(receipt.syncState === "pending");
      applySession(await port.recoverSession());
      setPhase("live");
    } catch (error) {
      handleTransportError(error);
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setStarting(false);
    }
  };

  const closeActionDialog = () => {
    if (actionDialogRef.current?.open) actionDialogRef.current.close();
    setPendingAction(null);
    setReversalTarget(null);
    setReversalReason("");
    setUnknownParticipant(false);
    setScorerError("");
    const returnTarget = actionReturnTargetRef.current;
    actionReturnTargetRef.current = null;
    window.requestAnimationFrame(() => returnTarget?.focus({ preventScroll: true }));
  };

  const openActionDialog = (action: ScoreControlAction, trigger: HTMLButtonElement) => {
    actionReturnTargetRef.current = trigger;
    setScorer("");
    setUnknownParticipant(false);
    setScorerError("");
    setPendingAction(action);
    setReversalTarget(null);
  };

  const openReversalDialog = (
    action: ScoringSessionView["scoreState"]["actions"][number],
    trigger: HTMLButtonElement,
  ) => {
    actionReturnTargetRef.current = trigger;
    setReversalReason("");
    setScorerError("");
    setPendingAction(null);
    setReversalTarget(action);
  };

  const recordAction = async () => {
    if (!pendingAction) return;
    const participant = scorer.trim();
    if (pendingAction.control.participantAttribution === "required" && !participant && !unknownParticipant) {
      setScorerError(phase2Copy.participantRequired);
      scorerInputRef.current?.focus();
      return;
    }
    const segmentNumber = Number(period);
    const submittedSegmentNumber = canonicalSegmentNumber(
      pendingAction.control.id,
      scoreState.currentSegment,
      segmentNumber,
    );
    const manualTimeSeconds = manualTimeEnabled ? timeSeconds(eventTime) : null;
    if (!Number.isInteger(segmentNumber) || segmentNumber < 1 || (manualTimeEnabled && manualTimeSeconds === null)) {
      setScorerError(phase2Copy.periodRequired);
      return;
    }
    setScorerError("");
    setInteractionError("");
    const command: ScoringEventCommand = {
      clientEventId: crypto.randomUUID(),
      expectedSequence: throughSequence,
      matchId,
      eventType: pendingAction.control.id,
      canonical: true,
      ...(pendingAction.side ? { team: pendingAction.side } : {}),
      scorer: participant,
      ...(participant ? { participantId: participant } : {}),
      ...(unknownParticipant ? { unknownParticipant: true } : {}),
      period: submittedSegmentNumber,
      segmentNumber: submittedSegmentNumber,
      manualTime: eventTime,
      ...(manualTimeEnabled ? { manualTimeSeconds } : {}),
      occurredAt: new Date().toISOString(),
    };
    mutationInFlightRef.current += 1;
    sessionRefreshFenceRef.current.cancel();
    setActionPending(true);
    setAnnouncement(phase2Copy.scoreControlsPending);
    try {
      const receipt = await port.appendEvent(command);
      setPendingSync(receipt.syncState === "pending");
      applySession(await port.recoverSession());
      setAnnouncement(phase2Copy.eventRecorded);
      closeActionDialog();
    } catch (error) {
      handleTransportError(error);
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setActionPending(false);
    }
  };

  const reverseAction = async () => {
    if (!reversalTarget) return;
    const reason = reversalReason.trim();
    if (reason.length < 3) {
      setScorerError(phase2Copy.reversalReasonHint);
      scorerInputRef.current?.focus();
      return;
    }
    mutationInFlightRef.current += 1;
    setInteractionError("");
    sessionRefreshFenceRef.current.cancel();
    setActionPending(true);
    setAnnouncement(phase2Copy.scoreControlsPending);
    try {
      const receipt = await port.appendEvent({
        clientEventId: crypto.randomUUID(),
        expectedSequence: throughSequence,
        matchId,
        eventType: phase2Machine.reversal,
        canonical: true,
        scorer: "",
        period: reversalTarget.segmentNumber,
        segmentNumber: reversalTarget.segmentNumber,
        manualTime: eventTime,
        reversalTargetEventId: reversalTarget.eventId,
        reason,
        occurredAt: new Date().toISOString(),
      });
      setPendingSync(receipt.syncState === "pending");
      applySession(await port.recoverSession());
      setAnnouncement(phase2Copy.eventReversed);
      const targetId = reversalTarget.eventId;
      actionReturnTargetRef.current = null;
      closeActionDialog();
      setReversedFocusId(targetId);
    } catch (error) {
      handleTransportError(error);
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setActionPending(false);
    }
  };

  const finalize = async () => {
    mutationInFlightRef.current += 1;
    setInteractionError("");
    sessionRefreshFenceRef.current.cancel();
    setAnnouncement(phase2Copy.scoreControlsPending);
    try {
      const receipt = await port.finalizeResult({
        matchId,
        expectedSequence: throughSequence,
        homeScore: score.home,
        awayScore: score.away,
        scorer: scorer.trim(),
      });
      setFinalReceipt(receipt);
      setPhase("receipt");
    } catch (error) {
      handleTransportError(error);
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
    }
  };

  if (phase === "access" || phase === "confirm") {
    return (
      <main className="p2-score-access" id="score-main">
        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
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
                {codeError ? (
                  <em id="scoring-code-error" role="alert">
                    {codeError}
                  </em>
                ) : null}
              </label>
              <button className="p2-score-primary" type="button" onClick={validate} disabled={accessChecking}>
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
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <header className="p2-score__header">
        <div>
          <p>{stage}</p>
          <h1>{matchLabel}</h1>
        </div>
        <div
          ref={writerStatusRef}
          className={`p2-writer p2-writer--${writerState}`}
          aria-label={writerTitle}
          tabIndex={-1}
        >
          {writerState === "active" ? <CloudCheck /> : writerState === "conflict" ? <ShieldWarning /> : <LockKey />}
          <span>
            <strong>{writerTitle}</strong>
            <small>{writerState === "active" ? phase2Copy.synced : phase2Copy.currentRevision}</small>
          </span>
        </div>
      </header>
      {interactionError ? (
        <section ref={interactionErrorRef} className="p2-score-warning" tabIndex={-1}>
          <Warning aria-hidden="true" />
          <div>
            <strong>{interactionError}</strong>
          </div>
        </section>
      ) : null}
      <section className="p5-scoring-device" aria-labelledby="scoring-device-label">
        <strong id="scoring-device-label">{t("prototype.fb6eea41124e")}</strong>
        {editingDeviceLabel ? (
          <div>
            <label>
              <span>{t("prototype.155106be1173")}</span>
              <input
                ref={deviceLabelInputRef}
                value={deviceLabelDraft}
                onChange={(event) => setDeviceLabelDraft(event.target.value)}
                maxLength={80}
              />
            </label>
            <button
              className="p2-score-primary"
              type="button"
              disabled={!deviceLabelDraft.trim()}
              onClick={() => void saveDeviceLabel()}
            >
              {t("prototype.1509f561f241")}
            </button>
            <button className="p2-score-secondary" type="button" onClick={cancelDeviceLabel}>
              {phase2Copy.cancel}
            </button>
          </div>
        ) : (
          <div>
            <span>{deviceLabel || t("prototype.06c4a77e4b3e")}</span>
            <button ref={editDeviceButtonRef} className="p2-score-secondary" type="button" onClick={editDeviceLabel}>
              {t("prototype.0d5e5c1ab863")}
            </button>
          </div>
        )}
      </section>
      {writerState === "conflict" ? (
        <section className="p2-score-warning" role="alert">
          <Warning />
          <div>
            <strong>{phase2Copy.writerConflict}</strong>
            <p>{phase2Copy.writerConflictBody}</p>
          </div>
        </section>
      ) : null}
      {writerState === phase2Machine.candidate ||
      writerState === phase2Machine.transferred ||
      writerState === phase2Machine.checking ||
      writerState === phase2Machine.expired ||
      writerState === phase2Machine.expiring ||
      writerState === phase2Machine.revoked ||
      writerState === phase2Machine.rateLimited ||
      writerState === phase2Machine.readOnly ? (
        <section className="p2-score-warning">
          <LockKey />
          <div>
            <strong>{writerTitle}</strong>
            <p>
              {writerState === phase2Machine.candidate
                ? phase2Copy.candidateBody
                : writerState === phase2Machine.transferred
                  ? phase2Copy.transferredBody
                  : writerState === phase2Machine.expiring
                    ? phase2Copy.leaseExpiringBody
                    : writerState === phase2Machine.expired
                      ? phase2Copy.qrUnavailableBody
                      : writerState === phase2Machine.revoked
                        ? phase2Copy.sessionRevoked
                        : writerState === phase2Machine.rateLimited
                          ? phase2Copy.rateLimited
                          : writerState === phase2Machine.readOnly
                            ? phase2Copy.candidateBody
                            : phase2Copy.leaseExpiringBody}
            </p>
            {writerState === phase2Machine.candidate && !takeoverPending ? (
              <button className="p2-score-secondary" type="button" onClick={() => void requestTakeover()}>
                {phase2Copy.requestTakeover}
              </button>
            ) : null}
            {takeoverPending ? <p>{phase2Copy.takeoverRequested}</p> : null}
          </div>
        </section>
      ) : null}
      {phase === "review" ? (
        <section className="p2-final-review" ref={finalReviewRef} tabIndex={-1} aria-labelledby="final-summary-title">
          <p className="p2-eyebrow">{phase2Copy.reviewFinal}</p>
          <h2 id="final-summary-title">
            {home} {score.home}–{score.away} {away}
          </h2>
          <p>{phase2Copy.finalReviewBody}</p>
          <dl className="p2-final-summary">
            <div>
              <dt>{phase2Copy.matchLifecycle}</dt>
              <dd>{scoreState.lifecycle.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>{phase2Copy.currentSegment}</dt>
              <dd>
                {definition.segmentLabel} {scoreState.currentSegment}
              </dd>
            </div>
            <div>
              <dt>{phase2Copy.segmentWins}</dt>
              <dd>
                {scoreState.segmentWins.home}–{scoreState.segmentWins.away}
              </dd>
            </div>
            <div>
              <dt>{phase2Copy.totalPoints}</dt>
              <dd>
                {scoreState.totalPoints.home}–{scoreState.totalPoints.away}
              </dd>
            </div>
            <div>
              <dt>{phase2Copy.recordedActions}</dt>
              <dd>{scoreState.actions.filter((action) => !action.reversed).length}</dd>
            </div>
            <div>
              <dt>{phase2Copy.noLiveClock}</dt>
              <dd>{phase2Copy.manualTimeOnly}</dd>
            </div>
          </dl>
          <button className="p2-score-primary" type="button" disabled={locked} onClick={finalize}>
            {phase2Copy.finalise}
            <Check />
          </button>
          <button
            className="p2-score-secondary"
            type="button"
            onClick={() => {
              setPhase("live");
              window.requestAnimationFrame(() => scoreControlsRef.current?.focus({ preventScroll: true }));
            }}
          >
            {phase2Copy.edit}
          </button>
        </section>
      ) : (
        <>
          <section className="p2-event-controls" aria-label={definition.displayName}>
            <div className="p2-event-context">
              <div>
                <label>
                  <span>{definition.segmentLabel}</span>
                  <select value={period} onChange={(event) => setPeriod(event.target.value)} disabled={locked}>
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
                      disabled={locked}
                    />
                  </label>
                ) : null}
              </div>
            </div>
            <div ref={scoreControlsRef} role="group" aria-label={phase2Copy.scoreControlsTitle} tabIndex={-1}>
              {definition.scoreMode === "segments" ? (
                <dl className="p2-segment-score" aria-label={`${definition.segmentLabel} ${scoreState.currentSegment}`}>
                  <div>
                    <dt>{home}</dt>
                    <dd>
                      {scoreState.segments.find((segment) => segment.number === scoreState.currentSegment)?.home ?? 0}
                    </dd>
                  </div>
                  <div>
                    <dt>{away}</dt>
                    <dd>
                      {scoreState.segments.find((segment) => segment.number === scoreState.currentSegment)?.away ?? 0}
                    </dd>
                  </div>
                </dl>
              ) : null}
              <FiveSportScoreControls
                definition={definition}
                homeLabel={home}
                awayLabel={away}
                score={score}
                copy={scoreControlsCopy}
                readOnly={locked}
                pending={actionPending}
                statusMessage={
                  manualTimeEnabled
                    ? `${definition.segmentLabel} ${scoreState.currentSegment} · ${phase2Copy.manualTime} ${eventTime}`
                    : `${definition.segmentLabel} ${scoreState.currentSegment}`
                }
                onActivate={openActionDialog}
              />
            </div>
          </section>
          <section className="p2-event-log" aria-labelledby="event-log-title">
            <header>
              <h2 id="event-log-title">{phase2Copy.recentCanonicalEvents}</h2>
              <span>
                <Clock />
                {pendingSync ? phase2Copy.syncPending : phase2Copy.synced}
              </span>
            </header>
            {scoreState.actions.length ? (
              <ol>
                {[...scoreState.actions].reverse().map((action) => (
                  <li
                    key={action.eventId}
                    data-event-id={action.eventId}
                    ref={(element) => {
                      if (element) timelineActionRefs.current.set(action.eventId, element);
                      else timelineActionRefs.current.delete(action.eventId);
                    }}
                    tabIndex={-1}
                  >
                    <time dateTime={action.occurredAt}>
                      {definition.segmentLabel} {action.segmentNumber}
                    </time>
                    <span>
                      <strong>
                        {action.label} {action.reversed ? `· ${phase2Copy.reversed}` : ""}
                      </strong>
                      <small>
                        {action.side === phase2Machine.home
                          ? home
                          : action.side === phase2Machine.away
                            ? away
                            : phase2Copy.incident}
                      </small>
                    </span>
                    {action.reversible && !action.reversed && !locked ? (
                      <button
                        className="p2-score-secondary"
                        type="button"
                        onClick={(event) => openReversalDialog(action, event.currentTarget)}
                      >
                        {phase2Copy.reverseEvent}
                      </button>
                    ) : (
                      <span>{action.participantId ?? "—"}</span>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p>{phase2Copy.noEvents}</p>
            )}
          </section>
          {!locked ? (
            <button className="p2-score-primary p2-score-final" type="button" onClick={() => setPhase("review")}>
              {phase2Copy.reviewFinal}
              <ArrowRight />
            </button>
          ) : null}
          {pendingAction || reversalTarget ? (
            <dialog
              className="p2-goal-sheet"
              ref={actionDialogRef}
              aria-labelledby="score-action-title"
              aria-describedby="score-action-description"
              onCancel={(event) => {
                event.preventDefault();
                if (!actionPending) closeActionDialog();
              }}
            >
              <div className="p2-goal-sheet__handle" aria-hidden="true" />
              <header>
                <p className="p2-eyebrow">{definition.displayName}</p>
                <h2 id="score-action-title" ref={actionDialogTitleRef} tabIndex={-1}>
                  {reversalTarget
                    ? phase2Copy.reversalTitle
                    : pendingAction?.control.id === phase2Machine.goal
                      ? phase2Copy.confirmGoalTitle
                      : `${phase2Copy.recordEvent}: ${pendingAction?.control.label ?? ""}`}
                </h2>
                <p id="score-action-description">
                  {reversalTarget ? phase2Copy.reversalBody : phase2Copy.actionDialogBody}
                </p>
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
              {reversalTarget || pendingAction?.control.participantAttribution !== "none" ? (
                <>
                  <label>
                    <span>{reversalTarget ? phase2Copy.reversalReason : phase2Copy.participantLabel}</span>
                    <span className="p2-input-icon">
                      <UserCircle />
                      <input
                        ref={scorerInputRef}
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
                <button
                  className="p2-score-secondary"
                  type="button"
                  disabled={actionPending}
                  onClick={closeActionDialog}
                >
                  {phase2Copy.cancel}
                </button>
                <button
                  className="p2-score-primary"
                  type="button"
                  disabled={actionPending}
                  onClick={() => void (reversalTarget ? reverseAction() : recordAction())}
                >
                  {reversalTarget
                    ? phase2Copy.confirmReversal
                    : pendingAction?.control.id === phase2Machine.goal
                      ? `${phase2Copy.recordGoalFor} ${pendingAction.side === phase2Machine.home ? home : away}`
                      : phase2Copy.recordEvent}
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
