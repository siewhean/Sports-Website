"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { interpolate, opaqueId, spectatorMessages as copy } from "@matchday/ui";
import type { CompetitionView, MatchView, PublicDivisionView } from "@/lib/phase2";
import {
  allMatches,
  availableTabs,
  bracketModel,
  competitionPhase,
  competitionTeams,
  dayKeyInTimezone,
  defaultScheduleDay,
  filterMatches,
  followedTeamStorageKey,
  followedTeamSummary,
  formatClock,
  groupMatchesByDay,
  involvesTeam,
  latestResults,
  liveMatches,
  parsePublicViewState,
  publicDivisions,
  resolveFollowedTeam,
  selectDivision,
  serializePublicViewState,
  standingsShowDraws,
  upNext,
  unscheduledDayKey,
  type DivisionMatch,
  type PublicTab,
  type PublicViewState,
  type ScoreChange,
} from "@/lib/public-competition-model";
import type { PublicCompetitionPhase } from "@/lib/phase2-public-phase";
import { useUrlSearch } from "@/components/ui/useUrlSearch";
import { PublicBracket } from "./PublicBracket";
import { LiveStatus } from "./PublicLiveStatus";
import { useLiveCompetition } from "./useLiveCompetition";
import { publicUi } from "@/lib/public-ui-tokens";
import styles from "./PublicCompetition.module.css";

const locale = publicUi.locale;
const nowTickMs = 60_000;

export function segmentName(competition: Pick<CompetitionView, "sportCode">): string {
  return competition.sportCode ? copy.segmentNames[competition.sportCode] : copy.segmentNames.default;
}

function readFollowedTeam(slug: string): string | null {
  try {
    return window.localStorage.getItem(followedTeamStorageKey(slug));
  } catch {
    return null;
  }
}

const followEvent = "matchday-followed-team";
/** In-memory fallback so following still works for this visit when storage is blocked. */
const memoryFollow = new Map<string, string | null>();

function writeFollowedTeam(slug: string, team: string | null): void {
  memoryFollow.set(slug, team);
  try {
    if (team) window.localStorage.setItem(followedTeamStorageKey(slug), team);
    else window.localStorage.removeItem(followedTeamStorageKey(slug));
  } catch {
    // Private mode or blocked storage: the in-memory value above is used instead.
  }
  window.dispatchEvent(new Event(followEvent));
}

function subscribeFollow(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(followEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(followEvent, onChange);
  };
}

/** Hydration-safe: the server and first client render have no followed team; the stored one applies right after. */
function useFollowedTeam(slug: string): string | null {
  return useSyncExternalStore(
    subscribeFollow,
    () => (memoryFollow.has(slug) ? (memoryFollow.get(slug) ?? null) : readFollowedTeam(slug)),
    () => null,
  );
}

export function PublicCompetitionApp({
  competition: initial,
  liveUpdates,
  renderedAt,
}: {
  competition: CompetitionView;
  liveUpdates: boolean;
  /** Server render instant, so the first client render matches the HTML exactly. */
  renderedAt: string;
}) {
  const [now, setNow] = useState(() => new Date(renderedAt));
  useEffect(() => {
    const first = window.setTimeout(() => setNow(new Date()), 0);
    const timer = window.setInterval(() => setNow(new Date()), nowTickMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  const initialPhase = competitionPhase(initial, new Date(renderedAt));
  const [announcement, setAnnouncement] = useState("");
  const followedRef = useRef<string | null>(null);
  const onScoreChanges = useCallback((changes: readonly ScoreChange[]) => {
    const team = followedRef.current;
    const mine = changes.filter((change) => team && (change.home === team || change.away === team));
    const latest = mine.at(-1);
    if (!latest) return;
    setAnnouncement(
      interpolate(latest.finished ? copy.matchFinished : copy.scoreUpdate, {
        home: latest.home,
        away: latest.away,
        homeScore: latest.homeScore,
        awayScore: latest.awayScore,
      }),
    );
  }, []);
  const live = useLiveCompetition(initial, liveUpdates && initialPhase !== "completed", onScoreChanges);
  const competition = live.view;
  const phase = competitionPhase(competition, now);

  const [search, navigate] = useUrlSearch();
  const state = useMemo(() => parsePublicViewState(search), [search]);
  const divisions = useMemo(() => publicDivisions(competition), [competition]);
  const division = selectDivision(divisions, state.division);
  const tabs = availableTabs(division);
  const tab: PublicTab = tabs.includes(state.tab) ? state.tab : opaqueId("live");
  const teams = useMemo(() => competitionTeams(divisions), [divisions]);

  const storedTeam = useFollowedTeam(competition.slug);
  const followed = resolveFollowedTeam(storedTeam, teams);
  useEffect(() => {
    followedRef.current = followed;
  }, [followed]);
  const follow = (team: string | null) => {
    writeFollowedTeam(competition.slug, team);
    setAnnouncement(team ? interpolate(copy.follow.following, { team }) : copy.follow.none);
  };

  const update = (patch: Partial<PublicViewState>, mode: "push" | "replace" = publicUi.replace) =>
    navigate(serializePublicViewState({ ...state, ...patch }), mode);

  return (
    <div className={styles.app}>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <header className={styles.identity}>
        <p className={styles.eyebrow}>
          {competition.sport} · {competition.dateLabel}
        </p>
        <h1>{competition.name}</h1>
        <p className={styles.venue}>{competition.venue}</p>
      </header>
      <div className={styles.subHeader}>
        <div className={styles.subHeaderRow}>
          <strong className={styles.subHeaderName}>{competition.name}</strong>
          <LiveStatus
            connection={live.connection}
            phase={phase}
            lastSyncedAt={live.lastSyncedAt}
            fallbackLabel={competition.lastUpdated}
            timezone={competition.timezone}
          />
        </div>
        <div className={styles.subHeaderRow}>
          <PublicTabs tabs={tabs} active={tab} onSelect={(next) => update({ tab: next }, publicUi.push)} />
          {divisions.length > 1 && tab !== "live" ? (
            <label className={styles.divisionSwitch}>
              <span>{copy.divisionLabel}</span>
              <select
                value={division.division.id}
                onChange={(event) =>
                  update({ division: event.target.value, team: null, court: null, day: null }, publicUi.push)
                }
              >
                {divisions.map(({ division: item }) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
      <section
        className={styles.panel}
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        data-division-id={tab === "live" ? undefined : division.division.id}
        tabIndex={-1}
      >
        {tab === "live" ? (
          <LivePanel
            competition={competition}
            divisions={divisions}
            phase={phase}
            followed={followed}
            teams={teams}
            onFollow={follow}
            changed={live.changed}
            onShowSchedule={() => update({ tab: opaqueId("schedule") }, publicUi.push)}
          />
        ) : tab === "schedule" ? (
          <SchedulePanel
            competition={competition}
            division={division}
            phase={phase}
            state={state}
            now={now}
            followed={followed}
            changed={live.changed}
            onChange={(patch) => update(patch)}
          />
        ) : tab === "table" ? (
          <TablePanel competition={competition} division={division} followed={followed} />
        ) : (
          <PublicBracket
            model={bracketModel(division.bracket)}
            division={division}
            slug={competition.slug}
            followed={followed}
          />
        )}
      </section>
    </div>
  );
}

function PublicTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly PublicTab[];
  active: PublicTab;
  onSelect: (tab: PublicTab) => void;
}) {
  const refs = useRef(new Map<PublicTab, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.indexOf(active);
    const next =
      event.key === "ArrowRight"
        ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    onSelect(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label={copy.tabsLabel} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab}
          ref={(element) => {
            if (element) refs.current.set(tab, element);
            else refs.current.delete(tab);
          }}
          type="button"
          role="tab"
          id={`tab-${tab}`}
          aria-selected={tab === active}
          aria-controls={`panel-${tab}`}
          tabIndex={tab === active ? 0 : -1}
          onClick={() => onSelect(tab)}
        >
          {copy.tabs[tab]}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- shared rows --------------------------------------------------------------- */

function matchHref(slug: string, match: MatchView): string {
  return `/competitions/${encodeURIComponent(slug)}/matches/${encodeURIComponent(match.id)}`;
}

function startLabel(match: MatchView, timezone: string): string {
  if (match.startsAt) {
    const instant = new Date(match.startsAt);
    if (Number.isFinite(instant.getTime())) return formatClock(instant, timezone, locale);
  }
  return match.time && match.time !== "—" ? match.time : copy.timeTbc;
}

function statusLabel(match: MatchView, phase: PublicCompetitionPhase): string {
  if (match.status === "live") return phase === "live" ? copy.liveBadge : copy.lastRecorded;
  return match.status === "final" ? copy.finalBadge : copy.scheduledBadge;
}

function hasScore(match: MatchView): boolean {
  return match.homeScore !== undefined && match.awayScore !== undefined;
}

function SegmentLine({ match, segment }: { match: MatchView; segment: string }) {
  if (!match.segments?.length && !match.currentSegment) return null;
  return (
    <p className={styles.segments}>
      {match.currentSegment && match.status === "live" ? (
        <span className={styles.segmentNow}>
          {interpolate(copy.segmentNow, { segment, number: match.currentSegment })}
        </span>
      ) : null}
      {match.segments?.length ? (
        <span aria-label={copy.segmentsLabel}>
          {match.segments.map((item) => `${item.home}–${item.away}`).join(" · ")}
        </span>
      ) : null}
    </p>
  );
}

function ScoreCard({
  item,
  competition,
  phase,
  followed,
  changed,
  showDivision,
}: {
  item: DivisionMatch;
  competition: CompetitionView;
  phase: PublicCompetitionPhase;
  followed: string | null;
  changed: ReadonlySet<string>;
  showDivision: boolean;
}) {
  const { match, division } = item;
  const isLive = match.status === "live" && phase === "live";
  return (
    <Link
      href={matchHref(competition.slug, match)}
      className={styles.scoreCard}
      data-status={isLive ? "live" : match.status === "live" ? "stale" : match.status}
      data-followed={involvesTeam(match, followed) || undefined}
      data-changed={changed.has(match.id) || undefined}
      data-match-id={match.id}
    >
      <span className={styles.cardMeta}>
        <span className={styles.badge} data-tone={isLive ? "live" : match.status}>
          {statusLabel(match, phase)}
        </span>
        <span>{interpolate(copy.courtStage, { court: match.area, stage: match.stage })}</span>
      </span>
      {showDivision ? <span className={styles.divisionTag}>{division.name}</span> : null}
      <span className={styles.side}>
        <span>{match.home}</span>
        <strong>{match.homeScore ?? "–"}</strong>
      </span>
      <span className={styles.side}>
        <span>{match.away}</span>
        <strong>{match.awayScore ?? "–"}</strong>
      </span>
      <SegmentLine match={match} segment={segmentName(competition)} />
      {!hasScore(match) ? (
        <span className={styles.cardFoot}>
          {match.dayLabel ? `${match.dayLabel} · ` : ""}
          {startLabel(match, competition.timezone)}
        </span>
      ) : null}
    </Link>
  );
}

/* ------------------------------------------------------------------- live ------------------------------------------------------------------- */

function LivePanel({
  competition,
  divisions,
  phase,
  followed,
  teams,
  onFollow,
  changed,
  onShowSchedule,
}: {
  competition: CompetitionView;
  divisions: readonly PublicDivisionView[];
  phase: PublicCompetitionPhase;
  followed: string | null;
  teams: readonly string[];
  onFollow: (team: string | null) => void;
  changed: ReadonlySet<string>;
  onShowSchedule: () => void;
}) {
  const items = allMatches(divisions);
  const playing = liveMatches(items, phase);
  const next = upNext(items);
  const results = latestResults(items);
  const summary = followedTeamSummary(items, followed, phase);
  const showDivision = divisions.length > 1;
  const card = (item: DivisionMatch) => (
    <li key={item.match.id}>
      <ScoreCard
        item={item}
        competition={competition}
        phase={phase}
        followed={followed}
        changed={changed}
        showDivision={showDivision}
      />
    </li>
  );

  return (
    <>
      <section className={styles.follow} aria-labelledby="follow-title">
        <div className={styles.followHead}>
          <h2 id="follow-title">{copy.follow.title}</h2>
          <label>
            <span>{copy.follow.label}</span>
            <select value={followed ?? ""} onChange={(event) => onFollow(event.target.value || null)}>
              <option value="">{copy.follow.none}</option>
              {teams.map((team) => (
                <option key={team} value={team}>
                  {team}
                </option>
              ))}
            </select>
          </label>
          {followed ? (
            <button type="button" className={styles.textButton} onClick={() => onFollow(null)}>
              {copy.follow.clear}
            </button>
          ) : null}
        </div>
        {followed ? (
          <ul className={styles.followCards}>
            {summary.live ? (
              <li>
                <h3>{copy.follow.live}</h3>
                <ScoreCard
                  item={summary.live}
                  competition={competition}
                  phase={phase}
                  followed={followed}
                  changed={changed}
                  showDivision={showDivision}
                />
              </li>
            ) : null}
            <li>
              <h3>{copy.follow.next}</h3>
              {summary.next ? (
                <ScoreCard
                  item={summary.next}
                  competition={competition}
                  phase={phase}
                  followed={followed}
                  changed={changed}
                  showDivision={showDivision}
                />
              ) : (
                <p className={styles.empty}>{interpolate(copy.follow.nothingScheduled, { team: followed })}</p>
              )}
            </li>
            <li>
              <h3>{copy.follow.recent}</h3>
              {summary.recent ? (
                <ScoreCard
                  item={summary.recent}
                  competition={competition}
                  phase={phase}
                  followed={followed}
                  changed={changed}
                  showDivision={showDivision}
                />
              ) : (
                <p className={styles.empty}>{interpolate(copy.follow.noResults, { team: followed })}</p>
              )}
            </li>
          </ul>
        ) : (
          <p className={styles.help}>{copy.follow.help}</p>
        )}
      </section>

      {phase === "live" ? (
        <section aria-labelledby="live-now-title">
          <h2 id="live-now-title" className={styles.sectionTitle}>
            {copy.liveNow}
          </h2>
          {playing.length > 0 ? (
            <ol className={styles.rail}>{playing.map(card)}</ol>
          ) : (
            <p className={styles.empty}>{copy.noLiveMatches}</p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="up-next-title">
        <h2 id="up-next-title" className={styles.sectionTitle}>
          {copy.upNext}
        </h2>
        {next.length > 0 ? (
          <ol className={styles.cardGrid}>{next.map(card)}</ol>
        ) : (
          <p className={styles.empty}>{copy.noUpcoming}</p>
        )}
      </section>

      <section aria-labelledby="latest-results-title">
        <h2 id="latest-results-title" className={styles.sectionTitle}>
          {copy.latestResults}
        </h2>
        {results.length > 0 ? (
          <ol className={styles.cardGrid}>{results.map(card)}</ol>
        ) : (
          <p className={styles.empty}>{copy.noResults}</p>
        )}
        <button type="button" className={styles.textButton} onClick={onShowSchedule}>
          {copy.allResults}
        </button>
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- schedule ----------------------------------------------------------------- */

function SchedulePanel({
  competition,
  division,
  phase,
  state,
  now,
  followed,
  changed,
  onChange,
}: {
  competition: CompetitionView;
  division: PublicDivisionView;
  phase: PublicCompetitionPhase;
  state: PublicViewState;
  now: Date;
  followed: string | null;
  changed: ReadonlySet<string>;
  onChange: (patch: Partial<PublicViewState>) => void;
}) {
  const timezone = competition.timezone;
  const teamOptions = [...new Set(division.matches.flatMap((match) => [match.home, match.away]))]
    .filter((team) => team && team !== "TBD")
    .sort((a, b) => a.localeCompare(b));
  const courtOptions = [...new Set(division.matches.map((match) => match.area))]
    .filter((court) => court && court !== "—")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const team = state.team && teamOptions.includes(state.team) ? state.team : null;
  const court = state.court && courtOptions.includes(state.court) ? state.court : null;
  const filtered = filterMatches(division.matches, { team, court });
  const allDays = groupMatchesByDay(division.matches, timezone, locale, copy.schedule.unscheduled);
  const days = groupMatchesByDay(filtered, timezone, locale, copy.schedule.unscheduled);
  const selectedDay =
    state.day && allDays.some((day) => day.key === state.day) ? state.day : defaultScheduleDay(allDays, now, timezone);
  const visible = allDays.length > 1 ? days.filter((day) => day.key === selectedDay) : days;
  const todayKey = dayKeyInTimezone(now, timezone);
  const segment = segmentName(competition);

  return (
    <>
      <h2 className={styles.sectionTitle}>{copy.schedule.title}</h2>
      <div className={styles.filters} role="group" aria-label={copy.schedule.filters}>
        {allDays.length > 1 ? (
          <div className={styles.dayPicker} role="group" aria-label={copy.schedule.day}>
            {allDays.map((day) => (
              <button
                key={day.key}
                type="button"
                aria-pressed={day.key === selectedDay}
                onClick={() => onChange({ day: day.key })}
              >
                {day.label}
                {day.key === todayKey ? <small>{copy.schedule.today}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
        <label>
          <span>{copy.schedule.team}</span>
          <select value={team ?? ""} onChange={(event) => onChange({ team: event.target.value || null })}>
            <option value="">{copy.schedule.allTeams}</option>
            {teamOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {courtOptions.length > 1 ? (
          <label>
            <span>{copy.schedule.court}</span>
            <select value={court ?? ""} onChange={(event) => onChange({ court: event.target.value || null })}>
              <option value="">{copy.schedule.allCourts}</option>
              {courtOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {team || court ? (
          <button type="button" className={styles.textButton} onClick={() => onChange({ team: null, court: null })}>
            {copy.schedule.clearFilters}
          </button>
        ) : null}
      </div>
      {visible.length === 0 || visible.every((day) => day.matches.length === 0) ? (
        <p className={styles.empty}>{copy.schedule.empty}</p>
      ) : (
        visible.map((day) => (
          <section key={day.key} className={styles.day} aria-labelledby={`day-${day.key}`}>
            <h3
              id={`day-${day.key}`}
              className={allDays.length === 1 && day.key === unscheduledDayKey ? "visually-hidden" : undefined}
            >
              {day.label} <small>{interpolate(copy.schedule.matchCount, { count: day.matches.length })}</small>
            </h3>
            <ol className={styles.fixtures} data-schedule="">
              {day.matches.map((match) => {
                const isLive = match.status === "live" && phase === "live";
                return (
                  <li
                    key={match.id}
                    data-match-id={match.id}
                    data-followed={involvesTeam(match, followed) || undefined}
                    data-changed={changed.has(match.id) || undefined}
                  >
                    <Link href={matchHref(competition.slug, match)} className={styles.fixture}>
                      <time dateTime={match.startsAt}>{startLabel(match, timezone)}</time>
                      <span className={styles.fixtureCourt}>{match.area}</span>
                      <span className={styles.fixtureTeams}>
                        <span>{match.home}</span>
                        <span className={styles.versus}>{copy.versus}</span>
                        <span>{match.away}</span>
                      </span>
                      <span className={styles.fixtureScore}>
                        {hasScore(match) ? `${match.homeScore}–${match.awayScore}` : ""}
                        <span className={styles.badge} data-tone={isLive ? "live" : match.status}>
                          {statusLabel(match, phase)}
                        </span>
                      </span>
                      <span className={styles.fixtureStage}>
                        {match.stage}
                        {isLive && match.currentSegment
                          ? ` · ${interpolate(copy.segmentNow, { segment, number: match.currentSegment })}`
                          : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
    </>
  );
}

/* ------------------------------------------------------------------ table ------------------------------------------------------------------- */

function TablePanel({
  competition,
  division,
  followed,
}: {
  competition: CompetitionView;
  division: PublicDivisionView;
  followed: string | null;
}) {
  const rows = division.standings;
  const draws = standingsShowDraws(competition, division);
  const explained = rows.filter((row) => row.explanations && row.explanations.length > 0);
  const label = interpolate(copy.table.tableLabel, { division: division.division.name });
  return (
    <>
      <h2 className={styles.sectionTitle}>{copy.table.title}</h2>
      {rows.length === 0 ? (
        <p className={styles.empty}>{copy.table.empty}</p>
      ) : (
        <div className={styles.tableScroll} role="region" aria-label={label} tabIndex={0}>
          <table className={styles.table} aria-label={label}>
            <thead>
              <tr>
                <th scope={publicUi.col}>
                  <abbr title={copy.table.position}>#</abbr>
                </th>
                <th scope={publicUi.col} className={styles.teamCell}>
                  {copy.table.team}
                </th>
                <th scope={publicUi.col}>
                  <abbr title={copy.table.playedLong}>{copy.table.played}</abbr>
                </th>
                <th scope={publicUi.col}>
                  <abbr title={copy.table.wonLong}>{copy.table.won}</abbr>
                </th>
                {draws ? (
                  <th scope={publicUi.col}>
                    <abbr title={copy.table.drawnLong}>{copy.table.drawn}</abbr>
                  </th>
                ) : null}
                <th scope={publicUi.col}>
                  <abbr title={copy.table.lostLong}>{copy.table.lost}</abbr>
                </th>
                <th scope={publicUi.col}>
                  <abbr title={copy.table.differenceLong}>{copy.table.difference}</abbr>
                </th>
                <th scope={publicUi.col}>
                  <abbr title={copy.table.pointsLong}>{copy.table.points}</abbr>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.team} data-followed={row.team === followed || undefined}>
                  <td>{row.position}</td>
                  <th scope={publicUi.row} className={styles.teamCell}>
                    {row.team}
                    {row.team === followed ? <span className={styles.youTag}>{copy.yourTeam}</span> : null}
                  </th>
                  <td>{row.played}</td>
                  <td>{row.won}</td>
                  {draws ? <td>{row.drawn}</td> : null}
                  <td>{row.lost}</td>
                  <td>{row.difference > 0 ? `+${row.difference}` : row.difference}</td>
                  <td>
                    <strong>{row.points}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {explained.length > 0 ? (
        <details className={styles.tieBreaks}>
          <summary>{copy.table.tieBreakTitle}</summary>
          <p>{copy.table.tieBreakIntro}</p>
          <dl>
            {explained.map((row) => (
              <div key={row.team} aria-label={interpolate(copy.table.tieBreakFor, { team: row.team })}>
                <dt>{row.team}</dt>
                <dd>{row.explanations?.join(" · ")}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </>
  );
}
