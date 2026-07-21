import { CANOE_POLO_DEFAULT_SETTINGS } from "./canoe-polo.js";
import { buildCapacitySlots, type AvailabilityInterval, type CapacitySlot } from "./capacity.js";
import type { MatchNode, MatchParticipantSource } from "./format.js";

export type ScheduleOptions = {
  slotMinutes?: number;
  minimumRestMinutes?: number;
};

export type ScheduledMatch = {
  matchId: string;
  areaId: string;
  intervalId: string;
  slotId: string;
  startMinute: number;
  endMinute: number;
};

function directEntry(source: MatchParticipantSource): string | null {
  return source.type === "entry" ? source.entryId : null;
}

function validateGraph(matches: readonly MatchNode[]): void {
  const ids = new Set(matches.map((match) => match.id));
  if (ids.size !== matches.length) throw new Error("Match graph contains duplicate IDs");
  for (const match of matches) {
    if (!match.id) throw new Error("Every match requires a stable ID");
    if (match.dependencyMatchIds.includes(match.id)) throw new Error(`Match ${match.id} depends on itself`);
    for (const dependency of match.dependencyMatchIds) {
      if (!ids.has(dependency)) throw new Error(`Match ${match.id} has unknown dependency ${dependency}`);
    }
  }
}

function topologicalMatches(matches: readonly MatchNode[]): MatchNode[] {
  const pending = new Map(matches.map((match) => [match.id, match]));
  const ordered: MatchNode[] = [];
  const complete = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((match) => match.dependencyMatchIds.every((dependency) => complete.has(dependency)))
      .sort((left, right) => left.round - right.round || left.order - right.order || left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error("Match graph contains a dependency cycle");
    for (const match of ready) {
      pending.delete(match.id);
      complete.add(match.id);
      ordered.push(match);
    }
  }
  return ordered;
}

function isAvailable(
  slot: CapacitySlot,
  match: MatchNode,
  scheduled: ReadonlyMap<string, ScheduledMatch>,
  entryAvailableAt: ReadonlyMap<string, number>,
  minimumRestMinutes: number,
): boolean {
  const dependencyAvailableAt = match.dependencyMatchIds.reduce((latest, dependency) => {
    const dependencySchedule = scheduled.get(dependency);
    if (!dependencySchedule) throw new Error(`Dependency ${dependency} was not scheduled`);
    return Math.max(latest, dependencySchedule.endMinute + minimumRestMinutes);
  }, Number.NEGATIVE_INFINITY);
  if (slot.startMinute < dependencyAvailableAt) return false;

  const participants = [directEntry(match.home), directEntry(match.away)].filter(
    (entry): entry is string => entry !== null,
  );
  if (participants.some((entry) => slot.startMinute < (entryAvailableAt.get(entry) ?? Number.NEGATIVE_INFINITY))) {
    return false;
  }
  return true;
}

export function generateDeterministicSchedule(
  matches: readonly MatchNode[],
  intervals: readonly AvailabilityInterval[],
  options: ScheduleOptions = {},
): ScheduledMatch[] {
  validateGraph(matches);
  const slotMinutes = options.slotMinutes ?? CANOE_POLO_DEFAULT_SETTINGS.slotMinutes;
  const minimumRestMinutes = options.minimumRestMinutes ?? slotMinutes;
  if (!Number.isInteger(minimumRestMinutes) || minimumRestMinutes < 0) {
    throw new Error("Minimum rest must be a non-negative integer number of minutes");
  }
  const slots = buildCapacitySlots(intervals, slotMinutes);
  const unusedSlots = new Map(slots.map((slot) => [slot.id, slot]));
  const scheduled = new Map<string, ScheduledMatch>();
  const entryAvailableAt = new Map<string, number>();

  for (const match of topologicalMatches(matches)) {
    const slot = slots.find(
      (candidate) =>
        unusedSlots.has(candidate.id) && isAvailable(candidate, match, scheduled, entryAvailableAt, minimumRestMinutes),
    );
    if (!slot) throw new Error(`Insufficient continuous capacity to schedule match ${match.id}`);
    const assignment: ScheduledMatch = {
      matchId: match.id,
      areaId: slot.areaId,
      intervalId: slot.intervalId,
      slotId: slot.id,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
    };
    scheduled.set(match.id, assignment);
    unusedSlots.delete(slot.id);
    for (const entry of [directEntry(match.home), directEntry(match.away)]) {
      if (entry) entryAvailableAt.set(entry, assignment.endMinute + minimumRestMinutes);
    }
  }
  return [...scheduled.values()].sort(
    (left, right) =>
      left.startMinute - right.startMinute ||
      left.areaId.localeCompare(right.areaId) ||
      left.matchId.localeCompare(right.matchId),
  );
}
