import {
  scheduleInternals,
  validateSchedule,
  type ScheduleAssignment,
  type ScheduleProblem,
  type SchedulingMatch,
  type SchedulingSlot,
} from "./schedule-constraints.js";
import { backToBackBufferMinutes, measureScheduleShape, scheduleMovesAllowed } from "./schedule-improvement.js";

const MINUTE_MS = 60_000;

export type RestAwareConstructionOptions = {
  /** Total search nodes across every back-to-back allowance tried (default 120 000, about 1 s). */
  maxNodes?: number;
};

export type RestAwareConstruction = {
  assignments: readonly ScheduleAssignment[];
  /** Back-to-backs as `measureScheduleShape` counts them. */
  backToBackCount: number;
  /** The allowance the search succeeded with; 0 means the search itself proves a 0 schedule exists. */
  backToBackAllowance: number;
  nodes: number;
};

type TimeGroup = { start: number; end: number; firstSlot: number };

/**
 * Bounded depth-first construction that places matches slot by slot in time order and admits a
 * back-to-back only while the running count stays within an allowance. Allowances are tried in
 * increasing order (0, 1, 2, 4, 8, ...), so the first success is the fewest back-to-backs the
 * search can reach within its node budget. Every placement passes the same hard and required
 * checks as local search, and the result is fully re-validated.
 *
 * This is the witness search for "0 back-to-backs when capacity allows": when it returns an
 * allowance of 0 the schedule it returns is the witness. It is deterministic (no randomness, no
 * wall clock) and returns null when it cannot place every match within the budget, so callers
 * keep the greedy construction. Minimal-change re-planning (preserve-existing on) is left to the
 * greedy constructor, which keeps matches in place.
 */
export function constructRestAwareSchedule(
  problem: ScheduleProblem,
  options: RestAwareConstructionOptions = {},
): RestAwareConstruction | null {
  if (problem.constraints.preserveExistingSchedule.mode !== "ignored") return null;
  if (problem.matches.length === 0) return null;
  const maxNodes = options.maxNodes ?? 120_000;
  const bufferMs = backToBackBufferMinutes(problem) * MINUTE_MS;
  const matchesById = new Map(problem.matches.map((match) => [match.id, match]));
  const dependantsById = new Map<string, string[]>();
  for (const match of problem.matches)
    for (const dependency of match.dependencyMatchIds) {
      const list = dependantsById.get(dependency);
      if (list) list.push(match.id);
      else dependantsById.set(dependency, [match.id]);
    }
  const ancestors = scheduleInternals.buildTransitiveDependencies(problem.matches);
  const slots = [...problem.slots].sort(
    (left, right) =>
      left.startEpochMs - right.startEpochMs ||
      left.endEpochMs - right.endEpochMs ||
      left.areaId.localeCompare(right.areaId) ||
      left.id.localeCompare(right.id),
  );
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  // Interchangeable same-time slots let the search skip permutations; required area rules break that.
  const symmetric =
    problem.constraints.featuredPlayingArea.mode !== "required" &&
    problem.constraints.keepDivisionTogether.mode !== "required";

  const groups: TimeGroup[] = [];
  const groupOfSlot: number[] = [];
  slots.forEach((slot, index) => {
    const last = groups.at(-1);
    if (!last || last.start !== slot.startEpochMs || last.end !== slot.endEpochMs)
      groups.push({ start: slot.startEpochMs, end: slot.endEpochMs, firstSlot: index });
    groupOfSlot.push(groups.length - 1);
  });

  const entries = [...new Set(problem.matches.flatMap((match) => match.possibleEntryIds))].sort();
  const entryIndex = new Map(entries.map((entry, index) => [entry, index]));
  const matchEntries = new Map(
    problem.matches.map((match) => [match.id, [...new Set(match.possibleEntryIds)].map((id) => entryIndex.get(id)!)]),
  );
  const order = [...problem.matches].sort((left, right) => left.id.localeCompare(right.id));
  // Longest chain of dependants below each match: later rounds wait on it, so it goes first on ties.
  const tail = new Map<string, number>();
  const tailOf = (matchId: string): number => {
    const known = tail.get(matchId);
    if (known !== undefined) return known;
    const value = 1 + Math.max(0, ...(dependantsById.get(matchId) ?? []).map(tailOf));
    tail.set(matchId, value);
    return value;
  };

  let nodes = 0;
  // Each back-to-back is one shared possible participant in one gap, so this bounds any schedule.
  const ceiling = problem.matches.reduce((total, match) => total + 2 * new Set(match.possibleEntryIds).size, 0);
  const tried = allowances(ceiling);
  // Zero gets 40% of the budget; the larger allowances share the rest, unspent nodes carry over.
  const shares = [0.4 * maxNodes, ...tried.slice(1).map(() => (0.6 * maxNodes) / Math.max(1, tried.length - 1))];
  let budget = 0;
  for (const [position, allowance] of tried.entries()) {
    if (nodes >= maxNodes) break;
    budget += shares[position]!;
    const limit = Math.min(maxNodes, Math.floor(budget));
    const placed = new Map<string, ScheduleAssignment>();
    const intervalsByEntry: { start: number; end: number }[][] = entries.map(() => []);
    const remainingByEntry = new Array<number>(entries.length).fill(0);
    const remaining = new Set<string>();
    const usedSlots = new Set<string>();
    for (const match of order) {
      if (match.fixedAssignment) {
        const slot = slotById.get(match.fixedAssignment.slotId);
        if (!slot) return null;
        placed.set(match.id, assignmentFor(match, slot));
        usedSlots.add(slot.id);
        for (const entry of matchEntries.get(match.id)!)
          intervalsByEntry[entry]!.push({ start: slot.startEpochMs, end: slot.endEpochMs });
      } else {
        remaining.add(match.id);
        for (const entry of matchEntries.get(match.id)!) remainingByEntry[entry]! += 1;
      }
    }
    for (const list of intervalsByEntry) list.sort((left, right) => left.start - right.start);

    const backToBacksFor = (match: SchedulingMatch, slot: SchedulingSlot): number => {
      let count = 0;
      for (const entry of matchEntries.get(match.id)!) {
        for (const interval of intervalsByEntry[entry]!) {
          const gap =
            interval.end <= slot.startEpochMs ? slot.startEpochMs - interval.end : interval.start - slot.endEpochMs;
          if (gap >= 0 && gap < bufferMs) count += 1;
        }
      }
      return count;
    };

    /** Most matches entry `entry` can still play from group `fromGroup` with a full buffer between. */
    const chainCapacity = (entry: number, fromGroup: number): number => {
      const busy = intervalsByEntry[entry]!;
      let earliest = Number.NEGATIVE_INFINITY;
      for (const interval of busy)
        if (interval.start < groups[fromGroup]!.start) earliest = Math.max(earliest, interval.end + bufferMs);
      let count = 0;
      for (let group = fromGroup; group < groups.length; group += 1) {
        const time = groups[group]!;
        if (time.start < earliest) continue;
        if (busy.some((interval) => interval.start < time.end + bufferMs && time.start < interval.end + bufferMs))
          continue;
        count += 1;
        earliest = time.end + bufferMs;
      }
      return count;
    };

    let freeSlotsFrom: number[] = [];
    {
      let free = 0;
      freeSlotsFrom = new Array<number>(slots.length + 1).fill(0);
      for (let index = slots.length - 1; index >= 0; index -= 1) {
        if (!usedSlots.has(slots[index]!.id)) free += 1;
        freeSlotsFrom[index] = free;
      }
    }

    const slackCache = new Map<number, Int32Array>();
    let exhausted = false;
    const search = (slotIndex: number, used: number, minimumRank: number): boolean => {
      if (remaining.size === 0) return true;
      nodes += 1;
      if (nodes >= limit) {
        exhausted = true;
        return false;
      }
      if (slotIndex >= slots.length || remaining.size > freeSlotsFrom[slotIndex]!) return false;
      const slot = slots[slotIndex]!;
      const group = groupOfSlot[slotIndex]!;
      const sameTimeAsPrevious = slotIndex > 0 && groupOfSlot[slotIndex - 1] === group;
      let slack = slackCache.get(slotIndex);
      if (!sameTimeAsPrevious || slack === undefined) {
        slack = new Int32Array(entries.length);
        let shortfall = 0;
        for (let entry = 0; entry < entries.length; entry += 1) {
          if (remainingByEntry[entry] === 0) continue;
          const value = chainCapacity(entry, group) - remainingByEntry[entry]!;
          slack[entry] = value;
          if (value < 0) shortfall -= value;
        }
        if (used + shortfall > allowance) return false;
        slackCache.set(slotIndex, slack);
      }
      const nextRankFloor = (rank: number) =>
        symmetric && slotIndex + 1 < slots.length && groupOfSlot[slotIndex + 1] === group ? rank : -1;
      if (usedSlots.has(slot.id)) return search(slotIndex + 1, used, -1);

      const candidates: { match: SchedulingMatch; rank: number; cost: number; key: number }[] = [];
      for (let rank = 0; rank < order.length; rank += 1) {
        const match = order[rank]!;
        if (!remaining.has(match.id)) continue;
        if (symmetric && sameTimeAsPrevious && rank <= minimumRank) continue;
        if (match.durationMinutes * MINUTE_MS !== slot.endEpochMs - slot.startEpochMs) continue;
        if (
          match.dependencyMatchIds.some((dependency) => {
            const prior = placed.get(dependency);
            return !prior || prior.endEpochMs > slot.startEpochMs;
          })
        )
          continue;
        const cost = backToBacksFor(match, slot);
        if (used + cost > allowance) continue;
        let tightest = Number.POSITIVE_INFINITY;
        for (const entry of matchEntries.get(match.id)!) tightest = Math.min(tightest, slack![entry]!);
        candidates.push({ match, rank, cost, key: tightest * 1_000 - tailOf(match.id) });
      }
      candidates.sort((left, right) => left.cost - right.cost || left.key - right.key || left.rank - right.rank);
      for (const candidate of candidates) {
        const assignment = assignmentFor(candidate.match, slot);
        placed.set(candidate.match.id, assignment);
        if (scheduleMovesAllowed(problem, matchesById, dependantsById, ancestors, placed, [candidate.match.id])) {
          remaining.delete(candidate.match.id);
          const touched = matchEntries.get(candidate.match.id)!;
          for (const entry of touched) {
            remainingByEntry[entry]! -= 1;
            intervalsByEntry[entry]!.push({ start: slot.startEpochMs, end: slot.endEpochMs });
          }
          if (search(slotIndex + 1, used + candidate.cost, nextRankFloor(candidate.rank))) return true;
          for (const entry of touched) {
            remainingByEntry[entry]! += 1;
            intervalsByEntry[entry]!.pop();
          }
          remaining.add(candidate.match.id);
        }
        placed.delete(candidate.match.id);
        if (exhausted) return false;
      }
      // Leaving the slot empty; with interchangeable slots the rest of this time stays empty too.
      if (remaining.size > freeSlotsFrom[slotIndex + 1]!) return false;
      return search(slotIndex + 1, used, nextRankFloor(order.length));
    };

    if (search(0, 0, -1)) {
      let assignments = [...placed.values()].sort(scheduleInternals.compareAssignment);
      if (!validateSchedule(problem, assignments).valid) return null;
      if (symmetric) {
        const balanced = balanceAreasWithinTimes(slots, groupOfSlot, assignments, matchesById);
        if (validateSchedule(problem, balanced).valid) assignments = balanced;
      }
      return {
        assignments,
        backToBackCount: measureScheduleShape(problem, assignments).backToBackCount,
        backToBackAllowance: allowance,
        nodes,
      };
    }
  }
  return null;
}

/**
 * Slot-order search fills the first areas of each time first. Matches at one time on
 * interchangeable slots can trade areas without changing any participant's day, so hand each
 * time's movable matches to the least-loaded areas so far (ties by area id).
 */
function balanceAreasWithinTimes(
  slots: readonly SchedulingSlot[],
  groupOfSlot: readonly number[],
  assignments: readonly ScheduleAssignment[],
  matchesById: ReadonlyMap<string, SchedulingMatch>,
): ScheduleAssignment[] {
  const bySlot = new Map(assignments.map((assignment) => [assignment.slotId, assignment]));
  const load = new Map<string, number>();
  const result: ScheduleAssignment[] = [];
  let index = 0;
  while (index < slots.length) {
    const group = groupOfSlot[index]!;
    const groupSlots: SchedulingSlot[] = [];
    for (; index < slots.length && groupOfSlot[index] === group; index += 1) groupSlots.push(slots[index]!);
    const movable: ScheduleAssignment[] = [];
    const open: SchedulingSlot[] = [];
    for (const slot of groupSlots) {
      const occupant = bySlot.get(slot.id);
      if (occupant && matchesById.get(occupant.matchId)?.fixedAssignment) {
        result.push(occupant);
        load.set(slot.areaId, (load.get(slot.areaId) ?? 0) + (slot.endEpochMs - slot.startEpochMs));
      } else {
        open.push(slot);
        if (occupant) movable.push(occupant);
      }
    }
    open.sort(
      (left, right) =>
        (load.get(left.areaId) ?? 0) - (load.get(right.areaId) ?? 0) || left.areaId.localeCompare(right.areaId),
    );
    movable.forEach((assignment, position) => {
      const slot = open[position]!;
      result.push(assignmentFor(matchesById.get(assignment.matchId)!, slot));
      load.set(slot.areaId, (load.get(slot.areaId) ?? 0) + (slot.endEpochMs - slot.startEpochMs));
    });
  }
  return result.sort(scheduleInternals.compareAssignment);
}

function allowances(ceiling: number): number[] {
  const values = [0];
  for (let value = 1; value < ceiling; value *= 2) values.push(value);
  values.push(ceiling);
  return values;
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
