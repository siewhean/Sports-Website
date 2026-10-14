import {
  evaluateScheduleQuality,
  scheduleInternals,
  validateSchedule,
  type ScheduleAssignment,
  type ScheduleProblem,
  type SchedulingMatch,
  type SchedulingSlot,
} from "./schedule-constraints.js";

const MINUTE_MS = 60_000;
const { localDateKey, localMinuteOfDay, parseLocalTime, maxMatchesForEntryInCollection, compareAssignment } =
  scheduleInternals;

/** Shape of a schedule as a participant or venue sees it; used to compare constructions and repairs. */
export type ScheduleShapeMetrics = {
  /** Consecutive matches of one possible participant closer than the back-to-back buffer, per participant. */
  backToBackCount: number;
  minimumRestMinutes: number | null;
  averageRestMinutes: number | null;
  /** Population standard deviation of each participant's shortest rest: lower is fairer. */
  restSpreadMinutes: number;
  days: readonly { date: string; firstStartLocalMinute: number; lastEndLocalMinute: number; lengthMinutes: number }[];
  courtLoadMinutes: Readonly<Record<string, number>>;
  courtLoadSpreadMinutes: number;
  /** Matches whose area or start differs from the previous revision (preserve-existing input). */
  movedMatchCount: number;
};

export type ScheduleImprovementOptions = {
  /** Seeds the move order; the same seed and input always give the same result. */
  seed: number;
  /** Bound on proposed moves (default 80 per match, 1000..10000). */
  maxMoveEvaluations?: number;
  /** Bound on full quality re-scores of accepted moves (default 400). */
  maxQualityChecks?: number;
};

export type ScheduleImprovement = {
  assignments: readonly ScheduleAssignment[];
  acceptedMoves: number;
  evaluatedMoves: number;
};

/** Gap below which two matches of one participant count as back to back. */
function backToBackBufferMinutes(problem: ScheduleProblem): number {
  const { avoidConsecutiveMatches } = problem.constraints;
  return avoidConsecutiveMatches.mode === "ignored" ? 1 : Math.max(1, avoidConsecutiveMatches.value.minutes);
}

function restGapsByEntry(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[]): Map<string, number[]> {
  const matches = new Map(problem.matches.map((match) => [match.id, match]));
  const byEntry = new Map<string, ScheduleAssignment[]>();
  for (const assignment of assignments) {
    for (const entryId of new Set(matches.get(assignment.matchId)?.possibleEntryIds ?? [])) {
      const list = byEntry.get(entryId);
      if (list) list.push(assignment);
      else byEntry.set(entryId, [assignment]);
    }
  }
  const gaps = new Map<string, number[]>();
  for (const [entryId, list] of byEntry) {
    list.sort((left, right) => left.startEpochMs - right.startEpochMs);
    const entryGaps: number[] = [];
    for (let index = 1; index < list.length; index += 1) {
      entryGaps.push(Math.max(0, (list[index]!.startEpochMs - list[index - 1]!.endEpochMs) / MINUTE_MS));
    }
    gaps.set(entryId, entryGaps);
  }
  return gaps;
}

export function measureScheduleShape(
  problem: ScheduleProblem,
  assignments: readonly ScheduleAssignment[],
): ScheduleShapeMetrics {
  const buffer = backToBackBufferMinutes(problem);
  let backToBackCount = 0;
  let restTotal = 0;
  let restCount = 0;
  let minimumRestMinutes: number | null = null;
  const entryMinimums: number[] = [];
  for (const gaps of restGapsByEntry(problem, assignments).values()) {
    if (gaps.length === 0) continue;
    for (const gap of gaps) {
      if (gap < buffer) backToBackCount += 1;
      restTotal += gap;
      restCount += 1;
    }
    const entryMinimum = Math.min(...gaps);
    entryMinimums.push(entryMinimum);
    minimumRestMinutes = minimumRestMinutes === null ? entryMinimum : Math.min(minimumRestMinutes, entryMinimum);
  }
  const meanMinimum = entryMinimums.reduce((total, value) => total + value, 0) / Math.max(1, entryMinimums.length);
  const restSpreadMinutes =
    entryMinimums.length === 0
      ? 0
      : Math.sqrt(entryMinimums.reduce((total, value) => total + (value - meanMinimum) ** 2, 0) / entryMinimums.length);
  const dayBounds = new Map<string, { first: number; last: number }>();
  for (const assignment of assignments) {
    const date = localDateKey(assignment.startEpochMs, problem.timeZone);
    const bounds = dayBounds.get(date);
    if (!bounds) dayBounds.set(date, { first: assignment.startEpochMs, last: assignment.endEpochMs });
    else {
      bounds.first = Math.min(bounds.first, assignment.startEpochMs);
      bounds.last = Math.max(bounds.last, assignment.endEpochMs);
    }
  }
  const days = [...dayBounds.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, bounds]) => {
      const firstStartLocalMinute = localMinuteOfDay(bounds.first, problem.timeZone);
      return {
        date,
        firstStartLocalMinute,
        lastEndLocalMinute: firstStartLocalMinute + (bounds.last - bounds.first) / MINUTE_MS,
        lengthMinutes: (bounds.last - bounds.first) / MINUTE_MS,
      };
    });
  const courtLoadMinutes: Record<string, number> = {};
  for (const slot of problem.slots) courtLoadMinutes[slot.areaId] = 0;
  for (const assignment of assignments) {
    courtLoadMinutes[assignment.areaId] =
      (courtLoadMinutes[assignment.areaId] ?? 0) + (assignment.endEpochMs - assignment.startEpochMs) / MINUTE_MS;
  }
  const loads = Object.values(courtLoadMinutes);
  const previous = problem.constraints.preserveExistingSchedule.value.byMatchId;
  const movedMatchCount = assignments.filter((assignment) => {
    const existing = previous[assignment.matchId];
    return (
      existing !== undefined &&
      (existing.areaId !== assignment.areaId || existing.startEpochMs !== assignment.startEpochMs)
    );
  }).length;
  return {
    backToBackCount,
    minimumRestMinutes,
    averageRestMinutes: restCount === 0 ? null : Math.round((restTotal / restCount) * 100) / 100,
    restSpreadMinutes: Math.round(restSpreadMinutes * 100) / 100,
    days,
    courtLoadMinutes,
    courtLoadSpreadMinutes: loads.length === 0 ? 0 : Math.max(...loads) - Math.min(...loads),
    movedMatchCount,
  };
}

/**
 * What the local search minimises, compared lexicographically: first the number of matches moved
 * from the previous revision (0 unless the preserve-existing setting is active), then the shape
 * cost. Shape terms: back-to-backs, shortfall against the rest target, rest unfairness across
 * participants, day length and finishes after the late threshold (compactness), and court load
 * imbalance. The objective scales the rest and compactness terms.
 *
 * Moved matches are a separate key rather than a weighted term so that no amount of shape gain
 * can buy a move away from a still-valid previous slot: a weighted term (formerly 1000 per
 * match) loses to the rest-spread and shortfall sums on larger or more unbalanced schedules.
 */
type ShapeKey = { readonly moved: number; readonly cost: number };

function improvesOn(candidate: ShapeKey, current: ShapeKey): boolean {
  return candidate.moved < current.moved || (candidate.moved === current.moved && candidate.cost < current.cost);
}

function shapeKey(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[], lateMinute: number): ShapeKey {
  const shape = measureScheduleShape(problem, assignments);
  const { minimumRest, preserveExistingSchedule } = problem.constraints;
  const restTarget = minimumRest.mode === "ignored" ? 0 : minimumRest.value.minutes;
  let restShortfall = 0;
  if (restTarget > 0) {
    for (const gaps of restGapsByEntry(problem, assignments).values())
      for (const gap of gaps) restShortfall += Math.max(0, restTarget - gap);
  }
  const restWeight = problem.objective === "rest_focused" ? 2 : 1;
  const compactWeight = problem.objective === "fastest" ? 2 : 1;
  const dayLength = shape.days.reduce((total, day) => total + day.lengthMinutes, 0);
  const lateFinish = shape.days.reduce((total, day) => total + Math.max(0, day.lastEndLocalMinute - lateMinute), 0);
  return {
    moved: preserveExistingSchedule.mode === "ignored" ? 0 : shape.movedMatchCount,
    cost:
      restWeight * (40 * shape.backToBackCount + 1 * restShortfall + 3 * shape.restSpreadMinutes) +
      compactWeight * (0.5 * dayLength + 1 * lateFinish) +
      0.25 * shape.courtLoadSpreadMinutes,
  };
}

/** Matches worth trying first: moved from the previous revision, or in a back-to-back pair. */
function focusMatchIds(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[]): string[] {
  const matches = new Map(problem.matches.map((match) => [match.id, match]));
  const focus = new Set<string>();
  const previous = problem.constraints.preserveExistingSchedule;
  if (previous.mode !== "ignored") {
    for (const assignment of assignments) {
      const existing = previous.value.byMatchId[assignment.matchId];
      if (existing && (existing.areaId !== assignment.areaId || existing.startEpochMs !== assignment.startEpochMs))
        focus.add(assignment.matchId);
    }
  }
  const bufferMs = backToBackBufferMinutes(problem) * MINUTE_MS;
  const byEntry = new Map<string, ScheduleAssignment[]>();
  for (const assignment of assignments)
    for (const entryId of new Set(matches.get(assignment.matchId)?.possibleEntryIds ?? [])) {
      const list = byEntry.get(entryId);
      if (list) list.push(assignment);
      else byEntry.set(entryId, [assignment]);
    }
  for (const list of byEntry.values()) {
    list.sort((left, right) => left.startEpochMs - right.startEpochMs);
    for (let index = 1; index < list.length; index += 1) {
      if (list[index]!.startEpochMs - list[index - 1]!.endEpochMs < bufferMs) {
        focus.add(list[index]!.matchId);
        focus.add(list[index - 1]!.matchId);
      }
    }
  }
  return [...focus].filter((matchId) => !matches.get(matchId)?.fixedAssignment).sort((l, r) => l.localeCompare(r));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function overlaps(
  left: { startEpochMs: number; endEpochMs: number },
  right: { startEpochMs: number; endEpochMs: number },
) {
  return left.startEpochMs < right.endEpochMs && right.startEpochMs < left.endEpochMs;
}

/**
 * Hard check for moving `moved` matches to new slots against everything else. It covers every
 * intrinsic hard rule and every `required` setting the constructor enforces; the final result is
 * still re-validated in full before it is returned.
 */
function movesAllowed(
  problem: ScheduleProblem,
  matchesById: ReadonlyMap<string, SchedulingMatch>,
  dependantsById: ReadonlyMap<string, readonly string[]>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  next: ReadonlyMap<string, ScheduleAssignment>,
  moved: readonly string[],
): boolean {
  const { constraints } = problem;
  const requiredRestMs = Math.max(
    constraints.minimumRest.mode === "required" ? constraints.minimumRest.value.minutes * MINUTE_MS : 0,
    constraints.avoidConsecutiveMatches.mode === "required"
      ? constraints.avoidConsecutiveMatches.value.minutes * MINUTE_MS
      : 0,
  );
  for (const matchId of moved) {
    const match = matchesById.get(matchId)!;
    const candidate = next.get(matchId)!;
    if (match.fixedAssignment) return false;
    if (candidate.endEpochMs - candidate.startEpochMs !== match.durationMinutes * MINUTE_MS) return false;
    for (const dependency of match.dependencyMatchIds) {
      const prior = next.get(dependency);
      if (!prior || prior.endEpochMs > candidate.startEpochMs) return false;
    }
    for (const dependantId of dependantsById.get(matchId) ?? []) {
      const later = next.get(dependantId);
      if (later && candidate.endEpochMs > later.startEpochMs) return false;
    }
    for (const other of next.values()) {
      if (other.matchId === matchId) continue;
      const otherMatch = matchesById.get(other.matchId)!;
      if (other.areaId === candidate.areaId && overlaps(other, candidate)) return false;
      if (match.officialIds.some((id) => otherMatch.officialIds.includes(id)) && overlaps(other, candidate))
        return false;
      if (match.possibleEntryIds.some((id) => otherMatch.possibleEntryIds.includes(id))) {
        if (overlaps(other, candidate)) return false;
        const gap =
          other.endEpochMs <= candidate.startEpochMs
            ? candidate.startEpochMs - other.endEpochMs
            : other.startEpochMs - candidate.endEpochMs;
        if (gap < requiredRestMs) return false;
      }
    }
    if (constraints.entryUnavailable.mode === "required") {
      for (const entryId of match.possibleEntryIds)
        if ((constraints.entryUnavailable.value.byEntryId[entryId] ?? []).some((window) => overlaps(candidate, window)))
          return false;
    }
    if (constraints.officialAvailability.mode === "required") {
      for (const officialId of match.officialIds)
        if (
          !constraints.officialAvailability.value.byOfficialId[officialId]?.some(
            (window) => candidate.startEpochMs >= window.startEpochMs && candidate.endEpochMs <= window.endEpochMs,
          )
        )
          return false;
    }
    if (
      match.isChampionshipFinal &&
      constraints.preferredFinalTime.mode === "required" &&
      Math.abs(candidate.startEpochMs - constraints.preferredFinalTime.value.targetStartEpochMs) >
        constraints.preferredFinalTime.value.toleranceMinutes * MINUTE_MS
    )
      return false;
    if (
      constraints.featuredPlayingArea.mode === "required" &&
      constraints.featuredPlayingArea.value.matchIds.includes(matchId) &&
      candidate.areaId !== constraints.featuredPlayingArea.value.areaId
    )
      return false;
    if (constraints.preserveExistingSchedule.mode === "required") {
      const existing = constraints.preserveExistingSchedule.value.byMatchId[matchId];
      if (
        existing &&
        (existing.areaId !== candidate.areaId ||
          Math.abs(candidate.startEpochMs - existing.startEpochMs) / MINUTE_MS >
            constraints.preserveExistingSchedule.value.maximumShiftMinutes)
      )
        return false;
    }
    if (constraints.keepDivisionTogether.mode === "required") {
      const areas = new Set<string>();
      for (const other of next.values())
        if (matchesById.get(other.matchId)!.divisionId === match.divisionId) areas.add(other.areaId);
      if (areas.size > constraints.keepDivisionTogether.value.maximumAreaCount) return false;
    }
    if (constraints.maximumMatchesPerDay.mode === "required") {
      const date = localDateKey(candidate.startEpochMs, problem.timeZone);
      const dayMatches = [...next.values()]
        .filter((other) => localDateKey(other.startEpochMs, problem.timeZone) === date)
        .map((other) => matchesById.get(other.matchId)!);
      for (const entryId of match.possibleEntryIds)
        if (
          maxMatchesForEntryInCollection(entryId, dayMatches, ancestors) >
          constraints.maximumMatchesPerDay.value.matches
        )
          return false;
    }
  }
  return true;
}

function moveTo(assignment: ScheduleAssignment, slot: SchedulingSlot): ScheduleAssignment {
  return {
    ...assignment,
    areaId: slot.areaId,
    intervalId: slot.intervalId,
    slotId: slot.id,
    startEpochMs: slot.startEpochMs,
    endEpochMs: slot.endEpochMs,
  };
}

/**
 * Deterministic improvement after construction: seeded relocate (to a free slot) and swap moves
 * between non-fixed matches, accepting a move only when it keeps every hard and required
 * constraint, never moves more matches away from the previous revision (and lowers the shape
 * cost when it moves no fewer), and does not lower the explainable quality score. Locked and
 * published-history matches never move; with preserve-existing active, an unlocked match whose
 * previous slot is still valid stays put whatever the shape gain. Bounded by move and re-score counts, never by wall time,
 * so the same input and seed always return the same schedule.
 */
export function improveSchedule(
  problem: ScheduleProblem,
  assignments: readonly ScheduleAssignment[],
  options: ScheduleImprovementOptions,
): ScheduleImprovement {
  const original = [...assignments].sort(compareAssignment);
  if (!validateSchedule(problem, original).valid) return { assignments: original, acceptedMoves: 0, evaluatedMoves: 0 };
  const matchesById = new Map(problem.matches.map((match) => [match.id, match]));
  const dependantsById = new Map<string, string[]>();
  for (const match of problem.matches)
    for (const dependency of match.dependencyMatchIds) {
      const list = dependantsById.get(dependency);
      if (list) list.push(match.id);
      else dependantsById.set(dependency, [match.id]);
    }
  const ancestors = scheduleInternals.buildTransitiveDependencies(problem.matches);
  const lateMinute = parseLocalTime(problem.constraints.balanceLateMatches.value.atOrAfterLocalTime, "Late threshold");
  const slots = [...problem.slots].sort(
    (left, right) =>
      left.startEpochMs - right.startEpochMs ||
      left.areaId.localeCompare(right.areaId) ||
      left.id.localeCompare(right.id),
  );
  const movable = original
    .filter((assignment) => !matchesById.get(assignment.matchId)?.fixedAssignment)
    .map((assignment) => assignment.matchId)
    .sort((left, right) => left.localeCompare(right));
  const maxMoves = options.maxMoveEvaluations ?? Math.min(10_000, Math.max(1_000, problem.matches.length * 80));
  const maxQualityChecks = options.maxQualityChecks ?? 400;
  const random = mulberry32(options.seed);

  let current = new Map(original.map((assignment) => [assignment.matchId, assignment]));
  let currentKey = shapeKey(problem, original, lateMinute);
  let currentScore = evaluateScheduleQuality(problem, original).score;
  const slotByPosition = new Map(slots.map((slot) => [`${slot.areaId}|${slot.startEpochMs}`, slot]));
  const previous = problem.constraints.preserveExistingSchedule;
  const slotOf = (value: ScheduleAssignment): SchedulingSlot => ({
    id: value.slotId,
    intervalId: value.intervalId,
    areaId: value.areaId,
    startEpochMs: value.startEpochMs,
    endEpochMs: value.endEpochMs,
  });
  let occupantBySlotId = new Map(original.map((assignment) => [assignment.slotId, assignment.matchId]));
  let focus = focusMatchIds(problem, original);
  let acceptedMoves = 0;
  let qualityChecks = 0;
  let evaluatedMoves = 0;
  for (; evaluatedMoves < maxMoves && qualityChecks < maxQualityChecks && movable.length > 0; evaluatedMoves += 1) {
    const pool = focus.length > 0 && random() < 0.5 ? focus : movable;
    const matchId = pool[Math.floor(random() * pool.length)]!;
    const assignment = current.get(matchId)!;
    const existing = previous.mode === "ignored" ? undefined : previous.value.byMatchId[matchId];
    // Restoring a moved match to its previous slot is the move minimal change needs most.
    const target =
      existing && random() < 0.5
        ? slotByPosition.get(`${existing.areaId}|${existing.startEpochMs}`)
        : random() < 0.5
          ? slots[Math.floor(random() * slots.length)]
          : slotOf(current.get(movable[Math.floor(random() * movable.length)]!)!);
    if (!target || target.id === assignment.slotId) continue;
    const otherId = occupantBySlotId.get(target.id);
    const next = new Map(current);
    let moved: string[];
    if (otherId === undefined) {
      next.set(matchId, moveTo(assignment, target));
      moved = [matchId];
    } else {
      const other = current.get(otherId)!;
      if (other.endEpochMs - other.startEpochMs !== assignment.endEpochMs - assignment.startEpochMs) continue;
      next.set(matchId, moveTo(assignment, slotOf(other)));
      next.set(otherId, moveTo(other, slotOf(assignment)));
      moved = [matchId, otherId];
    }
    if (!movesAllowed(problem, matchesById, dependantsById, ancestors, next, moved)) continue;
    const candidate = [...next.values()];
    const key = shapeKey(problem, candidate, lateMinute);
    if (!improvesOn(key, currentKey)) continue;
    qualityChecks += 1;
    const quality = evaluateScheduleQuality(problem, candidate);
    if (!quality.valid || quality.score < currentScore) continue;
    current = next;
    currentKey = key;
    currentScore = quality.score;
    occupantBySlotId = new Map(candidate.map((value) => [value.slotId, value.matchId]));
    focus = focusMatchIds(problem, candidate);
    acceptedMoves += 1;
  }
  const result = [...current.values()].sort(compareAssignment);
  // Defence in depth: never hand back something the full validator rejects.
  if (!validateSchedule(problem, result).valid) return { assignments: original, acceptedMoves: 0, evaluatedMoves };
  return { assignments: result, acceptedMoves, evaluatedMoves };
}
