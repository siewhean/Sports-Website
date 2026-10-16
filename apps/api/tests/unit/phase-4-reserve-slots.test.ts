import {
  buildCalendarCapacitySlotSet,
  calculateCalendarCapacity,
  generateScheduleCandidates,
  resolveCalendarCapacityWindows,
  validateSchedule,
  type CalendarCapacityInput,
  type DailyCapacityWindow,
  type ScheduleProblem,
  type SchedulingConstraints,
} from "@matchday/domain";
import { describe, expect, it } from "vitest";

import { capacityMatchSlots, type CapacityWindowRow } from "../../src/phase-4-capacity-slots.js";

// Phase 0 checkpoint: the solver never assigns a match to a reserve slot, and the slots the API
// offers it are exactly the capacity count. The oracle below re-derives "each area's latest
// `fixed_reserve_slots` slots" from the raw grid instead of trusting the reserve selection.

function seeded(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
function constraints(): SchedulingConstraints {
  return {
    minimumRest: ignored({ minutes: 0 }),
    maximumMatchesPerDay: ignored({ matches: 99 }),
    preferredFinalTime: ignored({ targetStartEpochMs: 0, toleranceMinutes: 0 }),
    entryUnavailable: ignored({ byEntryId: {} }),
    officialAvailability: ignored({ byOfficialId: {} }),
    featuredPlayingArea: ignored({ areaId: "court-a", matchIds: [] }),
    avoidConsecutiveMatches: ignored({ minutes: 0 }),
    balanceEarlyMatches: ignored({ beforeLocalTime: "10:00" }),
    balanceLateMatches: ignored({ atOrAfterLocalTime: "17:00" }),
    keepDivisionTogether: ignored({ maximumAreaCount: 99 }),
    preserveExistingSchedule: ignored({ maximumShiftMinutes: 0, byMatchId: {} }),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

type Case = { input: CalendarCapacityInput; reserves: Map<string, number> };

function randomCase(random: (limit: number) => number, sample: number): Case {
  const timeZone = ["Asia/Singapore", "Europe/London", "America/New_York"][sample % 3]!;
  // Europe/London and America/New_York cases straddle their autumn DST change.
  const firstDay = timeZone === "Asia/Singapore" ? 1 : timeZone === "Europe/London" ? 29 : 6;
  const month = timeZone === "America/New_York" ? "11" : "10";
  const dates = Array.from({ length: 1 + random(3) }, (_, index) => `2027-${month}-${pad(firstDay + index)}`);
  const slotMinutes = [15, 30, 45, 60][random(4)]!;
  const areaIds = ["court-a", "court-b", "court-c"].slice(0, 1 + random(3));
  const reserves = new Map(areaIds.map((id) => [id, random(10)]));
  const availability: DailyCapacityWindow[] = [];
  const unavailable: DailyCapacityWindow[] = [];
  for (const areaId of areaIds) {
    for (const date of dates) {
      const morningStart = 7 * 60 + random(4) * 30;
      availability.push({
        id: `${areaId}-${date}-am`,
        areaId,
        date,
        startTime: clock(morningStart),
        endTime: clock(morningStart + 120 + random(4) * 60),
      });
      if (random(2) === 0) {
        const afternoonStart = 13 * 60 + random(3) * 30;
        availability.push({
          id: `${areaId}-${date}-pm`,
          areaId,
          date,
          startTime: clock(afternoonStart),
          endTime: clock(afternoonStart + 60 + random(5) * 45),
        });
      }
      if (random(3) === 0) {
        // Deliberately off the slot grid, so slots after it restart at the closure's end.
        const closedStart = morningStart + 20 + random(4) * 10;
        unavailable.push({
          id: `${areaId}-${date}-closed`,
          areaId,
          date,
          startTime: clock(closedStart),
          endTime: clock(closedStart + 10 + random(3) * 15),
        });
      }
    }
  }
  return {
    input: {
      timeZone,
      slotMinutes,
      areas: areaIds.map((id, index) => ({ id, name: id, sortOrder: index, fixedReserveSlots: reserves.get(id)! })),
      availability,
      unavailable,
    },
    reserves,
  };
}

/** The persisted rows the API reads: resolved instants plus the civil source fields. */
function rows(input: CalendarCapacityInput) {
  const resolved = resolveCalendarCapacityWindows(input);
  const toRows = (civil: readonly DailyCapacityWindow[], instants: typeof resolved.availability): CapacityWindowRow[] =>
    civil.map((window) => {
      const instant = instants.find((candidate) => candidate.id === window.id)!;
      return {
        id: window.id,
        playing_area_id: window.areaId,
        starts_at: new Date(instant.startEpochMs),
        ends_at: new Date(instant.endEpochMs),
        date: window.date,
        start_time: window.startTime,
        end_time: window.endTime,
        cross_midnight: window.crossMidnight ?? false,
      };
    });
  return {
    windows: toRows(input.availability, resolved.availability),
    unavailable: toRows(input.unavailable ?? [], resolved.unavailable),
  };
}

describe("solver never uses reserve slots (Phase 0 property test)", () => {
  it("offers only usable slots and the solver places nothing in a reserve, over 240 random capacities", () => {
    const random = seeded(20261017);
    let solved = 0;
    let reservesChecked = 0;
    for (let sample = 0; sample < 240; sample += 1) {
      const { input, reserves } = randomCase(random, sample);
      const { windows, unavailable } = rows(input);
      const offered = capacityMatchSlots(
        windows,
        unavailable,
        input.slotMinutes!,
        input.areas.map((area) => ({
          id: area.id,
          slot_minutes: input.slotMinutes!,
          fixed_reserve_slots: area.fixedReserveSlots!,
        })),
        input.timeZone,
      );
      const summary = calculateCalendarCapacity(input);

      // Oracle: each area's latest N slots of the raw grid, by start instant.
      const raw = buildCalendarCapacitySlotSet(input).allSlots;
      const reserved: (typeof raw)[number][] = [];
      for (const [areaId, count] of reserves) {
        const areaSlots = raw.filter((slot) => slot.areaId === areaId).sort((a, b) => a.startEpochMs - b.startEpochMs);
        reserved.push(...areaSlots.slice(Math.max(0, areaSlots.length - count)));
      }
      reservesChecked += reserved.length;
      const inReserve = (placement: { areaId: string; startEpochMs: number; endEpochMs: number }) =>
        reserved.some(
          (slot) =>
            slot.areaId === placement.areaId &&
            slot.startEpochMs < placement.endEpochMs &&
            placement.startEpochMs < slot.endEpochMs,
        );

      // The domain capacity count is exactly what the solver is offered.
      expect(offered).toHaveLength(summary.availableMatchSlots);
      expect(summary.rawTotalSlots - offered.length).toBe(reserved.length);
      expect(offered.filter(inReserve)).toEqual([]);
      expect(new Set(offered.map((slot) => slot.id)).size).toBe(offered.length);
      if (offered.length === 0) continue;

      // Fill every usable slot (capped for speed) with independent matches and run the solver.
      const matchCount = Math.min(offered.length, 40);
      const problem: ScheduleProblem = {
        timeZone: input.timeZone,
        objective: "balanced",
        matches: Array.from({ length: matchCount }, (_, index) => ({
          id: `match-${index + 1}`,
          divisionId: "open",
          durationMinutes: input.slotMinutes!,
          dependencyMatchIds: [],
          possibleEntryIds: [`entry-${2 * index + 1}`, `entry-${2 * index + 2}`],
          officialIds: [],
          isChampionshipFinal: false,
        })),
        slots: offered,
        constraints: constraints(),
      };
      const [candidate] = generateScheduleCandidates(problem, { maxIterations: 1 });
      expect(candidate, `sample ${sample} produced no schedule`).toBeDefined();
      expect(candidate!.assignments).toHaveLength(matchCount);
      expect(candidate!.assignments.filter(inReserve)).toEqual([]);
      expect(validateSchedule(problem, candidate!.assignments).valid).toBe(true);
      solved += 1;
    }
    // Guard against a generator that never exercises the property.
    expect(solved).toBeGreaterThanOrEqual(200);
    expect(reservesChecked).toBeGreaterThan(500);
  });

  it("keeps the historical `<window>:<n>` slot IDs on an unchanged grid", () => {
    const input: CalendarCapacityInput = {
      timeZone: "Asia/Singapore",
      slotMinutes: 30,
      areas: [{ id: "court-a", name: "A", fixedReserveSlots: 1 }],
      availability: [{ id: "w1", areaId: "court-a", date: "2027-01-01", startTime: "09:00", endTime: "11:00" }],
      unavailable: [{ id: "u1", areaId: "court-a", date: "2027-01-01", startTime: "09:30", endTime: "09:40" }],
    };
    const { windows, unavailable } = rows(input);
    const slots = capacityMatchSlots(
      windows,
      unavailable,
      30,
      [{ id: "court-a", slot_minutes: 30, fixed_reserve_slots: 1 }],
      "Asia/Singapore",
    );
    // 09:00 is on the window grid; after the off-grid closure slots restart at 09:40 and get
    // exact-instant IDs; the latest slot (10:10) is the reserve and is not offered.
    expect(slots.map((slot) => slot.id)).toEqual(["w1:1", `w1:at:${Date.parse("2027-01-01T01:40:00Z")}`]);
  });
});
