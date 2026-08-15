import { describe, expect, it } from "vitest";
import {
  createDefaultFormatTemplates,
  deriveSchedulingMatches,
  generateScheduleCandidates,
  type ConstraintSetting,
  type ScheduleProblem,
  type SchedulingConstraints,
  type SchedulingMatch,
  type SchedulingSlot,
} from "../src/index.js";

const MINUTE = 60_000;
const START = Date.parse("2026-09-12T01:00:00.000Z");

function setting<T>(mode: "required" | "preferred" | "ignored", value: T, weight?: number): ConstraintSetting<T> {
  return { mode, value, ...(weight === undefined ? {} : { weight }) };
}

function division(id: string, prefix: string): SchedulingMatch[] {
  const template = createDefaultFormatTemplates(8).find((item) => item.strategy === "full_placement");
  if (!template) throw new Error("full placement missing");
  const derived = deriveSchedulingMatches(
    template.graph,
    id,
    Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, `${prefix}-entry-${i + 1}`])),
    30,
  );
  const ids = new Map(derived.map((match, i) => [match.id, `${prefix}-match-${i + 1}`]));
  return derived.map((match) => ({
    ...match,
    id: ids.get(match.id)!,
    dependencyMatchIds: match.dependencyMatchIds.map((dep) => ids.get(dep)!),
  }));
}

function slots(areas: number, dayBreakAfter: number | null): SchedulingSlot[] {
  return Array.from({ length: 36 }, (_, index) => {
    const timeIndex = Math.floor(index / areas);
    const dayOffset = dayBreakAfter !== null && timeIndex >= dayBreakAfter ? 18 * 60 * MINUTE : 0;
    const adjustedTime = dayBreakAfter !== null && timeIndex >= dayBreakAfter ? timeIndex - dayBreakAfter : timeIndex;
    const start = START + dayOffset + adjustedTime * 30 * MINUTE;
    return {
      id: `slot-${index}`,
      intervalId: `window-${dayOffset}-${Math.floor(adjustedTime / 6)}`,
      areaId: `area-${(index % areas) + 1}`,
      startEpochMs: start,
      endEpochMs: start + 30 * MINUTE,
    };
  });
}

function constraints(rest: number, maxPerDay: number, areas: number): SchedulingConstraints {
  return {
    minimumRest: setting("required", { minutes: rest }),
    maximumMatchesPerDay: setting("required", { matches: maxPerDay }),
    preferredFinalTime: setting("preferred", { targetStartEpochMs: START + 8 * 60 * MINUTE, toleranceMinutes: 120 }, 1),
    entryUnavailable: setting("ignored", { byEntryId: {} }),
    officialAvailability: setting("ignored", { byOfficialId: {} }),
    featuredPlayingArea: setting("ignored", { areaId: "area-1", matchIds: [] }),
    avoidConsecutiveMatches: setting("preferred", { minutes: 30 }, 1),
    balanceEarlyMatches: setting("preferred", { beforeLocalTime: "10:00" }, 1),
    balanceLateMatches: setting("preferred", { atOrAfterLocalTime: "17:00" }, 1),
    keepDivisionTogether: setting("required", { maximumAreaCount: areas }),
    preserveExistingSchedule: setting("ignored", { maximumShiftMinutes: 0, byMatchId: {} }),
  };
}

describe("tight-capacity deterministic search variation", () => {
  it("has at least one plausible 36-slot configuration where an ordering dead-ends and another succeeds", () => {
    const matches = [...division("open", "open"), ...division("women", "women")];
    let found: { rest: number; maxPerDay: number; areas: number; dayBreakAfter: number | null; failed: number; passed: number } | null = null;

    outer: for (const areas of [1, 2, 3]) {
      for (const rest of [0, 15, 30, 45, 60]) {
        for (const maxPerDay of [3, 4, 5, 6, 8, 12]) {
          for (const dayBreakAfter of [null, 6, 9, 12]) {
            const problem: ScheduleProblem = {
              timeZone: "Asia/Singapore",
              objective: "balanced",
              matches,
              slots: slots(areas, dayBreakAfter),
              constraints: constraints(rest, maxPerDay, areas),
            };
            let failed: number | null = null;
            let passed: number | null = null;
            for (let iteration = 0; iteration < 32; iteration += 1) {
              try {
                const result = generateScheduleCandidates(problem, { startIteration: iteration, maxIterations: 1 });
                if (result.length) passed ??= iteration;
              } catch (error) {
                if (error instanceof Error && error.message.startsWith("No valid slot remains for match ")) failed ??= iteration;
                else throw error;
              }
              if (failed !== null && passed !== null) {
                found = { rest, maxPerDay, areas, dayBreakAfter, failed, passed };
                console.log("mixed-search-case", JSON.stringify(found));
                break outer;
              }
            }
          }
        }
      }
    }

    expect(found).not.toBeNull();
  });
});
