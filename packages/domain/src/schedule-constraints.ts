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
  | "existing_schedule_moved"
  | "insufficient_capacity";

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

// Intl formatting dominated solver time when repeated per candidate slot, so formatters are built
// once per time zone and results are memoised per (zone, instant). Slot instants repeat across
// iterations; the memo is cleared when it grows large so long-lived processes stay bounded.
const LOCAL_TIME_MEMO_LIMIT = 200_000;
const localTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const localTimeMemo = new Map<string, number | string>();

function localTimeFormatter(locale: "en-CA" | "en-GB", timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  let formatter = localTimeFormatters.get(key);
  if (!formatter) {
    formatter =
      locale === "en-CA"
        ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        : new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    localTimeFormatters.set(key, formatter);
  }
  return formatter;
}

function rememberLocalTime<T extends number | string>(key: string, value: T): T {
  if (localTimeMemo.size >= LOCAL_TIME_MEMO_LIMIT) localTimeMemo.clear();
  localTimeMemo.set(key, value);
  return value;
}

function localDateKey(epochMs: number, timeZone: string): string {
  const memoKey = `d|${timeZone}|${epochMs}`;
  const cached = localTimeMemo.get(memoKey);
  if (cached !== undefined) return cached as string;
  const values = Object.fromEntries(
    localTimeFormatter("en-CA", timeZone)
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return rememberLocalTime(memoKey, `${values.year}-${values.month}-${values.day}`);
}

function localMinuteOfDay(epochMs: number, timeZone: string): number {
  const memoKey = `m|${timeZone}|${epochMs}`;
  const cached = localTimeMemo.get(memoKey);
  if (cached !== undefined) return cached as number;
  const parts = Object.fromEntries(
    localTimeFormatter("en-GB", timeZone)
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return rememberLocalTime(memoKey, (parts.hour ?? 0) * 60 + (parts.minute ?? 0));
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

function buildTransitiveDependencies(matches: readonly SchedulingMatch[]): Map<string, Set<string>> {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const ancestors = new Map<string, Set<string>>();
  function getAncestors(id: string): Set<string> {
    const existing = ancestors.get(id);
    if (existing) return existing;
    const match = byId.get(id);
    const set = new Set<string>(match?.dependencyMatchIds ?? []);
    for (const depId of match?.dependencyMatchIds ?? []) {
      for (const anc of getAncestors(depId)) {
        set.add(anc);
      }
    }
    ancestors.set(id, set);
    return set;
  }
  for (const match of matches) {
    getAncestors(match.id);
  }
  return ancestors;
}

function maxMatchesForEntryInCollection(
  entryId: string,
  matches: readonly SchedulingMatch[],
  ancestorsByMatchId: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  const relevant = matches.filter((m) => m.possibleEntryIds.includes(entryId));
  if (relevant.length <= 1) return relevant.length;
  const definite = relevant.filter((m) => m.possibleEntryIds.length === 2);
  const advancement = relevant.filter((m) => m.possibleEntryIds.length > 2);
  if (advancement.length === 0) return definite.length;

  const advIds = new Set(advancement.map((m) => m.id));
  const memo = new Map<string, number>();
  function chainLen(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const ancestors = ancestorsByMatchId.get(id);
    let maxPrev = 0;
    if (ancestors) {
      for (const prevId of advIds) {
        if (ancestors.has(prevId)) {
          const len = chainLen(prevId);
          if (len > maxPrev) maxPrev = len;
        }
      }
    }
    const res = 1 + maxPrev;
    memo.set(id, res);
    return res;
  }

  let maxAdvChain = 0;
  for (const m of advancement) {
    const len = chainLen(m.id);
    if (len > maxAdvChain) maxAdvChain = len;
  }

  return definite.length + maxAdvChain;
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
    const ancestors = buildTransitiveDependencies(problem.matches);
    const matchesByDate = new Map<string, SchedulingMatch[]>();
    for (const assignment of assigned) {
      const match = matches.get(assignment.matchId)!;
      const date = localDateKey(assignment.startEpochMs, problem.timeZone);
      const list = matchesByDate.get(date) ?? [];
      list.push(match);
      matchesByDate.set(date, list);
    }
    const limit = problem.constraints.maximumMatchesPerDay.value.matches;
    for (const [date, dayMatches] of matchesByDate) {
      const dayEntries = new Set(dayMatches.flatMap((m) => m.possibleEntryIds));
      for (const entryId of dayEntries) {
        const count = maxMatchesForEntryInCollection(entryId, dayMatches, ancestors);
        if (count > limit) {
          const matchIds = dayMatches.filter((m) => m.possibleEntryIds.includes(entryId)).map((m) => m.id);
          violations.push({
            code: "maximum_matches_per_day",
            severity: maximumSeverity,
            matchIds,
            message: `Possible participant ${entryId} has ${count} matches on ${date}; configured maximum is ${limit}`,
            amount: count - limit,
          });
        }
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
  const ancestors = buildTransitiveDependencies(problem.matches);
  const matchesByDate = new Map<string, SchedulingMatch[]>();
  for (const assignment of assignments) {
    const match = matches.get(assignment.matchId)!;
    const date = localDateKey(assignment.startEpochMs, problem.timeZone);
    const list = matchesByDate.get(date) ?? [];
    list.push(match);
    matchesByDate.set(date, list);
  }
  const counts: number[] = [];
  for (const dayMatches of matchesByDate.values()) {
    const dayEntries = new Set(dayMatches.flatMap((m) => m.possibleEntryIds));
    for (const entryId of dayEntries) {
      counts.push(maxMatchesForEntryInCollection(entryId, dayMatches, ancestors));
    }
  }
  return counts;
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
  const existingAssignments = Object.entries(problem.constraints.preserveExistingSchedule.value.byMatchId);
  const movement = existingAssignments.reduce(
    (summary, [matchId, existing]) => {
      const assignment = sorted.find((candidate) => candidate.matchId === matchId);
      if (!assignment) return summary;
      const startShiftMinutes = Math.abs(assignment.startEpochMs - existing.startEpochMs) / MINUTE_MS;
      const changedArea = assignment.areaId !== existing.areaId;
      if (startShiftMinutes > 0 || changedArea) summary.movedMatchCount += 1;
      summary.totalStartShiftMinutes = Math.round((summary.totalStartShiftMinutes + startShiftMinutes) * 100) / 100;
      if (changedArea) summary.areaChangeCount += 1;
      return summary;
    },
    { movedMatchCount: 0, totalStartShiftMinutes: 0, areaChangeCount: 0 },
  );
  const areaChangeSummary = `${movement.areaChangeCount} playing-area ${movement.areaChangeCount === 1 ? "change" : "changes"}`;
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
      measured: movement.movedMatchCount,
      unit: "matches",
      explanation: `${movement.movedMatchCount} of ${existingAssignments.length} existing assignments move; total start-time shift is ${movement.totalStartShiftMinutes} minutes with ${areaChangeSummary}.`,
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

/**
 * `id` places each dependency layer in match-id order. `interleaved` mixes divisions in proportion
 * to their ready matches: with id-ordered divisions (e.g. graph ids before materialisation) one
 * division's whole round goes first and can push another division's knockouts out of the event.
 */
type MatchOrder = "id" | "interleaved";

function topologicalMatches(matches: readonly SchedulingMatch[], order: MatchOrder = "id"): SchedulingMatch[] {
  const remaining = new Map(matches.map((match) => [match.id, match]));
  const complete = new Set<string>();
  const ordered: SchedulingMatch[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((match) => match.dependencyMatchIds.every((dependency) => complete.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error("Schedule match graph contains a dependency cycle");
    const progress = new Map<string, number>();
    if (order === "interleaved") {
      const byDivision = new Map<string, SchedulingMatch[]>();
      for (const match of ready) byDivision.set(match.divisionId, [...(byDivision.get(match.divisionId) ?? []), match]);
      for (const list of byDivision.values())
        list.forEach((match, index) => progress.set(match.id, (index + 0.5) / list.length));
    }
    ready.sort(
      (left, right) =>
        Number(Boolean(right.fixedAssignment)) - Number(Boolean(left.fixedAssignment)) ||
        (progress.get(left.id) ?? 0) - (progress.get(right.id) ?? 0) ||
        (order === "interleaved" ? left.divisionId.localeCompare(right.divisionId) : 0) ||
        left.id.localeCompare(right.id),
    );
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

/** Lookups shared by every iteration and relaxation rung; keyed on the problem's shared arrays. */
type SlotIndex = {
  sortedSlots: readonly SchedulingSlot[];
  dateByStart: ReadonlyMap<number, string>;
  minuteByStart: ReadonlyMap<number, number>;
};

type MatchIndex = {
  orderedMatches: Readonly<Record<MatchOrder, readonly SchedulingMatch[]>>;
  matchesById: ReadonlyMap<string, SchedulingMatch>;
  allEntryIds: readonly string[];
  ancestorsByMatchId: ReadonlyMap<string, ReadonlySet<string>>;
};

const slotIndexCache = new WeakMap<readonly SchedulingSlot[], Map<string, SlotIndex>>();
const matchIndexCache = new WeakMap<readonly SchedulingMatch[], MatchIndex>();

function slotIndexFor(problem: ScheduleProblem): SlotIndex {
  let byZone = slotIndexCache.get(problem.slots);
  if (!byZone) {
    byZone = new Map();
    slotIndexCache.set(problem.slots, byZone);
  }
  const cached = byZone.get(problem.timeZone);
  if (cached) return cached;
  const sortedSlots = [...problem.slots].sort(
    (left, right) =>
      left.startEpochMs - right.startEpochMs ||
      left.areaId.localeCompare(right.areaId) ||
      left.id.localeCompare(right.id),
  );
  const index: SlotIndex = {
    sortedSlots,
    dateByStart: new Map(
      sortedSlots.map((slot) => [slot.startEpochMs, localDateKey(slot.startEpochMs, problem.timeZone)]),
    ),
    minuteByStart: new Map(
      sortedSlots.map((slot) => [slot.startEpochMs, localMinuteOfDay(slot.startEpochMs, problem.timeZone)]),
    ),
  };
  byZone.set(problem.timeZone, index);
  return index;
}

function matchIndexFor(problem: ScheduleProblem): MatchIndex {
  const cached = matchIndexCache.get(problem.matches);
  if (cached) return cached;
  const index: MatchIndex = {
    orderedMatches: {
      id: topologicalMatches(problem.matches, "id"),
      interleaved: topologicalMatches(problem.matches, "interleaved"),
    },
    matchesById: new Map(problem.matches.map((match) => [match.id, match])),
    allEntryIds: uniqueSorted(problem.matches.flatMap((match) => match.possibleEntryIds)),
    ancestorsByMatchId: buildTransitiveDependencies(problem.matches),
  };
  matchIndexCache.set(problem.matches, index);
  return index;
}

function pushTo<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Incremental placement state: every hard check and ranking term only needs the assignments that
 * share an area, entry, official, date or division with the match being placed, so they are kept
 * indexed instead of rescanning every placed match for every candidate slot.
 */
class PlacementState {
  readonly assigned = new Map<string, ScheduleAssignment>();
  readonly usedSlotIds = new Set<string>();
  readonly byArea = new Map<string, ScheduleAssignment[]>();
  readonly byEntry = new Map<string, ScheduleAssignment[]>();
  readonly byOfficial = new Map<string, ScheduleAssignment[]>();
  readonly matchesByDate = new Map<string, SchedulingMatch[]>();
  readonly areasByDivision = new Map<string, Set<string>>();
  readonly earlyCounts = new Map<string, number>();
  readonly lateCounts = new Map<string, number>();

  constructor(
    readonly slotIndex: SlotIndex,
    readonly earlyThreshold: number,
    readonly lateThreshold: number,
    /** `${areaId}|${startEpochMs}` of each match's previous assignment, when preserve-existing applies. */
    readonly existingSlotOwners: ReadonlyMap<string, string> = new Map(),
  ) {}

  add(match: SchedulingMatch, assignment: ScheduleAssignment): void {
    this.assigned.set(match.id, assignment);
    this.usedSlotIds.add(assignment.slotId);
    pushTo(this.byArea, assignment.areaId, assignment);
    for (const entryId of new Set(match.possibleEntryIds)) pushTo(this.byEntry, entryId, assignment);
    for (const officialId of new Set(match.officialIds)) pushTo(this.byOfficial, officialId, assignment);
    pushTo(this.matchesByDate, this.slotIndex.dateByStart.get(assignment.startEpochMs)!, match);
    let areas = this.areasByDivision.get(match.divisionId);
    if (!areas) {
      areas = new Set();
      this.areasByDivision.set(match.divisionId, areas);
    }
    areas.add(assignment.areaId);
    const minute = this.slotIndex.minuteByStart.get(assignment.startEpochMs)!;
    // Duplicated entry ids count twice, matching the original whole-schedule recount.
    for (const entryId of match.possibleEntryIds) {
      if (minute < this.earlyThreshold) this.earlyCounts.set(entryId, (this.earlyCounts.get(entryId) ?? 0) + 1);
      if (minute >= this.lateThreshold) this.lateCounts.set(entryId, (this.lateCounts.get(entryId) ?? 0) + 1);
    }
  }
}

function restGapMs(prior: { startEpochMs: number; endEpochMs: number }, slot: SchedulingSlot): number {
  return prior.endEpochMs <= slot.startEpochMs
    ? slot.startEpochMs - prior.endEpochMs
    : prior.startEpochMs >= slot.endEpochMs
      ? prior.startEpochMs - slot.endEpochMs
      : -1;
}

/** Per-match values that depend only on the local date or on early/late membership, not the slot. */
class MatchPlacement {
  readonly #dailyLoadByDate = new Map<string, number>();
  readonly #spreads = new Map<string, number>();

  constructor(
    readonly problem: ScheduleProblem,
    readonly match: SchedulingMatch,
    readonly state: PlacementState,
    readonly matchIndex: MatchIndex,
  ) {}

  dailyLoad(date: string): number {
    const cached = this.#dailyLoadByDate.get(date);
    if (cached !== undefined) return cached;
    const dayMatches = [...(this.state.matchesByDate.get(date) ?? []), this.match];
    const load = Math.max(
      0,
      ...this.match.possibleEntryIds.map((entryId) =>
        maxMatchesForEntryInCollection(entryId, dayMatches, this.matchIndex.ancestorsByMatchId),
      ),
    );
    this.#dailyLoadByDate.set(date, load);
    return load;
  }

  balanceSpread(kind: "early" | "late", qualifies: boolean): number {
    const key = `${kind}:${qualifies}`;
    const cached = this.#spreads.get(key);
    if (cached !== undefined) return cached;
    const counts = kind === "early" ? this.state.earlyCounts : this.state.lateCounts;
    const bump = new Map<string, number>();
    if (qualifies) for (const entryId of this.match.possibleEntryIds) bump.set(entryId, (bump.get(entryId) ?? 0) + 1);
    let max = Number.NEGATIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    for (const entryId of this.matchIndex.allEntryIds) {
      const value = (counts.get(entryId) ?? 0) + (bump.get(entryId) ?? 0);
      if (value > max) max = value;
      if (value < min) min = value;
    }
    const spread = this.matchIndex.allEntryIds.length === 0 ? 0 : max - min;
    this.#spreads.set(key, spread);
    return spread;
  }

  allows(slot: SchedulingSlot): boolean {
    const { problem, match, state } = this;
    const { constraints } = problem;
    if (slot.endEpochMs - slot.startEpochMs !== match.durationMinutes * MINUTE_MS) return false;
    const fixed = match.fixedAssignment;
    if (
      fixed &&
      (slot.id !== fixed.slotId ||
        slot.areaId !== fixed.areaId ||
        slot.startEpochMs !== fixed.startEpochMs ||
        slot.endEpochMs !== fixed.endEpochMs)
    ) {
      return false;
    }
    for (const dependency of match.dependencyMatchIds) {
      const prior = state.assigned.get(dependency);
      if (!prior || slot.startEpochMs < prior.endEpochMs) return false;
    }
    for (const prior of state.byArea.get(slot.areaId) ?? []) if (intervalsOverlap(prior, slot)) return false;
    const requiredRestMs =
      constraints.minimumRest.mode === "required" ? constraints.minimumRest.value.minutes * MINUTE_MS : 0;
    const requiredConsecutiveMs =
      constraints.avoidConsecutiveMatches.mode === "required"
        ? constraints.avoidConsecutiveMatches.value.minutes * MINUTE_MS
        : 0;
    for (const entryId of match.possibleEntryIds) {
      for (const prior of state.byEntry.get(entryId) ?? []) {
        if (intervalsOverlap(prior, slot)) return false;
        if (requiredRestMs > 0 || requiredConsecutiveMs > 0) {
          const gap = restGapMs(prior, slot);
          if (gap < requiredRestMs || gap < requiredConsecutiveMs) return false;
        }
      }
    }
    for (const officialId of match.officialIds) {
      for (const prior of state.byOfficial.get(officialId) ?? []) if (intervalsOverlap(prior, slot)) return false;
    }
    if (constraints.entryUnavailable.mode === "required") {
      for (const entryId of match.possibleEntryIds) {
        if (
          (constraints.entryUnavailable.value.byEntryId[entryId] ?? []).some((interval) =>
            intervalsOverlap(slot, interval),
          )
        )
          return false;
      }
    }
    if (constraints.officialAvailability.mode === "required") {
      for (const officialId of match.officialIds) {
        const availability = constraints.officialAvailability.value.byOfficialId[officialId];
        if (
          !availability?.some(
            (interval) => slot.startEpochMs >= interval.startEpochMs && slot.endEpochMs <= interval.endEpochMs,
          )
        ) {
          return false;
        }
      }
    }
    if (
      constraints.maximumMatchesPerDay.mode === "required" &&
      this.dailyLoad(state.slotIndex.dateByStart.get(slot.startEpochMs)!) >
        constraints.maximumMatchesPerDay.value.matches
    ) {
      return false;
    }
    if (match.isChampionshipFinal && constraints.preferredFinalTime.mode === "required") {
      const delta = Math.abs(slot.startEpochMs - constraints.preferredFinalTime.value.targetStartEpochMs);
      if (delta > constraints.preferredFinalTime.value.toleranceMinutes * MINUTE_MS) return false;
    }
    if (
      constraints.featuredPlayingArea.mode === "required" &&
      constraints.featuredPlayingArea.value.matchIds.includes(match.id) &&
      slot.areaId !== constraints.featuredPlayingArea.value.areaId
    ) {
      return false;
    }
    if (
      constraints.keepDivisionTogether.mode === "required" &&
      this.divisionAreaCount(slot) > constraints.keepDivisionTogether.value.maximumAreaCount
    ) {
      return false;
    }
    if (constraints.preserveExistingSchedule.mode === "required") {
      const existing = constraints.preserveExistingSchedule.value.byMatchId[match.id];
      if (existing) {
        const shift = Math.abs(slot.startEpochMs - existing.startEpochMs) / MINUTE_MS;
        if (slot.areaId !== existing.areaId || shift > constraints.preserveExistingSchedule.value.maximumShiftMinutes) {
          return false;
        }
      }
    }
    return true;
  }

  divisionAreaCount(slot: SchedulingSlot): number {
    const areas = this.state.areasByDivision.get(this.match.divisionId);
    return (areas?.size ?? 0) + (areas?.has(slot.areaId) ? 0 : 1);
  }

  rank(slot: SchedulingSlot, placement: PlacementMode): readonly number[] {
    const { problem, match, state } = this;
    const { constraints } = problem;
    let nearestRest = Number.MAX_SAFE_INTEGER;
    for (const entryId of match.possibleEntryIds) {
      for (const prior of state.byEntry.get(entryId) ?? []) {
        const gap =
          prior.endEpochMs <= slot.startEpochMs
            ? slot.startEpochMs - prior.endEpochMs
            : prior.startEpochMs - slot.endEpochMs;
        nearestRest = Math.min(nearestRest, Math.max(0, gap / MINUTE_MS));
      }
    }
    const dailyLoad = this.dailyLoad(state.slotIndex.dateByStart.get(slot.startEpochMs)!);
    const finalDelta =
      match.isChampionshipFinal && constraints.preferredFinalTime.mode !== "ignored"
        ? Math.abs(slot.startEpochMs - constraints.preferredFinalTime.value.targetStartEpochMs) / MINUTE_MS
        : 0;
    const preferredRestShortfall =
      constraints.minimumRest.mode === "preferred"
        ? Math.max(0, constraints.minimumRest.value.minutes - nearestRest)
        : 0;
    const preferredDailyExcess =
      constraints.maximumMatchesPerDay.mode === "preferred"
        ? Math.max(0, dailyLoad - constraints.maximumMatchesPerDay.value.matches)
        : 0;
    const preferredEntryUnavailable =
      constraints.entryUnavailable.mode === "preferred"
        ? match.possibleEntryIds.filter((entryId) =>
            (constraints.entryUnavailable.value.byEntryId[entryId] ?? []).some((interval) =>
              intervalsOverlap(slot, interval),
            ),
          ).length
        : 0;
    const preferredOfficialUnavailable =
      constraints.officialAvailability.mode === "preferred"
        ? match.officialIds.filter(
            (officialId) =>
              !constraints.officialAvailability.value.byOfficialId[officialId]?.some(
                (interval) => slot.startEpochMs >= interval.startEpochMs && slot.endEpochMs <= interval.endEpochMs,
              ),
          ).length
        : 0;
    const preferredFeaturedArea =
      constraints.featuredPlayingArea.mode === "preferred" &&
      constraints.featuredPlayingArea.value.matchIds.includes(match.id) &&
      slot.areaId !== constraints.featuredPlayingArea.value.areaId
        ? 1
        : 0;
    const preferredConsecutiveShortfall =
      constraints.avoidConsecutiveMatches.mode === "preferred"
        ? Math.max(0, constraints.avoidConsecutiveMatches.value.minutes - nearestRest)
        : 0;
    const preferredDivisionExcess =
      constraints.keepDivisionTogether.mode === "preferred"
        ? Math.max(0, this.divisionAreaCount(slot) - constraints.keepDivisionTogether.value.maximumAreaCount)
        : 0;
    const existing = constraints.preserveExistingSchedule.value.byMatchId[match.id];
    const preferredPreservation =
      constraints.preserveExistingSchedule.mode === "preferred" && existing
        ? (slot.areaId === existing.areaId ? 0 : 1) +
          Math.max(
            0,
            Math.abs(slot.startEpochMs - existing.startEpochMs) / MINUTE_MS -
              constraints.preserveExistingSchedule.value.maximumShiftMinutes,
          )
        : 0;
    const minute = state.slotIndex.minuteByStart.get(slot.startEpochMs)!;
    const preferredEarlySpread =
      constraints.balanceEarlyMatches.mode === "preferred"
        ? Math.max(0, this.balanceSpread("early", minute < state.earlyThreshold) - 1)
        : 0;
    const preferredLateSpread =
      constraints.balanceLateMatches.mode === "preferred"
        ? Math.max(0, this.balanceSpread("late", minute >= state.lateThreshold) - 1)
        : 0;
    const preferencePenalty =
      preferredRestShortfall * weight(constraints.minimumRest) +
      preferredDailyExcess * weight(constraints.maximumMatchesPerDay) +
      (match.isChampionshipFinal && constraints.preferredFinalTime.mode === "preferred"
        ? Math.max(0, finalDelta - constraints.preferredFinalTime.value.toleranceMinutes) *
          weight(constraints.preferredFinalTime)
        : 0) +
      preferredEntryUnavailable * weight(constraints.entryUnavailable) +
      preferredOfficialUnavailable * weight(constraints.officialAvailability) +
      preferredFeaturedArea * weight(constraints.featuredPlayingArea) +
      preferredConsecutiveShortfall * weight(constraints.avoidConsecutiveMatches) +
      preferredEarlySpread * weight(constraints.balanceEarlyMatches) +
      preferredLateSpread * weight(constraints.balanceLateMatches) +
      preferredDivisionExcess * weight(constraints.keepDivisionTogether) +
      preferredPreservation * weight(constraints.preserveExistingSchedule);
    if (placement === "feasibility") return [slot.endEpochMs, dailyLoad, preferencePenalty, -nearestRest];
    const displacement = this.displacement(slot);
    if (problem.objective === "fastest")
      return [displacement, preferencePenalty, slot.endEpochMs, dailyLoad, -nearestRest];
    if (problem.objective === "balanced")
      return [displacement, preferencePenalty, slot.endEpochMs, dailyLoad, finalDelta, -nearestRest];
    return [displacement, preferencePenalty, -nearestRest, dailyLoad, slot.endEpochMs, finalDelta];
  }

  /**
   * Minimal change when regenerating against a previous revision (preserve-existing preferred):
   * keep a match in its previous slot whenever that slot is still hard-feasible, otherwise prefer
   * a free slot over evicting another match that has not been placed yet. Without this, a shift
   * inside the allowed window costs no penalty, so matches drift and evict each other (QA scenario
   * 7 moved 14 of 28 when 4 had to move). Own previous slot 0, a free slot 1, another unplaced
   * match's previous slot 2; always 0 when preserve-existing is ignored, leaving ranking unchanged.
   */
  displacement(slot: SchedulingSlot): number {
    const owners = this.state.existingSlotOwners;
    if (owners.size === 0) return 0;
    const owner = owners.get(`${slot.areaId}|${slot.startEpochMs}`);
    if (owner === this.match.id) return 0;
    return owner !== undefined && !this.state.assigned.has(owner) ? 2 : 1;
  }
}

/**
 * `preferences` ranks hard-feasible slots by preference penalty first. `bounded` keeps that
 * ranking but only within a short horizon after the earliest hard-feasible start, so a
 * preference (e.g. rest) can delay a match a little without consuming late capacity.
 * `feasibility` is earliest finish first (list scheduling), with preferences as tie-breakers.
 * Preferences never filter slots in any mode; they only order the hard-feasible ones.
 */
type PlacementMode = "preferences" | "bounded" | "feasibility";

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

function boundedPlacementHorizonMinutes(problem: ScheduleProblem, match: SchedulingMatch): number {
  const { minimumRest, avoidConsecutiveMatches } = problem.constraints;
  return (
    match.durationMinutes +
    Math.max(
      minimumRest.mode === "ignored" ? 0 : minimumRest.value.minutes,
      avoidConsecutiveMatches.mode === "ignored" ? 0 : avoidConsecutiveMatches.value.minutes,
    )
  );
}

/** Relaxed retries perturb only among the earliest few slots so exploration cannot starve dependants. */
const FEASIBILITY_PERTURBATION_WINDOW = 3;

/**
 * Smallest per-entry daily match limit the matches can satisfy across the available local dates:
 * the most matches any entry may have to play (knockout possibilities counted conservatively),
 * spread evenly over the dates. Used to derive a default that never makes a format unschedulable.
 */
export function minimumFeasibleDailyMatchLimit(
  matches: readonly SchedulingMatch[],
  slotStartEpochMs: readonly number[],
  timeZone: string,
): number {
  const dates = new Set(slotStartEpochMs.map((start) => localDateKey(start, timeZone))).size;
  if (dates === 0) return 1;
  const ancestors = buildTransitiveDependencies(matches);
  let mostMatches = 1;
  for (const entryId of new Set(matches.flatMap((match) => match.possibleEntryIds))) {
    mostMatches = Math.max(mostMatches, maxMatchesForEntryInCollection(entryId, matches, ancestors));
  }
  return Math.ceil(mostMatches / dates);
}

function exceedsRequiredDailyMatchCapacity(problem: ScheduleProblem): boolean {
  if (problem.constraints.maximumMatchesPerDay.mode !== "required") return false;
  const availableDates = new Set(problem.slots.map((slot) => localDateKey(slot.startEpochMs, problem.timeZone)));
  const totalLimit = problem.constraints.maximumMatchesPerDay.value.matches * availableDates.size;
  const ancestors = buildTransitiveDependencies(problem.matches);
  const allEntries = new Set(problem.matches.flatMap((match) => match.possibleEntryIds));
  for (const entryId of allEntries) {
    if (maxMatchesForEntryInCollection(entryId, problem.matches, ancestors) > totalLimit) {
      return true;
    }
  }
  return false;
}

function generateIteration(
  problem: ScheduleProblem,
  iteration: number,
  placement: PlacementMode = "preferences",
  order: MatchOrder = "id",
): ScheduleAssignment[] {
  validateProblem(problem);
  const slotIndex = slotIndexFor(problem);
  const matchIndex = matchIndexFor(problem);
  const state = new PlacementState(
    slotIndex,
    parseLocalTime(problem.constraints.balanceEarlyMatches.value.beforeLocalTime, "Early threshold"),
    parseLocalTime(problem.constraints.balanceLateMatches.value.atOrAfterLocalTime, "Late threshold"),
    problem.constraints.preserveExistingSchedule.mode === "ignored"
      ? new Map()
      : new Map(
          Object.entries(problem.constraints.preserveExistingSchedule.value.byMatchId).map(([matchId, existing]) => [
            `${existing.areaId}|${existing.startEpochMs}`,
            matchId,
          ]),
        ),
  );
  const slots = slotIndex.sortedSlots;
  for (const match of matchIndex.orderedMatches[order]) {
    const placementContext = new MatchPlacement(problem, match, state, matchIndex);
    // Slots are sorted by start, so skip straight past those that start before a dependency ends.
    let earliestStart = Number.NEGATIVE_INFINITY;
    for (const dependency of match.dependencyMatchIds) {
      earliestStart = Math.max(earliestStart, state.assigned.get(dependency)?.endEpochMs ?? Number.POSITIVE_INFINITY);
    }
    let low = 0;
    let high = slots.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (slots[middle]!.startEpochMs < earliestStart) low = middle + 1;
      else high = middle;
    }
    let candidates: SchedulingSlot[] = [];
    for (let index = low; index < slots.length; index += 1) {
      const slot = slots[index]!;
      if (!state.usedSlotIds.has(slot.id) && placementContext.allows(slot)) candidates.push(slot);
    }
    if (placement === "bounded" && candidates.length > 0) {
      const earliest = Math.min(...candidates.map((candidate) => candidate.startEpochMs));
      const horizon = earliest + boundedPlacementHorizonMinutes(problem, match) * MINUTE_MS;
      candidates = candidates.filter((candidate) => candidate.startEpochMs <= horizon);
    }
    const rankedCandidates = candidates.map((candidate) => ({
      candidate,
      rank: placementContext.rank(candidate, placement),
    }));
    rankedCandidates.sort((left, right) => {
      const ranked = compareRank(left.rank, right.rank);
      return (
        ranked ||
        left.candidate.areaId.localeCompare(right.candidate.areaId) ||
        left.candidate.id.localeCompare(right.candidate.id)
      );
    });
    let window =
      placement !== "preferences"
        ? Math.min(rankedCandidates.length, FEASIBILITY_PERTURBATION_WINDOW)
        : rankedCandidates.length;
    if (state.existingSlotOwners.size > 0 && placement !== "feasibility" && rankedCandidates.length > 0) {
      // Exploration must not undo minimal change: only vary among equally displacing slots.
      const best = rankedCandidates[0]!.rank[0];
      window = Math.min(window, rankedCandidates.filter((ranked) => ranked.rank[0] === best).length);
    }
    const selected = rankedCandidates[stableIterationIndex(iteration, match.id, window)]?.candidate;
    if (!selected) throw new Error(`No valid slot remains for match ${match.id}`);
    state.add(match, assignmentFor(match, selected));
  }
  const result = [...state.assigned.values()].sort(compareAssignment);
  const validation = validateSchedule(problem, result);
  if (!validation.valid) {
    const first = validation.violations.find((violation) => violation.severity !== "preferred");
    throw new Error(`Generated schedule is invalid: ${first?.message ?? "unknown violation"}`);
  }
  return result;
}

function isNoValidSlotError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("No valid slot remains");
}

/**
 * Preferred (soft) constraints must never turn a hard-feasible problem into no_solution. Greedy
 * placement has no backtracking, so a preference-led choice can consume a slot a later dependant
 * needs. Retry with preferences relaxed to tie-breakers (earliest-finish placement), first at the
 * same iteration and then at the deterministic baseline iteration. Required constraints stay hard.
 */
function generateIterationWithRelaxation(problem: ScheduleProblem, iteration: number): ScheduleAssignment[] {
  // Relaxation only changes how slots are ranked; the returned assignments are still validated
  // and scored by callers against the original problem, so quality reports stay honest.
  const preferredKeys = (Object.keys(problem.constraints) as (keyof SchedulingConstraints)[]).filter(
    (key) => problem.constraints[key].mode === "preferred",
  );
  const relaxing = (key: keyof SchedulingConstraints): ScheduleProblem => ({
    ...problem,
    constraints: { ...problem.constraints, [key]: { mode: "ignored", value: problem.constraints[key].value } },
  });
  const attempts: [ScheduleProblem, number, PlacementMode, MatchOrder?][] = [
    [problem, iteration, "preferences"],
    ...preferredKeys.map((key): [ScheduleProblem, number, PlacementMode] => [relaxing(key), iteration, "preferences"]),
    [problem, iteration, "bounded"],
    [problem, iteration, "feasibility"],
    ...(iteration === 0 ? [] : [[problem, 0, "feasibility"] as [ScheduleProblem, number, PlacementMode]]),
    // Last resort when id order clusters one division's rounds: interleave divisions.
    [problem, iteration, "preferences", "interleaved"],
    [problem, iteration, "feasibility", "interleaved"],
  ];
  let lastError: unknown;
  for (const [attemptProblem, attemptIteration, placement, order] of attempts) {
    try {
      // Relaxing a preferred setting cannot change hard validity: required modes are untouched.
      return generateIteration(attemptProblem, attemptIteration, placement, order);
    } catch (error) {
      if (!isNoValidSlotError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export function generateConstraintAwareSchedule(problem: ScheduleProblem): ScheduleAssignment[] {
  return generateIterationWithRelaxation(problem, 0);
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
  validateProblem(problem);
  if (exceedsRequiredDailyMatchCapacity(problem)) return [];
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
      add(iteration, generateIterationWithRelaxation(problem, iteration));
    } catch (error) {
      if (!isNoValidSlotError(error)) throw error;
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

/**
 * Identifies official-related infeasibility conditions that can be proven from the schedule problem.
 * Conservative analysis; not an unsatisfiable-core solver.
 */
export function diagnoseScheduleInfeasibility(problem: ScheduleProblem): readonly ScheduleViolation[] {
  const violations: ScheduleViolation[] = [];
  const officialAvailability = problem.constraints.officialAvailability;
  const isRequired = officialAvailability.mode === "required";

  // 1. Check for matches with assigned officials who have NO feasible slots in the problem
  for (const match of problem.matches) {
    if (!match.officialIds || match.officialIds.length === 0) continue;

    for (const officialId of match.officialIds) {
      const windows = officialAvailability.value.byOfficialId[officialId] ?? [];

      if (isRequired) {
        // Find if any slot in the entire problem can accommodate this match duration within the official's availability
        const hasFeasibleSlot = problem.slots.some((slot) => {
          const matchEnd = slot.startEpochMs + match.durationMinutes * MINUTE_MS;
          if (matchEnd > slot.endEpochMs) return false;
          return windows.some((window) => slot.startEpochMs >= window.startEpochMs && matchEnd <= window.endEpochMs);
        });

        if (!hasFeasibleSlot) {
          violations.push({
            code: "official_unavailable",
            severity: "required",
            matchIds: [match.id],
            message:
              `Official ${officialId} has no available window matching any valid slot for match ${match.id}. ` +
              `Widen the official's availability or assign another official.`,
          });
        }
      }
    }
  }

  // 2. Check for official over-allocation (maximum concurrent/sequential match capacity)
  // For each official, check if the number of matches assigned exceeds the maximum number of
  // non-overlapping slots in the problem during the official's available hours.
  const matchesByOfficial = new Map<string, SchedulingMatch[]>();
  for (const match of problem.matches) {
    for (const officialId of match.officialIds ?? []) {
      const list = matchesByOfficial.get(officialId) ?? [];
      list.push(match);
      matchesByOfficial.set(officialId, list);
    }
  }

  for (const [officialId, assignedMatches] of matchesByOfficial.entries()) {
    if (assignedMatches.length <= 1) continue;

    // Filter problem slots to those where the official is available (if required)
    const windows = officialAvailability.value.byOfficialId[officialId] ?? [];
    const validSlots = isRequired
      ? problem.slots.filter((slot) =>
          windows.some((w) => slot.startEpochMs >= w.startEpochMs && slot.endEpochMs <= w.endEpochMs),
        )
      : problem.slots;

    // Find the maximum number of mutually non-overlapping slots from validSlots
    // Standard greedy interval scheduling algorithm: sort by end time, pick greedily
    const sortedSlots = [...validSlots].sort((a, b) => a.endEpochMs - b.endEpochMs);
    let maxSequentialSlots = 0;
    let lastEnd = -Infinity;
    for (const slot of sortedSlots) {
      if (slot.startEpochMs >= lastEnd) {
        maxSequentialSlots += 1;
        lastEnd = slot.endEpochMs;
      }
    }

    if (assignedMatches.length > maxSequentialSlots) {
      violations.push({
        code: "official_overlap",
        severity: "hard",
        matchIds: assignedMatches.map((m) => m.id),
        message:
          `Official ${officialId} is assigned to ${assignedMatches.length} matches but only ${maxSequentialSlots} ` +
          `non-overlapping slots are available. Widen the official's availability or assign another official.`,
      });
    }
  }

  violations.push(...diagnoseCapacityInfeasibility(problem));
  violations.push(...diagnoseLockedConflicts(problem));
  return violations;
}

/**
 * Locked and published matches never move, so two of them that already break a hard or required
 * rule between themselves make every schedule invalid: a shared possible participant, official or
 * playing area at overlapping times, or a shared participant closer than the required rest.
 */
function diagnoseLockedConflicts(problem: ScheduleProblem): ScheduleViolation[] {
  const violations: ScheduleViolation[] = [];
  const restMinutes = Math.max(
    problem.constraints.minimumRest.mode === "required" ? problem.constraints.minimumRest.value.minutes : 0,
    problem.constraints.avoidConsecutiveMatches.mode === "required"
      ? problem.constraints.avoidConsecutiveMatches.value.minutes
      : 0,
  );
  const fixed = problem.matches
    .filter((match) => match.fixedAssignment)
    .sort(
      (left, right) =>
        left.fixedAssignment!.startEpochMs - right.fixedAssignment!.startEpochMs || left.id.localeCompare(right.id),
    );
  for (let index = 0; index < fixed.length; index += 1) {
    for (let other = index + 1; other < fixed.length; other += 1) {
      const left = fixed[index]!;
      const right = fixed[other]!;
      const a = left.fixedAssignment!;
      const b = right.fixedAssignment!;
      const overlap = a.startEpochMs < b.endEpochMs && b.startEpochMs < a.endEpochMs;
      const gapMinutes = (b.startEpochMs - a.endEpochMs) / MINUTE_MS;
      const pair = `Locked matches ${left.id} (${localTimeLabel(a.startEpochMs, problem.timeZone)}) and ${right.id} (${localTimeLabel(b.startEpochMs, problem.timeZone)})`;
      const fix = "Unlock or move one of them";
      const entries = left.possibleEntryIds.filter((entryId) => right.possibleEntryIds.includes(entryId));
      const officials = left.officialIds.filter((officialId) => right.officialIds.includes(officialId));
      if (overlap && a.areaId === b.areaId) {
        violations.push({
          code: "area_overlap",
          severity: "hard",
          matchIds: [left.id, right.id],
          message: `${pair} use playing area ${a.areaId} at the same time. ${fix}.`,
        });
      }
      if (overlap && entries.length > 0) {
        violations.push({
          code: "possible_entry_overlap",
          severity: "hard",
          matchIds: [left.id, right.id],
          message: `${pair} overlap and both may involve ${listLabel(entries)}. ${fix}.`,
        });
      }
      if (overlap && officials.length > 0) {
        violations.push({
          code: "official_overlap",
          severity: "hard",
          matchIds: [left.id, right.id],
          message: `${pair} overlap and share official ${listLabel(officials)}. ${fix} or assign another official.`,
        });
      }
      if (!overlap && entries.length > 0 && restMinutes > 0 && gapMinutes < restMinutes) {
        violations.push({
          code: "minimum_rest",
          severity: "required",
          matchIds: [left.id, right.id],
          amount: restMinutes - gapMinutes,
          message:
            `${pair} leave ${listLabel(entries)} only ${gapMinutes} minutes of rest, but ${restMinutes} minutes are ` +
            `required. ${fix}, or reduce the required rest.`,
        });
      }
    }
  }
  return violations;
}

function localTimeLabel(epochMs: number, timeZone: string): string {
  const minute = localMinuteOfDay(epochMs, timeZone);
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return `${localDateKey(epochMs, timeZone)} ${hh}:${mm}`;
}

function listLabel(values: readonly string[], limit = 6): string {
  return values.length <= limit
    ? values.join(", ")
    : `${values.slice(0, limit).join(", ")} and ${values.length - limit} more`;
}

/**
 * Necessary-condition checks for the common no_solution causes. Each finding proves that no
 * schedule exists under the stated hard/required settings, so the organiser can act on it: venue
 * capacity, the per-entry daily limit, required rest, and dependency (knockout ordering) windows.
 * Messages name raw ids; callers substitute display names.
 */
function diagnoseCapacityInfeasibility(problem: ScheduleProblem): ScheduleViolation[] {
  const violations: ScheduleViolation[] = [];
  const { timeZone } = problem;
  const dateOf = (epochMs: number) => localDateKey(epochMs, timeZone);
  const slotMinutes = (slot: SchedulingSlot) => (slot.endEpochMs - slot.startEpochMs) / MINUTE_MS;
  const dates = uniqueSorted(problem.slots.map((slot) => dateOf(slot.startEpochMs)));

  // 1. Venue capacity: each match occupies one slot of exactly its duration.
  for (const duration of new Set(problem.matches.map((match) => match.durationMinutes))) {
    const matchCount = problem.matches.filter((match) => match.durationMinutes === duration).length;
    const slots = problem.slots.filter((slot) => slotMinutes(slot) === duration);
    if (matchCount <= slots.length) continue;
    const perArea = uniqueSorted(slots.map((slot) => slot.areaId)).map(
      (areaId) => `${areaId}: ${slots.filter((slot) => slot.areaId === areaId).length} slots`,
    );
    violations.push({
      code: "insufficient_capacity",
      severity: "hard",
      matchIds: [],
      amount: matchCount - slots.length,
      message:
        `${matchCount} matches of ${duration} minutes need ${matchCount * duration} court-minutes, but the venue ` +
        `windows provide ${slots.length} slots (${slots.length * duration} court-minutes) over ${dates.length} ` +
        `day(s)${perArea.length ? ` (${perArea.join("; ")})` : ""}. Add playing areas or time, or choose a smaller format.`,
    });
  }

  const ancestors = buildTransitiveDependencies(problem.matches);
  const entryIds = uniqueSorted(problem.matches.flatMap((match) => match.possibleEntryIds));
  const neededByEntry = new Map(
    entryIds.map((entryId) => [entryId, maxMatchesForEntryInCollection(entryId, problem.matches, ancestors)]),
  );
  const matchIdsFor = (entries: readonly string[]) =>
    uniqueSorted(
      problem.matches
        .filter((match) => match.possibleEntryIds.some((entryId) => entries.includes(entryId)))
        .map((match) => match.id),
    );
  const entriesLabel = (entries: readonly string[]) =>
    `${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${listLabel(entries)})`;

  // 2. Required per-entry daily limit over the available dates.
  const daily = problem.constraints.maximumMatchesPerDay;
  const dailyLimit = daily.mode === "required" ? daily.value.matches : Number.POSITIVE_INFINITY;
  if (daily.mode === "required" && dates.length > 0) {
    const allowed = daily.value.matches * dates.length;
    const over = entryIds.filter((entryId) => neededByEntry.get(entryId)! > allowed);
    if (over.length > 0) {
      const most = Math.max(...over.map((entryId) => neededByEntry.get(entryId)!));
      violations.push({
        code: "maximum_matches_per_day",
        severity: "required",
        matchIds: matchIdsFor(over),
        amount: most - allowed,
        message:
          `${entriesLabel(over)} may have to play up to ${most} matches, but the required limit of ` +
          `${daily.value.matches} per day over ${dates.length} day(s) allows ${allowed}. ` +
          `Raise the daily limit to at least ${Math.ceil(most / dates.length)} or make it preferred.`,
      });
    }
  }

  // 3. Required rest: the most matches one entry can play per day when its matches must be
  // separated by the required gap (and capped by the required daily limit), summed over dates.
  const restMinutes = Math.max(
    problem.constraints.minimumRest.mode === "required" ? problem.constraints.minimumRest.value.minutes : 0,
    problem.constraints.avoidConsecutiveMatches.mode === "required"
      ? problem.constraints.avoidConsecutiveMatches.value.minutes
      : 0,
  );
  if (restMinutes > 0) {
    const sequentialCapacity = (duration: number, gapMinutes: number) => {
      let total = 0;
      const byDate: string[] = [];
      for (const date of dates) {
        const starts = [
          ...new Set(
            problem.slots
              .filter((slot) => slotMinutes(slot) === duration && dateOf(slot.startEpochMs) === date)
              .map((slot) => slot.startEpochMs),
          ),
        ].sort((left, right) => left - right);
        let count = 0;
        let nextStart = Number.NEGATIVE_INFINITY;
        for (const start of starts) {
          if (start < nextStart) continue;
          count += 1;
          nextStart = start + (duration + gapMinutes) * MINUTE_MS;
        }
        count = Math.min(count, dailyLimit);
        total += count;
        byDate.push(`${date}: ${count}`);
      }
      return { total, byDate };
    };
    const shortfalls: { entryId: string; needed: number; capacity: { total: number; byDate: string[] } }[] = [];
    for (const entryId of entryIds) {
      const duration = Math.max(
        ...problem.matches
          .filter((match) => match.possibleEntryIds.includes(entryId))
          .map((match) => match.durationMinutes),
      );
      const needed = neededByEntry.get(entryId)!;
      const capacity = sequentialCapacity(duration, restMinutes);
      // Report rest only when it is the binding cause (without the rest gap the entry would fit).
      if (needed > capacity.total && needed <= sequentialCapacity(duration, 0).total) {
        shortfalls.push({ entryId, needed, capacity });
      }
    }
    if (shortfalls.length > 0) {
      const worst = shortfalls.reduce((left, right) =>
        right.needed - right.capacity.total > left.needed - left.capacity.total ? right : left,
      );
      violations.push({
        code: "minimum_rest",
        severity: "required",
        matchIds: matchIdsFor(shortfalls.map((item) => item.entryId)),
        amount: worst.needed - worst.capacity.total,
        message:
          `${entriesLabel(shortfalls.map((item) => item.entryId))} may have to play up to ${worst.needed} matches, ` +
          `but with ${restMinutes} minutes of required rest only ${worst.capacity.total} fit in the venue windows ` +
          `(${worst.capacity.byDate.join("; ")}). Reduce the required rest, make it preferred, or add playing time.`,
      });
    }
  }

  // 4. Dependency windows: earliest possible finish along each prerequisite chain, including the
  // required rest between a match and the matches that feed it.
  const earliestFinish = new Map<string, number>();
  const blocked = new Set<string>();
  const sortedSlots = [...problem.slots].sort((left, right) => left.startEpochMs - right.startEpochMs);
  const matchesById = new Map(problem.matches.map((match) => [match.id, match]));
  // Matches sharing a possible participant can never overlap, so one entry's prerequisite matches
  // run one after another: the k-th of them cannot end before k non-overlapping slots (with the
  // required rest between them) have passed. Group play feeding a knockout is the usual case.
  const sequentialPrerequisiteReady = (match: SchedulingMatch): number => {
    const prerequisites = [...(ancestors.get(match.id) ?? [])].map((id) => matchesById.get(id)!);
    if (prerequisites.length === 0) return Number.NEGATIVE_INFINITY;
    let ready = Number.NEGATIVE_INFINITY;
    const countByEntryAndDuration = new Map<string, number>();
    for (const prerequisite of prerequisites)
      for (const entryId of new Set(prerequisite.possibleEntryIds)) {
        const key = `${prerequisite.durationMinutes}|${entryId}`;
        countByEntryAndDuration.set(key, (countByEntryAndDuration.get(key) ?? 0) + 1);
      }
    for (const [key, count] of countByEntryAndDuration) {
      const duration = Number(key.slice(0, key.indexOf("|")));
      let placed = 0;
      let nextStart = Number.NEGATIVE_INFINITY;
      let lastEnd = Number.NEGATIVE_INFINITY;
      for (const slot of sortedSlots) {
        if (slotMinutes(slot) !== duration || slot.startEpochMs < nextStart) continue;
        placed += 1;
        lastEnd = slot.endEpochMs;
        nextStart = slot.endEpochMs + restMinutes * MINUTE_MS;
        if (placed === count) break;
      }
      // Too few slots for this entry at all: the capacity finding covers that case.
      if (placed === count) ready = Math.max(ready, lastEnd + restMinutes * MINUTE_MS);
    }
    return ready;
  };
  for (const match of topologicalMatches(problem.matches)) {
    if (match.dependencyMatchIds.some((id) => blocked.has(id))) {
      blocked.add(match.id);
      continue;
    }
    const ready = Math.max(
      Number.NEGATIVE_INFINITY,
      ...match.dependencyMatchIds.map((id) => earliestFinish.get(id)! + restMinutes * MINUTE_MS),
      sequentialPrerequisiteReady(match),
    );
    const fixed = match.fixedAssignment;
    const start = fixed
      ? fixed.startEpochMs >= ready
        ? fixed.startEpochMs
        : undefined
      : sortedSlots.find((slot) => slotMinutes(slot) === match.durationMinutes && slot.startEpochMs >= ready)
          ?.startEpochMs;
    if (start !== undefined) {
      earliestFinish.set(match.id, start + match.durationMinutes * MINUTE_MS);
      continue;
    }
    blocked.add(match.id);
    if (match.dependencyMatchIds.length === 0) continue; // the capacity finding covers this case
    const chain = uniqueSorted([match.id, ...(ancestors.get(match.id) ?? [])]);
    const restNote = restMinutes > 0 ? ` plus ${restMinutes} minutes of required rest` : "";
    violations.push({
      code: "dependency_order",
      severity: "hard",
      matchIds: chain,
      message: fixed
        ? `Locked match ${match.id} starts at ${localTimeLabel(fixed.startEpochMs, timeZone)}, before its ` +
          `prerequisite matches can finish (earliest ${localTimeLabel(ready, timeZone)}${restNote}). ` +
          `Unlock it or move it later.`
        : `Match ${match.id} must wait for ${chain.length - 1} prerequisite match(es), which cannot finish before ` +
          `${localTimeLabel(ready, timeZone)}${restNote}, and no ${match.durationMinutes}-minute slot remains after ` +
          `that. Add playing time after the prerequisite rounds.`,
    });
  }

  return violations;
}

export type FormatScheduleCheck = {
  readonly status: "feasible" | "infeasible" | "not_checked";
  /** Infeasible: SCHEDULE_CAPACITY, _DAILY_LIMIT, _REST, _DEPENDENCIES or _INFEASIBLE; not_checked: SCHEDULE_UNVERIFIED. */
  readonly warningCodes: readonly string[];
  readonly diagnostics: readonly ScheduleViolation[];
};

const FORMAT_CHECK_WARNING_BY_CODE: Partial<Record<ScheduleViolationCode, string>> = {
  insufficient_capacity: "SCHEDULE_CAPACITY",
  maximum_matches_per_day: "SCHEDULE_DAILY_LIMIT",
  minimum_rest: "SCHEDULE_REST",
  consecutive_matches: "SCHEDULE_REST",
  dependency_order: "SCHEDULE_DEPENDENCIES",
};

/**
 * Fast schedule check for a proposed format before it is chosen, against the real courts and
 * venue windows: one bounded greedy solve when matches × slots is small enough for an interactive
 * request, otherwise only the analytic no_solution diagnostics (capacity, daily limit, required
 * rest, knockout windows). Participants are synthetic per-seed ids; preferences never make a
 * format infeasible. Returns not_checked when the problem is too large or cannot be built.
 */
export function checkFormatScheduleFeasibility(input: {
  timeZone: string;
  slots: readonly SchedulingSlot[];
  durationMinutes: number;
  divisions: readonly Readonly<{ divisionId: string; graph: FormatGraph }>[];
  constraints: SchedulingConstraints;
  /** Raise a required daily limit to what the format forces per day, as the workspace default does. */
  deriveDailyLimit?: boolean;
  /** Above this many matches × slots, skip the solve and only run diagnostics (default 60 000). */
  maxSolveCells?: number;
  /** Above this many matches (or 5 000 slots), skip diagnostics too (default 600). */
  maxCheckMatches?: number;
}): FormatScheduleCheck {
  const notChecked: FormatScheduleCheck = { status: "not_checked", warningCodes: [], diagnostics: [] };
  if (input.slots.length === 0) return notChecked;
  let problem: ScheduleProblem;
  try {
    const matches = input.divisions.flatMap(({ divisionId, graph }) => {
      const seeds = Object.fromEntries(
        Array.from({ length: graph.entryCount }, (_, index) => [index + 1, `${divisionId}:seed-${index + 1}`]),
      );
      return deriveSchedulingMatches(graph, divisionId, seeds, input.durationMinutes).map((match) => ({
        ...match,
        id: `${divisionId}:${match.id}`,
        dependencyMatchIds: match.dependencyMatchIds.map((dependency) => `${divisionId}:${dependency}`),
      }));
    });
    const daily = input.constraints.maximumMatchesPerDay;
    const dailyLimit =
      input.deriveDailyLimit && daily.mode === "required"
        ? Math.min(
            64,
            Math.max(
              daily.value.matches,
              minimumFeasibleDailyMatchLimit(
                matches,
                input.slots.map((slot) => slot.startEpochMs),
                input.timeZone,
              ),
            ),
          )
        : daily.value.matches;
    problem = {
      timeZone: input.timeZone,
      objective: "balanced",
      matches,
      slots: input.slots,
      constraints: { ...input.constraints, maximumMatchesPerDay: { ...daily, value: { matches: dailyLimit } } },
    };
    validateProblem(problem);
  } catch {
    return notChecked;
  }
  const infeasible = (diagnostics: readonly ScheduleViolation[]): FormatScheduleCheck => ({
    status: "infeasible",
    warningCodes: uniqueSorted(
      diagnostics.length === 0
        ? ["SCHEDULE_INFEASIBLE"]
        : diagnostics.map((violation) => FORMAT_CHECK_WARNING_BY_CODE[violation.code] ?? "SCHEDULE_INFEASIBLE"),
    ),
    diagnostics,
  });
  // Hard size bound for request paths: beyond it, even the analytic diagnostics are skipped.
  if (problem.matches.length > (input.maxCheckMatches ?? 600) || problem.slots.length > 5_000) {
    return problem.matches.length > problem.slots.length
      ? { status: "infeasible", warningCodes: ["SCHEDULE_CAPACITY"], diagnostics: [] }
      : notChecked;
  }
  if (problem.matches.length > problem.slots.length) return infeasible(diagnoseScheduleInfeasibility(problem));
  if (problem.matches.length * problem.slots.length > (input.maxSolveCells ?? 60_000)) {
    const diagnostics = diagnoseScheduleInfeasibility(problem);
    return diagnostics.length > 0 ? infeasible(diagnostics) : notChecked;
  }
  if (generateScheduleCandidates(problem, { startIteration: 0, maxIterations: 1 }).length > 0)
    return { status: "feasible", warningCodes: [], diagnostics: [] };
  // The quick greedy solve is not a proof: without a concrete reason, do not call it infeasible.
  const diagnostics = diagnoseScheduleInfeasibility(problem);
  return diagnostics.length > 0
    ? infeasible(diagnostics)
    : { status: "not_checked", warningCodes: ["SCHEDULE_UNVERIFIED"], diagnostics: [] };
}

/** Shared with schedule-improvement.ts so local search reuses the solver's time and daily-load rules. */
export const scheduleInternals = {
  localDateKey,
  localMinuteOfDay,
  parseLocalTime,
  maxMatchesForEntryInCollection,
  buildTransitiveDependencies,
  compareAssignment,
} as const;
