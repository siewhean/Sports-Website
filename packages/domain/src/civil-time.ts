export type CivilMinute = {
  /** ISO civil date: YYYY-MM-DD */
  date: string;
  /** 24-hour local civil time: HH:mm */
  time: string;
};

export const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
export const MINUTE_MS = 60_000;

export function parseDate(value: string, label: string = "Date"): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid civil date`);
  }
  return { year, month, day };
}

export function parseTime(value: string, label: string = "Time"): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(value);
  if (!match) throw new Error(`${label} must use HH:mm`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${label} is not a valid local time`);
  return { hour, minute };
}

export function nextCivilDate(date: { year: number; month: number; day: number }): {
  year: number;
  month: number;
  day: number;
} {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function createFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
}

export function dateTimeParts(epochMs: number, formatter: Intl.DateTimeFormat): readonly number[] {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return [parts.year!, parts.month!, parts.day!, parts.hour!, parts.minute!];
}

/**
 * Resolve a minute-precision civil time without depending on the host timezone.
 * Offset candidates are sampled around the target date. For a repeated local
 * minute at the autumn DST fold, the earlier instant is the documented policy.
 * A skipped spring-forward minute has no candidate and is rejected.
 */
export function resolveZonedMinute(
  date: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timeZone: string,
  formatter: Intl.DateTimeFormat,
): number {
  const nominalUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const offsets = new Set<number>();
  for (let sampleHours = -36; sampleHours <= 36; sampleHours += 6) {
    const sample = nominalUtc + sampleHours * 60 * MINUTE_MS;
    const [year, month, day, hour, minute] = dateTimeParts(sample, formatter);
    if ([year, month, day, hour, minute].some((part) => part === undefined || Number.isNaN(part))) continue;
    const renderedAsUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!);
    offsets.add(renderedAsUtc - sample);
  }
  const expected = [date.year, date.month, date.day, time.hour, time.minute];
  const candidates = [...offsets]
    .map((offset) => nominalUtc - offset)
    .filter((candidate) => dateTimeParts(candidate, formatter).every((part, index) => part === expected[index]))
    .sort((left, right) => left - right);
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error(
      `Local time ${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")} ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")} does not exist in ${timeZone}`,
    );
  }
  return selected;
}

/**
 * Resolves a civil date/time to epoch milliseconds in the specified IANA timeZone.
 *
 * DST Policy:
 * - Repeated minute (autumn fold): Returns the earlier instant.
 * - Nonexistent minute (spring gap): Throws an Error.
 */
export function resolveCivilMinute(value: CivilMinute, timeZone: string): number {
  const formatter = createFormatter(timeZone);
  const date = parseDate(value.date, "Civil date");
  const time = parseTime(value.time, "Civil time");
  return resolveZonedMinute(date, time, timeZone, formatter);
}

/**
 * Converts an epoch millisecond timestamp to a CivilMinute in the specified IANA timeZone.
 */
export function civilMinuteAtEpoch(epochMs: number, timeZone: string): CivilMinute {
  if (!Number.isFinite(epochMs)) {
    throw new Error("epochMs must be a finite number");
  }
  const formatter = createFormatter(timeZone);
  const [year, month, day, hour, minute] = dateTimeParts(epochMs, formatter);
  if ([year, month, day, hour, minute].some((part) => part === undefined || Number.isNaN(part))) {
    throw new Error(`Failed to resolve civil minute at epoch ${epochMs} in ${timeZone}`);
  }
  return {
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}
