import type { CompetitionView, MatchView, PublicDivisionView } from "@/lib/phase2";
import { publicCompetitionPhase, type PublicCompetitionPhase } from "@/lib/phase2-public-phase";

/**
 * Pure view-model helpers for the public competition page: tab/URL state, divisions, day grouping in the
 * competition timezone, live/up-next/results selection, team following and score-change detection.
 * Everything here is deterministic given its inputs (callers pass `now`), so it is unit tested directly.
 */

/** Optional fields some projections carry (lifecycle dates/status and preformatted labels). */
export type PublicCompetitionInput = CompetitionView & {
  status?: string | undefined;
  startsOn?: string | undefined;
  endsOn?: string | undefined;
};
export type PublicMatchInput = MatchView & { date?: string | undefined; dayLabel?: string | undefined };

export const publicTabs = ["live", "schedule", "table", "bracket"] as const;
export type PublicTab = (typeof publicTabs)[number];

export type PublicViewState = Readonly<{
  tab: PublicTab;
  /** Division id; null means "the first division". */
  division: string | null;
  team: string | null;
  court: string | null;
  /** Schedule day key (YYYY-MM-DD in the competition timezone); null means "pick a sensible default". */
  day: string | null;
}>;

export const defaultPublicViewState: PublicViewState = Object.freeze({
  tab: "live",
  division: null,
  team: null,
  court: null,
  day: null,
});

const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
const maxParamLength = 200;

function cleanParam(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= maxParamLength ? trimmed : null;
}

/** Parses `?tab=&division=&team=&court=&day=` defensively; unknown or malformed values fall back to defaults. */
export function parsePublicViewState(search: string | URLSearchParams): PublicViewState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const tab = params.get("tab");
  const day = cleanParam(params.get("day"));
  return {
    tab: (publicTabs as readonly string[]).includes(tab ?? "") ? (tab as PublicTab) : "live",
    division: cleanParam(params.get("division")),
    team: cleanParam(params.get("team")),
    court: cleanParam(params.get("court")),
    day: day && dayKeyPattern.test(day) ? day : null,
  };
}

/** Serialises state back to a query string, omitting defaults so shared links stay short. */
export function serializePublicViewState(state: PublicViewState): string {
  const params = new URLSearchParams();
  if (state.tab !== "live") params.set("tab", state.tab);
  if (state.division) params.set("division", state.division);
  if (state.team) params.set("team", state.team);
  if (state.court) params.set("court", state.court);
  if (state.day) params.set("day", state.day);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function publicDivisions(competition: CompetitionView): PublicDivisionView[] {
  return competition.publicDivisions && competition.publicDivisions.length > 0
    ? competition.publicDivisions
    : [
        {
          division: competition.division,
          teams: competition.teams,
          areas: competition.areas,
          matches: competition.matches,
          standings: competition.standings,
          bracket: competition.bracket,
        },
      ];
}

export function selectDivision(divisions: readonly PublicDivisionView[], id: string | null): PublicDivisionView {
  const first = divisions[0];
  if (!first) throw new Error("A public competition needs at least one division");
  return divisions.find((candidate) => candidate.division.id === id) ?? first;
}

export function competitionPhase(competition: PublicCompetitionInput, now: Date): PublicCompetitionPhase {
  return publicCompetitionPhase(
    {
      status: competition.status ?? "published",
      startsOn: competition.startsOn,
      endsOn: competition.endsOn,
      timezone: competition.timezone,
      hasLiveMatch: publicDivisions(competition).some((division) =>
        division.matches.some((match) => match.status === "live"),
      ),
    },
    now,
  );
}

/* ---------------------------------------------------------------- bracket ---------------------------------------------------------------- */

export type BracketRow = PublicDivisionView["bracket"][number];
export type BracketFormat = "none" | "single" | "double";
export type BracketRound = Readonly<{ key: string; title: string; matches: readonly BracketRow[] }>;
export type BracketModel = Readonly<{
  format: BracketFormat;
  /** Single elimination rounds, or the upper bracket for double elimination. */
  upper: readonly BracketRound[];
  lower: readonly BracketRound[];
  finals: readonly BracketRound[];
}>;

const groupStagePattern = /\b(group|pool|round[\s_-]?robin|league)\b/i;

function isGroupStage(row: BracketRow): boolean {
  return groupStagePattern.test(row.round) || groupStagePattern.test(row.id ?? "");
}

function bracketSection(row: BracketRow): "upper" | "lower" | "final" | "knockout" {
  if (row.stageKind === "upper") return "upper";
  if (row.stageKind === "lower") return "lower";
  if (row.stageKind === "grand_final" || row.stageKind === "reset_final") return "final";
  const round = row.round.toLowerCase();
  if (/\bupper\b/.test(round)) return "upper";
  if (/\blower\b/.test(round)) return "lower";
  if (/grand[\s_-]?final/.test(round)) return "final";
  return "knockout";
}

function roundsOf(rows: readonly BracketRow[]): BracketRound[] {
  const rounds = new Map<string, BracketRow[]>();
  for (const row of rows) {
    const key = row.round.trim() || "knockout";
    rounds.set(key, [...(rounds.get(key) ?? []), row]);
  }
  return [...rounds].map(([key, matches]) => ({ key, title: key, matches }));
}

/**
 * Builds the bracket to show for a division. Group/pool rows are never part of a bracket (a group-then-knockout
 * format only shows its knockout rounds) and finals only contain rows that are explicitly finals.
 */
export function bracketModel(rows: readonly BracketRow[]): BracketModel {
  const knockout = rows.filter((row) => !isGroupStage(row));
  if (knockout.length === 0) return { format: "none", upper: [], lower: [], finals: [] };
  const sections = knockout.map((row) => [row, bracketSection(row)] as const);
  const isDouble = sections.some(([, section]) => section === "lower");
  if (!isDouble) {
    return { format: "single", upper: roundsOf(knockout), lower: [], finals: [] };
  }
  return {
    format: "double",
    upper: roundsOf(sections.filter(([, s]) => s === "upper" || s === "knockout").map(([row]) => row)),
    lower: roundsOf(sections.filter(([, s]) => s === "lower").map(([row]) => row)),
    finals: roundsOf(sections.filter(([, s]) => s === "final").map(([row]) => row)),
  };
}

export function divisionHasBracket(division: PublicDivisionView): boolean {
  return bracketModel(division.bracket).format !== "none";
}

export function availableTabs(division: PublicDivisionView): PublicTab[] {
  return divisionHasBracket(division) ? [...publicTabs] : publicTabs.filter((tab) => tab !== "bracket");
}

/* -------------------------------------------------------------- schedule --------------------------------------------------------------- */

export type ScheduleDay = Readonly<{ key: string; label: string; matches: readonly MatchView[] }>;
export const unscheduledDayKey = "unscheduled";

function formatterFor(timezone: string, options: Intl.DateTimeFormatOptions, locale: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone });
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  }
}

/** Calendar day key (YYYY-MM-DD) of an instant in the competition timezone. */
export function dayKeyInTimezone(instant: Date, timezone: string): string {
  return formatterFor(timezone, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").format(instant);
}

function startInstant(match: MatchView): Date | null {
  if (!match.startsAt) return null;
  const date = new Date(match.startsAt);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function matchDayKey(match: PublicMatchInput, timezone: string): string {
  const start = startInstant(match);
  if (start) return dayKeyInTimezone(start, timezone);
  return match.date?.trim() || match.dayLabel?.trim() || unscheduledDayKey;
}

export function dayLabel(key: string, timezone: string, locale: string): string {
  if (!dayKeyPattern.test(key)) return key;
  // Noon UTC on the key's date is inside that calendar day in every real timezone (UTC-12…UTC+14).
  const instant = new Date(`${key}T12:00:00Z`);
  return formatterFor(timezone, { weekday: "long", day: "numeric", month: "long" }, locale).format(instant);
}

function compareStart(a: MatchView, b: MatchView): number {
  const left = startInstant(a)?.getTime() ?? Number.POSITIVE_INFINITY;
  const right = startInstant(b)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.time.localeCompare(b.time) || a.area.localeCompare(b.area) || a.id.localeCompare(b.id);
}

/** Groups matches into calendar days of the competition timezone, ordered by start time; undated matches go last. */
export function groupMatchesByDay(
  matches: readonly MatchView[],
  timezone: string,
  locale: string,
  unscheduledLabel: string,
): ScheduleDay[] {
  const days = new Map<string, MatchView[]>();
  for (const match of [...matches].sort(compareStart)) {
    const key = matchDayKey(match, timezone);
    days.set(key, [...(days.get(key) ?? []), match]);
  }
  return [...days]
    .sort(([a], [b]) => {
      if (a === unscheduledDayKey) return 1;
      if (b === unscheduledDayKey) return -1;
      return a.localeCompare(b);
    })
    .map(([key, dayMatches]) => ({
      key,
      label: key === unscheduledDayKey ? unscheduledLabel : dayLabel(key, timezone, locale),
      matches: dayMatches,
    }));
}

/** Today when the event is in progress on a scheduled day, otherwise the next day with matches, otherwise the last. */
export function defaultScheduleDay(days: readonly ScheduleDay[], now: Date, timezone: string): string | null {
  if (days.length === 0) return null;
  const today = dayKeyInTimezone(now, timezone);
  const dated = days.filter((day) => dayKeyPattern.test(day.key));
  if (dated.some((day) => day.key === today)) return today;
  const upcoming = dated.find((day) => day.key > today);
  return upcoming?.key ?? dated.at(-1)?.key ?? days[0]!.key;
}

export function filterMatches(
  matches: readonly MatchView[],
  filters: Readonly<{ team: string | null; court: string | null }>,
): MatchView[] {
  return matches.filter(
    (match) =>
      (!filters.team || match.home === filters.team || match.away === filters.team) &&
      (!filters.court || match.area === filters.court),
  );
}

/* ----------------------------------------------------------------- live ------------------------------------------------------------------ */

export type DivisionMatch = Readonly<{ match: MatchView; division: PublicDivisionView["division"] }>;

export function allMatches(divisions: readonly PublicDivisionView[]): DivisionMatch[] {
  return divisions.flatMap((division) => division.matches.map((match) => ({ match, division: division.division })));
}

/** Every in-progress match (never only the first). Empty once the competition itself is not live. */
export function liveMatches(items: readonly DivisionMatch[], phase: PublicCompetitionPhase): DivisionMatch[] {
  if (phase !== "live") return [];
  return items
    .filter(({ match }) => match.status === "live")
    .sort((a, b) => a.match.area.localeCompare(b.match.area) || compareStart(a.match, b.match));
}

export function upNext(items: readonly DivisionMatch[], limit = 4): DivisionMatch[] {
  return items
    .filter(({ match }) => match.status === "scheduled")
    .sort((a, b) => compareStart(a.match, b.match))
    .slice(0, limit);
}

function updatedTime(match: MatchView): number {
  const value = match.updatedAt ? Date.parse(match.updatedAt) : Number.NaN;
  return Number.isFinite(value) ? value : (startInstant(match)?.getTime() ?? 0);
}

export function latestResults(items: readonly DivisionMatch[], limit = 4): DivisionMatch[] {
  return items
    .filter(({ match }) => match.status === "final")
    .sort((a, b) => updatedTime(b.match) - updatedTime(a.match))
    .slice(0, limit);
}

/* -------------------------------------------------------------- following -------------------------------------------------------------- */

export function competitionTeams(divisions: readonly PublicDivisionView[]): string[] {
  const names = new Set<string>();
  for (const division of divisions) {
    for (const team of division.teams) if (team && team !== "TBD") names.add(team);
    for (const match of division.matches) {
      for (const team of [match.home, match.away]) if (team && team !== "TBD") names.add(team);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function involvesTeam(match: MatchView, team: string | null): boolean {
  return Boolean(team) && (match.home === team || match.away === team);
}

export type FollowedTeamSummary = Readonly<{
  live: DivisionMatch | null;
  next: DivisionMatch | null;
  recent: DivisionMatch | null;
}>;

export function followedTeamSummary(
  items: readonly DivisionMatch[],
  team: string | null,
  phase: PublicCompetitionPhase,
): FollowedTeamSummary {
  if (!team) return { live: null, next: null, recent: null };
  const mine = items.filter(({ match }) => involvesTeam(match, team));
  return {
    live: liveMatches(mine, phase)[0] ?? null,
    next: upNext(mine, 1)[0] ?? null,
    recent: latestResults(mine, 1)[0] ?? null,
  };
}

/** Validates a stored team against the current competition so a renamed/removed team is silently dropped. */
export function resolveFollowedTeam(stored: string | null, teams: readonly string[]): string | null {
  return stored && teams.includes(stored) ? stored : null;
}

export function followedTeamStorageKey(slug: string): string {
  return `matchday.followed-team.${slug}`;
}

/* -------------------------------------------------------- live score changes ---------------------------------------------------------- */

export type ScoreChange = Readonly<{
  matchId: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  finished: boolean;
}>;

/** Matches whose score or final state changed between two snapshots, limited by `include`. */
export function scoreChanges(
  previous: CompetitionView,
  next: CompetitionView,
  include: (match: MatchView) => boolean,
): ScoreChange[] {
  const before = new Map(allMatches(publicDivisions(previous)).map(({ match }) => [match.id, match]));
  return allMatches(publicDivisions(next)).flatMap(({ match }) => {
    if (!include(match) || match.homeScore === undefined || match.awayScore === undefined) return [];
    const old = before.get(match.id);
    const scoreChanged = old?.homeScore !== match.homeScore || old?.awayScore !== match.awayScore;
    const finished = match.status === "final" && old?.status !== "final";
    if (!old || (!scoreChanged && !finished)) return [];
    return [
      {
        matchId: match.id,
        home: match.home,
        away: match.away,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        finished,
      },
    ];
  });
}

/** Ids of matches whose visible score changed — used for a brief, motion-safe highlight. */
export function changedMatchIds(previous: CompetitionView, next: CompetitionView): string[] {
  return scoreChanges(previous, next, () => true).map((change) => change.matchId);
}

export function findMatch(
  competition: CompetitionView,
  matchId: string,
): { match: MatchView; division: PublicDivisionView } | null {
  for (const division of publicDivisions(competition)) {
    const match = division.matches.find((candidate) => candidate.id === matchId);
    if (match) return { match, division };
  }
  return null;
}

/** Whether standings for this sport can contain draws (shows the D column). */
export function standingsShowDraws(competition: CompetitionView, division: PublicDivisionView): boolean {
  return competition.sportCode === "canoe_polo" || division.standings.some((row) => row.drawn > 0);
}

export function formatClock(instant: Date, timezone: string, locale: string): string {
  return formatterFor(timezone, { hour: "2-digit", minute: "2-digit", hour12: false }, locale).format(instant);
}
