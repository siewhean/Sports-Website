import { CANOE_POLO_DEFAULT_SETTINGS } from "./canoe-polo.js";

/**
 * Phase 2's offset-minute capacity contract. Keep this API stable: generated
 * schedules still use competition-relative integer minutes.
 */
export type AvailabilityInterval = {
  id: string;
  areaId: string;
  startMinute: number;
  endMinute: number;
};

export type CapacitySlot = {
  id: string;
  intervalId: string;
  areaId: string;
  startMinute: number;
  endMinute: number;
};

export type CapacitySummary = {
  slotMinutes: number;
  totalSlots: number;
  intervalSlots: ReadonlyArray<{
    intervalId: string;
    areaId: string;
    usableMinutes: number;
    slots: number;
    unusedMinutes: number;
  }>;
};

function assertInterval(interval: AvailabilityInterval): void {
  if (!interval.id || !interval.areaId) throw new Error("Availability interval requires stable IDs");
  if (!Number.isInteger(interval.startMinute) || !Number.isInteger(interval.endMinute)) {
    throw new Error(`Availability interval ${interval.id} must use integer minutes`);
  }
  if (interval.endMinute <= interval.startMinute) {
    throw new Error(`Availability interval ${interval.id} must have positive duration`);
  }
}

function assertNoOverlaps(intervals: readonly AvailabilityInterval[]): void {
  const byArea = new Map<string, AvailabilityInterval[]>();
  const intervalIds = new Set<string>();
  for (const interval of intervals) {
    assertInterval(interval);
    if (intervalIds.has(interval.id)) throw new Error(`Duplicate availability interval ID: ${interval.id}`);
    intervalIds.add(interval.id);
    const current = byArea.get(interval.areaId) ?? [];
    current.push(interval);
    byArea.set(interval.areaId, current);
  }
  for (const [areaId, areaIntervals] of byArea) {
    areaIntervals.sort((left, right) => left.startMinute - right.startMinute || left.id.localeCompare(right.id));
    for (let index = 1; index < areaIntervals.length; index += 1) {
      const previous = areaIntervals[index - 1];
      const current = areaIntervals[index];
      if (previous && current && current.startMinute < previous.endMinute) {
        throw new Error(`Availability intervals overlap on area ${areaId}: ${previous.id}/${current.id}`);
      }
    }
  }
}

function assertSlotMinutes(slotMinutes: number): void {
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) {
    throw new Error("Slot duration must be a positive integer number of minutes");
  }
}

export function calculateContinuousCapacity(
  intervals: readonly AvailabilityInterval[],
  slotMinutes: number = CANOE_POLO_DEFAULT_SETTINGS.slotMinutes,
): CapacitySummary {
  assertSlotMinutes(slotMinutes);
  assertNoOverlaps(intervals);
  const intervalSlots = [...intervals]
    .sort(
      (left, right) =>
        left.startMinute - right.startMinute ||
        left.areaId.localeCompare(right.areaId) ||
        left.id.localeCompare(right.id),
    )
    .map((interval) => {
      const usableMinutes = interval.endMinute - interval.startMinute;
      const slots = Math.floor(usableMinutes / slotMinutes);
      return {
        intervalId: interval.id,
        areaId: interval.areaId,
        usableMinutes,
        slots,
        unusedMinutes: usableMinutes - slots * slotMinutes,
      };
    });
  return {
    slotMinutes,
    totalSlots: intervalSlots.reduce((total, interval) => total + interval.slots, 0),
    intervalSlots,
  };
}

export function buildCapacitySlots(
  intervals: readonly AvailabilityInterval[],
  slotMinutes: number = CANOE_POLO_DEFAULT_SETTINGS.slotMinutes,
): CapacitySlot[] {
  const capacity = calculateContinuousCapacity(intervals, slotMinutes);
  const byId = new Map(intervals.map((interval) => [interval.id, interval]));
  const slots: CapacitySlot[] = [];
  for (const summary of capacity.intervalSlots) {
    const interval = byId.get(summary.intervalId);
    if (!interval) throw new Error(`Missing interval ${summary.intervalId}`);
    for (let index = 0; index < summary.slots; index += 1) {
      const startMinute = interval.startMinute + index * slotMinutes;
      slots.push({
        id: `${interval.id}-slot-${String(index + 1).padStart(2, "0")}`,
        intervalId: interval.id,
        areaId: interval.areaId,
        startMinute,
        endMinute: startMinute + slotMinutes,
      });
    }
  }
  return slots.sort(
    (left, right) =>
      left.startMinute - right.startMinute ||
      left.areaId.localeCompare(right.areaId) ||
      left.id.localeCompare(right.id),
  );
}

// Phase 3 calendar-aware capacity domain.

export const CANOE_POLO_RECOMMENDED_SLOT_MINUTES = CANOE_POLO_DEFAULT_SETTINGS.slotMinutes;

export type PlayingArea = {
  id: string;
  name: string;
  /** Explicit presentation/scheduling order. Duplicate values are allowed. */
  sortOrder?: number;
  /** Latest local slots on this area are kept empty for operational recovery. */
  fixedReserveSlots?: number;
};

export type DailyCapacityWindow = {
  id: string;
  areaId: string;
  /** ISO civil date in the competition timezone. */
  date: string;
  /** 24-hour local time, minute precision. */
  startTime: string;
  /** 24-hour local time, minute precision. */
  endTime: string;
  /**
   * End is on the following civil date. Required when endTime <= startTime;
   * rejected otherwise so an accidental 24+ hour window cannot be created.
   */
  crossMidnight?: boolean;
};

export type CapacityStatus = "comfortable" | "tight" | "does_not_fit";

export type CapacityStatusThresholds = {
  /** A fitting plan with this many or fewer unallocated slots is tight. */
  tightRemainingSlots: number;
};

export type CalendarCapacityInput = {
  timeZone: string;
  areas: readonly PlayingArea[];
  availability: readonly DailyCapacityWindow[];
  unavailable?: readonly DailyCapacityWindow[];
  slotMinutes?: number;
  fixedReserveSlots?: number;
  requiredMatchSlots?: number;
  statusThresholds?: CapacityStatusThresholds;
};

export type CalendarCapacityIntervalSummary = {
  id: string;
  areaId: string;
  areaName: string;
  startEpochMs: number;
  endEpochMs: number;
  startIso: string;
  endIso: string;
  usableMinutes: number;
  slots: number;
  unusedMinutes: number;
  sourceAvailabilityIds: readonly string[];
};

export type PlayingAreaCapacitySummary = {
  areaId: string;
  areaName: string;
  sortOrder: number;
  usableMinutes: number;
  rawSlots: number;
  intervalCount: number;
};

/** View-ready, deterministic summary; labels and formatting remain UI concerns. */
export type CalendarCapacitySummary = {
  timeZone: string;
  slotMinutes: number;
  rawTotalSlots: number;
  fixedReserveSlots: number;
  availableMatchSlots: number;
  requiredMatchSlots: number;
  remainingMatchSlots: number;
  status: CapacityStatus;
  intervals: readonly CalendarCapacityIntervalSummary[];
  areas: readonly PlayingAreaCapacitySummary[];
};

export type CalendarCapacitySlot = {
  id: string;
  intervalId: string;
  areaId: string;
  startEpochMs: number;
  endEpochMs: number;
  startIso: string;
  endIso: string;
};

export type ResolvedCalendarCapacityWindow = {
  id: string;
  areaId: string;
  startEpochMs: number;
  endEpochMs: number;
  startIso: string;
  endIso: string;
};

export type ResolvedCalendarCapacityWindows = {
  availability: readonly ResolvedCalendarCapacityWindow[];
  unavailable: readonly ResolvedCalendarCapacityWindow[];
};

type ResolvedWindow = {
  id: string;
  areaId: string;
  startEpochMs: number;
  endEpochMs: number;
};

type NormalizedInterval = {
  areaId: string;
  startEpochMs: number;
  endEpochMs: number;
  sourceAvailabilityIds: string[];
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const MINUTE_MS = 60_000;

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function parseDate(value: string, label: string): { year: number; month: number; day: number } {
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

function parseTime(value: string, label: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(value);
  if (!match) throw new Error(`${label} must use HH:mm`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${label} is not a valid local time`);
  return { hour, minute };
}

function nextCivilDate(date: { year: number; month: number; day: number }): typeof date {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function dateTimeParts(epochMs: number, formatter: Intl.DateTimeFormat): readonly number[] {
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
function resolveZonedMinute(
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

function createFormatter(timeZone: string): Intl.DateTimeFormat {
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

function compareAreas(left: PlayingArea, right: PlayingArea): number {
  return (
    (left.sortOrder ?? 0) - (right.sortOrder ?? 0) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function validateAreas(areas: readonly PlayingArea[]): PlayingArea[] {
  const ids = new Set<string>();
  return [...areas]
    .map((area) => {
      if (!area.id.trim() || !area.name.trim()) throw new Error("Playing areas require stable IDs and names");
      const id = area.id.trim();
      if (ids.has(id)) throw new Error(`Duplicate playing area ID: ${id}`);
      ids.add(id);
      if (area.sortOrder !== undefined && !Number.isSafeInteger(area.sortOrder)) {
        throw new Error(`Playing area ${area.id} sortOrder must be a safe integer`);
      }
      if (area.fixedReserveSlots !== undefined) {
        assertNonNegativeInteger(area.fixedReserveSlots, `Playing area ${area.id} fixed reserve slots`);
      }
      return { ...area, id, name: area.name.trim() };
    })
    .sort(compareAreas);
}

function resolveWindows(
  windows: readonly DailyCapacityWindow[],
  kind: "availability" | "unavailable",
  areaIds: ReadonlySet<string>,
  timeZone: string,
  formatter: Intl.DateTimeFormat,
): ResolvedWindow[] {
  const ids = new Set<string>();
  return windows.map((window) => {
    if (!window.id.trim()) throw new Error(`${kind} windows require stable IDs`);
    if (ids.has(window.id)) throw new Error(`Duplicate ${kind} window ID: ${window.id}`);
    ids.add(window.id);
    if (!areaIds.has(window.areaId))
      throw new Error(`${kind} window ${window.id} references unknown area ${window.areaId}`);
    const startDate = parseDate(window.date, `${kind} window ${window.id} date`);
    const startTime = parseTime(window.startTime, `${kind} window ${window.id} startTime`);
    const endTime = parseTime(window.endTime, `${kind} window ${window.id} endTime`);
    const startClockMinute = startTime.hour * 60 + startTime.minute;
    const endClockMinute = endTime.hour * 60 + endTime.minute;
    const crosses = window.crossMidnight === true;
    if (endClockMinute <= startClockMinute && !crosses) {
      throw new Error(`${kind} window ${window.id} must opt in to crossing midnight`);
    }
    if (endClockMinute > startClockMinute && crosses) {
      throw new Error(`${kind} window ${window.id} has an unnecessary crossMidnight flag`);
    }
    const endDate = crosses ? nextCivilDate(startDate) : startDate;
    const startEpochMs = resolveZonedMinute(startDate, startTime, timeZone, formatter);
    const endEpochMs = resolveZonedMinute(endDate, endTime, timeZone, formatter);
    if (endEpochMs <= startEpochMs) throw new Error(`${kind} window ${window.id} must have positive elapsed duration`);
    if ((endEpochMs - startEpochMs) % MINUTE_MS !== 0) {
      throw new Error(`${kind} window ${window.id} does not resolve to whole minutes`);
    }
    return { id: window.id, areaId: window.areaId, startEpochMs, endEpochMs };
  });
}

function normalizeWindows(windows: readonly ResolvedWindow[]): NormalizedInterval[] {
  const sorted = [...windows].sort(
    (left, right) =>
      left.areaId.localeCompare(right.areaId) ||
      left.startEpochMs - right.startEpochMs ||
      left.endEpochMs - right.endEpochMs ||
      left.id.localeCompare(right.id),
  );
  const result: NormalizedInterval[] = [];
  for (const window of sorted) {
    const previous = result.at(-1);
    if (previous && previous.areaId === window.areaId && window.startEpochMs <= previous.endEpochMs) {
      previous.endEpochMs = Math.max(previous.endEpochMs, window.endEpochMs);
      previous.sourceAvailabilityIds = [...new Set([...previous.sourceAvailabilityIds, window.id])].sort();
    } else {
      result.push({
        areaId: window.areaId,
        startEpochMs: window.startEpochMs,
        endEpochMs: window.endEpochMs,
        sourceAvailabilityIds: [window.id],
      });
    }
  }
  return result;
}

function subtractUnavailable(
  availability: readonly NormalizedInterval[],
  unavailable: readonly NormalizedInterval[],
): NormalizedInterval[] {
  const closedByArea = new Map<string, NormalizedInterval[]>();
  for (const interval of unavailable) {
    const current = closedByArea.get(interval.areaId) ?? [];
    current.push(interval);
    closedByArea.set(interval.areaId, current);
  }
  const result: NormalizedInterval[] = [];
  for (const open of availability) {
    let cursor = open.startEpochMs;
    for (const closed of closedByArea.get(open.areaId) ?? []) {
      if (closed.endEpochMs <= cursor) continue;
      if (closed.startEpochMs >= open.endEpochMs) break;
      if (closed.startEpochMs > cursor) {
        result.push({ ...open, startEpochMs: cursor, endEpochMs: Math.min(closed.startEpochMs, open.endEpochMs) });
      }
      cursor = Math.max(cursor, closed.endEpochMs);
      if (cursor >= open.endEpochMs) break;
    }
    if (cursor < open.endEpochMs) result.push({ ...open, startEpochMs: cursor });
  }
  return result;
}

function buildCalendarModel(input: CalendarCapacityInput): {
  areas: PlayingArea[];
  slotMinutes: number;
  legacyReserveSlots: number;
  requiredSlots: number;
  tightRemainingSlots: number;
  intervals: CalendarCapacityIntervalSummary[];
} {
  const formatter = createFormatter(input.timeZone);
  const areas = validateAreas(input.areas);
  const areaIds = new Set(areas.map((area) => area.id));
  const slotMinutes = input.slotMinutes ?? CANOE_POLO_RECOMMENDED_SLOT_MINUTES;
  assertSlotMinutes(slotMinutes);
  const legacyReserveSlots = input.fixedReserveSlots ?? 0;
  const requiredSlots = input.requiredMatchSlots ?? 0;
  const tightRemainingSlots = input.statusThresholds?.tightRemainingSlots ?? 0;
  assertNonNegativeInteger(legacyReserveSlots, "Fixed reserve slots");
  assertNonNegativeInteger(requiredSlots, "Required match slots");
  assertNonNegativeInteger(tightRemainingSlots, "Tight remaining-slot threshold");
  const open = normalizeWindows(resolveWindows(input.availability, "availability", areaIds, input.timeZone, formatter));
  const closed = normalizeWindows(
    resolveWindows(input.unavailable ?? [], "unavailable", areaIds, input.timeZone, formatter),
  );
  const usable = subtractUnavailable(open, closed);
  const areaById = new Map(areas.map((area) => [area.id, area]));
  const areaRank = new Map(areas.map((area, index) => [area.id, index]));
  const intervals = usable
    .sort(
      (left, right) =>
        left.startEpochMs - right.startEpochMs ||
        (areaRank.get(left.areaId) ?? 0) - (areaRank.get(right.areaId) ?? 0) ||
        left.endEpochMs - right.endEpochMs ||
        left.sourceAvailabilityIds.join("\0").localeCompare(right.sourceAvailabilityIds.join("\0")),
    )
    .map((interval, index) => {
      const usableMinutes = (interval.endEpochMs - interval.startEpochMs) / MINUTE_MS;
      const slots = Math.floor(usableMinutes / slotMinutes);
      return {
        id: `capacity-interval-${String(index + 1).padStart(4, "0")}`,
        areaId: interval.areaId,
        areaName: areaById.get(interval.areaId)!.name,
        startEpochMs: interval.startEpochMs,
        endEpochMs: interval.endEpochMs,
        startIso: new Date(interval.startEpochMs).toISOString(),
        endIso: new Date(interval.endEpochMs).toISOString(),
        usableMinutes,
        slots,
        unusedMinutes: usableMinutes - slots * slotMinutes,
        sourceAvailabilityIds: interval.sourceAvailabilityIds,
      } satisfies CalendarCapacityIntervalSummary;
    });
  return { areas, slotMinutes, legacyReserveSlots, requiredSlots, tightRemainingSlots, intervals };
}

export function calculateCalendarCapacity(input: CalendarCapacityInput): CalendarCapacitySummary {
  const model = buildCalendarModel(input);
  const rawTotalSlots = model.intervals.reduce((total, interval) => total + interval.slots, 0);
  const hasAreaReserves = model.areas.some((area) => area.fixedReserveSlots !== undefined);
  const configuredAreaReserves = model.areas.reduce((total, area) => total + (area.fixedReserveSlots ?? 0), 0);
  const fixedReserveSlots = hasAreaReserves ? configuredAreaReserves : model.legacyReserveSlots;
  const availableMatchSlots = hasAreaReserves
    ? model.areas.reduce((total, area) => {
        const rawSlots = model.intervals
          .filter((interval) => interval.areaId === area.id)
          .reduce((areaTotal, interval) => areaTotal + interval.slots, 0);
        return total + Math.max(0, rawSlots - (area.fixedReserveSlots ?? 0));
      }, 0)
    : Math.max(0, rawTotalSlots - model.legacyReserveSlots);
  const remainingMatchSlots = availableMatchSlots - model.requiredSlots;
  const status: CapacityStatus =
    remainingMatchSlots < 0
      ? "does_not_fit"
      : remainingMatchSlots <= model.tightRemainingSlots
        ? "tight"
        : "comfortable";
  const areas = model.areas.map((area) => {
    const intervals = model.intervals.filter((interval) => interval.areaId === area.id);
    return {
      areaId: area.id,
      areaName: area.name,
      sortOrder: area.sortOrder ?? 0,
      usableMinutes: intervals.reduce((total, interval) => total + interval.usableMinutes, 0),
      rawSlots: intervals.reduce((total, interval) => total + interval.slots, 0),
      intervalCount: intervals.length,
    };
  });
  return {
    timeZone: input.timeZone,
    slotMinutes: model.slotMinutes,
    rawTotalSlots,
    fixedReserveSlots,
    availableMatchSlots,
    requiredMatchSlots: model.requiredSlots,
    remainingMatchSlots,
    status,
    intervals: model.intervals,
    areas,
  };
}

/**
 * Resolve the submitted civil windows with the same DST policy used by the
 * capacity calculation. Persistence must store these instants rather than ask
 * PostgreSQL to resolve an ambiguous local clock value independently.
 */
export function resolveCalendarCapacityWindows(input: CalendarCapacityInput): ResolvedCalendarCapacityWindows {
  const formatter = createFormatter(input.timeZone);
  const areas = validateAreas(input.areas);
  const areaIds = new Set(areas.map((area) => area.id));
  const present = (window: ResolvedWindow): ResolvedCalendarCapacityWindow => ({
    ...window,
    startIso: new Date(window.startEpochMs).toISOString(),
    endIso: new Date(window.endEpochMs).toISOString(),
  });
  return {
    availability: resolveWindows(input.availability, "availability", areaIds, input.timeZone, formatter).map(present),
    unavailable: resolveWindows(input.unavailable ?? [], "unavailable", areaIds, input.timeZone, formatter).map(
      present,
    ),
  };
}

export function buildCalendarCapacitySlots(input: CalendarCapacityInput): CalendarCapacitySlot[] {
  const model = buildCalendarModel(input);
  const slots: CalendarCapacitySlot[] = [];
  for (const interval of model.intervals) {
    for (let index = 0; index < interval.slots; index += 1) {
      const startEpochMs = interval.startEpochMs + index * model.slotMinutes * MINUTE_MS;
      const endEpochMs = startEpochMs + model.slotMinutes * MINUTE_MS;
      slots.push({
        id: `${interval.id}-slot-${String(index + 1).padStart(3, "0")}`,
        intervalId: interval.id,
        areaId: interval.areaId,
        startEpochMs,
        endEpochMs,
        startIso: new Date(startEpochMs).toISOString(),
        endIso: new Date(endEpochMs).toISOString(),
      });
    }
  }
  // Area reserves are deliberately the latest local slots on each area. This
  // prevents an over-reserved small area from consuming capacity on another.
  if (model.areas.some((area) => area.fixedReserveSlots !== undefined)) {
    const reserved = new Set<string>();
    for (const area of model.areas) {
      const localSlots = slots.filter((slot) => slot.areaId === area.id);
      for (const slot of localSlots.slice(Math.max(0, localSlots.length - (area.fixedReserveSlots ?? 0)))) {
        reserved.add(slot.id);
      }
    }
    return slots.filter((slot) => !reserved.has(slot.id));
  }
  // Retain the original aggregate input for callers not yet carrying area
  // metadata; deterministic ordering still reserves the latest slots.
  return slots.slice(0, Math.max(0, slots.length - model.legacyReserveSlots));
}
