import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ScheduleJobInput } from "@matchday/contracts";
import {
  createDefaultFormatTemplates,
  createRoundRobinFormatGraph,
  deriveSchedulingMatches,
  generateConstraintAwareSchedule,
  minimumFeasibleDailyMatchLimit,
  type ConstraintMode,
  type DefaultFormatEntryCount,
  type FormatGraph,
  type ScheduleAssignment,
  type ScheduleProblem,
  type ScheduleViolationCode,
  type SchedulingConstraints,
  type SchedulingMatch,
  type SchedulingSlot,
} from "@matchday/domain";

import { toDomainAssignment, toProblem } from "../../src/domain-optimizer.js";

/**
 * Track R3 benchmark fixtures. The October 2026 QA scenarios (S1-S7) are reproduced from the mock
 * tournament report; the canoe polo job input (S2) is the captured job. The range fixtures cover
 * every sport and every default entry count with the workspace defaults, multi-day venues,
 * officials and locks. Infeasible fixtures name the diagnostic and the fix the organiser needs.
 *
 * Sport match lengths are benchmark assumptions (one slot per match): badminton and canoe polo
 * 30 minutes, table tennis 20, volleyball and basketball 60.
 */
export type Sport = "badminton" | "table_tennis" | "volleyball" | "basketball" | "canoe_polo";

export type FeasibleExpectation = {
  kind: "feasible";
  /** Full job iterations to run (the production job runs 64 per run). */
  iterations: number;
  /** Job time target, when Track R3 sets one for this scenario. */
  jobTimeTargetMs?: number;
  /**
   * `witness`: a schedule with 0 back-to-backs exists (stored and checked independently), so the
   * job must reach 0. `impossible`: a proof in the fixture shows 0 cannot be reached.
   */
  backToBacks?: { kind: "witness"; witness: readonly ScheduleAssignment[] } | { kind: "impossible"; proof: string };
  /** Minimal-change re-planning: exactly these matches lose their slot and may move. */
  displacedMatchIds?: readonly string[];
  lockedMatchIds?: readonly string[];
};

export type InfeasibleExpectation = {
  kind: "infeasible";
  code: ScheduleViolationCode;
  /** The diagnostic's message must name the fix. */
  fix: RegExp;
};

export type BenchmarkScenario = {
  id: string;
  title: string;
  problem: ScheduleProblem;
  expectation: FeasibleExpectation | InfeasibleExpectation;
};

const MINUTE_MS = 60_000;
const TIME_ZONE = "Asia/Singapore";
/** 14 November 2026, 09:00 in Singapore. */
const FIRST_DAY_09_00 = Date.UTC(2026, 10, 14, 1, 0);
const DAY_MS = 24 * 60 * MINUTE_MS;

const durationBySport: Record<Sport, number> = {
  badminton: 30,
  table_tennis: 20,
  volleyball: 60,
  basketball: 60,
  canoe_polo: 30,
};

function setting<T>(mode: ConstraintMode, value: T, weight?: number) {
  return { mode, value, ...(weight === undefined ? {} : { weight }) };
}

/** Workspace defaults after PR #99/#100: soft rest and spacing, a required daily cap of max(4, derived). */
export function workspaceDefaults(overrides: Partial<SchedulingConstraints> = {}): SchedulingConstraints {
  return {
    minimumRest: setting("preferred", { minutes: 60 }, 4),
    maximumMatchesPerDay: setting("required", { matches: 4 }),
    preferredFinalTime: setting("ignored", { targetStartEpochMs: FIRST_DAY_09_00, toleranceMinutes: 30 }),
    entryUnavailable: setting("ignored", { byEntryId: {} }),
    officialAvailability: setting("ignored", { byOfficialId: {} }),
    featuredPlayingArea: setting("ignored", { areaId: "court-1", matchIds: [] }),
    avoidConsecutiveMatches: setting("preferred", { minutes: 30 }, 4),
    balanceEarlyMatches: setting("preferred", { beforeLocalTime: "09:00" }, 2),
    balanceLateMatches: setting("preferred", { atOrAfterLocalTime: "16:00" }, 2),
    keepDivisionTogether: setting("preferred", { maximumAreaCount: 2 }, 2),
    preserveExistingSchedule: setting("ignored", { maximumShiftMinutes: 0, byMatchId: {} }),
    ...overrides,
  };
}

/** `courts` areas, each with back-to-back slots from 09:00 for `minutesPerDay` on `days` days. */
export function venueSlots(input: {
  days: number;
  courts: number;
  slotMinutes: number;
  minutesPerDay?: number;
}): SchedulingSlot[] {
  const perDay = Math.floor((input.minutesPerDay ?? 540) / input.slotMinutes);
  const slots: SchedulingSlot[] = [];
  for (let court = 1; court <= input.courts; court += 1)
    for (let day = 0; day < input.days; day += 1)
      for (let index = 0; index < perDay; index += 1) {
        const start = FIRST_DAY_09_00 + day * DAY_MS + index * input.slotMinutes * MINUTE_MS;
        slots.push({
          id: `court-${court}:d${day + 1}:${index + 1}`,
          intervalId: `court-${court}:d${day + 1}`,
          areaId: `court-${court}`,
          startEpochMs: start,
          endEpochMs: start + input.slotMinutes * MINUTE_MS,
        });
      }
  return slots;
}

function graphMatches(graph: FormatGraph, divisionId: string, durationMinutes: number): SchedulingMatch[] {
  const seeds = Object.fromEntries(
    Array.from({ length: graph.entryCount }, (_, index) => [index + 1, `${divisionId}:entry-${index + 1}`]),
  );
  return deriveSchedulingMatches(graph, divisionId, seeds, durationMinutes).map((match) => ({
    ...match,
    id: `${divisionId}:${match.id}`,
    dependencyMatchIds: match.dependencyMatchIds.map((dependency) => `${divisionId}:${dependency}`),
  }));
}

/** Round robin with readable ids `rr:h-a` and entries `rr:entry-n`. */
export function roundRobinMatches(entries: number, durationMinutes = 30, divisionId = "rr"): SchedulingMatch[] {
  const matches: SchedulingMatch[] = [];
  for (let home = 1; home <= entries; home += 1)
    for (let away = home + 1; away <= entries; away += 1)
      matches.push({
        id: `${divisionId}:${home}-${away}`,
        divisionId,
        durationMinutes,
        dependencyMatchIds: [],
        possibleEntryIds: [`${divisionId}:entry-${home}`, `${divisionId}:entry-${away}`],
        officialIds: [],
        isChampionshipFinal: false,
      });
  return matches;
}

function withDerivedDailyLimit(problem: ScheduleProblem): ScheduleProblem {
  const derived = minimumFeasibleDailyMatchLimit(
    problem.matches,
    problem.slots.map((slot) => slot.startEpochMs),
    problem.timeZone,
  );
  return {
    ...problem,
    constraints: {
      ...problem.constraints,
      maximumMatchesPerDay: setting("required", { matches: Math.max(4, derived) }),
    },
  };
}

function assignmentAt(match: SchedulingMatch, slot: SchedulingSlot): ScheduleAssignment {
  return {
    matchId: match.id,
    divisionId: match.divisionId,
    areaId: slot.areaId,
    intervalId: slot.intervalId,
    slotId: slot.id,
    startEpochMs: slot.startEpochMs,
    endEpochMs: slot.endEpochMs,
    fixed: match.fixedAssignment !== undefined,
  };
}

/**
 * S1 witness: two blocks of four teams play their internal round robins in alternate half-hours,
 * then the cross matches pair 1-2 with 3-4 and 5-6 with 7-8, so every team rests at least one
 * slot between matches. Time index, court 1 pairing, court 2 pairing.
 */
const S1_WITNESS: readonly [number, string, string][] = [
  [0, "1-2", "3-4"],
  [1, "5-6", "7-8"],
  [2, "1-3", "2-4"],
  [3, "5-7", "6-8"],
  [4, "1-4", "2-3"],
  [5, "5-8", "6-7"],
  [7, "1-5", "2-6"],
  [8, "3-7", "4-8"],
  [9, "1-6", "2-5"],
  [10, "3-8", "4-7"],
  [12, "1-7", "2-8"],
  [13, "3-5", "4-6"],
  [14, "1-8", "2-7"],
  [15, "3-6", "4-5"],
];

function s1Problem(): ScheduleProblem {
  return withDerivedDailyLimit({
    timeZone: TIME_ZONE,
    objective: "balanced",
    matches: roundRobinMatches(8),
    slots: venueSlots({ days: 1, courts: 2, slotMinutes: 30 }),
    constraints: workspaceDefaults(),
  });
}

function s1Witness(problem: ScheduleProblem): ScheduleAssignment[] {
  const matches = new Map(problem.matches.map((match) => [match.id, match]));
  const slots = new Map(problem.slots.map((slot) => [slot.id, slot]));
  return S1_WITNESS.flatMap(([time, first, second]) =>
    [first, second].map((pair, court) =>
      assignmentAt(matches.get(`rr:${pair}`)!, slots.get(`court-${court + 1}:d1:${time + 1}`)!),
    ),
  );
}

const fixtureUrl = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export function loadJobInput(name: string): ScheduleJobInput {
  return JSON.parse(readFileSync(fixtureUrl(name), "utf8")) as ScheduleJobInput;
}

function s2Scenario(): BenchmarkScenario {
  const problem = toProblem(loadJobInput("qa-canoe-polo-104-matches.json"));
  const witness = (
    JSON.parse(readFileSync(fixtureUrl("qa-canoe-polo-104-matches.witness.json"), "utf8")) as {
      assignments: Parameters<typeof toDomainAssignment>[0][];
    }
  ).assignments.map(toDomainAssignment);
  return {
    id: "s2-canoe-polo-104",
    title: "S2 canoe polo, 4 divisions (16/12/8/16), 104 matches, 4 courts, 2 days, limit 4",
    problem,
    expectation: {
      kind: "feasible",
      iterations: 64,
      jobTimeTargetMs: 15_000,
      backToBacks: { kind: "witness", witness },
    },
  };
}

/** S5 as captured: three locks, regenerated with the workspace's preferred rest instead of required. */
function s5LocksScenario(): BenchmarkScenario {
  const captured = toProblem(loadJobInput("qa-s5-locks-required-rest.json"));
  return {
    id: "s5-locks",
    title: "S5 three locks (one entry locked back to back), preferred rest",
    problem: {
      ...captured,
      constraints: { ...captured.constraints, minimumRest: setting("preferred", { minutes: 60 }, 4) },
    },
    expectation: {
      kind: "feasible",
      iterations: 16,
      lockedMatchIds: captured.matches.filter((match) => match.fixedAssignment).map((match) => match.id),
    },
  };
}

/** S7: S1 published (rest ignored), then court 2 closes 13:00-15:00; regenerate preserving. */
function s7Scenario(): BenchmarkScenario {
  const base = s1Problem();
  const published = generateConstraintAwareSchedule({
    ...base,
    constraints: { ...base.constraints, minimumRest: setting("ignored", { minutes: 60 }) },
  });
  const closedFrom = FIRST_DAY_09_00 + 4 * 60 * MINUTE_MS;
  const closedTo = FIRST_DAY_09_00 + 6 * 60 * MINUTE_MS;
  const closed = (slot: { areaId: string; startEpochMs: number }) =>
    slot.areaId === "court-2" && slot.startEpochMs >= closedFrom && slot.startEpochMs < closedTo;
  return {
    id: "s7-repair-court-closed",
    title: "S7 re-planning: S1 published, court 2 closed 13:00-15:00, preserve existing (preferred, w50)",
    problem: {
      ...base,
      slots: base.slots.filter((slot) => !closed(slot)),
      constraints: {
        ...base.constraints,
        minimumRest: setting("ignored", { minutes: 60 }),
        preserveExistingSchedule: setting(
          "preferred",
          {
            maximumShiftMinutes: 30,
            byMatchId: Object.fromEntries(
              published.map((assignment) => [
                assignment.matchId,
                { areaId: assignment.areaId, startEpochMs: assignment.startEpochMs },
              ]),
            ),
          },
          50,
        ),
      },
    },
    expectation: {
      kind: "feasible",
      iterations: 64,
      displacedMatchIds: published.filter(closed).map((assignment) => assignment.matchId),
    },
  };
}

/** S3: championship focus with four officials, required availability with partial windows. */
function s3Problem(): ScheduleProblem {
  const graph = createDefaultFormatTemplates(8).find((template) => template.strategy === "championship_focus")!.graph;
  const officials = ["official-a", "official-b", "official-c", "official-d"];
  const matches = graphMatches(graph, "s3", 30).map((match, index) => ({
    ...match,
    officialIds: [officials[index % officials.length]!],
  }));
  const at = (hour: number) => FIRST_DAY_09_00 + (hour - 9) * 60 * MINUTE_MS;
  return withDerivedDailyLimit({
    timeZone: TIME_ZONE,
    objective: "balanced",
    matches,
    slots: venueSlots({ days: 1, courts: 2, slotMinutes: 30 }),
    constraints: workspaceDefaults({
      officialAvailability: setting("required", {
        byOfficialId: {
          "official-a": [{ startEpochMs: at(9), endEpochMs: at(18) }],
          "official-b": [{ startEpochMs: at(9), endEpochMs: at(14) }],
          "official-c": [
            { startEpochMs: at(9), endEpochMs: at(12) },
            { startEpochMs: at(13), endEpochMs: at(18) },
          ],
          "official-d": [{ startEpochMs: at(11), endEpochMs: at(18) }],
        },
      }),
    }),
  });
}

/**
 * Range fixtures: every sport and every default entry count, championship focus, sized so the
 * venue has about 40% slack. Courts: 2 up to 12 entries, 4 up to 24, 6 for 48. Volleyball and
 * basketball carry officials; table tennis locks its first match in the first slot.
 */
function rangeScenario(sport: Sport, entries: DefaultFormatEntryCount): BenchmarkScenario {
  const duration = durationBySport[sport];
  const graph = createDefaultFormatTemplates(entries).find(
    (template) => template.strategy === "championship_focus",
  )!.graph;
  let matches = graphMatches(graph, `${sport}-${entries}`, duration);
  const courts = entries <= 12 ? 2 : entries <= 24 ? 4 : 6;
  const perDay = Math.floor(540 / duration) * courts;
  const days = Math.min(3, Math.max(1, Math.ceil((matches.length * 1.4) / perDay)));
  const slots = venueSlots({ days, courts, slotMinutes: duration });
  let officialAvailability: SchedulingConstraints["officialAvailability"] = setting("ignored", { byOfficialId: {} });
  if (sport === "volleyball" || sport === "basketball") {
    const officials = Array.from({ length: courts * 2 }, (_, index) => `${sport}-official-${index + 1}`);
    matches = matches.map((match, index) => ({ ...match, officialIds: [officials[index % officials.length]!] }));
    officialAvailability = setting("required", {
      byOfficialId: Object.fromEntries(
        officials.map((official) => [
          official,
          Array.from({ length: days }, (_, day) => ({
            startEpochMs: FIRST_DAY_09_00 + day * DAY_MS,
            endEpochMs: FIRST_DAY_09_00 + day * DAY_MS + 540 * MINUTE_MS,
          })),
        ]),
      ),
    });
  }
  const lockedMatchIds: string[] = [];
  if (sport === "table_tennis") {
    const first = matches.find((match) => match.dependencyMatchIds.length === 0)!;
    const slot = slots[0]!;
    lockedMatchIds.push(first.id);
    matches = matches.map((match) =>
      match.id === first.id
        ? {
            ...match,
            fixedAssignment: {
              reason: "locked" as const,
              areaId: slot.areaId,
              slotId: slot.id,
              startEpochMs: slot.startEpochMs,
              endEpochMs: slot.endEpochMs,
            },
          }
        : match,
    );
  }
  return {
    id: `range-${sport}-${entries}`,
    title: `${sport.replace("_", " ")} ${entries} entries, championship focus, ${matches.length} matches, ${courts} courts, ${days} day(s)`,
    problem: withDerivedDailyLimit({
      timeZone: TIME_ZONE,
      objective: "balanced",
      matches,
      slots,
      constraints: workspaceDefaults({ officialAvailability }),
    }),
    expectation: { kind: "feasible", iterations: 4, lockedMatchIds },
  };
}

function infeasibleScenarios(): BenchmarkScenario[] {
  const rr8 = (slots: SchedulingSlot[], constraints: SchedulingConstraints): ScheduleProblem => ({
    timeZone: TIME_ZONE,
    objective: "balanced",
    matches: roundRobinMatches(8),
    slots,
    constraints,
  });
  const oneDay = venueSlots({ days: 1, courts: 2, slotMinutes: 30 });
  const championship = createDefaultFormatTemplates(8).find(
    (template) => template.strategy === "championship_focus",
  )!.graph;
  const championshipMatches = graphMatches(championship, "ko", 30);
  const at = (minutes: number) => FIRST_DAY_09_00 + minutes * MINUTE_MS;
  return [
    {
      id: "infeasible-capacity",
      title: "S4 venue too small: 28 round-robin matches, 12 slots",
      problem: rr8(
        venueSlots({ days: 1, courts: 2, slotMinutes: 30, minutesPerDay: 180 }),
        workspaceDefaults({
          maximumMatchesPerDay: setting("required", { matches: 7 }),
        }),
      ),
      expectation: { kind: "infeasible", code: "insufficient_capacity", fix: /Add playing areas or time/ },
    },
    {
      id: "infeasible-daily-limit",
      title: "S1 with the old default: required limit of 4 per day, 7 matches per entry, 1 day",
      problem: rr8(oneDay, workspaceDefaults({ maximumMatchesPerDay: setting("required", { matches: 4 }) })),
      expectation: { kind: "infeasible", code: "maximum_matches_per_day", fix: /Raise the daily limit to at least 7/ },
    },
    {
      id: "infeasible-required-rest",
      title: "S1 with 120 minutes of required rest",
      problem: rr8(
        oneDay,
        workspaceDefaults({
          minimumRest: setting("required", { minutes: 120 }),
          maximumMatchesPerDay: setting("required", { matches: 7 }),
        }),
      ),
      expectation: { kind: "infeasible", code: "minimum_rest", fix: /Reduce the required rest/ },
    },
    {
      id: "infeasible-knockout-window",
      title: "Championship focus 8 with enough slots but too few rounds for the knockout chain",
      problem: withDerivedDailyLimit({
        timeZone: TIME_ZONE,
        objective: "balanced",
        matches: championshipMatches,
        slots: venueSlots({ days: 1, courts: 8, slotMinutes: 30, minutesPerDay: 90 }),
        constraints: workspaceDefaults(),
      }),
      expectation: {
        kind: "infeasible",
        code: "dependency_order",
        fix: /Add playing time after the prerequisite rounds/,
      },
    },
    {
      id: "infeasible-official-window",
      title: "S3 over-constrained: one official with a one-hour window on four matches",
      problem: {
        ...rr8(oneDay, workspaceDefaults({ maximumMatchesPerDay: setting("required", { matches: 7 }) })),
        matches: roundRobinMatches(8).map((match, index) =>
          index < 4 ? { ...match, officialIds: ["official-a"] } : match,
        ),
        constraints: workspaceDefaults({
          maximumMatchesPerDay: setting("required", { matches: 7 }),
          officialAvailability: setting("required", {
            byOfficialId: { "official-a": [{ startEpochMs: at(0), endEpochMs: at(60) }] },
          }),
        }),
      },
      expectation: {
        kind: "infeasible",
        code: "official_overlap",
        fix: /Widen .* availability or assign another official/,
      },
    },
    {
      id: "infeasible-locked-rest",
      title: "S5 as captured (job input): three locks put one entry back to back while 30 minutes of rest is required",
      problem: toProblem(loadJobInput("qa-s5-locks-required-rest.json")),
      expectation: { kind: "infeasible", code: "minimum_rest", fix: /Unlock or move one of them/ },
    },
  ];
}

export function benchmarkScenarios(): BenchmarkScenario[] {
  const s1 = s1Problem();
  const exactFit = withDerivedDailyLimit({
    timeZone: TIME_ZONE,
    objective: "balanced",
    matches: roundRobinMatches(8),
    slots: venueSlots({ days: 1, courts: 2, slotMinutes: 30, minutesPerDay: 420 }),
    constraints: workspaceDefaults(),
  });
  const sports: Sport[] = ["badminton", "table_tennis", "volleyball", "basketball", "canoe_polo"];
  const sizes: DefaultFormatEntryCount[] = [8, 12, 16, 24, 48];
  return [
    {
      id: "s1-badminton-rr8",
      title: "S1 badminton round robin, 8 entries, 28 matches, 2 courts, 1 day (36 slots)",
      problem: s1,
      expectation: {
        kind: "feasible",
        iterations: 64,
        jobTimeTargetMs: 5_000,
        backToBacks: { kind: "witness", witness: s1Witness(s1) },
      },
    },
    s2Scenario(),
    {
      id: "s3-officials",
      title: "S3 championship focus 8 with four officials on partial windows (required)",
      problem: s3Problem(),
      expectation: { kind: "feasible", iterations: 16 },
    },
    {
      id: "s4-exact-fit",
      title: "S4 exact fit: 28 round-robin matches on 28 slots (2 courts x 14)",
      problem: exactFit,
      expectation: {
        kind: "feasible",
        iterations: 16,
        backToBacks: {
          kind: "impossible",
          proof:
            "Every half-hour is full (4 of 8 entries play). Without back-to-backs consecutive half-hours " +
            "use disjoint entry sets, so they alternate between one 4-entry set and its complement and " +
            "no match between the two sets can be played.",
        },
      },
    },
    s5LocksScenario(),
    s7Scenario(),
    {
      id: "round-robin-12-two-days",
      title: "Badminton round robin, 12 entries, 66 matches, 2 courts, 2 days",
      problem: withDerivedDailyLimit({
        timeZone: TIME_ZONE,
        objective: "balanced",
        matches: graphMatches(createRoundRobinFormatGraph(12), "rr12", 30),
        slots: venueSlots({ days: 2, courts: 2, slotMinutes: 30 }),
        constraints: workspaceDefaults(),
      }),
      expectation: { kind: "feasible", iterations: 16 },
    },
    ...sports.flatMap((sport) => sizes.map((entries) => rangeScenario(sport, entries))),
    ...infeasibleScenarios(),
  ];
}
