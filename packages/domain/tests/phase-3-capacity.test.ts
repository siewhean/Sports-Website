import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCapacitySlots,
  buildCalendarCapacitySlots,
  calculateContinuousCapacity,
  calculateCalendarCapacity,
  CANOE_POLO_RECOMMENDED_SLOT_MINUTES,
  type CalendarCapacityInput,
  type DailyCapacityWindow,
  type PlayingArea,
} from "../src/capacity.js";

type SizeContext = {
  id: string;
  entry_count: 8 | 12 | 16 | 24 | 48;
  time_zone: string;
  dates: string[];
  area_count: number;
  open: string;
  close: string;
  breaks: Array<{ start: string; end: string }>;
  slot_minutes: number;
  expected_raw_slots: number;
};

type BoundaryCase = {
  id: string;
  time_zone: string;
  date: string;
  start: string;
  end: string;
  cross_midnight?: boolean;
  slot_minutes: number;
  expected_usable_minutes: number;
  expected_slots: number;
};

const sizeContexts = (
  JSON.parse(
    readFileSync(new URL("../../../validation/phase-3/capacity/required-size-contexts.json", import.meta.url), "utf8"),
  ) as { contexts: SizeContext[] }
).contexts;

const boundaryCases = (
  JSON.parse(
    readFileSync(new URL("../../../validation/phase-3/capacity/timezone-boundaries.json", import.meta.url), "utf8"),
  ) as { cases: BoundaryCase[] }
).cases;

function areas(count: number): PlayingArea[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `area-${String(index + 1).padStart(2, "0")}`,
    name: `Field ${index + 1}`,
    sortOrder: index + 1,
  }));
}

function materializeContext(context: SizeContext): CalendarCapacityInput {
  const playingAreas = areas(context.area_count);
  return {
    timeZone: context.time_zone,
    areas: playingAreas,
    availability: context.dates.flatMap((date) =>
      playingAreas.map((area) => ({
        id: `${date}-${area.id}-open`,
        areaId: area.id,
        date,
        startTime: context.open,
        endTime: context.close,
      })),
    ),
    unavailable: context.dates.flatMap((date) =>
      playingAreas.flatMap((area) =>
        context.breaks.map((period, index) => ({
          id: `${date}-${area.id}-break-${index + 1}`,
          areaId: area.id,
          date,
          startTime: period.start,
          endTime: period.end,
        })),
      ),
    ),
    slotMinutes: context.slot_minutes,
  };
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function independentMinuteOracle(
  areaIds: readonly string[],
  availability: readonly DailyCapacityWindow[],
  unavailable: readonly DailyCapacityWindow[],
  slotMinutes: number,
): number {
  let total = 0;
  for (const areaId of areaIds) {
    const usable = new Set<number>();
    for (const window of availability.filter((candidate) => candidate.areaId === areaId)) {
      const start = Number(window.startTime.slice(0, 2)) * 60 + Number(window.startTime.slice(3));
      const end = Number(window.endTime.slice(0, 2)) * 60 + Number(window.endTime.slice(3));
      for (let minute = start; minute < end; minute += 1) usable.add(minute);
    }
    for (const window of unavailable.filter((candidate) => candidate.areaId === areaId)) {
      const start = Number(window.startTime.slice(0, 2)) * 60 + Number(window.startTime.slice(3));
      const end = Number(window.endTime.slice(0, 2)) * 60 + Number(window.endTime.slice(3));
      for (let minute = start; minute < end; minute += 1) usable.delete(minute);
    }
    const sorted = [...usable].sort((left, right) => left - right);
    let run = 0;
    let previous: number | undefined;
    for (const minute of sorted) {
      if (previous === undefined || minute === previous + 1) run += 1;
      else {
        total += Math.floor(run / slotMinutes);
        run = 1;
      }
      previous = minute;
    }
    total += Math.floor(run / slotMinutes);
  }
  return total;
}

describe("Phase 3 capacity domain (CAP-001-CAP-009)", () => {
  it.each(sizeContexts)("matches the independent $entry_count-entry capacity oracle", (context) => {
    const input = materializeContext(context);
    const summary = calculateCalendarCapacity(input);
    expect(summary.rawTotalSlots).toBe(context.expected_raw_slots);
    expect(summary.availableMatchSlots).toBe(context.expected_raw_slots);
    expect(summary.areas).toHaveLength(context.area_count);
    expect(summary.intervals).toHaveLength(context.area_count * context.dates.length * 2);
    expect(buildCalendarCapacitySlots(input)).toHaveLength(context.expected_raw_slots);
  });

  it("defaults Canoe Polo to one 30-minute slot duration per match", () => {
    expect(CANOE_POLO_RECOMMENDED_SLOT_MINUTES).toBe(30);
    const summary = calculateCalendarCapacity({
      timeZone: "Asia/Singapore",
      areas: areas(1),
      availability: [{ id: "open", areaId: "area-01", date: "2026-08-01", startTime: "09:00", endTime: "10:31" }],
    });
    expect(summary.slotMinutes).toBe(30);
    expect(summary.rawTotalSlots).toBe(3);
    expect(summary.intervals[0]).toMatchObject({ usableMinutes: 91, slots: 3, unusedMinutes: 1 });
  });

  it("unions adjacent and overlapping openings and closures without double-counting", () => {
    const input: CalendarCapacityInput = {
      timeZone: "Asia/Singapore",
      areas: areas(2),
      slotMinutes: 30,
      availability: [
        { id: "a-late", areaId: "area-01", date: "2026-08-01", startTime: "10:00", endTime: "12:00" },
        { id: "a-early", areaId: "area-01", date: "2026-08-01", startTime: "09:00", endTime: "11:00" },
        { id: "a-adjacent", areaId: "area-01", date: "2026-08-01", startTime: "12:00", endTime: "13:00" },
        { id: "b-partial", areaId: "area-02", date: "2026-08-01", startTime: "09:00", endTime: "10:20" },
      ],
      unavailable: [
        { id: "closure-1", areaId: "area-01", date: "2026-08-01", startTime: "10:00", endTime: "10:45" },
        { id: "closure-2", areaId: "area-01", date: "2026-08-01", startTime: "10:30", endTime: "11:00" },
      ],
    };
    const summary = calculateCalendarCapacity(input);
    expect(summary.rawTotalSlots).toBe(8);
    expect(
      summary.intervals.map(({ areaId, usableMinutes, slots, unusedMinutes }) => ({
        areaId,
        usableMinutes,
        slots,
        unusedMinutes,
      })),
    ).toEqual([
      { areaId: "area-01", usableMinutes: 60, slots: 2, unusedMinutes: 0 },
      { areaId: "area-02", usableMinutes: 80, slots: 2, unusedMinutes: 20 },
      { areaId: "area-01", usableMinutes: 120, slots: 4, unusedMinutes: 0 },
    ]);
  });

  it("never carries partial-slot remnants across a break", () => {
    const summary = calculateCalendarCapacity({
      timeZone: "UTC",
      areas: areas(1),
      slotMinutes: 30,
      availability: [{ id: "open", areaId: "area-01", date: "2026-08-01", startTime: "09:00", endTime: "12:00" }],
      unavailable: [{ id: "break", areaId: "area-01", date: "2026-08-01", startTime: "10:20", endTime: "10:40" }],
    });
    expect(summary.intervals.map((interval) => [interval.slots, interval.unusedMinutes])).toEqual([
      [2, 20],
      [2, 20],
    ]);
    expect(summary.rawTotalSlots).toBe(4);
  });

  it("applies fixed reserves before configurable capacity status", () => {
    const base: CalendarCapacityInput = {
      timeZone: "UTC",
      areas: areas(1),
      availability: [{ id: "open", areaId: "area-01", date: "2026-08-01", startTime: "09:00", endTime: "11:00" }],
      fixedReserveSlots: 1,
      requiredMatchSlots: 2,
      statusThresholds: { tightRemainingSlots: 1 },
    };
    expect(calculateCalendarCapacity(base)).toMatchObject({
      rawTotalSlots: 4,
      fixedReserveSlots: 1,
      availableMatchSlots: 3,
      remainingMatchSlots: 1,
      status: "tight",
    });
    expect(buildCalendarCapacitySlots(base)).toHaveLength(3);
    expect(calculateCalendarCapacity({ ...base, requiredMatchSlots: 1 }).status).toBe("comfortable");
    expect(calculateCalendarCapacity({ ...base, requiredMatchSlots: 4 }).status).toBe("does_not_fit");
    expect(calculateCalendarCapacity({ ...base, fixedReserveSlots: 99 })).toMatchObject({
      availableMatchSlots: 0,
      remainingMatchSlots: -2,
      status: "does_not_fit",
    });
  });

  it("reserves the latest slots independently on each playing area", () => {
    const input: CalendarCapacityInput = {
      timeZone: "UTC",
      areas: [
        { id: "small", name: "Small", sortOrder: 1, fixedReserveSlots: 5 },
        { id: "large", name: "Large", sortOrder: 2, fixedReserveSlots: 1 },
      ],
      availability: [
        { id: "small-open", areaId: "small", date: "2026-08-01", startTime: "09:00", endTime: "10:00" },
        { id: "large-open", areaId: "large", date: "2026-08-01", startTime: "09:00", endTime: "12:00" },
      ],
      slotMinutes: 30,
      requiredMatchSlots: 4,
    };
    const summary = calculateCalendarCapacity(input);
    expect(summary).toMatchObject({
      rawTotalSlots: 8,
      fixedReserveSlots: 6,
      availableMatchSlots: 5,
      requiredMatchSlots: 4,
      remainingMatchSlots: 1,
      status: "comfortable",
    });
    const slots = buildCalendarCapacitySlots(input);
    expect(slots).toHaveLength(5);
    expect(slots.every((slot) => slot.areaId === "large")).toBe(true);
    expect(slots.map((slot) => slot.startIso)).toEqual([
      "2026-08-01T09:00:00.000Z",
      "2026-08-01T09:30:00.000Z",
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:30:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ]);
  });

  it.each(boundaryCases)("matches elapsed-time oracle at $id", (fixture) => {
    const summary = calculateCalendarCapacity({
      timeZone: fixture.time_zone,
      areas: areas(1),
      availability: [
        {
          id: fixture.id,
          areaId: "area-01",
          date: fixture.date,
          startTime: fixture.start,
          endTime: fixture.end,
          ...(fixture.cross_midnight === undefined ? {} : { crossMidnight: fixture.cross_midnight }),
        },
      ],
      slotMinutes: fixture.slot_minutes,
    });
    expect(summary.intervals[0]?.usableMinutes).toBe(fixture.expected_usable_minutes);
    expect(summary.rawTotalSlots).toBe(fixture.expected_slots);
  });

  it("uses the earlier instant for a repeated local minute and rejects a skipped minute", () => {
    const repeated = calculateCalendarCapacity({
      timeZone: "America/New_York",
      areas: areas(1),
      availability: [{ id: "fold", areaId: "area-01", date: "2026-11-01", startTime: "01:15", endTime: "01:45" }],
    });
    expect(repeated.intervals[0]).toMatchObject({
      startIso: "2026-11-01T05:15:00.000Z",
      endIso: "2026-11-01T05:45:00.000Z",
      usableMinutes: 30,
    });
    expect(() =>
      calculateCalendarCapacity({
        timeZone: "America/New_York",
        areas: areas(1),
        availability: [{ id: "gap", areaId: "area-01", date: "2026-03-08", startTime: "02:15", endTime: "03:15" }],
      }),
    ).toThrow(/does not exist/);
  });

  it("requires an explicit cross-midnight policy", () => {
    const base = {
      timeZone: "Asia/Singapore",
      areas: areas(1),
    };
    expect(() =>
      calculateCalendarCapacity({
        ...base,
        availability: [{ id: "implicit", areaId: "area-01", date: "2026-08-01", startTime: "23:00", endTime: "01:00" }],
      }),
    ).toThrow(/opt in to crossing midnight/);
    expect(() =>
      calculateCalendarCapacity({
        ...base,
        availability: [
          {
            id: "accidental-long",
            areaId: "area-01",
            date: "2026-08-01",
            startTime: "09:00",
            endTime: "17:00",
            crossMidnight: true,
          },
        ],
      }),
    ).toThrow(/unnecessary crossMidnight/);
  });

  it.each([
    ["invalid timezone", { timeZone: "Mars/Olympus" }, /Invalid IANA time zone/],
    [
      "duplicate area",
      {
        areas: [
          { id: "area-01", name: "A" },
          { id: "area-01", name: "B" },
        ],
      },
      /Duplicate playing area/,
    ],
    [
      "duplicate area after canonical trimming",
      {
        areas: [
          { id: "area-01", name: "A" },
          { id: " area-01 ", name: "B" },
        ],
      },
      /Duplicate playing area ID: area-01/,
    ],
    [
      "unknown area",
      { availability: [{ id: "open", areaId: "missing", date: "2026-08-01", startTime: "09:00", endTime: "10:00" }] },
      /unknown area/,
    ],
    [
      "invalid date",
      { availability: [{ id: "open", areaId: "area-01", date: "2026-02-30", startTime: "09:00", endTime: "10:00" }] },
      /valid civil date/,
    ],
    [
      "invalid time",
      { availability: [{ id: "open", areaId: "area-01", date: "2026-08-01", startTime: "24:00", endTime: "10:00" }] },
      /valid local time/,
    ],
    [
      "duplicate window",
      {
        availability: [
          { id: "same", areaId: "area-01", date: "2026-08-01", startTime: "09:00", endTime: "10:00" },
          { id: "same", areaId: "area-01", date: "2026-08-01", startTime: "10:00", endTime: "11:00" },
        ],
      },
      /Duplicate availability/,
    ],
    ["zero slot", { slotMinutes: 0 }, /positive integer/],
    ["fractional reserve", { fixedReserveSlots: 1.5 }, /non-negative safe integer/],
    ["negative demand", { requiredMatchSlots: -1 }, /non-negative safe integer/],
  ] as const)("rejects %s", (_label, override, error) => {
    const input: CalendarCapacityInput = {
      timeZone: "UTC",
      areas: areas(1),
      availability: [{ id: "open", areaId: "area-01", date: "2026-08-01", startTime: "09:00", endTime: "10:00" }],
      ...override,
    };
    expect(() => calculateCalendarCapacity(input)).toThrow(error);
  });

  it("rejects duplicate legacy interval IDs before calculation or slot-map construction", () => {
    const duplicatedIds = [
      { id: "same", areaId: "area-a", startMinute: 0, endMinute: 60 },
      { id: "same", areaId: "area-b", startMinute: 60, endMinute: 120 },
    ];
    expect(() => calculateContinuousCapacity(duplicatedIds, 30)).toThrow(/Duplicate availability interval ID: same/);
    expect(() => buildCapacitySlots(duplicatedIds, 30)).toThrow(/Duplicate availability interval ID: same/);
  });

  it("sorts areas, intervals, source IDs, and generated slots stably", () => {
    const input: CalendarCapacityInput = {
      timeZone: "UTC",
      areas: [
        { id: "z", name: "Beta", sortOrder: 2 },
        { id: "a", name: "Alpha", sortOrder: 2 },
        { id: "m", name: "Main", sortOrder: 1 },
      ],
      availability: [
        { id: "z2", areaId: "z", date: "2026-08-02", startTime: "09:00", endTime: "10:00" },
        { id: "z1", areaId: "z", date: "2026-08-01", startTime: "09:30", endTime: "10:30" },
        { id: "z0", areaId: "z", date: "2026-08-01", startTime: "09:00", endTime: "10:00" },
        { id: "a1", areaId: "a", date: "2026-08-01", startTime: "09:00", endTime: "10:00" },
        { id: "m1", areaId: "m", date: "2026-08-01", startTime: "09:00", endTime: "10:00" },
      ],
    };
    const expected = calculateCalendarCapacity(input);
    const permuted = calculateCalendarCapacity({
      ...input,
      areas: [...input.areas].reverse(),
      availability: [...input.availability].reverse(),
    });
    expect(permuted).toEqual(expected);
    expect(expected.areas.map((area) => area.areaId)).toEqual(["m", "a", "z"]);
    expect(expected.intervals.map((interval) => interval.areaId)).toEqual(["m", "a", "z", "z"]);
    expect(expected.intervals[2]?.sourceAvailabilityIds).toEqual(["z0", "z1"]);
    expect(buildCalendarCapacitySlots(input)).toEqual(
      buildCalendarCapacitySlots({
        ...input,
        areas: [...input.areas].reverse(),
        availability: [...input.availability].reverse(),
      }),
    );
  });

  it.each(sizeContexts)(
    "property invariants hold for $entry_count-entry context across generated overlaps",
    (context) => {
      const areaCount = Math.min(context.area_count, 4);
      const playingAreas = areas(areaCount);
      for (let seed = 1; seed <= 24; seed += 1) {
        const availability: DailyCapacityWindow[] = [];
        const unavailable: DailyCapacityWindow[] = [];
        for (let areaIndex = 0; areaIndex < areaCount; areaIndex += 1) {
          const areaId = playingAreas[areaIndex]!.id;
          const shift = (seed * 7 + areaIndex * 11) % 31;
          availability.push(
            {
              id: `${seed}-${areaId}-a`,
              areaId,
              date: "2026-08-01",
              startTime: clock(480 + shift),
              endTime: clock(660 + shift),
            },
            {
              id: `${seed}-${areaId}-b`,
              areaId,
              date: "2026-08-01",
              startTime: clock(600 + shift),
              endTime: clock(780 + shift),
            },
            {
              id: `${seed}-${areaId}-c`,
              areaId,
              date: "2026-08-01",
              startTime: clock(780 + shift),
              endTime: clock(840 + shift),
            },
          );
          const closeStart = 620 + ((seed * 13 + areaIndex * 17) % 41);
          unavailable.push(
            {
              id: `${seed}-${areaId}-x`,
              areaId,
              date: "2026-08-01",
              startTime: clock(closeStart),
              endTime: clock(closeStart + 37),
            },
            {
              id: `${seed}-${areaId}-y`,
              areaId,
              date: "2026-08-01",
              startTime: clock(closeStart + 19),
              endTime: clock(closeStart + 53),
            },
          );
        }
        const input: CalendarCapacityInput = {
          timeZone: "Asia/Singapore",
          areas: playingAreas,
          availability: shuffled(availability, seed),
          unavailable: shuffled(unavailable, seed ^ 0x9e37),
          slotMinutes: context.slot_minutes,
        };
        const summary = calculateCalendarCapacity(input);
        const slots = buildCalendarCapacitySlots(input);
        expect(summary.rawTotalSlots).toBe(
          independentMinuteOracle(
            playingAreas.map((area) => area.id),
            availability,
            unavailable,
            context.slot_minutes,
          ),
        );
        expect(slots).toHaveLength(summary.rawTotalSlots);
        expect(new Set(slots.map((slot) => slot.id)).size).toBe(slots.length);
        for (let leftIndex = 0; leftIndex < slots.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < slots.length; rightIndex += 1) {
            const left = slots[leftIndex]!;
            const right = slots[rightIndex]!;
            if (left.areaId !== right.areaId) continue;
            expect(left.endEpochMs <= right.startEpochMs || right.endEpochMs <= left.startEpochMs).toBe(true);
          }
        }
        expect(
          calculateCalendarCapacity({
            ...input,
            areas: shuffled(input.areas, seed + 101),
            availability: shuffled(input.availability, seed + 211),
            unavailable: shuffled(input.unavailable ?? [], seed + 307),
          }),
        ).toEqual(summary);
      }
    },
  );
});
