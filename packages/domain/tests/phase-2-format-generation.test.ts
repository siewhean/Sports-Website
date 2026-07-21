import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCapacitySlots,
  calculateContinuousCapacity,
  generateBalancedCanoePoloFormat,
  type CompetitionEntry,
} from "../src/index.js";

function entries(count: 8 | 16): CompetitionEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `team-${String(index + 1).padStart(2, "0")}`,
    name: `Team ${index + 1}`,
    seed: index + 1,
  }));
}

function golden(count: 8 | 16) {
  const fileName = `../../../validation/phase-2/canoe-polo-${String(count).padStart(2, "0")}.vertical-slice.json`;
  return JSON.parse(readFileSync(new URL(fileName, import.meta.url), "utf8"));
}

describe("Phase 2 balanced Canoe Polo format generation", () => {
  it("floors each continuous interval without combining break remnants", () => {
    const intervals = [
      { id: "morning", areaId: "pitch-1", startMinute: 9 * 60, endMinute: 10 * 60 + 20 },
      { id: "afternoon", areaId: "pitch-1", startMinute: 10 * 60 + 40, endMinute: 12 * 60 },
    ];
    const capacity = calculateContinuousCapacity(intervals, 30);
    expect(capacity.totalSlots).toBe(4);
    expect(capacity.intervalSlots.map((interval) => interval.unusedMinutes)).toEqual([20, 20]);
    expect(buildCapacitySlots(intervals, 30).map((slot) => [slot.startMinute, slot.endMinute])).toEqual([
      [540, 570],
      [570, 600],
      [640, 670],
      [670, 700],
    ]);
  });

  it.each([8, 16] as const)("creates a stable, complete %i-team group-to-knockout graph", (count) => {
    const format = generateBalancedCanoePoloFormat(entries(count));
    expect(format).toEqual(generateBalancedCanoePoloFormat([...entries(count)].reverse()));
    expect(format.groups).toHaveLength(count / 4);
    expect(format.groups.every((group) => group.entryIds.length === 4 && group.matchIds.length === 6)).toBe(true);
    expect(new Set(format.groups.flatMap((group) => group.entryIds)).size).toBe(count);
    expect(format.matches).toHaveLength(count === 8 ? 16 : 32);
    expect(new Set(format.matches.map((match) => match.id)).size).toBe(format.matches.length);
    expect(format.knockoutMatchIds.at(-1)).toBe("championship-final");
    for (const match of format.matches) {
      expect(match.dependencyMatchIds).not.toContain(match.id);
      expect(match.dependencyMatchIds.every((id) => format.matches.some((candidate) => candidate.id === id))).toBe(
        true,
      );
    }
  });

  it("uses balanced snake seeding", () => {
    const format8 = generateBalancedCanoePoloFormat(entries(8));
    expect(format8.groups.map((group) => group.entryIds)).toEqual([
      ["team-01", "team-04", "team-05", "team-08"],
      ["team-02", "team-03", "team-06", "team-07"],
    ]);
    const format16 = generateBalancedCanoePoloFormat(entries(16));
    expect(format16.groups.map((group) => group.entryIds)).toEqual([
      ["team-01", "team-08", "team-09", "team-16"],
      ["team-02", "team-07", "team-10", "team-15"],
      ["team-03", "team-06", "team-11", "team-14"],
      ["team-04", "team-05", "team-12", "team-13"],
    ]);
  });

  it.each([8, 16] as const)("matches the independently authored %i-team format oracle", (count) => {
    const oracle = golden(count);
    const format = generateBalancedCanoePoloFormat(entries(count));
    expect(Object.fromEntries(format.groups.map((group) => [group.id, group.entryIds]))).toEqual(oracle.groups);
    expect(
      format.matches
        .filter((match) => match.stage === "group")
        .map((match) => [
          match.id,
          match.home.type === "entry" ? match.home.entryId : null,
          match.away.type === "entry" ? match.away.entryId : null,
        ]),
    ).toEqual(oracle.group_matches);
    expect(format.knockoutMatchIds).toEqual(oracle.knockout_matches.map((match: [string]) => match[0]));
  });

  it("rejects unsupported sizes and duplicate seeds", () => {
    expect(() => generateBalancedCanoePoloFormat(entries(8).slice(0, 7))).toThrow(/exactly 8 or 16/);
    const duplicated = entries(8);
    duplicated[1] = { ...duplicated[1]!, seed: 1 };
    expect(() => generateBalancedCanoePoloFormat(duplicated)).toThrow(/Duplicate seed/);
  });
});
