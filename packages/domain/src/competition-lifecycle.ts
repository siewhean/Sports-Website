import { MINUTE_MS, createFormatter, nextCivilDate, parseDate, resolveZonedMinute } from "./civil-time.js";

export const HOUR_MS = 60 * MINUTE_MS;

/** How long after the final competition day ends before it is auto-completed. */
export const DEFAULT_COMPETITION_AUTO_COMPLETE_GRACE_MS = 24 * HOUR_MS;

/** How long a live match may go without scoring activity before it stops being shown as live. */
export const DEFAULT_LIVE_MATCH_STALE_AFTER_MS = 6 * HOUR_MS;

/** Competition statuses the database lifecycle guard allows to move to `completed`. */
export const AUTO_COMPLETABLE_COMPETITION_STATUSES = ["active", "live"] as const;

function finiteEpoch(value: Date | number, label: string): number {
  const epoch = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(epoch)) throw new Error(`${label} must be a valid instant`);
  return epoch;
}

function nonNegativeDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

/**
 * The instant the final competition day ends: local midnight at the start of
 * the day after `endsOn`, in the competition's IANA timezone. If that local
 * midnight does not exist (a DST gap at 00:00), the first existing minute after
 * it is used, matching PostgreSQL's `(ends_on + 1)::timestamp AT TIME ZONE tz`.
 */
export function competitionScheduleEndsAt(endsOn: string, timeZone: string): Date {
  const formatter = createFormatter(timeZone);
  const nextDay = nextCivilDate(parseDate(endsOn, "Competition end date"));
  let lastError: unknown;
  for (let minuteOfDay = 0; minuteOfDay < 24 * 60; minuteOfDay += 15) {
    try {
      return new Date(
        resolveZonedMinute(
          nextDay,
          { hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 },
          timeZone,
          formatter,
        ),
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Cannot resolve the end of ${endsOn} in ${timeZone}`);
}

/**
 * True when the competition's final day ended more than `graceMs` ago in the
 * competition's own timezone. Exactly at the boundary counts as elapsed.
 */
export function isCompetitionScheduleElapsed(input: {
  endsOn: string;
  timeZone: string;
  now: Date | number;
  graceMs?: number;
}): boolean {
  const now = finiteEpoch(input.now, "Current time");
  const grace = nonNegativeDuration(input.graceMs ?? DEFAULT_COMPETITION_AUTO_COMPLETE_GRACE_MS, "Grace period");
  return competitionScheduleEndsAt(input.endsOn, input.timeZone).getTime() + grace <= now;
}

/** The latest scoring activity time at which a live match is considered abandoned. */
export function liveMatchStaleCutoff(now: Date | number, staleAfterMs = DEFAULT_LIVE_MATCH_STALE_AFTER_MS): Date {
  const epoch = finiteEpoch(now, "Current time");
  return new Date(epoch - nonNegativeDuration(staleAfterMs, "Live match staleness window"));
}

/**
 * True when a live match has had no scoring activity for at least
 * `staleAfterMs`. Stale matches remain in progress for the organiser; they are
 * only withheld from the public live view until scoring resumes or a result is
 * confirmed.
 */
export function isLiveMatchStale(input: {
  lastActivityAt: Date | number;
  now: Date | number;
  staleAfterMs?: number;
}): boolean {
  const lastActivity = finiteEpoch(input.lastActivityAt, "Last scoring activity");
  return lastActivity <= liveMatchStaleCutoff(input.now, input.staleAfterMs).getTime();
}
