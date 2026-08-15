from pathlib import Path

path = Path("packages/domain/src/schedule-constraints.ts")
text = path.read_text()
start_marker = "function isNoValidSlotError(error: unknown): error is Error {"
end_marker = "/** Converts camel-case domain objects to the stable persistence/worker payload. */"
start = text.find(start_marker)
end = text.find(end_marker)
if start < 0 or end < 0 or end <= start:
    raise SystemExit("Could not locate schedule search replacement boundaries")

replacement = r'''function isSearchFailureError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith("No valid slot remains") || error.message.startsWith("Generated schedule is invalid:"))
  );
}

function fallbackContext(problem: ScheduleProblem, slots: readonly SchedulingSlot[]): CandidateEvaluationContext {
  return {
    matchesById: new Map(problem.matches.map((match) => [match.id, match])),
    allEntryIds: uniqueSorted(problem.matches.flatMap((match) => match.possibleEntryIds)),
    localDateByStart: new Map(
      slots.map((slot) => [slot.startEpochMs, localDateKey(slot.startEpochMs, problem.timeZone)]),
    ),
    localMinuteByStart: new Map(
      slots.map((slot) => [slot.startEpochMs, localMinuteOfDay(slot.startEpochMs, problem.timeZone)]),
    ),
    earlyThreshold: parseLocalTime(problem.constraints.balanceEarlyMatches.value.beforeLocalTime, "Early threshold"),
    lateThreshold: parseLocalTime(problem.constraints.balanceLateMatches.value.atOrAfterLocalTime, "Late threshold"),
  };
}

function matchesByDivision(problem: ScheduleProblem): readonly Readonly<{ divisionId: string; matches: SchedulingMatch[] }>[] {
  const grouped = new Map<string, SchedulingMatch[]>();
  for (const match of problem.matches) {
    const matches = grouped.get(match.divisionId) ?? [];
    matches.push(match);
    grouped.set(match.divisionId, matches);
  }
  return [...grouped.entries()]
    .map(([divisionId, matches]) => ({ divisionId, matches }))
    .sort((left, right) => right.matches.length - left.matches.length || left.divisionId.localeCompare(right.divisionId));
}

function dedicatedAreaMappings(
  problem: ScheduleProblem,
  divisions: readonly Readonly<{ divisionId: string; matches: SchedulingMatch[] }>[],
): ReadonlyMap<string, string>[] {
  const slotsByArea = new Map<string, SchedulingSlot[]>();
  for (const slot of problem.slots) {
    const slots = slotsByArea.get(slot.areaId) ?? [];
    slots.push(slot);
    slotsByArea.set(slot.areaId, slots);
  }
  const areaIds = [...slotsByArea.keys()].sort((left, right) => left.localeCompare(right));
  if (divisions.length < 2 || divisions.length > areaIds.length) return [];

  const results: ReadonlyMap<string, string>[] = [];
  const maximumMappings = 256;
  const visit = (index: number, availableAreaIds: readonly string[], mapping: Map<string, string>): void => {
    if (results.length >= maximumMappings) return;
    if (index >= divisions.length) {
      results.push(new Map(mapping));
      return;
    }
    const division = divisions[index]!;
    for (const areaId of availableAreaIds) {
      if ((slotsByArea.get(areaId)?.length ?? 0) < division.matches.length) continue;
      mapping.set(division.divisionId, areaId);
      visit(
        index + 1,
        availableAreaIds.filter((candidate) => candidate !== areaId),
        mapping,
      );
      mapping.delete(division.divisionId);
      if (results.length >= maximumMappings) return;
    }
  };
  visit(0, areaIds, new Map());
  return results;
}

function tryDivisionFirstFallback(
  problem: ScheduleProblem,
  divisions: readonly Readonly<{ divisionId: string; matches: SchedulingMatch[] }>[],
  areaByDivision?: ReadonlyMap<string, string>,
): ScheduleAssignment[] | null {
  const slots = [...problem.slots].sort(
    (left, right) =>
      left.startEpochMs - right.startEpochMs ||
      left.areaId.localeCompare(right.areaId) ||
      left.id.localeCompare(right.id),
  );
  const context = fallbackContext(problem, slots);
  const assigned = new Map<string, ScheduleAssignment>();
  const usedSlots = new Set<string>();

  for (const division of divisions) {
    const mappedArea = areaByDivision?.get(division.divisionId);
    for (const match of topologicalMatches(division.matches)) {
      const selected = slots
        .filter((slot) => !usedSlots.has(slot.id) && (mappedArea === undefined || slot.areaId === mappedArea))
        .map((slot) => assignmentFor(match, slot))
        .find((candidate) => partialAllows(problem, match, candidate, assigned, context));
      if (!selected) return null;
      assigned.set(match.id, selected);
      usedSlots.add(selected.slotId);
    }
  }

  const result = [...assigned.values()].sort(compareAssignment);
  return validateSchedule(problem, result).valid ? result : null;
}

function generateFeasibilityFallback(problem: ScheduleProblem): ScheduleAssignment[] | null {
  const divisions = matchesByDivision(problem);
  for (const mapping of dedicatedAreaMappings(problem, divisions)) {
    const candidate = tryDivisionFirstFallback(problem, divisions, mapping);
    if (candidate) return candidate;
  }

  const normal = tryDivisionFirstFallback(problem, divisions);
  if (normal) return normal;
  if (divisions.length > 1) {
    const reversed = tryDivisionFirstFallback(problem, [...divisions].reverse());
    if (reversed) return reversed;
  }
  return null;
}

export function generateConstraintAwareSchedule(problem: ScheduleProblem): ScheduleAssignment[] {
  let lastSearchFailure: Error | undefined;
  const attempts = problem.objective === "fastest" ? [problem] : [problem, { ...problem, objective: "fastest" as const }];
  for (const attempt of attempts) {
    try {
      return generateIteration(attempt, 0);
    } catch (error) {
      if (!isSearchFailureError(error)) throw error;
      lastSearchFailure = error;
    }
  }

  const fallback = generateFeasibilityFallback(problem);
  if (fallback) return fallback;
  throw lastSearchFailure ?? new Error("No valid schedule could be constructed");
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
      add(iteration, generateIteration(problem, iteration));
    } catch (error) {
      if (!isSearchFailureError(error)) throw error;
      if (problem.objective === "fastest") continue;
      try {
        add(iteration, generateIteration({ ...problem, objective: "fastest" }, iteration));
      } catch (fallbackError) {
        if (!isSearchFailureError(fallbackError)) throw fallbackError;
      }
    }
  }

  if (candidates.length === 0) {
    const fallback = generateFeasibilityFallback(problem);
    if (fallback) add(startIteration, fallback);
  }
  return candidates;
}

'''

path.write_text(text[:start] + replacement + text[end:])
