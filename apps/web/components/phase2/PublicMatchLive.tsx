"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { interpolate, spectatorMessages as copy } from "@matchday/ui";
import type { CompetitionView } from "@/lib/phase2";
import {
  competitionPhase,
  findMatch,
  formatClock,
  liveUpdatesEnded,
  type ScoreChange,
} from "@/lib/public-competition-model";
import { segmentName } from "./PublicCompetitionApp";
import { LiveStatus } from "./PublicLiveStatus";
import { useLiveCompetition } from "./useLiveCompetition";
import { publicUi } from "@/lib/public-ui-tokens";
import styles from "./PublicMatch.module.css";

function formatRecorded(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PublicMatchLive({
  competition: initial,
  matchId,
  liveUpdates,
  renderedAt,
}: {
  competition: CompetitionView;
  matchId: string;
  liveUpdates: boolean;
  renderedAt: string;
}) {
  const [announcement, setAnnouncement] = useState("");
  const onScoreChanges = useCallback(
    (changes: readonly ScoreChange[]) => {
      const change = changes.find((item) => item.matchId === matchId);
      if (change)
        setAnnouncement(
          interpolate(change.finished ? copy.matchFinished : copy.scoreUpdate, {
            home: change.home,
            away: change.away,
            homeScore: change.homeScore,
            awayScore: change.awayScore,
          }),
        );
    },
    [matchId],
  );
  const live = useLiveCompetition(initial, liveUpdates && !liveUpdatesEnded(initial), onScoreChanges);
  const competition = live.view;
  const phase = competitionPhase(competition, new Date(live.lastSyncedAt ?? renderedAt));
  const found = findMatch(competition, matchId);
  const backHref = `/competitions/${encodeURIComponent(competition.slug)}`;

  if (!found) {
    return (
      <div className={styles.wrap}>
        <Link className={styles.back} href={backHref}>
          {interpolate(copy.match.back, { competition: competition.name })}
        </Link>
        <p>{copy.match.notFound}</p>
      </div>
    );
  }
  const { match, division } = found;
  const isLive = match.status === "live" && phase === "live";
  const status =
    match.status === "live"
      ? isLive
        ? copy.liveBadge
        : copy.lastRecorded
      : match.status === "final"
        ? copy.finalBadge
        : copy.scheduledBadge;
  const segment = segmentName(competition);
  const start = match.startsAt ? new Date(match.startsAt) : null;
  const startText =
    start && Number.isFinite(start.getTime())
      ? `${match.date ?? match.dayLabel ?? ""} · ${formatClock(start, competition.timezone, "en-SG")}`.replace(
          /^ · /u,
          "",
        )
      : match.date
        ? `${match.date} · ${match.time}`
        : match.time;
  const hasScore = match.homeScore !== undefined && match.awayScore !== undefined;

  return (
    <div className={styles.wrap}>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <nav className={styles.crumbs}>
        <Link className={styles.back} href={backHref}>
          {interpolate(copy.match.back, { competition: competition.name })}
        </Link>
        <Link className={styles.back} href={`${backHref}?tab=schedule`}>
          {copy.match.backToSchedule}
        </Link>
      </nav>
      <header className={styles.heading}>
        <p>
          {competition.sport} · {division.division.name} · {match.stage}
        </p>
        <h1>
          {match.home} <span className={styles.versus}>{copy.versus}</span> {match.away}
        </h1>
        <LiveStatus
          connection={live.connection}
          phase={phase}
          lastSyncedAt={live.lastSyncedAt}
          fallbackLabel={competition.lastUpdated}
          timezone={competition.timezone}
        />
      </header>
      <section
        className={styles.scoreboard}
        aria-label={copy.match.scoreboard}
        data-status={isLive ? "live" : match.status === "live" ? "stale" : match.status}
        data-changed={live.changed.has(match.id) || undefined}
      >
        <div className={styles.meta}>
          <span className={styles.badge} data-tone={isLive ? "live" : match.status}>
            {status}
          </span>
          <span>{match.label}</span>
        </div>
        <div
          className={styles.score}
          aria-label={
            hasScore
              ? interpolate(copy.scoreSummary, {
                  home: match.home,
                  away: match.away,
                  homeScore: match.homeScore ?? 0,
                  awayScore: match.awayScore ?? 0,
                })
              : undefined
          }
        >
          <div className={styles.team}>
            <span>{match.home}</span>
            <strong>{match.homeScore ?? "–"}</strong>
          </div>
          <span className={styles.dash} aria-hidden="true">
            –
          </span>
          <div className={styles.team}>
            <span>{match.away}</span>
            <strong>{match.awayScore ?? "–"}</strong>
          </div>
        </div>
        {isLive && match.currentSegment ? (
          <p className={styles.current}>
            {interpolate(copy.match.current, { segment: `${segment} ${match.currentSegment}` })}
          </p>
        ) : null}
        {match.segments?.length ? (
          <table className={styles.breakdown}>
            <caption>{copy.match.breakdown}</caption>
            <thead>
              <tr>
                <th scope={publicUi.col}>
                  <span className="visually-hidden">{copy.table.team}</span>
                </th>
                {match.segments.map((item) => (
                  <th scope={publicUi.col} key={item.number}>
                    {`${segment.charAt(0)}${item.number}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope={publicUi.row}>{match.home}</th>
                {match.segments.map((item) => (
                  <td key={item.number}>{item.home}</td>
                ))}
              </tr>
              <tr>
                <th scope={publicUi.row}>{match.away}</th>
                {match.segments.map((item) => (
                  <td key={item.number}>{item.away}</td>
                ))}
              </tr>
            </tbody>
          </table>
        ) : null}
      </section>
      <dl className={styles.details}>
        <div>
          <dt>{copy.match.status}</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>{copy.match.court}</dt>
          <dd>{match.area}</dd>
        </div>
        <div>
          <dt>{copy.match.stage}</dt>
          <dd>{match.stage}</dd>
        </div>
        <div>
          <dt>{copy.match.start}</dt>
          <dd>{startText}</dd>
        </div>
        <div>
          <dt>{copy.match.division}</dt>
          <dd>{division.division.name}</dd>
        </div>
        {match.recordedTimeSeconds != null ? (
          <div>
            <dt>{copy.match.recordedTime}</dt>
            <dd>{interpolate(copy.match.elapsed, { time: formatRecorded(match.recordedTimeSeconds) })}</dd>
          </div>
        ) : null}
        <div>
          <dt>{copy.match.lastUpdated}</dt>
          <dd>{match.updatedLabel ?? competition.lastUpdated}</dd>
        </div>
      </dl>
    </div>
  );
}
