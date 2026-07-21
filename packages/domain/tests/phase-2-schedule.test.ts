import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  generateBalancedCanoePoloFormat,
  generateDeterministicSchedule,
  type AvailabilityInterval,
  type CompetitionEntry,
} from "../src/index.js";

function entries(count: 8 | 16): CompetitionEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    name: `Team ${index + 1}`,
    seed: index + 1,
  }));
}

function intervals(days: number, areas: number): AvailabilityInterval[] {
  return Array.from({ length: days }, (_, day) =>
    Array.from({ length: areas }, (_, area) => [
      {
        id: `d${day + 1}-a${area + 1}-am`,
        areaId: `area-${area + 1}`,
        startMinute: day * 1440 + 540,
        endMinute: day * 1440 + 720,
      },
      {
        id: `d${day + 1}-a${area + 1}-pm`,
        areaId: `area-${area + 1}`,
        startMinute: day * 1440 + 780,
        endMinute: day * 1440 + 1080,
      },
    ]).flat(),
  ).flat();
}

describe("Phase 2 deterministic scheduling", () => {
  it.each([
    [8, 2, 2],
    [16, 2, 4],
  ] as const)(
    "schedules a %i-team graph with clashes, dependencies, breaks, and rest enforced",
    (count, days, areas) => {
      const format = generateBalancedCanoePoloFormat(entries(count));
      const availability = intervals(days, areas);
      const schedule = generateDeterministicSchedule(format.matches, availability, { minimumRestMinutes: 30 });
      expect(schedule).toEqual(
        generateDeterministicSchedule(format.matches, [...availability].reverse(), { minimumRestMinutes: 30 }),
      );
      expect(schedule).toHaveLength(format.matches.length);

      const assignment = new Map(schedule.map((match) => [match.matchId, match]));
      for (const match of format.matches) {
        const scheduled = assignment.get(match.id)!;
        const sourceInterval = availability.find((interval) => interval.id === scheduled.intervalId)!;
        expect(scheduled.startMinute).toBeGreaterThanOrEqual(sourceInterval.startMinute);
        expect(scheduled.endMinute).toBeLessThanOrEqual(sourceInterval.endMinute);
        for (const dependency of match.dependencyMatchIds) {
          expect(scheduled.startMinute).toBeGreaterThanOrEqual(assignment.get(dependency)!.endMinute + 30);
        }
      }

      for (let leftIndex = 0; leftIndex < schedule.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < schedule.length; rightIndex += 1) {
          const left = schedule[leftIndex]!;
          const right = schedule[rightIndex]!;
          if (left.areaId === right.areaId) {
            expect(left.endMinute <= right.startMinute || right.endMinute <= left.startMinute).toBe(true);
          }
        }
      }

      const directTeamTimes = new Map<string, Array<{ start: number; end: number }>>();
      for (const match of format.matches.filter(
        (candidate) => candidate.home.type === "entry" && candidate.away.type === "entry",
      )) {
        const assigned = assignment.get(match.id)!;
        for (const source of [match.home, match.away]) {
          if (source.type !== "entry") continue;
          const times = directTeamTimes.get(source.entryId) ?? [];
          times.push({ start: assigned.startMinute, end: assigned.endMinute });
          directTeamTimes.set(source.entryId, times);
        }
      }
      for (const times of directTeamTimes.values()) {
        times.sort((left, right) => left.start - right.start);
        for (let index = 1; index < times.length; index += 1) {
          expect(times[index]!.start).toBeGreaterThanOrEqual(times[index - 1]!.end + 30);
        }
      }
    },
  );

  it("fails closed when continuous capacity cannot fit the graph", () => {
    const format = generateBalancedCanoePoloFormat(entries(8));
    expect(() =>
      generateDeterministicSchedule(format.matches, [{ id: "tiny", areaId: "one", startMinute: 0, endMinute: 60 }]),
    ).toThrow(/Insufficient continuous capacity/);
  });

  it.each([8, 16] as const)("matches the independently authored %i-team schedule oracle", (count) => {
    const fileName = `../../../validation/phase-2/canoe-polo-${String(count).padStart(2, "0")}.vertical-slice.json`;
    const oracle = JSON.parse(readFileSync(new URL(fileName, import.meta.url), "utf8"));
    const availability: AvailabilityInterval[] = oracle.availability.map(
      ([id, areaId, startMinute, endMinute]: [string, string, number, number]) => ({
        id,
        areaId,
        startMinute,
        endMinute,
      }),
    );
    const schedule = generateDeterministicSchedule(
      generateBalancedCanoePoloFormat(entries(count)).matches,
      availability,
      {
        minimumRestMinutes: oracle.minimum_rest_minutes,
      },
    );
    expect(
      schedule.map((match) => [match.matchId, match.areaId, match.intervalId, match.startMinute, match.endMinute]),
    ).toEqual(oracle.schedule);
  });
});
