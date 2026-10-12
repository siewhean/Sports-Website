import { describe, expect, it } from "vitest";
import {
  checkFormatScheduleFeasibility,
  createRoundRobinFormatGraph,
  recommendCompetitionFormats,
  type ConstraintMode,
  type FormatGraph,
  type SchedulingConstraints,
  type SchedulingSlot,
} from "../src/index.js";

// QA report: the recommender returned scheduling_status "not_checked" for every option and never
// offered round robin for 8 entries. Suggestions are now checked against the real venue slots.

const MINUTE_MS = 60_000;
const DAY_START = Date.parse("2026-11-14T01:00:00.000Z"); // 09:00 Asia/Singapore

function setting<T>(mode: ConstraintMode, value: T, weight?: number) {
  return { mode, value, ...(weight === undefined ? {} : { weight }) };
}

/** The API workspace defaults; the daily limit is derived per format by the check. */
const workspaceDefaults: SchedulingConstraints = {
  minimumRest: setting("preferred", { minutes: 60 }, 4),
  maximumMatchesPerDay: setting("required", { matches: 4 }),
  preferredFinalTime: setting(
    "preferred",
    { targetStartEpochMs: DAY_START + 510 * MINUTE_MS, toleranceMinutes: 30 },
    3,
  ),
  entryUnavailable: setting("ignored", { byEntryId: {} }),
  officialAvailability: setting("ignored", { byOfficialId: {} }),
  featuredPlayingArea: setting("ignored", { areaId: "court-1", matchIds: [] }),
  avoidConsecutiveMatches: setting("preferred", { minutes: 30 }, 4),
  balanceEarlyMatches: setting("preferred", { beforeLocalTime: "09:00" }, 2),
  balanceLateMatches: setting("preferred", { atOrAfterLocalTime: "16:00" }, 2),
  keepDivisionTogether: setting("preferred", { maximumAreaCount: 2 }, 2),
  preserveExistingSchedule: setting("ignored", { maximumShiftMinutes: 0, byMatchId: {} }),
};

function courtSlots(courts: number, slotsPerCourt: number): SchedulingSlot[] {
  return Array.from({ length: courts }, (_, court) =>
    Array.from({ length: slotsPerCourt }, (_, index) => ({
      id: `court-${court + 1}:${index + 1}`,
      intervalId: `court-${court + 1}`,
      areaId: `court-${court + 1}`,
      startEpochMs: DAY_START + index * 30 * MINUTE_MS,
      endEpochMs: DAY_START + (index + 1) * 30 * MINUTE_MS,
    })),
  ).flat();
}

function check(slots: readonly SchedulingSlot[], constraints = workspaceDefaults, deriveDailyLimit = true) {
  return (divisions: readonly { divisionId: string; graph: FormatGraph }[]) =>
    checkFormatScheduleFeasibility({
      timeZone: "Asia/Singapore",
      slots,
      durationMinutes: 30,
      divisions,
      constraints,
      deriveDailyLimit,
    });
}

describe("schedule-aware format suggestions", () => {
  it("offers round robin for 8 entries on 2 courts for 1 day and marks every option feasible", () => {
    // QA scenario 1: 8 badminton entries, 2 courts, 09:00-18:00 (36 slots).
    const slots = courtSlots(2, 18);
    const result = recommendCompetitionFormats({
      sportCode: "badminton",
      divisions: [{ id: "open", entryCount: 8 }],
      availableMatchSlots: slots.length,
      checkSchedule: check(slots),
    });
    expect(result.recommendations.map((item) => item.strategy)).toContain("round_robin");
    expect(result.recommendations.find((item) => item.strategy === "round_robin")).toMatchObject({
      matchCount: 28,
      guaranteedMatches: 7,
      rankingCoverage: "all_entries",
      scheduleFeasibility: "feasible",
    });
    expect(result.recommendations.every((item) => item.scheduleFeasibility === "feasible")).toBe(true);
  });

  it("explains an infeasible option and ranks feasible options first", () => {
    // A strict daily limit of 4 that is not derived from the format: round robin needs 7 per entry.
    const slots = courtSlots(2, 18);
    const strict = check(slots, workspaceDefaults, false);
    const roundRobin = strict([{ divisionId: "open", graph: createRoundRobinFormatGraph(8) }]);
    expect(roundRobin.status).toBe("infeasible");
    expect(roundRobin.warningCodes).toContain("SCHEDULE_DAILY_LIMIT");
    expect(roundRobin.diagnostics.length).toBeGreaterThan(0);

    const result = recommendCompetitionFormats({
      sportCode: "badminton",
      divisions: [{ id: "open", entryCount: 8 }],
      availableMatchSlots: slots.length,
      checkSchedule: strict,
    });
    const statuses = result.recommendations.map((item) => item.scheduleFeasibility);
    expect(statuses).toEqual([...statuses].sort((left, right) => rank(left) - rank(right)));
    const infeasible = result.recommendations.filter((item) => item.scheduleFeasibility === "infeasible");
    expect(statuses[0]).toBe("feasible");
    expect(infeasible.length).toBeGreaterThan(0);
    expect(infeasible.every((item) => item.warningCodes.some((code) => code.startsWith("SCHEDULE_")))).toBe(true);
  });

  it("reports venue capacity and returns not_checked when there are no slots or the problem is too large", () => {
    const graph = createRoundRobinFormatGraph(8);
    expect(check(courtSlots(1, 12))([{ divisionId: "open", graph }])).toMatchObject({
      status: "infeasible",
      warningCodes: ["SCHEDULE_CAPACITY"],
    });
    expect(check([])([{ divisionId: "open", graph }]).status).toBe("not_checked");
    expect(
      checkFormatScheduleFeasibility({
        timeZone: "Asia/Singapore",
        slots: courtSlots(2, 18),
        durationMinutes: 30,
        divisions: [{ divisionId: "open", graph }],
        constraints: workspaceDefaults,
        deriveDailyLimit: true,
        maxSolveCells: 10,
      }).status,
    ).toBe("not_checked");
    // Above the match cap even the analytic diagnostics are skipped (request-path bound).
    expect(
      checkFormatScheduleFeasibility({
        timeZone: "Asia/Singapore",
        slots: courtSlots(2, 18),
        durationMinutes: 30,
        divisions: [{ divisionId: "open", graph }],
        constraints: { ...workspaceDefaults, maximumMatchesPerDay: setting("required", { matches: 1 }) },
        maxCheckMatches: 10,
      }),
    ).toEqual({ status: "not_checked", warningCodes: [], diagnostics: [] });
  });

  it("finds QA scenario 2 (canoe polo 16/12/8/16, 4 courts, 2 days) schedulable before materialisation", () => {
    // Graph ids sort one division's whole group stage first; the solver must still find a schedule.
    const slots = [0, 1].flatMap((day) =>
      courtSlots(4, 18).map((slot) => ({
        ...slot,
        id: `${slot.id}:day-${day}`,
        startEpochMs: slot.startEpochMs + day * 24 * 60 * MINUTE_MS,
        endEpochMs: slot.endEpochMs + day * 24 * 60 * MINUTE_MS,
      })),
    );
    const result = recommendCompetitionFormats({
      sportCode: "canoe_polo",
      divisions: [16, 12, 8, 16].map((entryCount, index) => ({ id: `division-${index + 1}`, entryCount })),
      availableMatchSlots: slots.length,
      checkSchedule: check(slots),
    });
    expect(result.recommendations.find((item) => item.strategy === "championship_focus")).toMatchObject({
      matchCount: 104,
      scheduleFeasibility: "feasible",
    });
  });

  it("keeps the old behaviour without a schedule check", () => {
    const result = recommendCompetitionFormats({
      sportCode: "badminton",
      divisions: [{ id: "open", entryCount: 8 }],
      availableMatchSlots: 36,
    });
    expect(result.recommendations.every((item) => item.scheduleFeasibility === "not_checked")).toBe(true);
  });
});

function rank(status: "feasible" | "infeasible" | "not_checked"): number {
  return status === "feasible" ? 0 : status === "not_checked" ? 1 : 2;
}
