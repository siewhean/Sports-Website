"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, ClockCounterClockwise, UsersThree } from "@phosphor-icons/react";
import { createCasualGame, type CasualGame, type CasualSettings } from "@/lib/casual-client";
import { getPresets, getSavedGames, getSharedGames, savePreset, type CasualPreset } from "@/lib/casual-account";
import { CasualFriends } from "./CasualFriends";
import { casualCopy as c } from "@/lib/casual-copy";
import { casualSports, defaultCasualSettings, validateCasualSettings } from "@/lib/casual-settings";
import type { SportId } from "@matchday/domain";
import { opaqueId } from "@matchday/ui";
import styles from "./Casual.module.css";

export function CasualSetup() {
  const router = useRouter();
  const [settings, setSettings] = useState<CasualSettings>(() => defaultCasualSettings(opaqueId("badminton")));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [history, setHistory] = useState<CasualGame[]>([]);
  const [sharedGames, setSharedGames] = useState<CasualGame[]>([]);
  const [presets, setPresets] = useState<CasualPreset[]>([]);
  const sport = casualSports.find((item) => item.id === settings.sport_id)!;

  useEffect(() => {
    void fetch("/api/identity/current", { cache: opaqueId("no-store") })
      .then((response) => response.json())
      .then((value: { status?: string }) => {
        if (value.status !== "authenticated") return;
        setSignedIn(true);
        void getSavedGames()
          .then(setHistory)
          .catch(() => undefined);
        void getSharedGames()
          .then(setSharedGames)
          .catch(() => undefined);
        void getPresets()
          .then(setPresets)
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  async function startGame() {
    const error = validateCasualSettings(settings);
    if (error) return setMessage(error);
    setBusy(true);
    setMessage("");
    try {
      const game = await createCasualGame({
        ...settings,
        home_name: settings.home_name.trim(),
        away_name: settings.away_name.trim(),
      });
      router.push(`/play/${encodeURIComponent(game.id)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : c.startFailed);
      setBusy(false);
    }
  }

  async function handlePreset() {
    const error = validateCasualSettings(settings);
    if (error) return setMessage(error);
    setBusy(true);
    try {
      await savePreset(`${sport.name} · ${settings.home_name} vs ${settings.away_name}`, settings);
      setPresets(await getPresets());
      setMessage(c.presetSaved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : c.presetFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page} id="main-content">
      <div className={styles.container}>
        <div className={styles.setupGrid}>
          <header className={styles.hero}>
            <span className={styles.eyebrow}>{c.eyebrow}</span>
            <h1>{c.setupTitle}</h1>
            <p>{c.setupIntro}</p>
            <div className={styles.heroAside}>
              <span>
                <ClockCounterClockwise aria-hidden="true" /> {c.liveClock}
              </span>
              <span>
                <UsersThree aria-hidden="true" /> {c.shareableView}
              </span>
            </div>
          </header>
          <section className={styles.formCard} aria-label={c.setupLabel}>
            <div className={styles.formHead}>
              <span>{c.setupStep}</span>
              <strong>{c.makeYours}</strong>
            </div>
            {presets.length ? (
              <label className={styles.field}>
                {c.presets}
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const preset = presets.find((item) => item.id === event.target.value);
                    if (preset) setSettings(preset.settings);
                  }}
                >
                  <option value="">{c.choosePreset}</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <fieldset className={styles.sportField}>
              <legend>{c.sport}</legend>
              <div className={styles.sportGrid}>
                {casualSports.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.sportChoice} ${settings.sport_id === item.id ? styles.selected : ""}`}
                    aria-pressed={settings.sport_id === item.id}
                    onClick={() =>
                      setSettings({
                        ...defaultCasualSettings(item.id as SportId),
                        home_name: settings.home_name,
                        away_name: settings.away_name,
                      })
                    }
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className={styles.fieldsTwo}>
              <label className={styles.field}>
                {c.teamA}
                <input
                  autoComplete="off"
                  maxLength={60}
                  value={settings.home_name}
                  onChange={(event) => setSettings({ ...settings, home_name: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                {c.teamB}
                <input
                  autoComplete="off"
                  maxLength={60}
                  value={settings.away_name}
                  onChange={(event) => setSettings({ ...settings, away_name: event.target.value })}
                />
              </label>
            </div>
            <div className={styles.fieldsTwo}>
              {sport.timed ? (
                <label className={styles.field}>
                  {c.period}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={120}
                    value={settings.period_minutes ?? ""}
                    onChange={(event) => setSettings({ ...settings, period_minutes: Number(event.target.value) })}
                  />
                </label>
              ) : (
                <>
                  <label className={styles.field}>
                    {c.target}
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={99}
                      value={settings.target_points ?? ""}
                      onChange={(event) => setSettings({ ...settings, target_points: Number(event.target.value) })}
                    />
                  </label>
                  <label className={styles.field}>
                    {c.sets}
                    <select
                      value={settings.best_of_sets ?? 1}
                      onChange={(event) => setSettings({ ...settings, best_of_sets: Number(event.target.value) })}
                    >
                      {[1, 3, 5, 7].map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            {message ? (
              <p className={styles.notice} role="status">
                {message}
              </p>
            ) : null}
            <div className={styles.formActions}>
              <button className={styles.primaryButton} type="button" disabled={busy} onClick={() => void startGame()}>
                {busy ? c.starting : c.start}
                <ArrowRight aria-hidden="true" />
              </button>
              {signedIn ? (
                <button className={styles.textButton} type="button" disabled={busy} onClick={() => void handlePreset()}>
                  {c.savePreset}
                </button>
              ) : (
                <Link className={styles.textButton} href="/sign-in">
                  {c.signIn}
                </Link>
              )}
            </div>
            <p className={styles.finePrint}>{c.guestNote}</p>
          </section>
        </div>
        {signedIn ? (
          <>
            <section className={styles.history}>
              <div>
                <span className={styles.eyebrow}>{c.yourSpace}</span>
                <h2>{c.accountTitle}</h2>
                <p>{c.accountIntro}</p>
              </div>
              <div className={styles.historyList}>
                {history.length ? (
                  history.map((game) => (
                    <Link key={game.id} href={`/play/${encodeURIComponent(game.id)}`} className={styles.historyItem}>
                      <span>
                        {game.home_name}{" "}
                        <strong>
                          {game.home_score} : {game.away_score}
                        </strong>{" "}
                        {game.away_name}
                      </span>
                      <small>{game.status}</small>
                    </Link>
                  ))
                ) : (
                  <p>{c.historyEmpty}</p>
                )}
              </div>
            </section>
            <section className={styles.history}>
              <div>
                <h2>{c.sharedGames}</h2>
              </div>
              <div className={styles.historyList}>
                {sharedGames.length ? (
                  sharedGames.map((game) => (
                    <Link
                      key={game.id}
                      href={`/play/${encodeURIComponent(game.id)}/watch`}
                      className={styles.historyItem}
                    >
                      <span>
                        {game.home_name}{" "}
                        <strong>
                          {game.home_score} : {game.away_score}
                        </strong>{" "}
                        {game.away_name}
                      </span>
                      <small>{game.status}</small>
                    </Link>
                  ))
                ) : (
                  <p>{c.sharedEmpty}</p>
                )}
              </div>
            </section>
            <CasualFriends />
          </>
        ) : null}
      </div>
    </main>
  );
}
