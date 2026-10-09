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
import { gateCOfflineQueueLimit, gateCOfflineQueueWarningCount } from "@matchday/contracts";
import type { SportId } from "@matchday/domain";
import { interpolate, opaqueId, scorerMessages, translate as t } from "@matchday/ui";
import { phase2Copy, phase2Machine, type ScoringEventCommand, type ScoringSessionView } from "@/lib/phase2";
import { FiveSportScoreControls, type FiveSportScoreControlsCopy } from "@/components/phase5/FiveSportScoreControls";
import { buildFiveSportScorecardDefinition } from "@/lib/five-sport-scorecard";
import type { ScoreControlAction } from "@/lib/five-sport-score-control-actions";
import { getScoringDeviceIdentity, renameScoringDevice } from "@/lib/scoring-device";
import {
  IndexedDbOfflineScoringRepository,
  OfflineReplayController,
  createOfflineDiagnosticExport,
  type OfflineScoringRepository,
} from "@/lib/offline-scoring";
import {
  enqueueOfflineEvent,
  enqueueOfflineFinalisation,
  OfflineReconnectSingleFlight,
  reconcileOfflineReplayRecovery,
  recoverOfflineScoringSession,
  saveOfflineMatchPackage,
} from "@/lib/offline-scoring-coordinator";
import { ApiOfflineScoringPort, emptyOfflineQueueSummary, offlineQueueSummary } from "@/lib/offline-scoring-port";
import {
  clearScoringPrincipalCookie,
  readScoringPrincipalCookie,
  retainScoringPrincipalCookie,
} from "@/lib/offline-scoring-principal";
import {
  assertScoringWorkerTransitionAllowed,
  guardScoringWorkerTransport,
  isScoringWorkerSafetyFrozen,
  prepareOfflineScoringShell,
  runScoringWorkerTransition,
  scoringWorkerFreezeAllowedOfflineMethods,
  ScoringWorkerPreparationError,
  ScoringWorkerSafetyFrozenError,
  scoringWorkerVersion,
} from "@/lib/scoring-service-worker";
import {
  canonicalSegmentNumber,
  createScoringCommandPort,
  recoveredOfflineState,
  refreshScoringSessionAccess,
  scoringRefreshFailureState,
  scoringMutationIsLocked,
  scoringSessionAnnouncement,
  scoringWriterAvailability,
  ScoringTransportError,
  terminalOfflineQueueState,
} from "@/lib/phase2-scoring";
import { LatestRequestFence } from "@/lib/latest-request";
import { elapsedTimeMode, formatRecordedTime, recordedElapsedSeconds } from "@/lib/scoring-time";
import {
  emptyTapQueue,
  isOneTapAction,
  nextTapToSend,
  optimisticDelta,
  tapQueueIdle,
  tapQueueReducer,
  unsentTapCount,
  withExpectedSequence,
  type QueuedTap,
  type TapQueueAction,
  type TapQueueState,
} from "@/lib/scorer-tap-queue";
import { scorerLinkTarget, scorerStatus } from "@/lib/scorer-status";
import { useUrlSearch } from "@/components/ui/useUrlSearch";
import { useHighContrast, useOnline, useScreenWakeLock } from "@/components/ui/useScorerDevice";
import styles from "./PhoneScoring.module.css";

/** How long the inline Undo stays available after a one-tap action. */
const undoWindowMs = 5_000;
type UndoToast = Readonly<{ tapId: string; text: string; label: string }>;

type ScoringPhase = "access" | "confirm" | "live" | "review" | "receipt";
type OfflineState =
  | "online"
  | "preparing"
  | "offline-ready"
  | "offline-recording"
  | "pending-sync"
  | "reconnecting"
  | "replaying"
  | "pending-finalisation"
  | "conflict"
  | "expired"
  | "revoked"
  | "read-only"
  | "storage-error";
type OfflineResources = {
  repository: OfflineScoringRepository;
  port: ApiOfflineScoringPort;
  replay: OfflineReplayController;
};
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
  const port = useMemo(
    () => guardScoringWorkerTransport(createScoringCommandPort(mode, demoSportId)),
    [demoSportId, mode],
  );
  const [phase, setPhase] = useState<ScoringPhase>(phase2Machine.access);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [accessChecking, setAccessChecking] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scorer, setScorer] = useState("");
  const [scorerError, setScorerError] = useState("");
  const [period, setPeriod] = useState("1");
  const [eventTime, setEventTime] = useState("00:00");
  const [timeMode, setTimeMode] = useState<"elapsed" | "remaining">(elapsedTimeMode);
  const [periodDurationMinutes, setPeriodDurationMinutes] = useState<number | null>(null);
  const [scorecardDefinition, setScorecardDefinition] = useState(() => buildFiveSportScorecardDefinition(demoSportId));
  const [allowUnknownScorer, setAllowUnknownScorer] = useState(false);
  const [unknownParticipant, setUnknownParticipant] = useState(false);
  const [scoreState, setScoreState] = useState<ScoringSessionView["scoreState"]>(initialScoreState);
  const [writerState, setWriterState] = useState<WriterState>(initialWriterState);
  const [pendingSync, setPendingSync] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [offlineState, setOfflineState] = useState<OfflineState>(phase2Machine.offlineOnline);
  const [offlinePreparationErrorCode, setOfflinePreparationErrorCode] = useState<string | null>(null);
  const transportOnlineRef = useRef(true);
  const [offlineAuthorizationId, setOfflineAuthorizationId] = useState<string | null>(null);
  const [offlineRecordingExpiresAt, setOfflineRecordingExpiresAt] = useState<string | null>(null);
  const [offlineReplayExpiresAt, setOfflineReplayExpiresAt] = useState<string | null>(null);
  const [diagnosticExportSha, setDiagnosticExportSha] = useState<string | null>(null);
  const [replayRequest, setReplayRequest] = useState(0);
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
  const [competitionName, setCompetitionName] = useState<string | null>(null);
  const [matchId, setMatchId] = useState(phase2Machine.matchTwelveId);
  const [matchLabel, setMatchLabel] = useState<string>(phase2Copy.matchTwelve);
  const [stage, setStage] = useState<string>(phase2Copy.groupB);
  const [fixtureSchedule, setFixtureSchedule] = useState<ScoringSessionView["schedule"]>(null);
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
  const [sheetTranslateY, setSheetTranslateY] = useState(0);
  const touchStartYRef = useRef<number | null>(null);
  const actionDialogRef = useRef<HTMLDialogElement>(null);
  const signOutDialogRef = useRef<HTMLDialogElement>(null);
  const endSessionButtonRef = useRef<HTMLButtonElement>(null);
  const actionReturnTargetRef = useRef<HTMLButtonElement | null>(null);
  const actionDialogViewportRef = useRef<{ left: number; top: number } | null>(null);
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
  const offlineResourcesRef = useRef<OfflineResources | null>(null);
  const principalIdRef = useRef<string | null>(null);
  const offlineReconnectRef = useRef(new OfflineReconnectSingleFlight());
  const offlineReplayAbortRef = useRef<AbortController | null>(null);
  const componentMountedRef = useRef(false);
  const offlineStatusRef = useRef<HTMLElement>(null);
  const [tapQueue, setTapQueue] = useState<TapQueueState>(() => emptyTapQueue());
  const tapQueueRef = useRef<TapQueueState>(tapQueue);
  const drainingRef = useRef(false);
  const scoreStateRef = useRef(scoreState);
  const offlineAuthorizationIdRef = useRef<string | null>(null);
  const handleTransportErrorRef = useRef<((error: unknown) => Promise<void>) | null>(null);
  const [undoToast, setUndoToast] = useState<UndoToast | null>(null);
  const [reversalPreset, setReversalPreset] = useState<string | null>(null);
  const online = useOnline();
  const [search] = useUrlSearch();
  const linkTarget = useMemo(() => scorerLinkTarget(search), [search]);
  const codeNeedsLink = mode === phase2Machine.scoringApiMode && !linkTarget.matchId && !linkTarget.competitionId;
  const [highContrast, setHighContrast] = useHighContrast();
  const wakeLock = useScreenWakeLock(phase === "live");
  const commitTap = useCallback((action: TapQueueAction) => {
    tapQueueRef.current = tapQueueReducer(tapQueueRef.current, action);
    setTapQueue(tapQueueRef.current);
  }, []);

  const definition = scorecardDefinition;
  const manualTimeEnabled = definition.fields.some((field) => field.id === "manual_event_time" && field.enabled);
  const recordedSeconds = manualTimeEnabled ? recordedElapsedSeconds(eventTime, timeMode, periodDurationMinutes) : null;
  const elapsedTime = recordedSeconds === null ? null : formatRecordedTime(recordedSeconds);
  const score = { home: scoreState.home, away: scoreState.away };
  // Optimistic: taps not yet folded into the authoritative score move it immediately.
  const currentSegmentScore = scoreState.segments.find((segment) => segment.number === scoreState.currentSegment);
  const displayScore =
    definition.scoreMode === "segments"
      ? score
      : {
          home: score.home + optimisticDelta(tapQueue, phase2Machine.home),
          away: score.away + optimisticDelta(tapQueue, phase2Machine.away),
        };
  const displaySegmentScore = {
    home: (currentSegmentScore?.home ?? 0) + optimisticDelta(tapQueue, phase2Machine.home, scoreState.currentSegment),
    away: (currentSegmentScore?.away ?? 0) + optimisticDelta(tapQueue, phase2Machine.away, scoreState.currentSegment),
  };
  const tapsIdle = tapQueueIdle(tapQueue);
  const unsentTaps = unsentTapCount(tapQueue);
  const supportsPeriodAdvance = definition.operationalControls.some(
    (control) => control.id === phase2Machine.periodChange,
  );
  const activeScorecardDefinition = useMemo(() => {
    if (!supportsPeriodAdvance) return definition;
    return {
      ...definition,
      operationalControls: definition.operationalControls.filter(
        (control) => control.id !== phase2Machine.periodChange,
      ),
    };
  }, [definition, supportsPeriodAdvance]);
  const locked = scoringMutationIsLocked({
    writerState,
    offlineState,
    hasOfflineAuthorization: offlineAuthorizationId !== null,
    pendingCount,
    queueLimit: gateCOfflineQueueLimit,
  });
  const status = scorerStatus({
    writerState,
    offlineState,
    online,
    pendingCount: pendingCount + unsentTaps,
    syncing: !tapsIdle,
  });
  const writerTitle =
    writerState === phase2Machine.active
      ? scorerMessages.titles.active
      : writerState === phase2Machine.expired
        ? scorerMessages.titles.expired
        : writerState === phase2Machine.expiring
          ? scorerMessages.titles.expiring
          : writerState === phase2Machine.revoked
            ? scorerMessages.titles.revoked
            : writerState === phase2Machine.rateLimited
              ? scorerMessages.titles.rateLimited
              : writerState === phase2Machine.candidate
                ? scorerMessages.titles.candidate
                : writerState === phase2Machine.transferred
                  ? scorerMessages.titles.transferred
                  : writerState === phase2Machine.checking
                    ? scorerMessages.titles.checking
                    : writerState === phase2Machine.conflict
                      ? scorerMessages.titles.conflict
                      : scorerMessages.titles.readOnly;

  const applySession = useCallback(
    async (session: ScoringSessionView | null): Promise<void> => {
      if (!session) return;
      assertScoringWorkerTransitionAllowed();
      const previousPrincipalId = principalIdRef.current ?? readScoringPrincipalCookie();
      if (previousPrincipalId && previousPrincipalId !== session.principalId) {
        sessionRefreshFenceRef.current.cancel();
        offlineReplayAbortRef.current?.abort();
      }
      await offlineResourcesRef.current?.repository.bindPrincipal(session.principalId);
      principalIdRef.current = session.principalId;
      retainScoringPrincipalCookie(session.principalId, session.expiresAt);
      const previousState = writerStateRef.current;
      setCompetitionSlug(session.competitionSlug);
      setCompetitionName(session.competitionName ?? session.competitionSlug);
      setScorecardDefinition(buildFiveSportScorecardDefinition(session.sportId, session.sportSettings));
      setAllowUnknownScorer(
        session.sportId === phase2Machine.canoePolo && session.sportSettings.allowUnknownScorer === true,
      );
      setMatchId(session.matchId);
      setMatchLabel(session.matchLabel);
      setStage(session.stage);
      setFixtureSchedule(session.schedule ?? null);
      setPeriodDurationMinutes(session.periodDurationMinutes ?? null);
      setHome(session.home);
      setAway(session.away);
      setScoreState(session.scoreState);
      scoreStateRef.current = session.scoreState;
      setPeriod(String(session.scoreState.currentSegment));
      setThroughSequence(session.throughSequence);
      commitTap({ type: "sync", sequence: session.throughSequence });
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
            ? scorerMessages.titles.active
            : nextState === phase2Machine.expiring
              ? scorerMessages.titles.expiring
              : scorerMessages.titles.transferred,
        );
        pendingWriterFocusRef.current =
          nextState === phase2Machine.active
            ? phase2Machine.active
            : nextState === phase2Machine.expiring
              ? phase2Machine.expiring
              : phase2Machine.transferred;
      }
    },
    [commitTap],
  );

  const offlineResources = useCallback(async (): Promise<OfflineResources> => {
    if (offlineResourcesRef.current) return offlineResourcesRef.current;
    const device = await getScoringDeviceIdentity();
    const repository = new IndexedDbOfflineScoringRepository();
    if (principalIdRef.current) await repository.bindPrincipal(principalIdRef.current);
    const offlinePort = guardScoringWorkerTransport(new ApiOfflineScoringPort(device.id, 1, scoringWorkerVersion), {
      allowDuringFreeze: scoringWorkerFreezeAllowedOfflineMethods,
    });
    const resources = {
      repository,
      port: offlinePort,
      replay: new OfflineReplayController({ repository, port: offlinePort }),
    };
    offlineResourcesRef.current = resources;
    return resources;
  }, []);

  const applyOfflineProjection = useCallback(
    async (session: ScoringSessionView, authorizationId: string, count: number, state: OfflineState) => {
      await applySession(session);
      setOfflineAuthorizationId(authorizationId);
      setPendingCount(count);
      setPendingSync(count > 0);
      setOfflineState(state);
      setPhase("live");
    },
    [applySession],
  );

  const prepareOfflineAuthority = useCallback(
    (session: ScoringSessionView) =>
      runScoringWorkerTransition(async () => {
        if (mode !== phase2Machine.scoringApiMode || session.mode !== "writer" || session.readOnly) return;
        setOfflinePreparationErrorCode(null);
        setOfflineState(phase2Machine.offlinePreparing);
        const resources = await offlineResources();
        await resources.repository.bindPrincipal(session.principalId);
        const summary = await emptyOfflineQueueSummary(session.matchId, session.throughSequence);
        const result = await resources.port.establishAuthority(summary, phase2Machine.offlinePrepareIntent);
        const authoritative = result.session ?? session;
        const matchPackage = await saveOfflineMatchPackage(resources.repository, authoritative, result.offline);
        retainScoringPrincipalCookie(session.principalId, matchPackage.replay_expires_at);
        setOfflineAuthorizationId(matchPackage.authorization_id);
        setOfflineRecordingExpiresAt(matchPackage.recording_expires_at);
        setOfflineReplayExpiresAt(matchPackage.replay_expires_at);
        try {
          await prepareOfflineScoringShell();
        } catch (preparationError) {
          try {
            await resources.port.revokeAuthority(phase2Machine.offlinePreparationRollbackIntent);
            await resources.repository.discardResolvedAuthorization(matchPackage.authorization_id);
            setOfflineAuthorizationId(null);
            setOfflineRecordingExpiresAt(null);
            setOfflineReplayExpiresAt(null);
          } catch {
            // Keep the empty package and sealed resume grant so an online retry can
            // finish preparation or explicitly end the retained authority.
          }
          throw preparationError;
        }
        setPendingCount(0);
        setPendingSync(false);
        setOfflinePreparationErrorCode(null);
        setOfflineState(phase2Machine.offlineReady);
        setAnnouncement(phase2Copy.offlinePreparedAnnouncement);
      }),
    [mode, offlineResources],
  );

  const recoverStoredOfflineSession = useCallback(async () => {
    assertScoringWorkerTransitionAllowed();
    try {
      const resources = await offlineResources();
      const principalId = readScoringPrincipalCookie();
      if (!principalId) return false;
      await resources.repository.bindPrincipal(principalId);
      const recovered = await recoverOfflineScoringSession(resources.repository);
      if (!recovered) return false;
      const recoveredState: OfflineState = recoveredOfflineState({
        status: recovered.matchPackage.status,
        recordingExpiresAt: recovered.matchPackage.recording_expires_at,
        replayExpiresAt: recovered.matchPackage.replay_expires_at,
        passExpiresAt: recovered.matchPackage.pass_expires_at,
        pendingCount: recovered.pendingCount,
      });
      await applyOfflineProjection(
        recovered.session,
        recovered.matchPackage.authorization_id,
        recovered.pendingCount,
        recoveredState,
      );
      retainScoringPrincipalCookie(recovered.session.principalId, recovered.matchPackage.replay_expires_at);
      setOfflineRecordingExpiresAt(recovered.matchPackage.recording_expires_at);
      setOfflineReplayExpiresAt(recovered.matchPackage.replay_expires_at);
      setAnnouncement(
        recoveredState === phase2Machine.readOnly
          ? phase2Copy.transferredBody
          : recoveredState === phase2Machine.revoked
            ? phase2Copy.sessionRevoked
            : recoveredState === phase2Machine.expired
              ? phase2Copy.offlineExpiredTitle
              : recovered.pendingCount > 0
                ? phase2Copy.offlinePendingAnnouncement(recovered.pendingCount)
                : phase2Copy.offlineRestoredAnnouncement,
      );
      return true;
    } catch (error) {
      if (error instanceof ScoringWorkerSafetyFrozenError) return false;
      setOfflineState(phase2Machine.offlineStorageError);
      setAnnouncement(phase2Copy.offlineStorageRecoveryError);
      window.requestAnimationFrame(() => offlineStatusRef.current?.focus({ preventScroll: true }));
      return true;
    }
  }, [applyOfflineProjection, offlineResources]);

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

  const handleTransportError = useCallback(
    async (error: unknown, accessMessage: string = phase2Copy.serviceUnavailable): Promise<void> => {
      sessionRefreshFenceRef.current.cancel();
      const ordinarySessionEnded =
        error instanceof ScoringTransportError &&
        (error.code === "SCORING_SESSION_EXPIRED" || error.code === "SCORING_SESSION_REVOKED");
      if (
        ((error instanceof ScoringTransportError && error.state === "unavailable") ||
          ordinarySessionEnded ||
          !navigator.onLine) &&
        (await recoverStoredOfflineSession())
      ) {
        return;
      }
      if (error instanceof ScoringTransportError) {
        if (error.state === phase2Machine.conflict) {
          writerStateRef.current = phase2Machine.conflict;
          setWriterState(phase2Machine.conflict);
          return;
        }
        if (error.state === "invalid") {
          const message =
            error.detailMessage ??
            (error.code === "FINALISATION_INVALID" ? phase2Copy.finalisationNotReady : phase2Copy.semanticRejected);
          if (actionDialogRef.current?.open) {
            setScorerError(message);
            setInteractionError("");
          } else {
            setInteractionError(message);
            setAnnouncement(message);
            window.requestAnimationFrame(() => interactionErrorRef.current?.focus({ preventScroll: true }));
          }
          return;
        }
        if (error.state === "expired" || error.state === "revoked" || error.state === "rate_limited") {
          const offlineTerminalState: "expired" | "revoked" | null =
            error.code === "OFFLINE_AUTHORIZATION_EXPIRED" ||
            error.code === "OFFLINE_RECORDING_EXPIRED" ||
            error.code === "ACCESS_EXPIRED"
              ? phase2Machine.expired
              : error.code === "OFFLINE_AUTHORIZATION_REVOKED" || error.code === "ACCESS_REVOKED"
                ? phase2Machine.revoked
                : null;
          if (offlineTerminalState && offlineAuthorizationId) {
            try {
              const resources = await offlineResources();
              await resources.repository.transitionMatchPackageStatus(offlineAuthorizationId, offlineTerminalState);
            } catch {
              setOfflineState(phase2Machine.offlineStorageError);
              setAnnouncement(phase2Copy.offlineStorageRecoveryError);
              window.requestAnimationFrame(() => offlineStatusRef.current?.focus({ preventScroll: true }));
              return;
            }
          }
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
          if (offlineTerminalState && offlineAuthorizationId) {
            setOfflineState(offlineTerminalState);
            setPhase("live");
            window.requestAnimationFrame(() => offlineStatusRef.current?.focus({ preventScroll: true }));
          } else {
            setPhase("access");
          }
          return;
        }
      }
      setPhase("access");
      setCodeError(accessMessage);
    },
    [offlineAuthorizationId, offlineResources, recoverStoredOfflineSession],
  );

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    transportOnlineRef.current = navigator.onLine;
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
        .then(async (session) => {
          await applySession(session);
          setPhase(session.mode === phase2Machine.writer ? "confirm" : "live");
          setAnnouncement(scoringSessionAnnouncement(session));
        })
        .catch(async (error: unknown) => {
          await handleTransportError(error, phase2Copy.codeError);
        })
        .finally(() => setAccessChecking(false));
      return;
    }
    if (!recoverOnLoad) {
      void device.finally(() => setAccessChecking(false));
      return;
    }
    if (!transportOnlineRef.current || !navigator.onLine) {
      void device.then(() => recoverStoredOfflineSession()).finally(() => setAccessChecking(false));
      return;
    }
    void port
      .recoverSession()
      .then(async (session) => {
        if (!session) {
          if (!(await recoverStoredOfflineSession())) clearScoringPrincipalCookie();
          return;
        }
        await applySession(session);
        if (!(await recoverStoredOfflineSession())) setPhase("live");
      })
      .catch(async (error: unknown) => {
        await handleTransportError(error);
      })
      .finally(() => setAccessChecking(false));
  }, [applySession, handleTransportError, port, recoverOnLoad, recoverStoredOfflineSession]);

  useEffect(() => {
    if (phase !== "live" && phase !== "review") return;
    const sessionRefreshFence = sessionRefreshFenceRef.current;
    const refresh = async (forceAuthoritative = false) => {
      if (
        !sessionActiveRef.current ||
        document.visibilityState !== "visible" ||
        mutationInFlightRef.current > 0 ||
        !transportOnlineRef.current ||
        !navigator.onLine ||
        offlineReplayAbortRef.current
      ) {
        return;
      }
      try {
        const recoveryMode =
          writerStateRef.current === phase2Machine.candidate
            ? phase2Machine.refreshPromotion
            : forceAuthoritative || writerStateRef.current === phase2Machine.expiring
              ? phase2Machine.refreshRenewal
              : phase2Machine.refreshNone;
        await sessionRefreshFence.run(
          (signal) =>
            refreshScoringSessionAccess(
              port,
              {
                lastAcknowledgedSequence: throughSequence,
                pendingEventCount: pendingSync ? 1 : 0,
                pendingThroughSequence: pendingSync ? throughSequence : null,
              },
              recoveryMode,
              signal,
            ),
          applySession,
        );
      } catch (error) {
        if (error instanceof ScoringWorkerSafetyFrozenError) return;
        const preservedState = scoringRefreshFailureState(writerStateRef.current, error, sessionActiveRef.current);
        if (preservedState) {
          writerStateRef.current = preservedState;
          setWriterState(preservedState);
          setAnnouncement(
            preservedState === phase2Machine.expiring ? scorerMessages.titles.expiring : phase2Copy.serviceUnavailable,
          );
          return;
        }
        await handleTransportError(error);
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
      if (isScoringWorkerSafetyFrozen()) return;
      if (writerStateRef.current === phase2Machine.active) {
        writerStateRef.current = phase2Machine.expiring;
        setWriterState(phase2Machine.expiring);
        setAnnouncement(scorerMessages.titles.expiring);
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
  }, [applySession, handleTransportError, pendingSync, phase, port, recoverStoredOfflineSession, throughSequence]);

  useEffect(() => {
    if ((!pendingAction && !reversalTarget) || !actionDialogRef.current) return;
    const dialog = actionDialogRef.current;
    if (!dialog.open) {
      actionDialogViewportRef.current = { left: window.scrollX, top: window.scrollY };
      dialog.showModal();
    }
    const focusFrame = window.requestAnimationFrame(() => {
      const needsParticipant = Boolean(reversalTarget) || pendingAction?.control.participantAttribution !== "none";
      if (needsParticipant) scorerInputRef.current?.focus({ preventScroll: true });
      else actionDialogTitleRef.current?.focus({ preventScroll: true });
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

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
      offlineReplayAbortRef.current?.abort();
      offlineReplayAbortRef.current = null;
    };
  }, []);

  const reconnectAndReplay = useCallback(() => {
    if (!offlineAuthorizationId || mode !== phase2Machine.scoringApiMode) return Promise.resolve();
    if (!transportOnlineRef.current || !navigator.onLine) {
      setOfflineState(phase2Machine.offlinePendingSync);
      return Promise.resolve();
    }
    return offlineReconnectRef.current.run(async () => {
      if (isScoringWorkerSafetyFrozen()) return;
      setDiagnosticExportSha(null);
      const replayAbort = new AbortController();
      offlineReplayAbortRef.current = replayAbort;
      try {
        if (!componentMountedRef.current) return;
        setOfflineState(phase2Machine.offlineReconnecting);
        setAnnouncement(phase2Copy.offlineReconnectAnnouncement);
        const resources = await offlineResources();
        const summary = await offlineQueueSummary(resources.repository, offlineAuthorizationId);
        if (summary.pending_count === 0) {
          setPendingCount(0);
          setPendingSync(false);
          setOfflineState(phase2Machine.offlineReady);
          return;
        }
        const authority = await resources.port.establishAuthority(summary);
        if (!componentMountedRef.current) return;
        if (authority.session) await applySession(authority.session);
        setOfflineState(phase2Machine.offlineReplaying);
        setAnnouncement(phase2Copy.offlineReplayAnnouncement(summary.pending_count));
        const result = await resources.replay.replay(offlineAuthorizationId, replayAbort.signal);
        if (!componentMountedRef.current) return;
        const remaining = await resources.repository.listPendingCommands(offlineAuthorizationId);
        setPendingCount(remaining.length);
        setPendingSync(remaining.length > 0);
        if (result.status === "blocked") {
          const state: OfflineState =
            result.error?.code === "authority_expired" || result.error?.code === "pass_expired"
              ? phase2Machine.expired
              : result.error?.code === "authority_revoked"
                ? phase2Machine.revoked
                : phase2Machine.conflict;
          setOfflineState(state);
          setAnnouncement(phase2Copy.offlineReplayStopped);
          return;
        }
        if (result.status !== "complete") {
          setOfflineState(
            result.status === "offline" ? phase2Machine.offlinePendingSync : phase2Machine.offlineReconnecting,
          );
          return;
        }
        const authoritative = await port.recoverSession();
        if (!authoritative) throw new Error(phase2Copy.offlineAuthoritativeUnavailable);
        if (!componentMountedRef.current) return;
        await applySession(authoritative);
        const replayFinalReceipt = await reconcileOfflineReplayRecovery(
          resources.repository,
          authoritative,
          authority.offline,
        );
        if (!componentMountedRef.current) return;
        setOfflineState(phase2Machine.offlineReady);
        setAnnouncement(phase2Copy.offlineReplayComplete);
        if (replayFinalReceipt) {
          setFinalReceipt(replayFinalReceipt);
          setPhase("receipt");
        }
      } catch (error) {
        if (!componentMountedRef.current) return;
        if (replayAbort.signal.aborted) return;
        if (error instanceof ScoringWorkerSafetyFrozenError) return;
        if (error instanceof ScoringTransportError) {
          setOfflineState(
            error.code === "OFFLINE_AUTHORIZATION_REVOKED"
              ? phase2Machine.revoked
              : error.code === "OFFLINE_AUTHORIZATION_EXPIRED"
                ? phase2Machine.expired
                : error.code === "OFFLINE_AUTHORIZATION_TRANSFERRED" || error.code === "STALE_WRITER_GENERATION"
                  ? phase2Machine.conflict
                  : phase2Machine.offlinePendingSync,
          );
        } else {
          setOfflineState(phase2Machine.offlinePendingSync);
        }
        setAnnouncement(phase2Copy.offlineReplayDeferred);
      } finally {
        if (offlineReplayAbortRef.current === replayAbort) offlineReplayAbortRef.current = null;
      }
    });
  }, [applySession, mode, offlineAuthorizationId, offlineResources, port]);

  useEffect(() => {
    if (!offlineAuthorizationId || mode !== phase2Machine.scoringApiMode) return;
    let subscribed = true;
    const offline = () => {
      if (!subscribed) return;
      transportOnlineRef.current = false;
      if (isScoringWorkerSafetyFrozen()) return;
      void recoverStoredOfflineSession();
    };
    const online = () => {
      if (!subscribed) return;
      transportOnlineRef.current = true;
      void reconnectAndReplay();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (navigator.onLine && pendingCount > 0) void online();
    return () => {
      subscribed = false;
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [
    applySession,
    mode,
    offlineAuthorizationId,
    pendingCount,
    reconnectAndReplay,
    recoverStoredOfflineSession,
    replayRequest,
  ]);

  const validate = async () => {
    setAccessChecking(true);
    try {
      const device = await getScoringDeviceIdentity();
      setDeviceLabel(device.label);
      setDeviceLabelDraft(device.label);
      const session = await port.exchangeAccess({
        shortCode: code.trim(),
        device,
        ...(linkTarget.matchId ? { expectedMatchId: linkTarget.matchId } : {}),
        ...(linkTarget.competitionId ? { expectedCompetitionId: linkTarget.competitionId } : {}),
      });
      await applySession(session);
      setCodeError("");
      setPhase(session.mode === phase2Machine.writer ? "confirm" : "live");
      setAnnouncement(scoringSessionAnnouncement(session));
    } catch (error) {
      await handleTransportError(error, phase2Copy.codeError);
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

  const prepareOfflineForCurrentMatch = async () => {
    try {
      const session = await port.recoverSession();
      if (!session) throw new Error(phase2Copy.offlineAuthoritativeUnavailable);
      await applySession(session);
      await prepareOfflineAuthority(session);
    } catch (error) {
      if (error instanceof ScoringWorkerSafetyFrozenError) return;
      if (error instanceof ScoringTransportError) await handleTransportError(error);
      else {
        setOfflinePreparationErrorCode(
          error instanceof ScoringWorkerPreparationError
            ? error.code
            : phase2Machine.offlineUnexpectedPreparationFailure,
        );
        setOfflineState(phase2Machine.offlineStorageError);
        setAnnouncement(phase2Copy.offlinePreparationRetry);
      }
    }
  };

  const exportOfflineDiagnostics = async (): Promise<string | null> => {
    if (!offlineAuthorizationId) return null;
    try {
      const resources = await offlineResources();
      const exported = await createOfflineDiagnosticExport(resources.repository, offlineAuthorizationId);
      const url = URL.createObjectURL(new Blob([`${exported.json}\n`], { type: "application/json" }));
      const link = document.createElement(phase2Machine.anchorElement);
      link.href = url;
      link.download = `matchday-offline-${matchId}-${exported.sha256.slice(0, 12)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setDiagnosticExportSha(exported.sha256);
      setAnnouncement(phase2Copy.offlineDiagnosticSuccess(exported.sha256));
      return exported.sha256;
    } catch {
      setOfflineState(phase2Machine.offlineStorageError);
      setAnnouncement(phase2Copy.offlineDiagnosticError);
      return null;
    }
  };

  const completeScoringSignOut = async (discardExportedWork: boolean) => {
    if (!offlineAuthorizationId) return;
    try {
      offlineReplayAbortRef.current?.abort();
      await offlineReconnectRef.current.waitForIdle().catch(() => undefined);
      const resources = await offlineResources();
      await resources.port.revokeAuthority();
      if (discardExportedWork) {
        if (!diagnosticExportSha) throw new Error(phase2Copy.offlineExportBeforeDiscard);
        await resources.repository.discardAfterExport(offlineAuthorizationId, diagnosticExportSha, diagnosticExportSha);
      } else {
        await resources.repository.discardResolvedAuthorization(offlineAuthorizationId);
      }
      signOutDialogRef.current?.close();
      offlineResourcesRef.current = null;
      sessionActiveRef.current = false;
      setOfflineAuthorizationId(null);
      setOfflineRecordingExpiresAt(null);
      setOfflineReplayExpiresAt(null);
      setDiagnosticExportSha(null);
      setPendingCount(0);
      setPendingSync(false);
      setOfflineState(phase2Machine.offlineOnline);
      clearScoringPrincipalCookie();
      writerStateRef.current = phase2Machine.checking;
      setWriterState(phase2Machine.checking);
      setPhase("access");
      setAnnouncement(phase2Copy.offlineEndComplete);
    } catch {
      setAnnouncement(phase2Copy.offlineEndError);
    }
  };

  const cancelScoringSignOut = () => {
    signOutDialogRef.current?.close();
    window.requestAnimationFrame(() => endSessionButtonRef.current?.focus({ preventScroll: true }));
  };

  const handleOfflineQueueFailure = (error: unknown, fallback: string) => {
    if (error instanceof ScoringWorkerSafetyFrozenError) return;
    const detail = error instanceof Error ? error.message : "";
    const terminalState = terminalOfflineQueueState(detail);
    if (terminalState) {
      if (actionDialogRef.current?.open) actionDialogRef.current.close();
      setPendingAction(null);
      setReversalTarget(null);
      setReversalReason("");
      setUnknownParticipant(false);
      setScorerError("");
      setOfflineState(terminalState);
      setAnnouncement(
        terminalState === phase2Machine.expired
          ? phase2Copy.offlineExpiredTitle
          : terminalState === phase2Machine.revoked
            ? phase2Copy.offlineRevokedTitle
            : phase2Copy.offlineReadOnlyTitle,
      );
      window.requestAnimationFrame(() => offlineStatusRef.current?.focus({ preventScroll: true }));
      return;
    }
    if (detail.includes(phase2Machine.offlineQueueFullCode) || detail.includes(phase2Machine.offlineCommandLimitCode)) {
      setOfflineState(phase2Machine.offlinePendingSync);
      setAnnouncement(phase2Copy.offlineQueueFull);
      return;
    }
    setOfflineState(phase2Machine.offlineStorageError);
    setAnnouncement(fallback);
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
      setAnnouncement(scorerMessages.takeOverSent);
    } catch (error) {
      await handleTransportError(error);
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setActionPending(false);
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
        expectedSequence: tapQueueRef.current.sequence,
        matchId,
        eventType: phase2Machine.matchStarted,
        canonical: true,
        scorer: "",
        period: 1,
        manualTime: "00:00",
      });
      setPendingSync(receipt.syncState === "pending");
      const session = await port.recoverSession();
      await applySession(session);
      setPhase("live");
    } catch (error) {
      await handleTransportError(error);
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setStarting(false);
    }
  };

  const closeActionDialog = () => {
    if (actionDialogRef.current?.open) actionDialogRef.current.close();
    setSheetTranslateY(0);
    touchStartYRef.current = null;
    setPendingAction(null);
    setReversalTarget(null);
    setReversalReason("");
    setReversalPreset(null);
    setUnknownParticipant(false);
    setScorerError("");
    const returnTarget = actionReturnTargetRef.current;
    actionReturnTargetRef.current = null;
    const viewport = actionDialogViewportRef.current;
    actionDialogViewportRef.current = null;
    window.requestAnimationFrame(() => {
      returnTarget?.focus({ preventScroll: true });
      // Recording changes the score controls and event log behind the modal.
      // Restore the viewport after that layout settles, including scroll anchoring.
      if (viewport) window.scrollTo({ ...viewport, behavior: opaqueId("instant") });
    });
  };

  const handleSheetTouchStart = (event: React.TouchEvent<HTMLDialogElement>) => {
    if (actionPending) return;
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  };

  const handleSheetTouchMove = (event: React.TouchEvent<HTMLDialogElement>) => {
    if (touchStartYRef.current === null || actionPending) return;
    const deltaY = event.touches[0].clientY - touchStartYRef.current;
    if (deltaY > 0) {
      if (event.cancelable) event.preventDefault();
      setSheetTranslateY(deltaY);
    }
  };

  const handleSheetTouchEnd = () => {
    if (touchStartYRef.current === null) return;
    if (sheetTranslateY > 80) {
      closeActionDialog();
    } else {
      setSheetTranslateY(0);
    }
    touchStartYRef.current = null;
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
    setReversalPreset(null);
    setScorerError("");
    setPendingAction(null);
    setReversalTarget(action);
  };

  const queueOfflineEvent = (command: ScoringEventCommand, successMessage: string) =>
    runScoringWorkerTransition(async () => {
      const resources = await offlineResources();
      const matchPackage = await resources.repository.getActiveMatchPackage();
      if (!matchPackage || matchPackage.match_id !== command.matchId) {
        throw new Error(phase2Copy.offlineMatchUnauthorized);
      }
      const session = await enqueueOfflineEvent(resources.repository, matchPackage, command);
      setDiagnosticExportSha(null);
      const pending = await resources.repository.listPendingCommands(matchPackage.authorization_id);
      await applyOfflineProjection(
        session,
        matchPackage.authorization_id,
        pending.length,
        phase2Machine.offlinePendingSync,
      );
      setAnnouncement(phase2Copy.offlineRecordedAnnouncement(successMessage, pending.length));
    });

  const queueOfflineFinalisation = (command: Parameters<typeof enqueueOfflineFinalisation>[2]) =>
    runScoringWorkerTransition(async () => {
      const resources = await offlineResources();
      const matchPackage = await resources.repository.getActiveMatchPackage();
      if (!matchPackage || matchPackage.match_id !== command.matchId) {
        throw new Error(phase2Copy.offlineMatchUnauthorized);
      }
      const session = await enqueueOfflineFinalisation(resources.repository, matchPackage, command);
      setDiagnosticExportSha(null);
      const pending = await resources.repository.listPendingCommands(matchPackage.authorization_id);
      await applyOfflineProjection(
        session,
        matchPackage.authorization_id,
        pending.length,
        phase2Machine.offlinePendingFinalisation,
      );
      setAnnouncement(phase2Copy.offlinePendingFinalisation);
    });

  const advancePeriod = async (nextValue: string) => {
    if (mutationInFlightRef.current > 0 || actionPending) return;
    const nextSegment = Number(nextValue);
    if (nextSegment === scoreState.currentSegment) {
      setPeriod(nextValue);
      return;
    }
    if (
      !supportsPeriodAdvance ||
      !Number.isInteger(nextSegment) ||
      nextSegment !== scoreState.currentSegment + 1 ||
      nextSegment > definition.segments.length
    ) {
      setPeriod(String(scoreState.currentSegment));
      setInteractionError(phase2Copy.periodAdvanceInvalid);
      setAnnouncement(phase2Copy.periodAdvanceInvalid);
      window.requestAnimationFrame(() => interactionErrorRef.current?.focus({ preventScroll: true }));
      return;
    }

    const command: ScoringEventCommand = {
      clientEventId: crypto.randomUUID(),
      expectedSequence: tapQueueRef.current.sequence,
      matchId,
      eventType: phase2Machine.periodChange,
      canonical: true,
      scorer: "",
      period: nextSegment,
      segmentNumber: nextSegment,
      manualTime: "00:00",
      occurredAt: new Date().toISOString(),
    };

    mutationInFlightRef.current += 1;
    sessionRefreshFenceRef.current.cancel();
    setActionPending(true);
    setInteractionError("");
    setAnnouncement(phase2Copy.scoreControlsPending);
    try {
      if (!navigator.onLine) throw new ScoringTransportError(phase2Machine.unavailable);
      const receipt = await port.appendEvent(command);
      setPendingSync(receipt.syncState === "pending");
      await applySession(await port.recoverSession());
      setAnnouncement(phase2Copy.eventRecorded);
    } catch (error) {
      if (error instanceof ScoringTransportError && error.state === "unavailable" && offlineAuthorizationId) {
        try {
          await queueOfflineEvent(command, phase2Copy.eventRecorded);
        } catch (offlineError) {
          handleOfflineQueueFailure(offlineError, phase2Copy.offlineEventStorageError);
        }
      } else {
        setPeriod(String(scoreState.currentSegment));
        await handleTransportError(error);
      }
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setActionPending(false);
    }
  };

  useEffect(() => {
    offlineAuthorizationIdRef.current = offlineAuthorizationId;
    handleTransportErrorRef.current = handleTransportError;
  }, [handleTransportError, offlineAuthorizationId]);

  useEffect(() => {
    if (!undoToast) return;
    const timer = window.setTimeout(() => setUndoToast(null), undoWindowMs);
    return () => window.clearTimeout(timer);
  }, [undoToast]);

  const waitForTapQueueIdle = () =>
    new Promise<void>((resolve) => {
      const check = () =>
        tapQueueIdle(tapQueueRef.current) && !drainingRef.current ? resolve() : window.setTimeout(check, 50);
      check();
    });

  const sideName = (side: "home" | "away" | null) =>
    side === phase2Machine.home ? home : side === phase2Machine.away ? away : matchLabel;

  /** The command for a queued tap at send time; an undo resolves its target's server event id now. */
  const commandForTap = (tap: QueuedTap, expectedSequence: number): ScoringEventCommand => {
    const command = withExpectedSequence(tap, expectedSequence);
    if (!tap.undoOf) return command;
    const targetEventId =
      tapQueueRef.current.taps.find((candidate) => candidate.id === tap.undoOf)?.eventId ??
      scoreStateRef.current.actions.find((action) => action.clientEventId === tap.undoOf)?.eventId;
    return targetEventId
      ? { ...command, reversalTargetEventId: targetEventId }
      : { ...command, reversalTargetClientEventId: tap.undoOf };
  };

  /**
   * Sends queued taps one at a time. Each expects the sequence returned by the previous receipt; the controls
   * stay usable throughout (new taps simply join the queue). When the queue drains, the authoritative session
   * is fetched once to reconcile the optimistic score.
   */
  const drainTapQueue = async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (;;) {
        let acknowledged = false;
        for (let tap = nextTapToSend(tapQueueRef.current); tap; tap = nextTapToSend(tapQueueRef.current)) {
          const command = commandForTap(tap, tapQueueRef.current.sequence);
          commitTap({ type: "send", id: tap.id });
          mutationInFlightRef.current += 1;
          sessionRefreshFenceRef.current.cancel();
          try {
            if (!navigator.onLine) throw new ScoringTransportError(phase2Machine.unavailable);
            const receipt = await port.appendEvent(command);
            commitTap({ type: "acknowledged", id: tap.id, eventId: receipt.eventId, sequence: receipt.sequence });
            setThroughSequence(receipt.sequence);
            setPendingSync(receipt.syncState === "pending");
            acknowledged = true;
          } catch (error) {
            if (
              error instanceof ScoringTransportError &&
              error.state === "unavailable" &&
              offlineAuthorizationIdRef.current
            ) {
              // Offline: hand this tap and everything after it to the offline queue, in order.
              const pending = tapQueueRef.current.taps.filter((candidate) => candidate.status !== "acknowledged");
              try {
                for (const item of pending) {
                  await queueOfflineEvent(commandForTap(item, tapQueueRef.current.sequence), phase2Copy.eventRecorded);
                  commitTap({ type: "offloaded", ids: [item.id] });
                }
              } catch (offlineError) {
                commitTap({ type: "rejected", reason: phase2Copy.offlineEventStorageError });
                handleOfflineQueueFailure(offlineError, phase2Copy.offlineEventStorageError);
              }
            } else {
              const reason =
                error instanceof ScoringTransportError && error.state === "invalid" && error.detailMessage
                  ? error.detailMessage
                  : scorerMessages.rollbackGeneric;
              commitTap({ type: "rejected", reason });
              setUndoToast(null);
              setAnnouncement(interpolate(scorerMessages.rolledBack, { reason }));
              await handleTransportErrorRef.current?.(error);
            }
            break;
          } finally {
            sessionRefreshFenceRef.current.cancel();
            mutationInFlightRef.current -= 1;
          }
        }
        if (acknowledged && tapQueueIdle(tapQueueRef.current)) {
          try {
            await applySession(await port.recoverSession());
          } catch (error) {
            await handleTransportErrorRef.current?.(error);
          }
        }
        if (!nextTapToSend(tapQueueRef.current)) break;
      }
    } finally {
      drainingRef.current = false;
    }
  };

  const tapAction = (action: ScoreControlAction) => {
    const segmentNumber = Number(period);
    const manualTimeSeconds = manualTimeEnabled ? recordedSeconds : null;
    if (!Number.isInteger(segmentNumber) || segmentNumber < 1 || (manualTimeEnabled && manualTimeSeconds === null)) {
      setInteractionError(phase2Copy.periodRequired);
      setAnnouncement(phase2Copy.periodRequired);
      window.requestAnimationFrame(() => interactionErrorRef.current?.focus({ preventScroll: true }));
      return;
    }
    setInteractionError("");
    commitTap({ type: "dismissRollback" });
    const submittedSegmentNumber = canonicalSegmentNumber(action.control.id, scoreState.currentSegment, segmentNumber);
    const clientEventId = crypto.randomUUID();
    commitTap({
      type: "enqueue",
      tap: {
        id: clientEventId,
        command: {
          clientEventId,
          matchId,
          eventType: action.control.id,
          canonical: true,
          ...(action.side ? { team: action.side } : {}),
          scorer: "",
          period: submittedSegmentNumber,
          segmentNumber: submittedSegmentNumber,
          manualTime: elapsedTime ?? eventTime,
          ...(manualTimeEnabled ? { manualTimeSeconds } : {}),
          occurredAt: new Date().toISOString(),
        },
        side: action.side,
        scoreDelta: action.control.scoreDelta,
        segmentNumber: submittedSegmentNumber,
        label: action.control.label,
      },
    });
    const team = sideName(action.side);
    setUndoToast(
      action.control.reversible
        ? {
            tapId: clientEventId,
            text: interpolate(scorerMessages.undoToast, { action: action.control.label, team }),
            label: interpolate(scorerMessages.undoLabel, { action: action.control.label, team }),
          }
        : null,
    );
    setAnnouncement(
      action.side
        ? interpolate(scorerMessages.recorded, { action: action.control.label, team })
        : interpolate(scorerMessages.recordedGlobal, { action: action.control.label }),
    );
    void drainTapQueue();
  };

  const undoTap = (toast: UndoToast) => {
    setUndoToast(null);
    const target = tapQueueRef.current.taps.find((tap) => tap.id === toast.tapId);
    const action = scoreStateRef.current.actions.find((candidate) => candidate.clientEventId === toast.tapId);
    const label = target?.label ?? action?.label ?? "";
    if (target?.status === "queued") {
      // Never left the phone: just drop it.
      commitTap({ type: "cancel", id: target.id });
      setAnnouncement(interpolate(scorerMessages.undone, { action: label }));
      return;
    }
    if (!target && (!action || action.reversed || !action.reversible)) {
      setAnnouncement(scorerMessages.undoUnavailable);
      return;
    }
    if (!target && action && offlineAuthorizationIdRef.current && pendingCount > 0) {
      // Stored offline: the confirmation sheet knows whether the target is still local to this phone.
      actionReturnTargetRef.current = null;
      setReversalReason("");
      setReversalPreset(null);
      setScorerError("");
      setPendingAction(null);
      setReversalTarget(action);
      return;
    }
    const segmentNumber = target?.segmentNumber ?? action?.segmentNumber ?? scoreState.currentSegment;
    const clientEventId = crypto.randomUUID();
    commitTap({
      type: "enqueue",
      tap: {
        id: clientEventId,
        command: {
          clientEventId,
          matchId,
          eventType: phase2Machine.reversal,
          canonical: true,
          scorer: "",
          period: segmentNumber,
          segmentNumber,
          manualTime: elapsedTime ?? eventTime,
          reason: scorerMessages.undoReasonDefault,
          occurredAt: new Date().toISOString(),
        },
        side: target?.side ?? action?.side ?? null,
        scoreDelta: -(target?.scoreDelta ?? action?.scoreDelta ?? 0),
        segmentNumber,
        label,
        undoOf: toast.tapId,
      },
    });
    setAnnouncement(interpolate(scorerMessages.undone, { action: label }));
    void drainTapQueue();
  };

  const activateControl = (action: ScoreControlAction, trigger: HTMLButtonElement) => {
    if (isOneTapAction(action)) tapAction(action);
    else openActionDialog(action, trigger);
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
    const manualTimeSeconds = manualTimeEnabled ? recordedSeconds : null;
    if (!Number.isInteger(segmentNumber) || segmentNumber < 1 || (manualTimeEnabled && manualTimeSeconds === null)) {
      setScorerError(phase2Copy.periodRequired);
      return;
    }
    setScorerError("");
    setInteractionError("");
    // Earlier one-tap actions must be confirmed first so this command expects the right sequence.
    await waitForTapQueueIdle();
    const command: ScoringEventCommand = {
      clientEventId: crypto.randomUUID(),
      expectedSequence: tapQueueRef.current.sequence,
      matchId,
      eventType: pendingAction.control.id,
      canonical: true,
      ...(pendingAction.side ? { team: pendingAction.side } : {}),
      scorer: participant,
      ...(participant ? { participantId: participant } : {}),
      ...(unknownParticipant ? { unknownParticipant: true } : {}),
      period: submittedSegmentNumber,
      segmentNumber: submittedSegmentNumber,
      manualTime: elapsedTime ?? eventTime,
      ...(manualTimeEnabled ? { manualTimeSeconds } : {}),
      occurredAt: new Date().toISOString(),
    };
    mutationInFlightRef.current += 1;
    sessionRefreshFenceRef.current.cancel();
    setActionPending(true);
    setAnnouncement(phase2Copy.scoreControlsPending);
    try {
      if (!navigator.onLine) throw new ScoringTransportError(phase2Machine.unavailable);
      const receipt = await port.appendEvent(command);
      setPendingSync(receipt.syncState === "pending");
      await applySession(await port.recoverSession());
      setAnnouncement(phase2Copy.eventRecorded);
      closeActionDialog();
    } catch (error) {
      if (error instanceof ScoringTransportError && error.state === "unavailable" && offlineAuthorizationId) {
        try {
          await queueOfflineEvent(command, phase2Copy.eventRecorded);
          closeActionDialog();
        } catch (offlineError) {
          handleOfflineQueueFailure(offlineError, phase2Copy.offlineEventStorageError);
        }
      } else {
        await handleTransportError(error);
      }
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setActionPending(false);
    }
  };

  const reverseAction = async () => {
    if (!reversalTarget) return;
    // The reason is optional for the scorer; the record still needs one, so a neutral preset is sent.
    const typedReason = reversalReason.trim();
    if (typedReason && typedReason.length < 3) {
      setScorerError(phase2Copy.reversalReasonHint);
      scorerInputRef.current?.focus();
      return;
    }
    const reason = typedReason || reversalPreset || scorerMessages.undoReasonDefault;
    await waitForTapQueueIdle();
    mutationInFlightRef.current += 1;
    setActionPending(true);
    setInteractionError("");
    sessionRefreshFenceRef.current.cancel();
    setAnnouncement(phase2Copy.scoreControlsPending);
    let reversalCommand: ScoringEventCommand | null = null;
    try {
      const resources = await offlineResources();
      const pendingCommands = offlineAuthorizationId
        ? await resources.repository.listPendingCommands(offlineAuthorizationId)
        : [];
      const targetIsLocal = pendingCommands.some(
        ({ command }) => command.client_event_id === reversalTarget.clientEventId,
      );
      reversalCommand = {
        clientEventId: crypto.randomUUID(),
        expectedSequence: tapQueueRef.current.sequence,
        matchId,
        eventType: phase2Machine.reversal,
        canonical: true,
        scorer: "",
        period: reversalTarget.segmentNumber,
        segmentNumber: reversalTarget.segmentNumber,
        manualTime: elapsedTime ?? eventTime,
        ...(targetIsLocal
          ? { reversalTargetClientEventId: reversalTarget.clientEventId }
          : { reversalTargetEventId: reversalTarget.eventId }),
        reason,
        occurredAt: new Date().toISOString(),
      };
      if (!navigator.onLine) throw new ScoringTransportError(phase2Machine.unavailable);
      const receipt = await port.appendEvent(reversalCommand);
      setPendingSync(receipt.syncState === "pending");
      await applySession(await port.recoverSession());
      setAnnouncement(phase2Copy.eventReversed);
      const targetId = reversalTarget.eventId;
      actionReturnTargetRef.current = null;
      closeActionDialog();
      setReversedFocusId(targetId);
    } catch (error) {
      if (error instanceof ScoringTransportError && error.state === "unavailable" && offlineAuthorizationId) {
        try {
          if (!reversalCommand) throw new Error(phase2Copy.offlineReversalUnavailable);
          await queueOfflineEvent(reversalCommand, phase2Copy.eventReversed);
          closeActionDialog();
        } catch (offlineError) {
          handleOfflineQueueFailure(offlineError, phase2Copy.offlineReversalStorageError);
        }
      } else {
        await handleTransportError(error);
      }
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setActionPending(false);
    }
  };

  const finalize = async () => {
    if (mutationInFlightRef.current > 0 || actionPending) return;
    if (supportsPeriodAdvance && scoreState.currentSegment < definition.segments.length) {
      setInteractionError(phase2Copy.finalisationNotReady);
      setAnnouncement(phase2Copy.finalisationNotReady);
      window.requestAnimationFrame(() => interactionErrorRef.current?.focus({ preventScroll: true }));
      return;
    }
    mutationInFlightRef.current += 1;
    setActionPending(true);
    setInteractionError("");
    await sessionRefreshFenceRef.current.waitForIdle();
    setAnnouncement(phase2Copy.scoreControlsPending);
    const command = {
      clientEventId: crypto.randomUUID(),
      matchId,
      expectedSequence: tapQueueRef.current.sequence,
      homeScore: score.home,
      awayScore: score.away,
      scorer: scorer.trim(),
      occurredAt: new Date().toISOString(),
    };
    try {
      if (!navigator.onLine) throw new ScoringTransportError(phase2Machine.unavailable);
      const receipt = await port.finalizeResult(command);
      setFinalReceipt(receipt);
      setPhase("receipt");
    } catch (error) {
      if (error instanceof ScoringTransportError && error.state === "unavailable" && offlineAuthorizationId) {
        try {
          await queueOfflineFinalisation(command);
        } catch (offlineError) {
          handleOfflineQueueFailure(offlineError, phase2Copy.offlineFinalisationStorageError);
        }
      } else {
        await handleTransportError(error);
      }
    } finally {
      sessionRefreshFenceRef.current.cancel();
      mutationInFlightRef.current -= 1;
      setActionPending(false);
    }
  };

  if (phase === "access" || phase === "confirm") {
    return (
      <main
        className="p2-score-access"
        id="score-main"
        data-scoring-phase={phase}
        data-writer-state={writerState}
        data-offline-state={offlineState}
      >
        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        <header>
          <span className="p2-score-brand">{phase2Copy.brand}</span>
          <span>{phase2Copy.scoringAccess}</span>
        </header>
        {offlineState === phase2Machine.offlineStorageError ? (
          <section
            ref={offlineStatusRef}
            className="p2-score-warning"
            data-offline-state={offlineState}
            aria-labelledby="offline-access-storage-title"
            tabIndex={-1}
          >
            <Warning aria-hidden="true" />
            <div>
              <strong id="offline-access-storage-title">{phase2Copy.offlineStorageErrorTitle}</strong>
              <p>{phase2Copy.offlineStorageRecoveryError}</p>
            </div>
          </section>
        ) : null}
        <section>
          <p className="p2-eyebrow">
            {phase === "access" ? phase2Copy.scoringAccess : `${competitionName ?? ""} · ${matchLabel} · ${stage}`}
          </p>
          {phase === "access" ? (
            <h1>{phase2Copy.codeHint}</h1>
          ) : (
            <h1>
              {home}
              <span>{phase2Copy.versus}</span>
              {away}
            </h1>
          )}
          {phase === "access" && codeNeedsLink ? (
            <p className="p2-score-form" data-access-guidance="">
              {scorerMessages.codeNeedsLink}
            </p>
          ) : phase === "access" ? (
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
                  <dt>{phase2Copy.fixtureLocation}</dt>
                  <dd>{fixtureSchedule?.areaName ?? phase2Copy.fixtureUnknownArea}</dd>
                </div>
                <div>
                  <dt>{phase2Copy.fixtureStart}</dt>
                  <dd>
                    {fixtureSchedule?.startsAt
                      ? new Date(fixtureSchedule.startsAt).toLocaleString()
                      : phase2Copy.fixtureUnscheduled}
                  </dd>
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
      <main
        className="p2-score-receipt"
        id="score-main"
        data-scoring-phase={phase}
        data-writer-state={writerState}
        data-offline-state={offlineState}
      >
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
          <Link
            className="p2-score-primary"
            href={`/competitions/${encodeURIComponent(competitionSlug)}`}
            prefetch={false}
          >
            {phase2Copy.openPublic}
            <ArrowRight />
          </Link>
        ) : null}
      </main>
    );
  }

  return (
    <main
      className={`p2-score ${styles.scoringPage}`}
      id="score-main"
      data-scoring-phase={phase}
      data-writer-state={writerState}
      data-offline-state={offlineState}
      data-offline-preparation-error-code={offlinePreparationErrorCode ?? undefined}
      data-contrast={highContrast ? opaqueId("high") : undefined}
    >
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <header className={`p2-score__header ${styles.matchHeader}`}>
        <div>
          <p>{interpolate(scorerMessages.scorerHeading, { stage })}</p>
          <h1>{matchLabel}</h1>
        </div>
        <div
          ref={writerStatusRef}
          className={`p2-writer p2-writer--${writerState} ${styles.statusChip}`}
          data-tone={status.tone}
          aria-label={`${scorerMessages.statusLabel}: ${status.label}. ${writerTitle}`}
          tabIndex={-1}
        >
          {status.tone === "ok" ? (
            <CloudCheck aria-hidden="true" />
          ) : status.tone === "blocked" ? (
            <ShieldWarning aria-hidden="true" />
          ) : (
            <Warning aria-hidden="true" />
          )}
          <strong>{status.label}</strong>
        </div>
      </header>
      <section className={styles.liveScore} aria-label={scorerMessages.liveScore}>
        <div className={styles.liveScoreSide} data-side="home">
          <span>{home}</span>
          <strong>{displayScore.home}</strong>
        </div>
        <div className={styles.liveScoreSide} data-side="away">
          <span>{away}</span>
          <strong>{displayScore.away}</strong>
        </div>
        {definition.scoreMode === "segments" ? (
          <p className={styles.liveScoreSegment}>
            {definition.segmentLabel} {scoreState.currentSegment}: {displaySegmentScore.home}–{displaySegmentScore.away}
          </p>
        ) : null}
      </section>
      {tapQueue.rolledBack ? (
        <section className={`p2-score-warning ${styles.rollback}`}>
          <Warning aria-hidden="true" />
          <div>
            <strong>{interpolate(scorerMessages.rolledBack, { reason: tapQueue.rolledBack.reason })}</strong>
            <button className="p2-score-secondary" type="button" onClick={() => commitTap({ type: "dismissRollback" })}>
              {phase2Copy.continue}
            </button>
          </div>
        </section>
      ) : null}
      {!offlineAuthorizationId &&
      offlineState === phase2Machine.offlineOnline &&
      mode === phase2Machine.scoringApiMode &&
      writerState === phase2Machine.active ? (
        <section className={`p2-score-warning ${styles.secondaryNotice}`} aria-labelledby="offline-preparation-title">
          <CloudCheck aria-hidden="true" />
          <div>
            <strong id="offline-preparation-title">{phase2Copy.offlinePreparationTitle}</strong>
            <p>{phase2Copy.offlinePreparationBody}</p>
            <button className="p2-score-secondary" type="button" onClick={() => void prepareOfflineForCurrentMatch()}>
              {phase2Copy.offlinePrepareAction}
            </button>
          </div>
        </section>
      ) : null}
      {offlineAuthorizationId ||
      offlineState === phase2Machine.offlinePreparing ||
      offlineState === phase2Machine.offlineStorageError ? (
        <section
          ref={offlineStatusRef}
          className="p2-score-warning"
          data-offline-state={offlineState}
          aria-labelledby="offline-state-title"
          tabIndex={-1}
        >
          {offlineState === "offline-ready" || offlineState === "online" ? (
            <CloudCheck aria-hidden="true" />
          ) : (
            <Warning aria-hidden="true" />
          )}
          <div>
            <strong id="offline-state-title">
              {pendingCount >= gateCOfflineQueueLimit
                ? phase2Copy.offlineQueueFull
                : pendingCount >= gateCOfflineQueueWarningCount
                  ? phase2Copy.offlineQueueWarning
                  : offlineState === phase2Machine.offlineReady
                    ? phase2Copy.offlineReadyTitle
                    : offlineState === phase2Machine.offlineRecording
                      ? phase2Copy.offlineRecordingTitle
                      : offlineState === phase2Machine.offlinePendingFinalisation
                        ? phase2Copy.offlinePendingFinalisation
                        : offlineState === phase2Machine.offlineReplaying
                          ? phase2Copy.offlineReplayingTitle
                          : offlineState === phase2Machine.offlineReconnecting
                            ? phase2Copy.offlineConfirmingTitle
                            : offlineState === phase2Machine.conflict
                              ? phase2Copy.offlineConflictTitle
                              : offlineState === phase2Machine.expired
                                ? phase2Copy.offlineExpiredTitle
                                : offlineState === phase2Machine.revoked
                                  ? phase2Copy.offlineRevokedTitle
                                  : offlineState === phase2Machine.readOnly
                                    ? phase2Copy.offlineReadOnlyTitle
                                    : offlineState === phase2Machine.offlineStorageError
                                      ? phase2Copy.offlineStorageErrorTitle
                                      : offlineState === phase2Machine.offlinePreparing
                                        ? phase2Copy.offlinePreparingTitle
                                        : phase2Copy.offlinePendingTitle}
            </strong>
            <p>
              {phase2Copy.offlinePendingCount(pendingCount)}
              {offlineRecordingExpiresAt
                ? ` ${phase2Copy.offlineRecordingEnds(new Date(offlineRecordingExpiresAt).toLocaleString())}`
                : ""}
              {offlineReplayExpiresAt
                ? ` ${phase2Copy.offlineReplayEnds(new Date(offlineReplayExpiresAt).toLocaleString())}`
                : ""}
            </p>
            {pendingCount >= gateCOfflineQueueWarningCount ? (
              <p>{phase2Copy.offlineQueueGuidance(gateCOfflineQueueLimit)}</p>
            ) : null}
            {offlineState === phase2Machine.offlineStorageError &&
            mode === phase2Machine.scoringApiMode &&
            writerState === phase2Machine.active &&
            typeof navigator !== "undefined" &&
            navigator.onLine ? (
              <button className="p2-score-secondary" type="button" onClick={() => void prepareOfflineForCurrentMatch()}>
                {phase2Copy.offlinePrepareAction}
              </button>
            ) : null}
            {offlineAuthorizationId && pendingCount === 0 ? <p>{phase2Copy.offlineAllSynced}</p> : null}
            {offlineAuthorizationId ? <p>{phase2Copy.offlineLastConfirmed(throughSequence - pendingCount)}</p> : null}
            {offlineAuthorizationId && pendingCount > 0 && typeof navigator !== "undefined" && navigator.onLine ? (
              <button
                className="p2-score-secondary"
                type="button"
                onClick={() => setReplayRequest((value) => value + 1)}
              >
                {phase2Copy.offlineSyncNow}
              </button>
            ) : null}
            {offlineAuthorizationId ? (
              <>
                <button className="p2-score-secondary" type="button" onClick={() => void exportOfflineDiagnostics()}>
                  {phase2Copy.offlineDiagnosticAction}
                </button>
                <button
                  ref={endSessionButtonRef}
                  className="p2-score-secondary"
                  type="button"
                  onClick={() =>
                    pendingCount > 0 ? signOutDialogRef.current?.showModal() : void completeScoringSignOut(false)
                  }
                >
                  {phase2Copy.offlineEndSession}
                </button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
      {offlineAuthorizationId && pendingCount > 0 ? (
        <dialog
          ref={signOutDialogRef}
          className="p2-goal-sheet"
          aria-labelledby="offline-signout-title"
          aria-describedby="offline-signout-description"
          onCancel={(event) => {
            event.preventDefault();
            cancelScoringSignOut();
          }}
        >
          <header>
            <h2 id="offline-signout-title">{phase2Copy.offlineEndSessionTitle}</h2>
            <p id="offline-signout-description">{phase2Copy.offlineEndSessionBody}</p>
          </header>
          <footer>
            <button className="p2-score-secondary" type="button" onClick={cancelScoringSignOut}>
              {phase2Copy.cancel}
            </button>
            <button
              className="p2-score-secondary"
              type="button"
              onClick={() => {
                signOutDialogRef.current?.close();
                setReplayRequest((value) => value + 1);
              }}
            >
              {phase2Copy.offlineReconnectAndSync}
            </button>
            <button className="p2-score-secondary" type="button" onClick={() => void exportOfflineDiagnostics()}>
              {phase2Copy.offlineExportBeforeDiscard}
            </button>
            <button
              className="p2-score-primary"
              type="button"
              disabled={!diagnosticExportSha}
              onClick={() => void completeScoringSignOut(true)}
            >
              {phase2Copy.offlineDiscardAndEnd}
            </button>
          </footer>
        </dialog>
      ) : null}
      {interactionError ? (
        <section ref={interactionErrorRef} className="p2-score-warning" tabIndex={-1}>
          <Warning aria-hidden="true" />
          <div>
            <strong>{interactionError}</strong>
          </div>
        </section>
      ) : null}
      <section className={`p5-scoring-device ${styles.deviceDetails}`} aria-labelledby="scoring-device-label">
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
      <section className={styles.settings} aria-label={scorerMessages.matchSettings}>
        <label className="p2-check">
          <input type="checkbox" checked={highContrast} onChange={(event) => setHighContrast(event.target.checked)} />
          <span>
            {scorerMessages.highContrast}
            <small>{scorerMessages.highContrastHint}</small>
          </span>
        </label>
        {wakeLock === "active" ? <p>{scorerMessages.screenAwake}</p> : null}
        {wakeLock === "unsupported" ? <p>{scorerMessages.screenAwakeUnavailable}</p> : null}
      </section>
      {writerState === "conflict" ? (
        <section className="p2-score-warning" role="alert">
          <Warning />
          <div>
            <strong>{scorerMessages.titles.conflict}</strong>
            <p>{scorerMessages.bodies.conflict}</p>
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
                ? scorerMessages.bodies.candidate
                : writerState === phase2Machine.transferred
                  ? scorerMessages.bodies.transferred
                  : writerState === phase2Machine.expiring
                    ? scorerMessages.bodies.expiring
                    : writerState === phase2Machine.expired
                      ? scorerMessages.bodies.expired
                      : writerState === phase2Machine.revoked
                        ? scorerMessages.bodies.revoked
                        : writerState === phase2Machine.rateLimited
                          ? scorerMessages.bodies.rateLimited
                          : writerState === phase2Machine.readOnly
                            ? scorerMessages.bodies.readOnly
                            : scorerMessages.bodies.expiring}
            </p>
            {writerState === phase2Machine.candidate && !takeoverPending ? (
              <button className="p2-score-secondary" type="button" onClick={() => void requestTakeover()}>
                {scorerMessages.takeOverAction}
              </button>
            ) : null}
            {takeoverPending ? <p>{scorerMessages.takeOverSent}</p> : null}
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
          <button className="p2-score-primary" type="button" disabled={locked || actionPending} onClick={finalize}>
            {phase2Copy.finalise}
            <Check />
          </button>
          <button
            className="p2-score-secondary"
            type="button"
            disabled={actionPending}
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
          <section className={`p2-event-controls ${styles.eventControls}`} aria-label={definition.displayName}>
            <div ref={scoreControlsRef} role="group" aria-label={phase2Copy.scoreControlsTitle} tabIndex={-1}>
              <FiveSportScoreControls
                definition={activeScorecardDefinition}
                homeLabel={home}
                awayLabel={away}
                score={displayScore}
                copy={scoreControlsCopy}
                readOnly={locked}
                pending={actionPending}
                showScoreboard={false}
                statusMessage={
                  manualTimeEnabled
                    ? `${definition.segmentLabel} ${scoreState.currentSegment} · ${phase2Copy.elapsedPreview} ${elapsedTime ?? "—"}`
                    : `${definition.segmentLabel} ${scoreState.currentSegment}`
                }
                onActivate={activateControl}
              />
              {undoToast ? (
                <div className={styles.undoToast}>
                  <span>{undoToast.text}</span>
                  <button type="button" aria-label={undoToast.label} onClick={() => undoTap(undoToast)}>
                    {scorerMessages.undo}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="p2-event-context">
              <div>
                <label>
                  <span>{definition.segmentLabel}</span>
                  <select
                    value={period}
                    onChange={(event) => void advancePeriod(event.target.value)}
                    disabled={locked || actionPending || !supportsPeriodAdvance}
                  >
                    {definition.segments.map((segment) => (
                      <option
                        key={segment.number}
                        value={segment.number}
                        disabled={
                          supportsPeriodAdvance &&
                          (segment.number < scoreState.currentSegment || segment.number > scoreState.currentSegment + 1)
                        }
                      >
                        {definition.segmentLabel} {segment.number}
                      </option>
                    ))}
                  </select>
                </label>
                {manualTimeEnabled ? (
                  <div className={styles.timeEntry}>
                    {periodDurationMinutes !== null ? (
                      <label>
                        <span>{phase2Copy.timeMode}</span>
                        <select
                          value={timeMode}
                          onChange={(event) => {
                            setTimeMode(event.target.value as "elapsed" | "remaining");
                            setEventTime(
                              event.target.value === "remaining"
                                ? formatRecordedTime(periodDurationMinutes * 60)
                                : "00:00",
                            );
                          }}
                          disabled={locked}
                        >
                          <option value="elapsed">{phase2Copy.elapsedTime}</option>
                          <option value="remaining">{phase2Copy.remainingTime}</option>
                        </select>
                      </label>
                    ) : null}
                    <label>
                      <span>{timeMode === "remaining" ? phase2Copy.remainingTime : phase2Copy.eventTimeLabel}</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={eventTime}
                        onChange={(event) => setEventTime(event.target.value)}
                        aria-invalid={recordedSeconds === null}
                        aria-describedby="recorded-time-feedback"
                        disabled={locked}
                      />
                    </label>
                    <small id="recorded-time-feedback" role={recordedSeconds === null ? "alert" : undefined}>
                      {recordedSeconds === null
                        ? phase2Copy.invalidRecordedTime
                        : `${phase2Copy.elapsedPreview}: ${elapsedTime}`}
                    </small>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
          <section className={`p2-event-log ${styles.eventLog}`} aria-labelledby="event-log-title">
            <header>
              <h2 id="event-log-title">{scorerMessages.recentActions}</h2>
              <span>
                <Clock />
                {pendingSync || !tapsIdle ? scorerMessages.status.syncing : phase2Copy.synced}
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
                      {action.participantId ? (
                        <small>
                          {phase2Copy.scorer}: {action.participantId}
                        </small>
                      ) : null}
                    </span>
                    {action.reversible && !action.reversed && !locked ? (
                      <button
                        className="p2-score-secondary"
                        type="button"
                        aria-label={interpolate(scorerMessages.undoLabel, {
                          action: action.label,
                          team: sideName(action.side),
                        })}
                        onClick={(event) => openReversalDialog(action, event.currentTarget)}
                      >
                        {scorerMessages.recentUndo}
                      </button>
                    ) : (
                      <span>{action.participantId ?? "—"}</span>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p>{scorerMessages.noActions}</p>
            )}
          </section>
          {!locked ? (
            <button
              className="p2-score-primary p2-score-final"
              type="button"
              disabled={actionPending || !tapsIdle}
              onClick={() => setPhase("review")}
            >
              {phase2Copy.reviewFinal}
              <ArrowRight />
            </button>
          ) : null}
          {pendingAction || reversalTarget ? (
            <dialog
              className="p2-goal-sheet"
              ref={actionDialogRef}
              style={sheetTranslateY > 0 ? { transform: `translateY(${sheetTranslateY}px)` } : undefined}
              onTouchStart={handleSheetTouchStart}
              onTouchMove={handleSheetTouchMove}
              onTouchEnd={handleSheetTouchEnd}
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
                    ? scorerMessages.undoTitle
                    : pendingAction?.control.id === phase2Machine.goal
                      ? phase2Copy.confirmGoalTitle
                      : `${phase2Copy.recordEvent}: ${pendingAction?.control.label ?? ""}`}
                </h2>
                <p id="score-action-description">
                  {reversalTarget ? scorerMessages.undoBody : phase2Copy.actionDialogBody}
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
                    <dd>{elapsedTime ?? eventTime}</dd>
                  </div>
                ) : null}
              </dl>
              {reversalTarget ? (
                <fieldset className={styles.reasonChips}>
                  <legend>{scorerMessages.undoReasonHint}</legend>
                  {Object.values(scorerMessages.undoReasons).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={reversalPreset === preset}
                      onClick={() => {
                        setReversalPreset(reversalPreset === preset ? null : preset);
                        setScorerError("");
                      }}
                    >
                      {preset}
                    </button>
                  ))}
                </fieldset>
              ) : null}
              {reversalTarget || pendingAction?.control.participantAttribution !== "none" ? (
                <>
                  <label>
                    <span>{reversalTarget ? scorerMessages.undoReasonLabel : phase2Copy.participantLabel}</span>
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
                        required={pendingAction?.control.participantAttribution === "required" && !unknownParticipant}
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
                    ? scorerMessages.confirmUndo
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
