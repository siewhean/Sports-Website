import type { FormatGraph, FormatParticipantSource } from "./format.js";

export type ConstraintMode = "required" | "preferred" | "ignored";
export type ScheduleObjective = "fastest" | "balanced" | "rest_focused";

export const intrinsicScheduleHardConstraints = [
  "entry_overlap",
  "playing_area_overlap",
  "dependency_order",
  "playing_area_availability",
  "fixed_match_immutability",
  "official_overlap",
  "full_slot_occupancy",
] as const;
export type IntrinsicScheduleHardConstraint = (typeof intrinsicScheduleHardConstraints)[number];

export type ConstraintSetting<T> = {
  mode: ConstraintMode;
  value: T;
  weight?: number;
};

export type SchedulingConstraints = {
  minimumRest: ConstraintSetting<{ minutes: number }>;
  maximumMatchesPerDay: ConstraintSetting<{ matches: number }>;
  preferredFinalTime: ConstraintSetting<{ targetStartEpochMs: number; toleranceMinutes: number }>;
  entryUnavailable: ConstraintSetting<{
    byEntryId: Readonly<Record<string, readonly { startEpochMs: number; endEpochMs: number }[]>>;
  }>;
  officialAvailability: ConstraintSetting<{
    byOfficialId: Readonly<Record<string, readonly { startEpochMs: number; endEpochMs: number }[]>>;
  }>;
  featuredPlayingArea: ConstraintSetting<{ areaId: string; matchIds: readonly string[] }>;
  avoidConsecutiveMatches: ConstraintSetting<{ minutes: number }>;
  balanceEarlyMatches: ConstraintSetting<{ beforeLocalTime: string }>;
  balanceLateMatches: ConstraintSetting<{ atOrAfterLocalTime: string }>;
  keepDivisionTogether: ConstraintSetting<{ maximumAreaCount: number }>;
  preserveExistingSchedule: ConstraintSetting<{
    maximumShiftMinutes: number;
    byMatchId: Readonly<Record<string, { areaId: string; startEpochMs: number }>>;
  }>;
};

export type SchedulingMatch = {
  id: string;
  divisionId: string;
  durationMinutes: number;
  dependencyMatchIds: readonly string[];
  possibleEntryIds: readonly string[];
  officialIds: readonly string[];
  isChampionshipFinal: boolean;
  fixedAssignment?: {
    reason: "locked" | "published_history";
    areaId: string;
    slotId: string;
    startEpochMs: number;
    endEpochMs: number;
  };
};

export type SchedulingSlot = {
  id: string;
  intervalId: string;
  areaId: string;
  startEpochMs: number;
  endEpochMs: number;
};

export type ScheduleAssignment = {
  matchId: string;
  divisionId: string;
  areaId: string;
  intervalId: string;
  slotId: string;
  startEpochMs: number;
  endEpochMs: number;
  fixed: boolean;
};

export type ScheduleViolationCode =
  | "unknown_match"
  | "missing_match"
  | "duplicate_assignment"
  | "assignment_mismatch"
  | "unknown_slot"
  | "slot_mismatch"
  | "slot_duration"
  | "area_overlap"
  | "possible_entry_overlap"
  | "official_overlap"
  | "dependency_order"
  | "fixed_match_moved"
  | "minimum_rest"
  | "maximum_matches_per_day"
  | "entry_unavailable"
  | "official_unavailable"
  | "preferred_final_time"
  | "featured_playing_area"
  | "consecutive_matches"
  | "early_match_balance"
  | "late_match_balance"
  | "division_area_spread"
  | "existing_schedule_moved";

export type ScheduleViolation = {
  code: ScheduleViolationCode;
  severity: "hard" | "required" | "preferred";
  matchIds: readonly string[];
  message: string;
  amount?: number;
};

export type ScheduleValidation = {
  valid: boolean;
  violations: readonly ScheduleViolation[];
};

export type ScheduleQualityComponent = {
  key:
    | "completion"
    | "rest"
    | "daily_balance"
    | "preferred_final"
    | "featured_area"
    | "consecutive"
    | "time_balance"
    | "division_cohesion"
    | "schedule_preservation"
    | "entry_availability"
    | "official_availability";
  score: number;
  weight: number;
  measured: number;
  unit: "minutes" | "matches" | "areas" | "percent";
  explanation: string;
};

export type ScheduleQuality = {
  score: number;
  objective: ScheduleObjective;
  valid: boolean;
  makespanMinutes: number;
  minimumRestMinutes: number | null;
  maximumMatchesPerEntryDay: number;
  preferredFinalDeltaMinutes: number | null;
  requiredViolationCount: number;
  preferredPenalty: number;
  components: readonly ScheduleQualityComponent[];
};

export type ScheduleProblem = {
  timeZone: string;
  objective: ScheduleObjective;
  matches: readonly SchedulingMatch[];
  slots: readonly SchedulingSlot[];
  constraints: SchedulingConstraints;
};

export type ScheduleCandidate = {
  iteration: number;
  assignments: readonly ScheduleAssignment[];
};

export type ScheduleCandidateOptions = {
  startIteration?: number;
  maxIterations?: number;
  seedAssignments?: readonly ScheduleAssignment[];
};

const MINUTE_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function formatSourceDependencies(source: FormatParticipantSource, graph: FormatGraph): string[] {
  if (source.type === "winner" || source.type === "loser") return [source.matchId];
  if (source.type !== "stage_rank" && source.type !== "manual_qualifier") return [];
  const stage = graph.stages.find((candidate) => candidate.id === source.stageId);
  if (!stage) throw new Error(`Unknown source stage ${source.stageId}`);
  return stage.matchIds.filter((matchId) => {
    if (source.type === "manual_qualifier" || source.groupId === undefined) return true;
    return graph.matches.find((match) => match.id === matchId)?.poolId === source.groupId;
  });
}

function sourcePossibilities(
  source: FormatParticipantSource,
  graph: FormatGraph,
  entryIdBySeed: ReadonlyMap<number, string>,
  possibilities: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (source.type === "entry_seed") {
    const entryId = entryIdBySeed.get(source.seed);
    if (!entryId) throw new Error(`No entry ID supplied for seed ${source.seed}`);
    return [entryId];
  }
  if (source.type === "winner" || source.type === "loser") {
    const possible = possibilities.get(source.matchId);
    if (!possible) throw new Error(`Match outcome ${source.matchId} is not ordered before its consumer`);
    return [...possible];
  }
  const matchIds = formatSourceDependencies(source, graph);
  return uniqueSorted(
    matchIds.flatMap((matchId) => {
      const possible = possibilities.get(matchId);
      if (!possible) throw new Error(`Stage ${source.stageId} is not ordered before its consumer`);
      return possible;
    }),
  );
}

/**
 * Convert a validated Phase 3 graph to solver matches. Unresolved advancement
 * slots retain the union of every entrant that can reach them. This prevents a
 * schedule from hiding a future participant clash behind winner/rank tokens.
 */
export function deriveSchedulingMatches(
  graph: FormatGraph,
  divisionId: string,
  entryIdsBySeed: Readonly<Record<number, string>>,
  durationMinutes: number,
): SchedulingMatch[] {
  if (!divisionId.trim()) throw new Error("A division ID is required");
  assertPositiveInteger(durationMinutes, "Match duration");
  const seedMap = new Map(Object.entries(entryIdsBySeed).map(([seed, id]) => [Number(seed), id]));
  if (
    seedMap.size !== graph.entryCount ||
    [...seedMap.values()].some((id) => !id.trim()) ||
    new Set(seedMap.values()).size !== graph.entryCount
  ) {
    throw new Error(`Expected one unique non-empty entry ID for each of ${graph.entryCount} seeds`);
  }
  const matchesById = new Map(graph.matches.map((match) => [match.id, match]));
  const remaining = new Map(graph.matches.map((match) => [match.id, match]));
  const possibilities = new Map<string, readonly string[]>();
  const derived: SchedulingMatch[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((match) =>
        [...formatSourceDependencies(match.home, graph), ...formatSourceDependencies(match.away, graph)].every((id) =>
          possibilities.has(id),
        ),
      )
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error("Format graph has a dependency cycle or invalid order");
    for (const match of ready) {
      const possibleEntryIds = uniqueSorted([
        ...sourcePossibilities(match.home, graph, seedMap, possibilities),
        ...sourcePossibilities(match.away, graph, seedMap, possibilities),
      ]);
      const dependencyMatchIds = [
        ...new Set([...formatSourceDependencies(match.home, graph), ...formatSourceDependencies(match.away, graph)]),
      ];
      possibilities.set(match.id, possibleEntryIds);
      remaining.delete(match.id);
      derived.push({
        id: match.id,
        divisionId,
        durationMinutes,
        dependencyMatchIds,
        possibleEntryIds,
        officialIds: [],
        isChampionshipFinal: match.purpose === "championship" && graph.terminalMatchIds.includes(match.id),
      });
    }
  }
  if (derived.some((match) => !matchesById.has(match.id))) throw new Error("Failed to derive every format match");
  return derived;
}

/** Fail closed when a later result resolves an unresolved schedule slot. */
export function assertResolvedMatchParticipants(match: SchedulingMatch, resolvedEntryIds: readonly string[]): void {
  if (
    resolvedEntryIds.length !== 2 ||
    new Set(resolvedEntryIds).size !== 2 ||
    resolvedEntryIds.some((entryId) => !entryId.trim())
  ) {
    throw new Error(`Resolved match ${match.id} requires exactly two unique non-empty entry IDs`);
  }
  for (const entryId of resolvedEntryIds) {
    if (!match.possibleEntryIds.includes(entryId)) {
      throw new Error(`Resolved entry ${entryId} is outside match ${match.id}'s possible-participant universe`);
    }
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an epoch millisecond safe integer`);
}

function assertSetting<T>(setting: ConstraintSetting<T>, label: string): void {
  if (!["required", "preferred", "ignored"].includes(setting.mode)) throw new Error(`${label} has an invalid mode`);
  if (setting.weight !== undefined) {
    if (setting.mode !== "preferred") throw new Error(`${label} weight is allowed only in preferred mode`);
    assertPositiveInteger(setting.weight, `${label} weight`);
  }
}

function localDateKey(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localMinuteOfDay(epochMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return (parts.hour ?? 0) * 60 + (parts.minute ?? 0);
}

function parseLocalTime(value: string, label: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) throw new Error(`${label} must use valid HH:mm local time`);
  return hour * 60 + minute;
}

function intervalsOverlap(
  left: { startEpochMs: number; endEpochMs: number },
  right: { startEpochMs: number; endEpochMs: number },
): boolean {
  return left.startEpochMs < right.endEpochMs && right.startEpochMs < left.endEpochMs;
}

function validateProblem(problem: ScheduleProblem): void {
  try {
    localDateKey(Date.now(), problem.timeZone);
  } catch {
    throw new Error(`Invalid IANA time zone: ${problem.timeZone}`);
  }
  if (!["fastest", "balanced", "rest_focused"].includes(problem.objective)) {
    throw new Error(`Unknown schedule objective: ${String(problem.objective)}`);
  }
  if (problem.matches.length === 0) throw new Error("A schedule problem requires at least one match");
  if (problem.slots.length === 0) throw new Error("A schedule problem requires at least one available slot");
  const matchIds = new Set<string>();
  const possibleEntryIds = new Set<string>();
  const assignedOfficialIds = new Set<string>();
  for (const match of problem.matches) {
    if (!match.id.trim() || !match.divisionId.trim()) throw new Error("Matches require stable match and division IDs");
    if (matchIds.has(match.id)) throw new Error(`Duplicate match ID: ${match.id}`);
    matchIds.add(match.id);
    assertPositiveInteger(match.durationMinutes, `Match ${match.id} duration`);
    if (
      new Set(match.possibleEntryIds).size !== match.possibleEntryIds.length ||
      match.possibleEntryIds.length < 2 ||
      match.possibleEntryIds.some((id) => !id.trim())
    ) {
      throw new Error(`Match ${match.id} requires at least two unique non-empty possible entry IDs`);
    }
    if (new Set(match.officialIds).size !== match.officialIds.length || match.officialIds.some((id) => !id.trim())) {
      throw new Error(`Match ${match.id} official IDs must be non-empty and unique`);
    }
    for (const entryId of match.possibleEntryIds) possibleEntryIds.add(entryId);
    for (const officialId of match.officialIds) assignedOfficialIds.add(officialId);
    if (match.fixedAssignment) {
      if (!match.fixedAssignment.areaId.trim() || !match.fixedAssignment.slotId.trim()) {
        throw new Error(`Fixed match ${match.id} requires stable area and slot IDs`);
      }
      assertEpoch(match.fixedAssignment.startEpochMs, `Fixed match ${match.id} start`);
      assertEpoch(match.fixedAssignment.endEpochMs, `Fixed match ${match.id} end`);
      if (match.fixedAssignment.endEpochMs - match.fixedAssignment.startEpochMs !== match.durationMinutes * MINUTE_MS) {
        throw new Error(`Fixed match ${match.id} must occupy one full ${match.durationMinutes}-minute slot`);
      }
    }
  }
  for (const match of problem.matches) {
    for (const dependency of match.dependencyMatchIds) {
      if (!matchIds.has(dependency)) throw new Error(`Match ${match.id} has unknown dependency ${dependency}`);
      if (dependency === match.id) throw new Error(`Match ${match.id} depends on itself`);
    }
  }
  const slotIds = new Set<string>();
  for (const slot of problem.slots) {
    if (!slot.id.trim() || !slot.intervalId.trim() || !slot.areaId.trim()) throw new Error("Slots require stable IDs");
    if (slotIds.has(slot.id)) throw new Error(`Duplicate slot ID: ${slot.id}`);
    slotIds.add(slot.id);
    assertEpoch(slot.startEpochMs, `Slot ${slot.id} start`);
    assertEpoch(slot.endEpochMs, `Slot ${slot.id} end`);
    if (slot.endEpochMs <= slot.startEpochMs) throw new Error(`Slot ${slot.id} must have positive duration`);
    if ((slot.endEpochMs - slot.startEpochMs) % MINUTE_MS !== 0) {
      throw new Error(`Slot ${slot.id} must span whole minutes`);
    }
  }
  const slotById = new Map(problem.slots.map((slot) => [slot.id, slot]));
  for (const match of problem.matches) {
    if (!match.fixedAssignment) continue;
    const slot = slotById.get(match.fixedAssignment.slotId);
    if (
      !slot ||
      slot.areaId !== match.fixedAssignment.areaId ||
      slot.startEpochMs !== match.fixedAssignment.startEpochMs ||
      slot.endEpochMs !== match.fixedAssignment.endEpochMs
    ) {
      throw new Error(`Fixed match ${match.id} does not exactly match an available slot`);
    }
  }
  const { constraints } = problem;
  assertSetting(constraints.minimumRest, "Minimum rest");
  assertNonNegativeInteger(constraints.minimumRest.value.minutes, "Minimum rest minutes");
  assertSetting(constraints.maximumMatchesPerDay, "Maximum matches per day");
  assertPositiveInteger(constraints.maximumMatchesPerDay.value.matches, "Maximum matches per day");
  assertSetting(constraints.preferredFinalTime, "Preferred final time");
  assertEpoch(constraints.preferredFinalTime.value.targetStartEpochMs, "Preferred final target");
  assertNonNegativeInteger(constraints.preferredFinalTime.value.toleranceMinutes, "Preferred final tolerance");
  assertSetting(constraints.entryUnavailable, "Entry unavailable");
  for (const [entryId, intervals] of Object.entries(constraints.entryUnavailable.value.byEntryId)) {
    if (!entryId.trim()) throw new Error("Entry unavailable constraints require stable entry IDs");
    if (!possibleEntryIds.has(entryId)) throw new Error(`Entry unavailable references unknown entry ${entryId}`);
    for (const interval of intervals) {
      assertEpoch(interval.startEpochMs, `Entry ${entryId} unavailable start`);
      assertEpoch(interval.endEpochMs, `Entry ${entryId} unavailable end`);
      if (interval.endEpochMs <= interval.startEpochMs) {
        throw new Error(`Entry ${entryId} unavailable interval must have positive duration`);
      }
    }
  }
  assertSetting(constraints.officialAvailability, "Official availability");
  for (const [officialId, intervals] of Object.entries(constraints.officialAvailability.value.byOfficialId)) {
    if (!officialId.trim()) throw new Error("Official availability requires stable official IDs");
    if (!assignedOfficialIds.has(officialId)) {
      throw new Error(`Official availability references unassigned official ${officialId}`);
    }
    for (const interval of intervals) {
      assertEpoch(interval.startEpochMs, `Official ${officialId} availability start`);
      assertEpoch(interval.endEpochMs, `Official ${officialId} availability end`);
      if (interval.endEpochMs <= interval.startEpochMs) {
        throw new Error(`Official ${officialId} availability interval must have positive duration`);
      }
    }
  }
  assertSetting(constraints.featuredPlayingArea, "Featured playing area");
  if (!constraints.featuredPlayingArea.value.areaId.trim())
    throw new Error("Featured playing area requires an area ID");
  if (
    new Set(constraints.featuredPlayingArea.value.matchIds).size !==
    constraints.featuredPlayingArea.value.matchIds.length
  ) {
    throw new Error("Featured playing-area match IDs must be unique");
  }
  for (const matchId of constraints.featuredPlayingArea.value.matchIds) {
    if (!matchIds.has(matchId)) throw new Error(`Featured playing area references unknown match ${matchId}`);
  }
  assertSetting(constraints.avoidConsecutiveMatches, "Avoid consecutive matches");
  assertNonNegativeInteger(constraints.avoidConsecutiveMatches.value.minutes, "Consecutive-match buffer");
  assertSetting(constraints.balanceEarlyMatches, "Balance early matches");
  parseLocalTime(constraints.balanceEarlyMatches.value.beforeLocalTime, "Early-match threshold");
  assertSetting(constraints.balanceLateMatches, "Balance late matches");
  parseLocalTime(constraints.balanceLateMatches.value.atOrAfterLocalTime, "Late-match threshold");
  assertSetting(constraints.keepDivisionTogether, "Keep division together");
  assertPositiveInteger(constraints.keepDivisionTogether.value.maximumAreaCount, "Division maximum area count");
  assertSetting(constraints.preserveExistingSchedule, "Preserve existing schedule");
  assertNonNegativeInteger(
    constraints.preserveExistingSchedule.value.maximumShiftMinutes,
    "Existing schedule maximum shift",
  );
  for (const [matchId, existing] of Object.entries(constraints.preserveExistingSchedule.value.byMatchId)) {
    if (!matchIds.has(matchId)) throw new Error(`Existing schedule references unknown match ${matchId}`);
    if (!existing.areaId.trim()) throw new Error(`Existing assignment for ${matchId} requires an area ID`);
    assertEpoch(existing.startEpochMs, `Existing assignment ${matchId} start`);
  }
}

function severityFor(mode: ConstraintMode): "required" | "preferred" | null {
  return mode === "ignored" ? null : mode;
}

function weight(setting: ConstraintSetting<unknown>): number {
  return setting.mode === "preferred" ? (setting.weight ?? 1) : 0;
}

function compareAssignment(left: ScheduleAssignment, right: ScheduleAssignment): number {
  return (
    left.startEpochMs - right.startEpochMs ||
    left.areaId.localeCompare(right.areaId) ||
    left.matchId.localeCompare(right.matchId)
  );
}

export function validateSchedule(
  problem: ScheduleProblem,
  submittedAssignments: readonly ScheduleAssignment[],
): ScheduleValidation {
  validateProblem(problem);
  const violations: ScheduleViolation[] = [];
  const matches = new Map(problem.matches.map((match) => [match.id, match]));
  const slots = new Map(problem.slots.map((slot) => [slot.id, slot]));
  const assignments = new Map<string, ScheduleAssignment>();
  for (const assignment of submittedAssignments) {
    const match = matches.get(assignment.matchId);
    if (!match) {
      violations.push({
        code: "unknown_match",
        severity: "hard",
        matchIds: [assignment.matchId],
        message: `Assignment references unknown match ${assignment.matchId}`,
      });
      continue;
    }
    if (assignments.has(assignment.matchId)) {
      violations.push({
        code: "duplicate_assignment",
        severity: "hard",
        matchIds: [assignment.matchId],
        message: `Match ${assignment.matchId} has more than one assignment`,
      });
      continue;
    }
    assignments.set(assignment.matchId, assignment);
    if (assignment.divisionId !== match.divisionId || assignment.fixed !== (match.fixedAssignment !== undefined)) {
      violations.push({
        code: "assignment_mismatch",
        severity: "hard",
        matchIds: [assignment.matchId],
        message: `Match ${assignment.matchId} assignment metadata does not match its immutable match definition`,
      });
    }
    const slot = slots.get(assignment.slotId);
    if (!slot) {
      violations.push({
        code: "unknown_slot",
        severity: "hard",
        matchIds: [assignment.matchId],
        message: `Match ${assignment.matchId} references unknown slot ${assignment.slotId}`,
      });
    } else if (
      assignment.areaId !== slot.areaId ||
      assignment.intervalId !== slot.intervalId ||
      assignment.startEpochMs !== slot.startEpochMs ||
      assignment.endEpochMs !== slot.endEpochMs
    ) {
      violations.push({
        code: "slot_mismatch",
        severity: "hard",
        matchIds: [assignment.matchId],
        message: `Match ${assignment.matchId} assignment does not exactly match slot ${slot.id}`,
      });
    }
    if (assignment.endEpochMs - assignment.startEpochMs !== match.durationMinutes * MINUTE_MS) {
      violations.push({
        code: "slot_duration",
        severity: "hard",
        matchIds: [assignment.matchId],
        message: `Match ${assignment.matchId} must occupy one full ${match.durationMinutes}-minute slot`,
      });
    }
    const fixed = match.fixedAssignment;
    if (
      fixed &&
      (assignment.areaId !== fixed.areaId ||
        assignment.slotId !== fixed.slotId ||
        assignment.startEpochMs !== fixed.startEpochMs ||
        assignment.endEpochMs !== fixed.endEpochMs)
    ) {
      violations.push({
        code: "fixed_match_moved",
        severity: "hard",
        matchIds: [assignment.matchId],
        message: `${fixed.reason === "locked" ? "Locked" : "Published historical"} match ${assignment.matchId} moved`,
      });
    }
  }
  for (const match of problem.matches) {
    if (!assignments.has(match.id)) {
      violations.push({
        code: "missing_match",
        severity: "hard",
        matchIds: [match.id],
        message: `Match ${match.id} is not scheduled`,
      });
    }
  }

  const assigned = [...assignments.values()].sort(compareAssignment);
  for (let leftIndex = 0; leftIndex < assigned.length; leftIndex += 1) {
    const left = assigned[leftIndex]!;
    const leftMatch = matches.get(left.matchId)!;
    for (let rightIndex = leftIndex + 1; rightIndex < assigned.length; rightIndex += 1) {
      const right = assigned[rightIndex]!;
      const rightMatch = matches.get(right.matchId)!;
      const sharedEntries = leftMatch.possibleEntryIds.filter((entryId) =>
        rightMatch.possibleEntryIds.includes(entryId),
      );
      if (left.areaId === right.areaId && intervalsOverlap(left, right)) {
        violations.push({
          code: "area_overlap",
          severity: "hard",
          matchIds: [left.matchId, right.matchId],
          message: `Playing area ${left.areaId} hosts overlapping matches`,
        });
      }
      if (sharedEntries.length > 0 && intervalsOverlap(left, right)) {
        violations.push({
          code: "possible_entry_overlap",
          severity: "hard",
          matchIds: [left.matchId, right.matchId],
          message: `Possible participant ${sharedEntries[0]} could be in overlapping matches`,
        });
      }
      const sharedOfficials = leftMatch.officialIds.filter((officialId) => rightMatch.officialIds.includes(officialId));
      if (sharedOfficials.length > 0 && intervalsOverlap(left, right)) {
        violations.push({
          code: "official_overlap",
          severity: "hard",
          matchIds: [left.matchId, right.matchId],
          message: `Official ${sharedOfficials[0]} is assigned to overlapping matches`,
        });
      }
      const restSeverity = severityFor(problem.constraints.minimumRest.mode);
      if (restSeverity && sharedEntries.length > 0 && !intervalsOverlap(left, right)) {
        const [earlier, later] = left.endEpochMs <= right.startEpochMs ? [left, right] : [right, left];
        const actualMinutes = (later.startEpochMs - earlier.endEpochMs) / MINUTE_MS;
        const requiredMinutes = problem.constraints.minimumRest.value.minutes;
        if (actualMinutes < requiredMinutes) {
          violations.push({
            code: "minimum_rest",
            severity: restSeverity,
            matchIds: [earlier.matchId, later.matchId],
            message: `Possible participant rest is ${actualMinutes} minutes; configured minimum is ${requiredMinutes}`,
            amount: requiredMinutes - actualMinutes,
          });
        }
      }
      const consecutiveSeverity = severityFor(problem.constraints.avoidConsecutiveMatches.mode);
      if (consecutiveSeverity && sharedEntries.length > 0 && !intervalsOverlap(left, right)) {
        const [earlier, later] = left.endEpochMs <= right.startEpochMs ? [left, right] : [right, left];
        const actualMinutes = (later.startEpochMs - earlier.endEpochMs) / MINUTE_MS;
        const buffer = problem.constraints.avoidConsecutiveMatches.value.minutes;
        if (actualMinutes < buffer) {
          violations.push({
            code: "consecutive_matches",
            severity: consecutiveSeverity,
            matchIds: [earlier.matchId, later.matchId],
            message: `Possible participant has only ${actualMinutes} minutes between consecutive matches; configured buffer is ${buffer}`,
            amount: buffer - actualMinutes,
          });
        }
      }
    }
  }
  for (const match of problem.matches) {
    const assignment = assignments.get(match.id);
    if (!assignment) continue;
    for (const dependencyId of match.dependencyMatchIds) {
      const dependency = assignments.get(dependencyId);
      if (dependency && assignment.startEpochMs < dependency.endEpochMs) {
        violations.push({
          code: "dependency_order",
          severity: "hard",
          matchIds: [dependencyId, match.id],
          message: `Match ${match.id} begins before dependency ${dependencyId} is known`,
        });
      }
    }
  }

  const maximumSeverity = severityFor(problem.constraints.maximumMatchesPerDay.mode);
  if (maximumSeverity) {
    const counts = new Map<string, { count: number; matchIds: string[] }>();
    for (const assignment of assigned) {
      const match = matches.get(assignment.matchId)!;
      const date = localDateKey(assignment.startEpochMs, problem.timeZone);
      for (const entryId of match.possibleEntryIds) {
        const key = `${entryId}\0${date}`;
        const state = counts.get(key) ?? { count: 0, matchIds: [] };
        state.count += 1;
        state.matchIds.push(match.id);
        counts.set(key, state);
      }
    }
    for (const [key, state] of counts) {
      const limit = problem.constraints.maximumMatchesPerDay.value.matches;
      if (state.count > limit) {
        const [entryId, date] = key.split("\0");
        violations.push({
          code: "maximum_matches_per_day",
          severity: maximumSeverity,
          matchIds: state.matchIds,
          message: `Possible participant ${entryId} has ${state.count} matches on ${date}; configured maximum is ${limit}`,
          amount: state.count - limit,
        });
      }
    }
  }

  const unavailableSeverity = severityFor(problem.constraints.entryUnavailable.mode);
  if (unavailableSeverity) {
    for (const assignment of assigned) {
      const match = matches.get(assignment.matchId)!;
      for (const entryId of match.possibleEntryIds) {
        if (
          (problem.constraints.entryUnavailable.value.byEntryId[entryId] ?? []).some((interval) =>
            intervalsOverlap(assignment, interval),
          )
        ) {
          violations.push({
            code: "entry_unavailable",
            severity: unavailableSeverity,
            matchIds: [match.id],
            message: `Possible participant ${entryId} is unavailable for match ${match.id}`,
          });
        }
      }
    }
  }

  const officialAvailabilitySeverity = severityFor(problem.constraints.officialAvailability.mode);
  if (officialAvailabilitySeverity) {
    for (const assignment of assigned) {
      const match = matches.get(assignment.matchId)!;
      for (const officialId of match.officialIds) {
        const availability = problem.constraints.officialAvailability.value.byOfficialId[officialId];
        if (
          !availability?.some(
            (interval) =>
              assignment.startEpochMs >= interval.startEpochMs && assignment.endEpochMs <= interval.endEpochMs,
          )
        ) {
          violations.push({
            code: "official_unavailable",
            severity: officialAvailabilitySeverity,
            matchIds: [match.id],
            message: `Official ${officialId} is unavailable for match ${match.id}`,
          });
        }
      }
    }
  }

  const finalSeverity = severityFor(problem.constraints.preferredFinalTime.mode);
  if (finalSeverity) {
    for (const match of problem.matches.filter((candidate) => candidate.isChampionshipFinal)) {
      const assignment = assignments.get(match.id);
      if (!assignment) continue;
      const delta = Math.abs(
        (assignment.startEpochMs - problem.constraints.preferredFinalTime.value.targetStartEpochMs) / MINUTE_MS,
      );
      const tolerance = problem.constraints.preferredFinalTime.value.toleranceMinutes;
      if (delta > tolerance) {
        violations.push({
          code: "preferred_final_time",
          severity: finalSeverity,
          matchIds: [match.id],
          message: `Championship final is ${delta} minutes from the preferred start; tolerance is ${tolerance}`,
          amount: delta - tolerance,
        });
      }
    }
  }

  const featuredSeverity = severityFor(problem.constraints.featuredPlayingArea.mode);
  if (featuredSeverity) {
    const { areaId, matchIds } = problem.constraints.featuredPlayingArea.value;
    for (const matchId of matchIds) {
      const assignment = assignments.get(matchId);
      if (assignment && assignment.areaId !== areaId) {
        violations.push({
          code: "featured_playing_area",
          severity: featuredSeverity,
          matchIds: [matchId],
          message: `Featured match ${matchId} is on ${assignment.areaId}, not ${areaId}`,
        });
      }
    }
  }

  const earlySeverity = severityFor(problem.constraints.balanceEarlyMatches.mode);
  const lateSeverity = severityFor(problem.constraints.balanceLateMatches.mode);
  const earlyThreshold = parseLocalTime(
    problem.constraints.balanceEarlyMatches.value.beforeLocalTime,
    "Early threshold",
  );
  const lateThreshold = parseLocalTime(
    problem.constraints.balanceLateMatches.value.atOrAfterLocalTime,
    "Late threshold",
  );
  const balanceCounts = (
    predicate: (assignment: ScheduleAssignment) => boolean,
  ): { minimum: number; maximum: number; matchIds: string[] } => {
    const counts = new Map<string, number>();
    const matchIds: string[] = [];
    for (const assignment of assigned) {
      if (!predicate(assignment)) continue;
      matchIds.push(assignment.matchId);
      for (const entryId of matches.get(assignment.matchId)!.possibleEntryIds) {
        counts.set(entryId, (counts.get(entryId) ?? 0) + 1);
      }
    }
    const allEntries = uniqueSorted(problem.matches.flatMap((match) => match.possibleEntryIds));
    const values = allEntries.map((entryId) => counts.get(entryId) ?? 0);
    return {
      minimum: values.length === 0 ? 0 : Math.min(...values),
      maximum: values.length === 0 ? 0 : Math.max(...values),
      matchIds,
    };
  };
  const early = balanceCounts(
    (assignment) => localMinuteOfDay(assignment.startEpochMs, problem.timeZone) < earlyThreshold,
  );
  if (earlySeverity && early.maximum - early.minimum > 1) {
    violations.push({
      code: "early_match_balance",
      severity: earlySeverity,
      matchIds: early.matchIds,
      message: `Early-match allocation differs by ${early.maximum - early.minimum}; allowed spread is one`,
      amount: early.maximum - early.minimum - 1,
    });
  }
  const late = balanceCounts(
    (assignment) => localMinuteOfDay(assignment.startEpochMs, problem.timeZone) >= lateThreshold,
  );
  if (lateSeverity && late.maximum - late.minimum > 1) {
    violations.push({
      code: "late_match_balance",
      severity: lateSeverity,
      matchIds: late.matchIds,
      message: `Late-match allocation differs by ${late.maximum - late.minimum}; allowed spread is one`,
      amount: late.maximum - late.minimum - 1,
    });
  }

  const divisionSeverity = severityFor(problem.constraints.keepDivisionTogether.mode);
  if (divisionSeverity) {
    const byDivision = new Map<string, { areas: Set<string>; matches: string[] }>();
    for (const assignment of assigned) {
      const match = matches.get(assignment.matchId)!;
      const state = byDivision.get(match.divisionId) ?? { areas: new Set<string>(), matches: [] };
      state.areas.add(assignment.areaId);
      state.matches.push(match.id);
      byDivision.set(match.divisionId, state);
    }
    for (const [divisionId, state] of byDivision) {
      const maximum = problem.constraints.keepDivisionTogether.value.maximumAreaCount;
      if (state.areas.size > maximum) {
        violations.push({
          code: "division_area_spread",
          severity: divisionSeverity,
          matchIds: state.matches,
          message: `Division ${divisionId} uses ${state.areas.size} areas; configured maximum is ${maximum}`,
          amount: state.areas.size - maximum,
        });
      }
    }
  }

  const preservationSeverity = severityFor(problem.constraints.preserveExistingSchedule.mode);
  if (preservationSeverity) {
    for (const [matchId, existing] of Object.entries(problem.constraints.preserveExistingSchedule.value.byMatchId)) {
      const assignment = assignments.get(matchId);
      if (!assignment) continue;
      const shift = Math.abs(assignment.startEpochMs - existing.startEpochMs) / MINUTE_MS;
      const maximum = problem.constraints.preserveExistingSchedule.value.maximumShiftMinutes;
      if (assignment.areaId !== existing.areaId || shift > maximum) {
        violations.push({
          code: "existing_schedule_moved",
          severity: preservationSeverity,
          matchIds: [matchId],
          message: `Match ${matchId} moved ${shift} minutes${assignment.areaId === existing.areaId ? "" : " and changed area"}`,
          amount: Math.max(1, shift - maximum),
        });
      }
    }
  }
  return {
    valid: violations.every((violation) => violation.severity === "preferred"),
    violations,
  };
}

function pairRestMinutes(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[]): number[] {
  const matches = new Map(problem.matches.map((match) => [match.id, match]));
  const rests: number[] = [];
  for (let leftIndex = 0; leftIndex < assignments.length; leftIndex += 1) {
    const left = assignments[leftIndex]!;
    const leftMatch = matches.get(left.matchId)!;
    for (let rightIndex = leftIndex + 1; rightIndex < assignments.length; rightIndex += 1) {
      const right = assignments[rightIndex]!;
      const rightMatch = matches.get(right.matchId)!;
      if (!leftMatch.possibleEntryIds.some((entryId) => rightMatch.possibleEntryIds.includes(entryId))) continue;
      if (left.endEpochMs <= right.startEpochMs) rests.push((right.startEpochMs - left.endEpochMs) / MINUTE_MS);
      else if (right.endEpochMs <= left.startEpochMs) rests.push((left.startEpochMs - right.endEpochMs) / MINUTE_MS);
    }
  }
  return rests;
}

function entryDayCounts(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[]): number[] {
  const matches = new Map(problem.matches.map((match) => [match.id, match]));
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    const match = matches.get(assignment.matchId)!;
    const date = localDateKey(assignment.startEpochMs, problem.timeZone);
    for (const entryId of match.possibleEntryIds) {
      const key = `${entryId}\0${date}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()];
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

const OBJECTIVE_WEIGHTS: Record<ScheduleObjective, Record<ScheduleQualityComponent["key"], number>> = {
  fastest: {
    completion: 30,
    rest: 10,
    daily_balance: 10,
    preferred_final: 10,
    featured_area: 5,
    consecutive: 5,
    time_balance: 5,
    division_cohesion: 5,
    schedule_preservation: 10,
    entry_availability: 5,
    official_availability: 5,
  },
  balanced: {
    completion: 15,
    rest: 15,
    daily_balance: 15,
    preferred_final: 10,
    featured_area: 10,
    consecutive: 10,
    time_balance: 10,
    division_cohesion: 5,
    schedule_preservation: 5,
    entry_availability: 3,
    official_availability: 2,
  },
  rest_focused: {
    completion: 10,
    rest: 35,
    daily_balance: 10,
    preferred_final: 5,
    featured_area: 5,
    consecutive: 15,
    time_balance: 5,
    division_cohesion: 5,
    schedule_preservation: 5,
    entry_availability: 3,
    official_availability: 2,
  },
};

/** Explainable, deterministic 0..100 quality; no AI or opaque model score. */
export function evaluateScheduleQuality(
  problem: ScheduleProblem,
  assignments: readonly ScheduleAssignment[],
): ScheduleQuality {
  const validation = validateSchedule(problem, assignments);
  const sorted = [...assignments].sort(compareAssignment);
  const starts = sorted.map((assignment) => assignment.startEpochMs);
  const ends = sorted.map((assignment) => assignment.endEpochMs);
  const makespanMinutes = sorted.length === 0 ? 0 : (Math.max(...ends) - Math.min(...starts)) / MINUTE_MS;
  const scheduledAreaCount = Math.max(1, new Set(sorted.map((assignment) => assignment.areaId)).size);
  const availableAreaCount = Math.max(1, new Set(problem.slots.map((slot) => slot.areaId)).size);
  const occupiedMinutes = problem.matches.reduce((total, match) => total + match.durationMinutes, 0);
  const theoreticalMinimumSpan = occupiedMinutes / availableAreaCount;
  const availableSpanMinutes =
    (Math.max(...problem.slots.map((slot) => slot.endEpochMs)) -
      Math.min(...problem.slots.map((slot) => slot.startEpochMs))) /
    MINUTE_MS;
  const completionRange = Math.max(0, availableSpanMinutes - theoreticalMinimumSpan);
  const completionScore =
    makespanMinutes === 0
      ? 0
      : completionRange === 0
        ? 100
        : roundScore(100 - ((makespanMinutes - theoreticalMinimumSpan) / completionRange) * 100);
  const rests = pairRestMinutes(problem, sorted);
  const minimumRestMinutes = rests.length === 0 ? null : Math.min(...rests);
  const restTarget = Math.max(1, problem.constraints.minimumRest.value.minutes);
  const maximumRestOpportunityMinutes = Math.max(
    0,
    (Math.max(...problem.slots.map((slot) => slot.startEpochMs)) -
      Math.min(...problem.slots.map((slot) => slot.endEpochMs))) /
      MINUTE_MS,
  );
  const restScore =
    minimumRestMinutes === null
      ? 100
      : minimumRestMinutes < restTarget
        ? roundScore((minimumRestMinutes / restTarget) * 50)
        : maximumRestOpportunityMinutes <= restTarget
          ? 100
          : roundScore(
              50 +
                50 *
                  Math.sqrt(
                    Math.min(1, (minimumRestMinutes - restTarget) / (maximumRestOpportunityMinutes - restTarget)),
                  ),
            );
  const dailyCounts = entryDayCounts(problem, sorted);
  const maximumMatchesPerEntryDay = dailyCounts.length === 0 ? 0 : Math.max(...dailyCounts);
  const configuredMaximum = problem.constraints.maximumMatchesPerDay.value.matches;
  const dailyScore = roundScore((configuredMaximum / Math.max(configuredMaximum, maximumMatchesPerEntryDay)) * 100);
  const finalDeltas = problem.matches
    .filter((match) => match.isChampionshipFinal)
    .flatMap((match) => {
      const finalAssignment = sorted.find((assignment) => assignment.matchId === match.id);
      return finalAssignment
        ? [
            Math.abs(
              (finalAssignment.startEpochMs - problem.constraints.preferredFinalTime.value.targetStartEpochMs) /
                MINUTE_MS,
            ),
          ]
        : [];
    });
  const preferredFinalDeltaMinutes = finalDeltas.length === 0 ? null : Math.max(...finalDeltas);
  const finalTolerance = Math.max(1, problem.constraints.preferredFinalTime.value.toleranceMinutes);
  const finalScore =
    problem.constraints.preferredFinalTime.mode === "ignored" || preferredFinalDeltaMinutes === null
      ? 100
      : roundScore(100 - (Math.max(0, preferredFinalDeltaMinutes - finalTolerance) / finalTolerance) * 25);
  const weights = OBJECTIVE_WEIGHTS[problem.objective];
  const preferredOrRequired = validation.violations.filter((violation) => violation.severity !== "hard");
  const violationScore = (codes: readonly ScheduleViolationCode[]) =>
    roundScore(
      100 -
        preferredOrRequired
          .filter((violation) => codes.includes(violation.code))
          .reduce((total, violation) => total + Math.max(1, violation.amount ?? 1) * 10, 0),
    );
  const featuredMatches = problem.constraints.featuredPlayingArea.value.matchIds;
  const featuredCorrect = featuredMatches.filter((matchId) => {
    const assignment = sorted.find((candidate) => candidate.matchId === matchId);
    return assignment?.areaId === problem.constraints.featuredPlayingArea.value.areaId;
  }).length;
  const featuredScore =
    problem.constraints.featuredPlayingArea.mode === "ignored" || featuredMatches.length === 0
      ? 100
      : roundScore((featuredCorrect / featuredMatches.length) * 100);
  const consecutiveScore = violationScore(["consecutive_matches"]);
  const timeBalanceScore = violationScore(["early_match_balance", "late_match_balance"]);
  const divisionScore = violationScore(["division_area_spread"]);
  const preservationScore = violationScore(["existing_schedule_moved"]);
  const entryAvailabilityScore = violationScore(["entry_unavailable"]);
  const officialAvailabilityScore = violationScore(["official_unavailable"]);
  const components: ScheduleQualityComponent[] = [
    {
      key: "completion",
      score: completionScore,
      weight: weights.completion,
      measured: makespanMinutes,
      unit: "minutes",
      explanation: `${problem.matches.length} matches finish within a ${makespanMinutes}-minute span using ${scheduledAreaCount} of ${availableAreaCount} available areas.`,
    },
    {
      key: "rest",
      score: restScore,
      weight: weights.rest,
      measured: minimumRestMinutes ?? restTarget,
      unit: "minutes",
      explanation:
        minimumRestMinutes === null
          ? "No two matches share a possible participant; rest is unconstrained."
          : `The shortest conservative possible-participant rest is ${minimumRestMinutes} minutes.`,
    },
    {
      key: "daily_balance",
      score: dailyScore,
      weight: weights.daily_balance,
      measured: maximumMatchesPerEntryDay,
      unit: "matches",
      explanation: `The busiest possible participant has ${maximumMatchesPerEntryDay} matches on one competition-local day.`,
    },
    {
      key: "preferred_final",
      score: finalScore,
      weight: weights.preferred_final,
      measured: preferredFinalDeltaMinutes ?? 0,
      unit: "minutes",
      explanation:
        preferredFinalDeltaMinutes === null
          ? "The graph has no championship final."
          : `The furthest championship final starts ${preferredFinalDeltaMinutes} minutes from the configured target.`,
    },
    {
      key: "featured_area",
      score: featuredScore,
      weight: weights.featured_area,
      measured: featuredMatches.length === 0 ? 100 : roundScore((featuredCorrect / featuredMatches.length) * 100),
      unit: "percent",
      explanation: `${featuredCorrect} of ${featuredMatches.length} featured matches use the configured featured area.`,
    },
    {
      key: "consecutive",
      score: consecutiveScore,
      weight: weights.consecutive,
      measured: problem.constraints.avoidConsecutiveMatches.value.minutes,
      unit: "minutes",
      explanation: `Consecutive-match spacing is measured against a ${problem.constraints.avoidConsecutiveMatches.value.minutes}-minute buffer.`,
    },
    {
      key: "time_balance",
      score: timeBalanceScore,
      weight: weights.time_balance,
      measured: timeBalanceScore,
      unit: "percent",
      explanation: `Early and late allocations are compared across every possible participant in competition local time.`,
    },
    {
      key: "division_cohesion",
      score: divisionScore,
      weight: weights.division_cohesion,
      measured: problem.constraints.keepDivisionTogether.value.maximumAreaCount,
      unit: "areas",
      explanation: `Division area spread is compared with a ${problem.constraints.keepDivisionTogether.value.maximumAreaCount}-area target.`,
    },
    {
      key: "schedule_preservation",
      score: preservationScore,
      weight: weights.schedule_preservation,
      measured: Object.keys(problem.constraints.preserveExistingSchedule.value.byMatchId).length,
      unit: "matches",
      explanation: `Movement is measured for ${Object.keys(problem.constraints.preserveExistingSchedule.value.byMatchId).length} existing assignments.`,
    },
    {
      key: "entry_availability",
      score: entryAvailabilityScore,
      weight: weights.entry_availability,
      measured: entryAvailabilityScore,
      unit: "percent",
      explanation:
        "Possible-participant assignments are measured against every configured entry availability interval.",
    },
    {
      key: "official_availability",
      score: officialAvailabilityScore,
      weight: weights.official_availability,
      measured: officialAvailabilityScore,
      unit: "percent",
      explanation: "Assigned officials are measured against their configured availability intervals.",
    },
  ];
  const preferredPenalty = validation.violations
    .filter((violation) => violation.severity === "preferred")
    .reduce((total, violation) => {
      const setting: ConstraintSetting<unknown> =
        violation.code === "minimum_rest"
          ? problem.constraints.minimumRest
          : violation.code === "maximum_matches_per_day"
            ? problem.constraints.maximumMatchesPerDay
            : violation.code === "preferred_final_time"
              ? problem.constraints.preferredFinalTime
              : violation.code === "entry_unavailable"
                ? problem.constraints.entryUnavailable
                : violation.code === "official_unavailable"
                  ? problem.constraints.officialAvailability
                  : violation.code === "featured_playing_area"
                    ? problem.constraints.featuredPlayingArea
                    : violation.code === "consecutive_matches"
                      ? problem.constraints.avoidConsecutiveMatches
                      : violation.code === "early_match_balance"
                        ? problem.constraints.balanceEarlyMatches
                        : violation.code === "late_match_balance"
                          ? problem.constraints.balanceLateMatches
                          : violation.code === "division_area_spread"
                            ? problem.constraints.keepDivisionTogether
                            : problem.constraints.preserveExistingSchedule;
      return total + (violation.amount ?? 1) * weight(setting);
    }, 0);
  const score = roundScore(
    components.reduce((total, component) => total + component.score * (component.weight / 100), 0),
  );
  return {
    score,
    objective: problem.objective,
    valid: validation.valid,
    makespanMinutes,
    minimumRestMinutes,
    maximumMatchesPerEntryDay,
    preferredFinalDeltaMinutes,
    requiredViolationCount: validation.violations.filter((violation) => violation.severity !== "preferred").length,
    preferredPenalty,
    components,
  };
}

function topologicalMatches(matches: readonly SchedulingMatch[]): SchedulingMatch[] {
  const remaining = new Map(matches.map((match) => [match.id, match]));
  const complete = new Set<string>();
  const ordered: SchedulingMatch[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((match) => match.dependencyMatchIds.every((dependency) => complete.has(dependency)))
      .sort(
        (left, right) =>
          Number(Boolean(right.fixedAssignment)) - Number(Boolean(left.fixedAssignment)) ||
          left.id.localeCompare(right.id),
      );
    if (ready.length === 0) throw new Error("Schedule match graph contains a dependency cycle");
    for (const match of ready) {
      remaining.delete(match.id);
      complete.add(match.id);
      ordered.push(match);
    }
  }
  return ordered;
}

function assignmentFor(match: SchedulingMatch, slot: SchedulingSlot): ScheduleAssignment {
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

function partialAllows(
  problem: ScheduleProblem,
  match: SchedulingMatch,
  candidate: ScheduleAssignment,
  assigned: ReadonlyMap<string, ScheduleAssignment>,
): boolean {
  if (candidate.endEpochMs - candidate.startEpochMs !== match.durationMinutes * MINUTE_MS) return false;
  const fixed = match.fixedAssignment;
  if (
    fixed &&
    (candidate.slotId !== fixed.slotId ||
      candidate.areaId !== fixed.areaId ||
      candidate.startEpochMs !== fixed.startEpochMs ||
      candidate.endEpochMs !== fixed.endEpochMs)
  ) {
    return false;
  }
  for (const dependency of match.dependencyMatchIds) {
    const prior = assigned.get(dependency);
    if (!prior || candidate.startEpochMs < prior.endEpochMs) return false;
  }
  const matches = new Map(problem.matches.map((value) => [value.id, value]));
  for (const prior of assigned.values()) {
    const priorMatch = matches.get(prior.matchId)!;
    if (prior.areaId === candidate.areaId && intervalsOverlap(prior, candidate)) return false;
    const sharesPossibleEntry = match.possibleEntryIds.some((entryId) => priorMatch.possibleEntryIds.includes(entryId));
    if (sharesPossibleEntry && intervalsOverlap(prior, candidate)) return false;
    if (
      match.officialIds.some((officialId) => priorMatch.officialIds.includes(officialId)) &&
      intervalsOverlap(prior, candidate)
    ) {
      return false;
    }
    if (sharesPossibleEntry && problem.constraints.minimumRest.mode === "required") {
      const gap =
        prior.endEpochMs <= candidate.startEpochMs
          ? candidate.startEpochMs - prior.endEpochMs
          : prior.startEpochMs >= candidate.endEpochMs
            ? prior.startEpochMs - candidate.endEpochMs
            : -1;
      if (gap < problem.constraints.minimumRest.value.minutes * MINUTE_MS) return false;
    }
    if (sharesPossibleEntry && problem.constraints.avoidConsecutiveMatches.mode === "required") {
      const gap =
        prior.endEpochMs <= candidate.startEpochMs
          ? candidate.startEpochMs - prior.endEpochMs
          : prior.startEpochMs >= candidate.endEpochMs
            ? prior.startEpochMs - candidate.endEpochMs
            : -1;
      if (gap < problem.constraints.avoidConsecutiveMatches.value.minutes * MINUTE_MS) return false;
    }
  }
  if (problem.constraints.entryUnavailable.mode === "required") {
    for (const entryId of match.possibleEntryIds) {
      if (
        (problem.constraints.entryUnavailable.value.byEntryId[entryId] ?? []).some((interval) =>
          intervalsOverlap(candidate, interval),
        )
      ) {
        return false;
      }
    }
  }
  if (problem.constraints.officialAvailability.mode === "required") {
    for (const officialId of match.officialIds) {
      const availability = problem.constraints.officialAvailability.value.byOfficialId[officialId];
      if (
        !availability?.some(
          (interval) => candidate.startEpochMs >= interval.startEpochMs && candidate.endEpochMs <= interval.endEpochMs,
        )
      ) {
        return false;
      }
    }
  }
  if (problem.constraints.maximumMatchesPerDay.mode === "required") {
    const date = localDateKey(candidate.startEpochMs, problem.timeZone);
    for (const entryId of match.possibleEntryIds) {
      const count = [...assigned.values()].filter((prior) => {
        const priorMatch = matches.get(prior.matchId)!;
        return (
          priorMatch.possibleEntryIds.includes(entryId) && localDateKey(prior.startEpochMs, problem.timeZone) === date
        );
      }).length;
      if (count >= problem.constraints.maximumMatchesPerDay.value.matches) return false;
    }
  }
  if (match.isChampionshipFinal && problem.constraints.preferredFinalTime.mode === "required") {
    const delta = Math.abs(candidate.startEpochMs - problem.constraints.preferredFinalTime.value.targetStartEpochMs);
    if (delta > problem.constraints.preferredFinalTime.value.toleranceMinutes * MINUTE_MS) return false;
  }
  if (
    problem.constraints.featuredPlayingArea.mode === "required" &&
    problem.constraints.featuredPlayingArea.value.matchIds.includes(match.id) &&
    candidate.areaId !== problem.constraints.featuredPlayingArea.value.areaId
  ) {
    return false;
  }
  if (problem.constraints.keepDivisionTogether.mode === "required") {
    const matches = new Map(problem.matches.map((value) => [value.id, value]));
    const areas = new Set(
      [...assigned.values()]
        .filter((prior) => matches.get(prior.matchId)!.divisionId === match.divisionId)
        .map((prior) => prior.areaId),
    );
    areas.add(candidate.areaId);
    if (areas.size > problem.constraints.keepDivisionTogether.value.maximumAreaCount) return false;
  }
  if (problem.constraints.preserveExistingSchedule.mode === "required") {
    const existing = problem.constraints.preserveExistingSchedule.value.byMatchId[match.id];
    if (existing) {
      const shift = Math.abs(candidate.startEpochMs - existing.startEpochMs) / MINUTE_MS;
      if (
        candidate.areaId !== existing.areaId ||
        shift > problem.constraints.preserveExistingSchedule.value.maximumShiftMinutes
      ) {
        return false;
      }
    }
  }
  return true;
}

function candidateRank(
  problem: ScheduleProblem,
  match: SchedulingMatch,
  candidate: ScheduleAssignment,
  assigned: ReadonlyMap<string, ScheduleAssignment>,
): readonly number[] {
  const matches = new Map(problem.matches.map((value) => [value.id, value]));
  const shared = [...assigned.values()].filter((prior) => {
    const priorMatch = matches.get(prior.matchId)!;
    return match.possibleEntryIds.some((entryId) => priorMatch.possibleEntryIds.includes(entryId));
  });
  const nearestRest = shared.length
    ? Math.min(
        ...shared.map((prior) =>
          Math.max(
            0,
            (prior.endEpochMs <= candidate.startEpochMs
              ? candidate.startEpochMs - prior.endEpochMs
              : prior.startEpochMs - candidate.endEpochMs) / MINUTE_MS,
          ),
        ),
      )
    : Number.MAX_SAFE_INTEGER;
  const date = localDateKey(candidate.startEpochMs, problem.timeZone);
  const dailyLoad = Math.max(
    0,
    ...match.possibleEntryIds.map(
      (entryId) =>
        [...assigned.values()].filter((prior) => {
          const priorMatch = matches.get(prior.matchId)!;
          return (
            priorMatch.possibleEntryIds.includes(entryId) && localDateKey(prior.startEpochMs, problem.timeZone) === date
          );
        }).length + 1,
    ),
  );
  const finalDelta =
    match.isChampionshipFinal && problem.constraints.preferredFinalTime.mode !== "ignored"
      ? Math.abs(candidate.startEpochMs - problem.constraints.preferredFinalTime.value.targetStartEpochMs) / MINUTE_MS
      : 0;
  const preferredRestShortfall =
    problem.constraints.minimumRest.mode === "preferred"
      ? Math.max(0, problem.constraints.minimumRest.value.minutes - nearestRest)
      : 0;
  const preferredDailyExcess =
    problem.constraints.maximumMatchesPerDay.mode === "preferred"
      ? Math.max(0, dailyLoad - problem.constraints.maximumMatchesPerDay.value.matches)
      : 0;
  const preferredEntryUnavailable =
    problem.constraints.entryUnavailable.mode === "preferred"
      ? match.possibleEntryIds.filter((entryId) =>
          (problem.constraints.entryUnavailable.value.byEntryId[entryId] ?? []).some((interval) =>
            intervalsOverlap(candidate, interval),
          ),
        ).length
      : 0;
  const preferredOfficialUnavailable =
    problem.constraints.officialAvailability.mode === "preferred"
      ? match.officialIds.filter(
          (officialId) =>
            !problem.constraints.officialAvailability.value.byOfficialId[officialId]?.some(
              (interval) =>
                candidate.startEpochMs >= interval.startEpochMs && candidate.endEpochMs <= interval.endEpochMs,
            ),
        ).length
      : 0;
  const preferredFeaturedArea =
    problem.constraints.featuredPlayingArea.mode === "preferred" &&
    problem.constraints.featuredPlayingArea.value.matchIds.includes(match.id) &&
    candidate.areaId !== problem.constraints.featuredPlayingArea.value.areaId
      ? 1
      : 0;
  const preferredConsecutiveShortfall =
    problem.constraints.avoidConsecutiveMatches.mode === "preferred"
      ? Math.max(0, problem.constraints.avoidConsecutiveMatches.value.minutes - nearestRest)
      : 0;
  const divisionAreas = new Set(
    [...assigned.values()]
      .filter((prior) => matches.get(prior.matchId)!.divisionId === match.divisionId)
      .map((prior) => prior.areaId),
  );
  divisionAreas.add(candidate.areaId);
  const preferredDivisionExcess =
    problem.constraints.keepDivisionTogether.mode === "preferred"
      ? Math.max(0, divisionAreas.size - problem.constraints.keepDivisionTogether.value.maximumAreaCount)
      : 0;
  const existing = problem.constraints.preserveExistingSchedule.value.byMatchId[match.id];
  const preferredPreservation =
    problem.constraints.preserveExistingSchedule.mode === "preferred" && existing
      ? (candidate.areaId === existing.areaId ? 0 : 1) +
        Math.max(
          0,
          Math.abs(candidate.startEpochMs - existing.startEpochMs) / MINUTE_MS -
            problem.constraints.preserveExistingSchedule.value.maximumShiftMinutes,
        )
      : 0;
  const balanceSpread = (kind: "early" | "late"): number => {
    const threshold =
      kind === "early"
        ? parseLocalTime(problem.constraints.balanceEarlyMatches.value.beforeLocalTime, "Early threshold")
        : parseLocalTime(problem.constraints.balanceLateMatches.value.atOrAfterLocalTime, "Late threshold");
    const qualifies = (assignment: ScheduleAssignment) =>
      kind === "early"
        ? localMinuteOfDay(assignment.startEpochMs, problem.timeZone) < threshold
        : localMinuteOfDay(assignment.startEpochMs, problem.timeZone) >= threshold;
    const counts = new Map<string, number>();
    for (const current of [...assigned.values(), candidate]) {
      if (!qualifies(current)) continue;
      for (const entryId of matches.get(current.matchId)!.possibleEntryIds) {
        counts.set(entryId, (counts.get(entryId) ?? 0) + 1);
      }
    }
    const allEntries = uniqueSorted(problem.matches.flatMap((current) => current.possibleEntryIds));
    const values = allEntries.map((entryId) => counts.get(entryId) ?? 0);
    return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
  };
  const preferredEarlySpread =
    problem.constraints.balanceEarlyMatches.mode === "preferred" ? Math.max(0, balanceSpread("early") - 1) : 0;
  const preferredLateSpread =
    problem.constraints.balanceLateMatches.mode === "preferred" ? Math.max(0, balanceSpread("late") - 1) : 0;
  const preferencePenalty =
    preferredRestShortfall * weight(problem.constraints.minimumRest) +
    preferredDailyExcess * weight(problem.constraints.maximumMatchesPerDay) +
    (match.isChampionshipFinal && problem.constraints.preferredFinalTime.mode === "preferred"
      ? Math.max(0, finalDelta - problem.constraints.preferredFinalTime.value.toleranceMinutes) *
        weight(problem.constraints.preferredFinalTime)
      : 0) +
    preferredEntryUnavailable * weight(problem.constraints.entryUnavailable) +
    preferredOfficialUnavailable * weight(problem.constraints.officialAvailability) +
    preferredFeaturedArea * weight(problem.constraints.featuredPlayingArea) +
    preferredConsecutiveShortfall * weight(problem.constraints.avoidConsecutiveMatches) +
    preferredEarlySpread * weight(problem.constraints.balanceEarlyMatches) +
    preferredLateSpread * weight(problem.constraints.balanceLateMatches) +
    preferredDivisionExcess * weight(problem.constraints.keepDivisionTogether) +
    preferredPreservation * weight(problem.constraints.preserveExistingSchedule);
  if (problem.objective === "fastest") return [preferencePenalty, candidate.endEpochMs, dailyLoad, -nearestRest];
  if (problem.objective === "balanced")
    return [preferencePenalty, candidate.endEpochMs, dailyLoad, finalDelta, -nearestRest];
  return [preferencePenalty, -nearestRest, dailyLoad, candidate.endEpochMs, finalDelta];
}

function compareRank(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Deterministic baseline solver used by workers and reproducible fixture tests. */
function stableIterationIndex(iteration: number, matchId: string, candidateCount: number): number {
  if (iteration === 0 || candidateCount <= 1) return 0;
  let offset = 0;
  for (const character of matchId) offset = Math.imul(offset ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return (offset + iteration) % candidateCount;
}

function generateIteration(problem: ScheduleProblem, iteration: number): ScheduleAssignment[] {
  validateProblem(problem);
  const slots = [...problem.slots].sort(
    (left, right) =>
      left.startEpochMs - right.startEpochMs ||
      left.areaId.localeCompare(right.areaId) ||
      left.id.localeCompare(right.id),
  );
  const assigned = new Map<string, ScheduleAssignment>();
  for (const match of topologicalMatches(problem.matches)) {
    let candidates = slots
      .filter((slot) => ![...assigned.values()].some((assignment) => assignment.slotId === slot.id))
      .map((slot) => assignmentFor(match, slot))
      .filter((assignment) => partialAllows(problem, match, assignment, assigned));
    if (match.fixedAssignment)
      candidates = candidates.filter((candidate) => candidate.slotId === match.fixedAssignment!.slotId);
    candidates.sort((left, right) => {
      const ranked = compareRank(
        candidateRank(problem, match, left, assigned),
        candidateRank(problem, match, right, assigned),
      );
      return ranked || left.areaId.localeCompare(right.areaId) || left.slotId.localeCompare(right.slotId);
    });
    const selected = candidates[stableIterationIndex(iteration, match.id, candidates.length)];
    if (!selected) throw new Error(`No valid slot remains for match ${match.id}`);
    assigned.set(match.id, selected);
  }
  const result = [...assigned.values()].sort(compareAssignment);
  const validation = validateSchedule(problem, result);
  if (!validation.valid) {
    const first = validation.violations.find((violation) => violation.severity !== "preferred");
    throw new Error(`Generated schedule is invalid: ${first?.message ?? "unknown violation"}`);
  }
  return result;
}

export function generateConstraintAwareSchedule(problem: ScheduleProblem): ScheduleAssignment[] {
  try {
    return generateIteration(problem, 0);
  } catch (error) {
    if (
      problem.objective === "fastest" ||
      !(error instanceof Error) ||
      !error.message.startsWith("No valid slot remains")
    ) {
      throw error;
    }
    // Preference-led greedy placement may consume a scarce late slot. Fall
    // back to the deterministic feasibility-first baseline; workers can then
    // continue exploring preferred quality without losing a valid draft.
    return generateIteration({ ...problem, objective: "fastest" }, 0);
  }
}

/**
 * Bounded deterministic exploration for cancellable worker loops. Each
 * iteration is independent, so a worker checkpoints between entries and can
 * resume with only `startIteration` plus its persisted current best.
 */
export function generateScheduleCandidates(
  problem: ScheduleProblem,
  options: ScheduleCandidateOptions = {},
): ScheduleCandidate[] {
  const startIteration = options.startIteration ?? 0;
  const maxIterations = options.maxIterations ?? 1;
  assertNonNegativeInteger(startIteration, "Candidate start iteration");
  assertPositiveInteger(maxIterations, "Candidate iteration count");
  if (maxIterations > 256) throw new Error("Candidate iteration count cannot exceed 256 per worker step");
  const candidates: ScheduleCandidate[] = [];
  const seen = new Set<string>();
  const add = (iteration: number, assignments: readonly ScheduleAssignment[]) => {
    const key = assignments
      .map((assignment) => `${assignment.matchId}:${assignment.slotId}`)
      .sort()
      .join("|");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ iteration, assignments: [...assignments].sort(compareAssignment) });
  };
  let firstGeneratedIteration = startIteration;
  if (options.seedAssignments) {
    if (!validateSchedule(problem, options.seedAssignments).valid) {
      throw new Error("Seed assignments must form a valid complete schedule");
    }
    add(startIteration, options.seedAssignments);
    firstGeneratedIteration += 1;
  }
  const endExclusive = startIteration + maxIterations;
  for (let iteration = firstGeneratedIteration; iteration < endExclusive; iteration += 1) {
    try {
      add(iteration, generateIteration(problem, iteration));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("No valid slot remains")) throw error;
    }
  }
  return candidates;
}

/** Converts camel-case domain objects to the stable persistence/worker payload. */
export function toScheduleJobInput(
  problem: ScheduleProblem,
  identity: {
    jobId: string;
    competitionId: string;
    sourceRevision: number;
    capacityRevision: number;
    capacityHash: string;
  },
): {
  schema_version: 1;
  job_id: string;
  competition_id: string;
  source_revision: number;
  capacity_revision: number;
  capacity_hash: string;
  time_zone: string;
  objective: ScheduleObjective;
  matches: readonly Record<string, unknown>[];
  slots: readonly Record<string, unknown>[];
  constraints: Record<string, unknown>;
} {
  validateProblem(problem);
  if (!UUID_PATTERN.test(identity.jobId) || !UUID_PATTERN.test(identity.competitionId)) {
    throw new Error("Job and competition IDs must be canonical UUIDs");
  }
  assertPositiveInteger(identity.sourceRevision, "Source revision");
  assertPositiveInteger(identity.capacityRevision, "Capacity revision");
  if (!/^[0-9a-f]{64}$/.test(identity.capacityHash))
    throw new Error("Capacity hash must be 64 lowercase hex characters");
  const setting = <T>(input: ConstraintSetting<T>, value: unknown) => ({
    mode: input.mode,
    value,
    ...(input.weight === undefined ? {} : { weight: input.weight }),
  });
  return {
    schema_version: 1,
    job_id: identity.jobId,
    competition_id: identity.competitionId,
    source_revision: identity.sourceRevision,
    capacity_revision: identity.capacityRevision,
    capacity_hash: identity.capacityHash,
    time_zone: problem.timeZone,
    objective: problem.objective,
    matches: problem.matches.map((match) => ({
      match_id: match.id,
      division_id: match.divisionId,
      duration_minutes: match.durationMinutes,
      dependency_match_ids: match.dependencyMatchIds,
      possible_entry_ids: match.possibleEntryIds,
      official_ids: match.officialIds,
      is_championship_final: match.isChampionshipFinal,
      ...(match.fixedAssignment
        ? {
            fixed_assignment: {
              reason: match.fixedAssignment.reason,
              area_id: match.fixedAssignment.areaId,
              slot_id: match.fixedAssignment.slotId,
              start_epoch_ms: match.fixedAssignment.startEpochMs,
              end_epoch_ms: match.fixedAssignment.endEpochMs,
            },
          }
        : {}),
    })),
    slots: problem.slots.map((slot) => ({
      slot_id: slot.id,
      interval_id: slot.intervalId,
      area_id: slot.areaId,
      start_epoch_ms: slot.startEpochMs,
      end_epoch_ms: slot.endEpochMs,
    })),
    constraints: {
      minimum_rest: setting(problem.constraints.minimumRest, {
        minutes: problem.constraints.minimumRest.value.minutes,
      }),
      maximum_matches_per_day: setting(problem.constraints.maximumMatchesPerDay, {
        matches: problem.constraints.maximumMatchesPerDay.value.matches,
      }),
      preferred_final_time: setting(problem.constraints.preferredFinalTime, {
        target_start_epoch_ms: problem.constraints.preferredFinalTime.value.targetStartEpochMs,
        tolerance_minutes: problem.constraints.preferredFinalTime.value.toleranceMinutes,
      }),
      entry_unavailable: setting(problem.constraints.entryUnavailable, {
        by_entry_id: Object.fromEntries(
          Object.entries(problem.constraints.entryUnavailable.value.byEntryId).map(([entryId, intervals]) => [
            entryId,
            intervals.map((interval) => ({
              start_epoch_ms: interval.startEpochMs,
              end_epoch_ms: interval.endEpochMs,
            })),
          ]),
        ),
      }),
      official_availability: setting(problem.constraints.officialAvailability, {
        by_official_id: Object.fromEntries(
          Object.entries(problem.constraints.officialAvailability.value.byOfficialId).map(([officialId, intervals]) => [
            officialId,
            intervals.map((interval) => ({
              start_epoch_ms: interval.startEpochMs,
              end_epoch_ms: interval.endEpochMs,
            })),
          ]),
        ),
      }),
      featured_playing_area: setting(problem.constraints.featuredPlayingArea, {
        area_id: problem.constraints.featuredPlayingArea.value.areaId,
        match_ids: problem.constraints.featuredPlayingArea.value.matchIds,
      }),
      avoid_consecutive_matches: setting(problem.constraints.avoidConsecutiveMatches, {
        minutes: problem.constraints.avoidConsecutiveMatches.value.minutes,
      }),
      balance_early_matches: setting(problem.constraints.balanceEarlyMatches, {
        before_local_time: problem.constraints.balanceEarlyMatches.value.beforeLocalTime,
      }),
      balance_late_matches: setting(problem.constraints.balanceLateMatches, {
        at_or_after_local_time: problem.constraints.balanceLateMatches.value.atOrAfterLocalTime,
      }),
      keep_division_together: setting(problem.constraints.keepDivisionTogether, {
        maximum_area_count: problem.constraints.keepDivisionTogether.value.maximumAreaCount,
      }),
      preserve_existing_schedule: setting(problem.constraints.preserveExistingSchedule, {
        maximum_shift_minutes: problem.constraints.preserveExistingSchedule.value.maximumShiftMinutes,
        by_match_id: Object.fromEntries(
          Object.entries(problem.constraints.preserveExistingSchedule.value.byMatchId).map(([matchId, existing]) => [
            matchId,
            { area_id: existing.areaId, start_epoch_ms: existing.startEpochMs },
          ]),
        ),
      }),
    },
  };
}
