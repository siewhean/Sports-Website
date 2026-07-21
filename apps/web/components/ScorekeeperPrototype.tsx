"use client";

import {
  ArrowRight,
  Cards,
  Check,
  ClipboardText,
  CloudArrowUp,
  DeviceMobileCamera,
  Timer,
  Warning,
} from "@phosphor-icons/react";
import { opaqueId, translate as t } from "@matchday/ui";
import { FormEvent, useState } from "react";
import { EventTimeline } from "./scorekeeper/EventTimeline";
import { FinaliseDialog } from "./scorekeeper/FinaliseDialog";
import { TeamScorePanel } from "./scorekeeper/TeamScorePanel";
import { UndoDialog } from "./scorekeeper/UndoDialog";
import { scorekeeperFixture } from "./scorekeeper/__fixtures__/scorekeeperFixture";
import type {
  AccessPhase,
  ConflictResolution,
  EventSync,
  FinalState,
  ScorekeeperTeam,
  SyncState,
  WriterState,
} from "./scorekeeper/types";
import { useScoreEvents } from "./scorekeeper/useScoreEvents";
import styles from "./ScorekeeperPrototype.module.css";
import { cssModuleClasses as cx } from "./prototype/cssModuleClasses";

const teamNames: Record<ScorekeeperTeam, string> = {
  blue: scorekeeperFixture.teams.blue.name,
  gold: scorekeeperFixture.teams.gold.name,
};

export function ScorekeeperPrototype() {
  const [phase, setPhase] = useState<AccessPhase>(opaqueId("access"));
  const [accessCode, setAccessCode] = useState<string>(scorekeeperFixture.accessCode);
  const [accessError, setAccessError] = useState("");
  const [accessLoading, setAccessLoading] = useState(false);
  const [matchConfirmed, setMatchConfirmed] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>(opaqueId("offline"));
  const [writerState, setWriterState] = useState<WriterState>(opaqueId("active"));
  const [showTakeover, setShowTakeover] = useState(false);
  const [transferRequested, setTransferRequested] = useState(false);
  const [generation, setGeneration] = useState<number>(scorekeeperFixture.initialGeneration);
  const [eventTime, setEventTime] = useState<string>(scorekeeperFixture.initialEventTime);
  const [finalState, setFinalState] = useState<FinalState>(opaqueId("open"));
  const [showFinalReview, setShowFinalReview] = useState(false);
  const [reconciliationReason, setReconciliationReason] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [downstreamConflict, setDownstreamConflict] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const {
    events,
    scores,
    lastReversibleEvent,
    pendingCount,
    unresolvedConflicts,
    appendEvent,
    acknowledgeGeneration,
    fenceGeneration,
    resolveConflict,
  } = useScoreEvents();

  const scoringLocked = writerState !== "active" || finalState !== "open";

  function currentEventSync(): EventSync {
    return syncState === "synced" ? opaqueId("acknowledged") : opaqueId("pending");
  }

  function validateAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accessCode.trim().toUpperCase() !== scorekeeperFixture.accessCode) {
      setAccessError(t("prototype.693980534463"));
      return;
    }

    setAccessError("");
    setAccessLoading(true);
    setAnnouncement(t("prototype.49ac18b4ca9b"));
    window.setTimeout(() => {
      setAccessLoading(false);
      setPhase("confirm");
      setAnnouncement(t("prototype.e02592e8ddb1"));
    }, 350);
  }

  function assumeScoringAuthority() {
    if (!matchConfirmed) return;
    setPhase("scoring");
    setAnnouncement(t("prototype.ec2b13e12b9c"));
  }

  function addGoal(team: ScorekeeperTeam) {
    if (scoringLocked) return;
    appendEvent(
      {
        kind: "goal",
        label: t("prototype.add3a9a4ae35", { team: teamNames[team] }),
        occurredAt: eventTime,
        team,
        scoreDelta: 1,
      },
      generation,
      currentEventSync(),
    );
    setAnnouncement(
      t("prototype.19261c6cd654", {
        team: teamNames[team],
        status: syncState === "synced" ? t("prototype.3ef25c849197") : t("prototype.b881206565f0"),
      }),
    );
  }

  function addNeutralEvent(label: string) {
    if (scoringLocked) return;
    appendEvent({ kind: "neutral", label, occurredAt: eventTime }, generation, currentEventSync());
    setAnnouncement(t("prototype.6aa042057381", { label, time: eventTime }));
  }

  function reverseLastEvent() {
    if (scoringLocked || !lastReversibleEvent) return;
    appendEvent(
      {
        kind: "reversal",
        label: t("prototype.f679172df60b", { label: lastReversibleEvent.label }),
        occurredAt: eventTime,
        team: lastReversibleEvent.team,
        scoreDelta: lastReversibleEvent.scoreDelta ? -lastReversibleEvent.scoreDelta : undefined,
        reversedEventId: lastReversibleEvent.id,
      },
      generation,
      currentEventSync(),
    );
    setAnnouncement(t("prototype.4345615c8eb6"));
  }

  function startReconnect() {
    if (pendingCount === 0) {
      setSyncState("synced");
      setAnnouncement(t("prototype.746ae3924f8f"));
      return;
    }

    setSyncState("replaying");
    setAnnouncement(t("prototype.a7e58dbf4114", { count: pendingCount }));
  }

  function acknowledgeReplay() {
    acknowledgeGeneration(generation);
    setSyncState("synced");
    if (finalState === "pending_sync") setFinalState("published");
    setAnnouncement(t("prototype.65357a28c01c"));
  }

  function simulateWriterConflict() {
    setWriterState("read_only");
    setShowTakeover(false);
    setTransferRequested(false);
    setAnnouncement(t("prototype.2abb601fd6de"));
  }

  function requestTransfer() {
    setTransferRequested(true);
    setAnnouncement(t("prototype.b565b7a00044"));
  }

  function confirmTakeover() {
    const previousGeneration = generation;
    fenceGeneration(previousGeneration);
    setGeneration((current) => current + 1);
    setWriterState("active");
    setShowTakeover(false);
    setTransferRequested(false);
    setSyncState("synced");
    setAnnouncement(t("prototype.7e9949dae4cd"));
  }

  function resolveStaleEvent(mode: ConflictResolution) {
    const staleEvent = unresolvedConflicts[0];
    const reason = reconciliationReason.trim();
    if (!staleEvent || !reason) return;

    resolveConflict(staleEvent.id, mode, reason);

    if (mode === "converted") {
      appendEvent(
        {
          kind: "correction",
          label: t("prototype.213999a81c59", { label: staleEvent.label }),
          occurredAt: staleEvent.occurredAt,
          team: staleEvent.team,
          scoreDelta: staleEvent.scoreDelta,
          reason,
          sync: "acknowledged",
        },
        generation,
        currentEventSync(),
      );
    }

    setReconciliationReason("");
    setAnnouncement(mode === "converted" ? t("prototype.2e1338d0cf4c") : t("prototype.aab8c258d8d5"));
  }

  function confirmFinalisation() {
    if (writerState !== "active" || unresolvedConflicts.length > 0) return;
    const acknowledged = syncState === "synced";
    appendEvent(
      {
        kind: "finalisation",
        label: t("prototype.8681094f75a6"),
        occurredAt: eventTime,
        sync: acknowledged ? "acknowledged" : "pending",
      },
      generation,
      currentEventSync(),
    );
    setFinalState(acknowledged ? "published" : "pending_sync");
    setShowFinalReview(false);
    setAnnouncement(acknowledged ? t("prototype.ad340a558a88") : t("prototype.5b783bba1997"));
  }

  function addCorrection(team: ScorekeeperTeam) {
    const reason = correctionReason.trim();
    if (!reason || finalState !== "published") return;
    appendEvent(
      {
        kind: "correction",
        label: t("prototype.24e1317702a8", { team: teamNames[team] }),
        occurredAt: eventTime,
        team,
        scoreDelta: 1,
        reason,
        sync: "acknowledged",
      },
      generation,
      currentEventSync(),
    );
    setCorrectionReason("");
    setDownstreamConflict(true);
    setAnnouncement(t("prototype.8bca5998692f"));
  }

  if (phase === "access") {
    return (
      <div className={cx(styles, "scorekeeper scorekeeper--access")}>
        <section className={cx(styles, "scorekeeper-access")} aria-labelledby="scorekeeper-access-title">
          <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.f837f349a881")}</p>
          <h1 id="scorekeeper-access-title">{t("prototype.2dd6ed427b37")}</h1>
          <p className={cx(styles, "scorekeeper-supporting-copy")}>{t("prototype.47dc025175f3")}</p>
          <form className={cx(styles, "scorekeeper-access-form")} onSubmit={validateAccess} noValidate>
            <label htmlFor="scorekeeper-access-code">{t("prototype.9407364f679f")}</label>
            <input
              id="scorekeeper-access-code"
              name="scoring-code"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              autoCapitalize="characters"
              autoComplete="one-time-code"
              aria-describedby={accessError ? "scorekeeper-access-error" : undefined}
              aria-invalid={Boolean(accessError)}
            />
            {accessError ? (
              <p className={cx(styles, "scorekeeper-field-error")} id="scorekeeper-access-error">
                <Warning size={18} aria-hidden="true" />
                {accessError}
              </p>
            ) : null}
            <button className={cx(styles, "scorekeeper-primary-button")} type="submit" disabled={accessLoading}>
              {accessLoading ? t("prototype.bd0a65fbb275") : t("prototype.60e6e66ee0a6")}
              <ArrowRight size={20} aria-hidden="true" />
            </button>
          </form>
          <p className={cx(styles, "scorekeeper-form-hint")}>{t("prototype.027452f410e6")}</p>
        </section>
        <p className={cx(styles, "visually-hidden")} aria-live="polite">
          {announcement}
        </p>
      </div>
    );
  }

  if (phase === "confirm") {
    return (
      <div className={cx(styles, "scorekeeper scorekeeper--confirm")}>
        <section className={cx(styles, "scorekeeper-confirm")} aria-labelledby="scorekeeper-confirm-title">
          <span className={cx(styles, "scorekeeper-confirm-icon")} aria-hidden="true">
            <Check size={24} />
          </span>
          <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.29d6a4299d76")}</p>
          <h1 id="scorekeeper-confirm-title">{t("prototype.cb41f515bfbe")}</h1>
          <dl className={cx(styles, "scorekeeper-match-summary")}>
            {scorekeeperFixture.summary.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          <label className={cx(styles, "scorekeeper-confirm-check")}>
            <input
              type="checkbox"
              checked={matchConfirmed}
              onChange={(event) => setMatchConfirmed(event.target.checked)}
            />
            <span>{scorekeeperFixture.confirmationLabel}</span>
          </label>
          <div className={cx(styles, "scorekeeper-confirm-actions")}>
            <button
              type="button"
              className={cx(styles, "scorekeeper-secondary-button")}
              onClick={() => setPhase("access")}
            >
              {t("prototype.76900f1bfd16")}
            </button>
            <button
              type="button"
              className={cx(styles, "scorekeeper-primary-button")}
              disabled={!matchConfirmed}
              onClick={assumeScoringAuthority}
            >
              {t("prototype.e06a216eddd1")}
              <ArrowRight size={20} aria-hidden="true" />
            </button>
          </div>
        </section>
        <p className={cx(styles, "visually-hidden")} aria-live="polite">
          {announcement}
        </p>
      </div>
    );
  }

  return (
    <div className={cx(styles, "scorekeeper")} data-sync-state={syncState}>
      <header className={cx(styles, "scorekeeper-live-header")}>
        <div>
          <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.f837f349a881")}</p>
          <h1>{scorekeeperFixture.matchTitle}</h1>
        </div>
        <div
          className={cx(
            styles,
            "scorekeeper-sync-badge",
            syncState !== "offline" && `scorekeeper-sync-badge--${syncState}`,
          )}
          role="status"
          aria-label={t("prototype.c62103b6d0a8", {
            state: syncState,
            count: pendingCount,
          })}
        >
          {syncState === "synced" ? (
            <Check size={18} aria-hidden="true" />
          ) : (
            <CloudArrowUp size={18} aria-hidden="true" />
          )}
          <span>
            {syncState === "offline"
              ? t("prototype.a30835c3b46b", { count: pendingCount })
              : syncState === "replaying"
                ? t("prototype.14c3decd57a2", { count: pendingCount })
                : t("prototype.670eb8b5888f")}
          </span>
        </div>
      </header>

      {writerState === "read_only" ? (
        <section className={cx(styles, "scorekeeper-writer-alert")} role="alert" aria-labelledby="writer-alert-title">
          <Warning size={22} aria-hidden="true" />
          <div>
            <h2 id="writer-alert-title">{t("prototype.739bc3377b14")}</h2>
            <p>{t("prototype.cfbecb268e8c")}</p>
            {transferRequested ? <p role="status">{t("prototype.0581757cd824")}</p> : null}
          </div>
          <div className={cx(styles, "scorekeeper-writer-actions")}>
            <button
              type="button"
              className={cx(styles, "scorekeeper-secondary-button")}
              onClick={requestTransfer}
              disabled={transferRequested}
            >
              {t("prototype.2f1bf5adada9")}
            </button>
            <button
              type="button"
              className={cx(styles, "scorekeeper-warning-button")}
              onClick={() => setShowTakeover(true)}
            >
              <DeviceMobileCamera size={20} aria-hidden="true" />
              {t("prototype.66abfef02cd8")}
            </button>
          </div>
        </section>
      ) : null}

      {showTakeover ? (
        <section
          className={cx(styles, "scorekeeper-takeover-review")}
          role="alertdialog"
          aria-labelledby="takeover-title"
        >
          <div>
            <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.8d290fe0cb16")}</p>
            <h2 id="takeover-title">{t("prototype.e3ab3e1f24a6")}</h2>
            <p>{t("prototype.11b9e698f524")}</p>
          </div>
          <div className={cx(styles, "scorekeeper-review-actions")}>
            <button
              type="button"
              className={cx(styles, "scorekeeper-secondary-button")}
              onClick={() => setShowTakeover(false)}
            >
              {t("prototype.3abbea6909f4")}
            </button>
            <button type="button" className={cx(styles, "scorekeeper-danger-button")} onClick={confirmTakeover}>
              {t("prototype.1bfd0aa8deb9")}
            </button>
          </div>
        </section>
      ) : null}

      <section className={cx(styles, "scorekeeper-board")} aria-label={t("prototype.30ee25e00918")}>
        <TeamScorePanel side={opaqueId("blue")} score={scores.blue} disabled={scoringLocked} onGoal={addGoal} />
        <div className={cx(styles, "scorekeeper-board-centre")} aria-hidden="true">
          <span>{t("prototype.f130559f0e7f")}</span>
          <span>{eventTime}</span>
        </div>
        <TeamScorePanel side={opaqueId("gold")} score={scores.gold} disabled={scoringLocked} onGoal={addGoal} />
      </section>

      <section className={cx(styles, "scorekeeper-event-controls")} aria-labelledby="event-controls-title">
        <div className={cx(styles, "scorekeeper-section-heading")}>
          <div>
            <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.1484afcf5cef")}</p>
            <h2 id="event-controls-title">{t("prototype.1b243c038ab5")}</h2>
          </div>
          <label className={cx(styles, "scorekeeper-time-control")}>
            <span>{t("prototype.972b9c8e7d6c")}</span>
            <input
              type="time"
              value={eventTime}
              onChange={(event) => setEventTime(event.target.value)}
              disabled={scoringLocked}
            />
          </label>
        </div>
        <div className={cx(styles, "scorekeeper-neutral-actions")}>
          <button type="button" onClick={() => addNeutralEvent(t("prototype.70594d932950"))} disabled={scoringLocked}>
            <Timer size={28} aria-hidden="true" />
            {t("prototype.70594d932950")}
          </button>
          <button type="button" onClick={() => addNeutralEvent(t("prototype.d8aa08f0ae65"))} disabled={scoringLocked}>
            <Cards size={28} aria-hidden="true" />
            {t("prototype.d8aa08f0ae65")}
          </button>
          <UndoDialog disabled={scoringLocked || !lastReversibleEvent} onUndo={reverseLastEvent} />
        </div>
      </section>

      <EventTimeline events={events} generation={generation} />

      {syncState !== "synced" ? (
        <section className={cx(styles, "scorekeeper-pending-panel")} aria-labelledby="pending-panel-title">
          <CloudArrowUp size={24} aria-hidden="true" />
          <div>
            <h2 id="pending-panel-title">
              {syncState === "offline" ? t("prototype.b5542a7f0f0c") : t("prototype.1a7dafb0ef66")}
            </h2>
            <p>{syncState === "offline" ? t("prototype.7fe298921bdc") : t("prototype.8e67f101c5a1")}</p>
          </div>
          {syncState === "offline" ? (
            <button type="button" className={cx(styles, "scorekeeper-primary-button")} onClick={startReconnect}>
              {t("prototype.bf8a9eab9e7e")}
            </button>
          ) : (
            <button type="button" className={cx(styles, "scorekeeper-primary-button")} onClick={acknowledgeReplay}>
              {t("prototype.e256fba07dc4")}
            </button>
          )}
        </section>
      ) : (
        <section className={cx(styles, "scorekeeper-sync-acknowledgement")} role="status">
          <Check size={20} aria-hidden="true" />
          <p>{t("prototype.e05d8baf518d")}</p>
          <button
            type="button"
            className={cx(styles, "scorekeeper-link-button")}
            onClick={() => setSyncState("offline")}
          >
            {t("prototype.659b8ae1aa4a")}
          </button>
        </section>
      )}

      <section className={cx(styles, "scorekeeper-authority")} aria-labelledby="authority-title">
        <div>
          <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.a2fc2e9cd90e")}</p>
          <h2 id="authority-title">
            {writerState === "active" ? t("prototype.e78a88843365") : t("prototype.a7e2fee19981")}
          </h2>
          <p>
            {t("prototype.d506ddaf1a99")} {generation}
          </p>
        </div>
        {writerState === "active" ? (
          <button type="button" className={cx(styles, "scorekeeper-secondary-button")} onClick={simulateWriterConflict}>
            {t("prototype.b32e77c8c66b")}
          </button>
        ) : null}
      </section>

      {unresolvedConflicts.length > 0 ? (
        <section className={cx(styles, "scorekeeper-reconciliation")} aria-labelledby="reconciliation-title">
          <Warning size={24} aria-hidden="true" />
          <div>
            <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.30c3f865c8c1")}</p>
            <h2 id="reconciliation-title">{t("prototype.966630a0f68e")}</h2>
            <p>
              {unresolvedConflicts.length === 1
                ? t("prototype.a69a27b48dfc")
                : t("prototype.0420d3a65134", { count: unresolvedConflicts.length })}
            </p>
            <label>
              {t("prototype.1ec205366c37")}
              <textarea
                value={reconciliationReason}
                onChange={(event) => setReconciliationReason(event.target.value)}
                placeholder={t("prototype.02fc05c00f6c")}
                rows={3}
              />
            </label>
            <div className={cx(styles, "scorekeeper-review-actions")}>
              <button
                type="button"
                className={cx(styles, "scorekeeper-secondary-button")}
                disabled={!reconciliationReason.trim()}
                onClick={() => resolveStaleEvent("discarded")}
              >
                {t("prototype.e43d8755f0a4")}
              </button>
              <button
                type="button"
                className={cx(styles, "scorekeeper-primary-button")}
                disabled={!reconciliationReason.trim()}
                onClick={() => resolveStaleEvent("converted")}
              >
                {t("prototype.00b037fc8eae")}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className={cx(styles, "scorekeeper-finalisation")} aria-labelledby="finalisation-title">
        <div>
          <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.c2e43d8393f8")}</p>
          <h2 id="finalisation-title">
            {finalState === "open"
              ? t("prototype.fcc4d9a49fb2")
              : finalState === "pending_sync"
                ? t("prototype.9716ece4f9dd")
                : t("prototype.70341c832a8d")}
          </h2>
          <p>
            {finalState === "pending_sync"
              ? t("prototype.92dd1e9505d7")
              : finalState === "published"
                ? t("prototype.dd1313f521ef")
                : t("prototype.fb5d80220c65")}
          </p>
        </div>
        {finalState === "open" ? (
          <button
            type="button"
            className={cx(styles, "scorekeeper-finalise-button")}
            onClick={() => setShowFinalReview(true)}
            disabled={writerState !== "active" || unresolvedConflicts.length > 0}
          >
            <ClipboardText size={22} aria-hidden="true" />
            {t("prototype.1beae4a8bd01")}
          </button>
        ) : null}
      </section>

      <FinaliseDialog
        open={showFinalReview}
        scores={scores}
        syncState={syncState}
        onCancel={() => setShowFinalReview(false)}
        onConfirm={confirmFinalisation}
      />

      {finalState === "published" ? (
        <section className={cx(styles, "scorekeeper-correction")} aria-labelledby="correction-title">
          <div>
            <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.3d398d177d39")}</p>
            <h2 id="correction-title">{t("prototype.642ce67554b2")}</h2>
            <p>{t("prototype.c4638c774a96")}</p>
          </div>
          <label>
            {t("prototype.f96404674470")}
            <textarea
              rows={3}
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
              placeholder={t("prototype.abc8d8bd27b9")}
            />
          </label>
          <div className={cx(styles, "scorekeeper-correction-actions")}>
            <button type="button" disabled={!correctionReason.trim()} onClick={() => addCorrection("blue")}>
              {t("prototype.deb4cd81bf66")}
            </button>
            <button type="button" disabled={!correctionReason.trim()} onClick={() => addCorrection("gold")}>
              {t("prototype.c5d51a96e5f3")}
            </button>
          </div>
        </section>
      ) : null}

      {downstreamConflict ? (
        <section className={cx(styles, "scorekeeper-downstream-conflict")} role="alert">
          <Warning size={22} aria-hidden="true" />
          <div>
            <h2>{t("prototype.bb560cd655ec")}</h2>
            <p>{t("prototype.f909f2cd35af")}</p>
          </div>
          <button
            type="button"
            className={cx(styles, "scorekeeper-secondary-button")}
            onClick={() => setDownstreamConflict(false)}
          >
            {t("prototype.1fcc1a92ad98")}
          </button>
        </section>
      ) : null}

      <p className={cx(styles, "visually-hidden")} aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

export default ScorekeeperPrototype;
