"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowLeft, Copy, Pause, Play, ShareNetwork, Stop } from "@phosphor-icons/react";
import { claimGame, getFriends, shareGameWithFriend, type CasualFriend } from "@/lib/casual-account";
import {
  casualViewerHref,
  changeCasualGame,
  hostTokenFor,
  readCasualGame,
  viewerTokenFor,
  type CasualGame,
} from "@/lib/casual-client";
import { casualCopy as c } from "@/lib/casual-copy";
import { formatElapsed } from "@/lib/casual-settings";
import { SPORT_PACKS } from "@matchday/domain";
import { opaqueId } from "@matchday/ui";
import styles from "./Casual.module.css";

export function CasualBoard({ id, mode, viewerToken }: { id: string; mode: "host" | "viewer"; viewerToken?: string }) {
  const [game, setGame] = useState<CasualGame | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [friends, setFriends] = useState<CasualFriend[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [tick, setTick] = useState(0);
  const [clockOrigin, setClockOrigin] = useState(0);
  const [previousScores, setPreviousScores] = useState<[number, number] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const latestVersion = useRef(0);
  const effectiveViewerToken =
    viewerToken ?? (typeof window !== "undefined" ? (viewerTokenFor(id) ?? undefined) : undefined);

  useEffect(() => {
    let active = true;
    let first = true;
    async function refresh() {
      try {
        const next = await readCasualGame(id, mode, effectiveViewerToken);
        if (!active) return;
        if (next.version < latestVersion.current) return;
        latestVersion.current = next.version;
        setClockOrigin(performance.now());
        setCanEdit(Boolean(mode === "host" && hostTokenFor(id)));
        setGame((old) => {
          if (old && (old.home_score !== next.home_score || old.away_score !== next.away_score))
            setPreviousScores([old.home_score, old.away_score]);
          return next;
        });
        setMessage("");
      } catch (error) {
        if (active && (first || !navigator.onLine)) setMessage(error instanceof Error ? error.message : c.unavailable);
        else if (active) setMessage(c.reconnecting);
      }
      first = false;
    }
    void refresh();
    const poll = window.setInterval(() => void refresh(), mode === "viewer" ? 3000 : 6000);
    function onVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, mode, effectiveViewerToken]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!shareOpen || !signedIn) return;
    void getFriends()
      .then(setFriends)
      .catch(() => undefined);
  }, [shareOpen, signedIn]);

  useEffect(() => {
    void fetch("/api/identity/current", { cache: opaqueId("no-store") })
      .then((response) => response.json())
      .then((value: { status?: string }) => setSignedIn(value.status === "authenticated"))
      .catch(() => undefined);
  }, []);

  function mutate(action: "actions" | "undo" | "timer" | "finish", body?: Record<string, unknown>) {
    if (busy || !game) return;
    setBusy(true);
    void changeCasualGame(id, action, body)
      .then((next) => {
        latestVersion.current = next.version;
        setClockOrigin(performance.now());
        setGame(next);
        setMessage("");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : c.unavailable))
      .finally(() => setBusy(false));
  }

  async function copyViewerLink() {
    const token = game?.viewer_token ?? viewerTokenFor(id);
    if (!token) return setMessage(c.missingViewingLink);
    const url = new URL(casualViewerHref(id, token), window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setMessage(c.copied);
    } catch {
      setMessage(url);
    }
  }

  async function saveToAccount() {
    const token = hostTokenFor(id);
    if (!token) return setMessage(c.noAccess);
    try {
      await claimGame(id, token);
      setMessage(c.saved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : c.unavailable);
    }
  }

  const elapsed = game
    ? game.elapsed_seconds +
      (game.timer_running && game.status !== "final" && clockOrigin && tick
        ? Math.max(0, Math.floor((tick - clockOrigin) / 1000))
        : 0)
    : 0;
  const live = game?.status !== "final";
  const editable = mode === "host" && live && canEdit;
  const sportName = game ? SPORT_PACKS[game.sport_id].displayName : c.game;

  return (
    <main className={styles.page} id="main-content">
      <div className={`${styles.container} ${styles.boardContainer}`}>
        <header className={styles.boardHeader}>
          <Link className={styles.backLink} href="/play">
            <ArrowLeft aria-hidden="true" />
            {c.goBack}
          </Link>
          <div className={styles.boardIdentity}>
            <span className={styles.eyebrow}>
              {mode === "viewer" ? (live ? c.watch : c.watchFinal) : live ? c.live : c.finished}
            </span>
            <h1>{sportName}</h1>
          </div>
          <span className={`${styles.liveBadge} ${live ? "" : styles.finalBadge}`}>
            <span />
            {live ? c.liveLabel : c.finalLabel}
          </span>
        </header>
        {message ? (
          <p className={styles.notice} role="status">
            {message}
          </p>
        ) : null}
        {!game ? (
          <div className={styles.loadingCard} role="status">
            {message || c.loading}
          </div>
        ) : (
          <>
            <section className={styles.scoreStage} aria-label={c.currentScore}>
              <div className={styles.scoreMeta}>
                <div>
                  <span>{c.elapsed}</span>
                  <strong className={styles.clock}>{formatElapsed(elapsed)}</strong>
                </div>
                <div>
                  <span>{game.period_minutes ? c.periodLabel : c.set}</span>
                  <strong>
                    {game.period_minutes
                      ? `${game.period_minutes} min`
                      : `${game.current_set} / ${game.best_of_sets ?? 1}`}
                  </strong>
                </div>
              </div>
              <div className={styles.scoreSides}>
                {([opaqueId("home"), opaqueId("away")] as const).map((side) => {
                  const score = side === "home" ? game.home_score : game.away_score;
                  const name = side === "home" ? game.home_name : game.away_name;
                  const changed = previousScores && score !== previousScores[side === "home" ? 0 : 1];
                  return editable ? (
                    <button
                      className={`${styles.scoreSide} ${side === "home" ? styles.home : styles.away} ${changed ? styles.scoreChanged : ""}`}
                      type="button"
                      key={side}
                      disabled={busy}
                      onClick={() => mutate(opaqueId("actions"), { side, points: 1 })}
                      aria-label={opaqueId(`Add one point for ${name}. Current score ${score}`)}
                    >
                      <span className={styles.teamName}>{name}</span>
                      <strong className={styles.scoreNumber}>{score}</strong>
                      <span className={styles.tapHint}>{c.pointAdded}</span>
                    </button>
                  ) : (
                    <div
                      className={`${styles.scoreSide} ${side === "home" ? styles.home : styles.away} ${changed ? styles.scoreChanged : ""}`}
                      key={side}
                    >
                      <span className={styles.teamName}>{name}</span>
                      <strong className={styles.scoreNumber}>{score}</strong>
                      <span className={styles.tapHint}>{mode === "viewer" ? c.watching : c.finalLabel}</span>
                    </div>
                  );
                })}
              </div>
              {editable ? <p className={styles.scoreInstruction}>{c.scoreHint}</p> : null}
              {game.sets.length ? (
                <div className={styles.setSummary} aria-label={c.setScores}>
                  {game.sets.map((set, index) => (
                    <span key={index}>
                      {c.set} {index + 1}{" "}
                      <strong>
                        {set.home}–{set.away}
                      </strong>
                    </span>
                  ))}
                </div>
              ) : null}
            </section>
            {mode === "host" ? (
              <div className={styles.boardActions}>
                <button type="button" disabled={!editable || busy} onClick={() => mutate(opaqueId("undo"))}>
                  <ArrowCounterClockwise aria-hidden="true" />
                  {c.undo}
                </button>
                <button
                  type="button"
                  disabled={!editable || busy}
                  onClick={() => mutate(opaqueId("timer"), { running: !game.timer_running })}
                >
                  {game.timer_running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                  {game.timer_running ? c.pause : c.resume}
                </button>
                <button type="button" onClick={() => setShareOpen(true)}>
                  <ShareNetwork aria-hidden="true" />
                  {c.share}
                </button>
                <button
                  className={styles.finishButton}
                  type="button"
                  disabled={!editable || busy}
                  onClick={() => {
                    if (window.confirm(c.confirmFinish)) mutate(opaqueId("finish"));
                  }}
                >
                  <Stop aria-hidden="true" />
                  {c.finish}
                </button>
              </div>
            ) : (
              <p className={styles.viewerInfo}>{c.viewerNote}</p>
            )}
            <footer className={styles.boardFooter}>
              <span>
                {c.update}{" "}
                {new Date(game.updated_at).toLocaleTimeString([], {
                  hour: opaqueId("2-digit"),
                  minute: opaqueId("2-digit"),
                })}
              </span>
              {mode === "host" && signedIn && editable ? (
                <button type="button" onClick={() => void saveToAccount()}>
                  {c.saveGame}
                </button>
              ) : null}
            </footer>
          </>
        )}
      </div>
      {shareOpen && mode === "host" ? (
        <div className={styles.modalBackdrop} onClick={() => setShareOpen(false)}>
          <section
            className={styles.sharePanel}
            role="dialog"
            aria-modal="true"
            aria-label={c.share}
            onClick={(event) => event.stopPropagation()}
          >
            <button className={styles.closeButton} type="button" onClick={() => setShareOpen(false)}>
              {c.close}
            </button>
            <span className={styles.eyebrow}>{c.shareMoment}</span>
            <h2>{c.share}</h2>
            <p>{c.viewerNote}</p>
            <button className={styles.primaryButton} type="button" onClick={() => void copyViewerLink()}>
              <Copy aria-hidden="true" />
              {c.copy}
            </button>
            {signedIn && friends.length ? (
              <div className={styles.friendsList}>
                <h3>{c.friends}</h3>
                {friends.map((friend) => (
                  <button
                    key={friend.id}
                    type="button"
                    onClick={() =>
                      void shareGameWithFriend(id, friend.id)
                        .then(() => setMessage(opaqueId(`Shared with ${friend.display_name}.`)))
                        .catch((error) => setMessage(error instanceof Error ? error.message : c.unavailable))
                    }
                  >
                    {c.shareFriend}: {friend.display_name}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
