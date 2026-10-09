export type PublicCompetitionPhase = "live" | "upcoming" | "completed";

export type PublicCompetitionPhaseInput = Readonly<{
  status: string;
  startsOn?: string | undefined;
  endsOn?: string | undefined;
  timezone?: string | undefined;
  /** True when at least one match is currently in progress in the public projection. */
  hasLiveMatch?: boolean | undefined;
}>;

const isoDate = /^(\d{4})-(\d{2})-(\d{2})/;

function dayNumber(value: string | undefined): number | null {
  const match = value ? isoDate.exec(value) : null;
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) ? Math.floor(time / 86_400_000) : null;
}

/** Calendar day (as a day number) of `now` in the competition's timezone; falls back to UTC for bad zones. */
export function dayNumberInTimezone(now: Date, timezone: string | undefined): number {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  let formatted: string;
  try {
    formatted = format(timezone || "UTC");
  } catch {
    formatted = format("UTC");
  }
  return dayNumber(formatted) ?? Math.floor(now.getTime() / 86_400_000);
}

/**
 * Single source of truth for how a competition is labelled on the home page, list, filters and detail page.
 *
 * A competition that ended two or more days ago is completed even if the server still says `live`, so a stale
 * lifecycle can never keep "LIVE NOW" on screen. One day of grace lets matches that run past midnight on the
 * last day stay live.
 */
export function publicCompetitionPhase(competition: PublicCompetitionPhaseInput, now: Date): PublicCompetitionPhase {
  if (competition.status === "completed" || competition.status === "archived") return "completed";
  const endDay = dayNumber(competition.endsOn);
  const daysPastEnd = endDay === null ? 0 : dayNumberInTimezone(now, competition.timezone) - endDay;
  if (daysPastEnd >= 2) return "completed";
  if (competition.status === "live" || competition.hasLiveMatch) return "live";
  if (daysPastEnd >= 1) return "completed";
  return "upcoming";
}
