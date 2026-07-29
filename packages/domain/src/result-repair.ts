export type RepairMatchState = "pending" | "ready" | "in_progress" | "final" | "corrected";
export type RepairSlot = "home" | "away";
export type RepairSlotControl = "automatic" | "manual";
export type RepairOutcomeKind = "winner" | "loser";

export type RepairDependency = Readonly<{
  sourceMatchId: string;
  downstreamMatchId: string;
  slot: RepairSlot;
  outcome: RepairOutcomeKind;
}>;

export type RepairMatchSnapshot = Readonly<{
  matchId: string;
  divisionId: string;
  state: RepairMatchState;
  homeEntryId: string | null;
  awayEntryId: string | null;
  homeControl: RepairSlotControl;
  awayControl: RepairSlotControl;
  operationallyLocked?: boolean;
}>;

export type RepairOutcomeSnapshot = Readonly<{
  matchId: string;
  winnerEntryId: string | null;
  loserEntryId: string | null;
}>;

export type AffectedMatchActionKind =
  | "no_change"
  | "automatic_update"
  | "protected_started_match"
  | "protected_finalised_match"
  | "protected_manual_slot"
  | "requires_organiser_decision";

export type RepairDependencyPathStep = Readonly<{
  sourceMatchId: string;
  downstreamMatchId: string;
  slot: RepairSlot;
  outcome: RepairOutcomeKind;
}>;

export type AffectedMatchAction = Readonly<{
  matchId: string;
  divisionId: string;
  slot: RepairSlot;
  currentEntryId: string | null;
  proposedEntryId: string | null;
  matchState: RepairMatchState;
  control: RepairSlotControl;
  action: AffectedMatchActionKind;
  reason: string;
  dependencyPath: readonly RepairDependencyPathStep[];
}>;

export type AffectedMatchClosureInput = Readonly<{
  competitionId: string;
  correctedMatchId: string;
  sourceResultVersion: number;
  sourceScheduleVersion: number;
  matches: readonly RepairMatchSnapshot[];
  dependencies: readonly RepairDependency[];
  proposedOutcomes: readonly RepairOutcomeSnapshot[];
}>;

export type AffectedMatchClosure = Readonly<{
  schemaVersion: 1;
  competitionId: string;
  correctedMatchId: string;
  sourceResultVersion: number;
  sourceScheduleVersion: number;
  affectedDivisionIds: readonly string[];
  actions: readonly AffectedMatchAction[];
  analysisFingerprintInput: string;
}>;

function dependencyKey(dependency: RepairDependency): string {
  return [dependency.sourceMatchId, dependency.downstreamMatchId, dependency.slot, dependency.outcome].join("\u0000");
}

function pathKey(path: readonly RepairDependencyPathStep[]): string {
  return path
    .map((step) => [step.sourceMatchId, step.downstreamMatchId, step.slot, step.outcome].join("\u0000"))
    .join("\u0001");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validatePositiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function validateInput(input: AffectedMatchClosureInput): {
  matches: ReadonlyMap<string, RepairMatchSnapshot>;
  outcomes: ReadonlyMap<string, RepairOutcomeSnapshot>;
  outgoing: ReadonlyMap<string, readonly RepairDependency[]>;
} {
  if (!input.competitionId || !input.correctedMatchId) {
    throw new Error("Repair analysis requires stable competition and match IDs");
  }
  validatePositiveVersion(input.sourceResultVersion, "Source result version");
  validatePositiveVersion(input.sourceScheduleVersion, "Source schedule version");

  const matches = new Map<string, RepairMatchSnapshot>();
  for (const match of input.matches) {
    if (!match.matchId || !match.divisionId) throw new Error("Repair matches require stable IDs");
    if (matches.has(match.matchId)) throw new Error(`Duplicate repair match ${match.matchId}`);
    matches.set(match.matchId, match);
  }
  if (!matches.has(input.correctedMatchId)) throw new Error(`Unknown corrected match ${input.correctedMatchId}`);

  const outcomes = new Map<string, RepairOutcomeSnapshot>();
  for (const outcome of input.proposedOutcomes) {
    if (!matches.has(outcome.matchId)) throw new Error(`Repair outcome references unknown match ${outcome.matchId}`);
    if (outcomes.has(outcome.matchId)) throw new Error(`Duplicate repair outcome ${outcome.matchId}`);
    if (
      outcome.winnerEntryId !== null &&
      outcome.loserEntryId !== null &&
      outcome.winnerEntryId === outcome.loserEntryId
    ) {
      throw new Error(`Repair outcome ${outcome.matchId} cannot use the same winner and loser`);
    }
    outcomes.set(outcome.matchId, outcome);
  }

  const outgoing = new Map<string, RepairDependency[]>();
  const dependencySlots = new Set<string>();
  for (const dependency of input.dependencies) {
    if (dependency.sourceMatchId === dependency.downstreamMatchId) {
      throw new Error(`Repair dependency ${dependency.sourceMatchId} cannot reference itself`);
    }
    if (!matches.has(dependency.sourceMatchId) || !matches.has(dependency.downstreamMatchId)) {
      throw new Error(
        `Repair dependency ${dependency.sourceMatchId} -> ${dependency.downstreamMatchId} references an unknown match`,
      );
    }
    const slotKey = `${dependency.downstreamMatchId}\u0000${dependency.slot}`;
    if (dependencySlots.has(slotKey)) {
      throw new Error(`Repair dependency duplicates ${dependency.downstreamMatchId}/${dependency.slot}`);
    }
    dependencySlots.add(slotKey);
    const dependencies = outgoing.get(dependency.sourceMatchId) ?? [];
    dependencies.push(dependency);
    outgoing.set(dependency.sourceMatchId, dependencies);
  }
  for (const dependencies of outgoing.values()) {
    dependencies.sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right)));
  }

  if ((outgoing.get(input.correctedMatchId)?.length ?? 0) > 0 && !outcomes.has(input.correctedMatchId)) {
    throw new Error("Corrected match requires a proposed winner and loser outcome");
  }

  return { matches, outcomes, outgoing };
}

function assertReachableGraphIsAcyclic(
  correctedMatchId: string,
  outgoing: ReadonlyMap<string, readonly RepairDependency[]>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (matchId: string, path: readonly string[]): void => {
    if (visiting.has(matchId)) {
      throw new Error(`Repair dependency cycle detected: ${[...path, matchId].join(" -> ")}`);
    }
    if (visited.has(matchId)) return;
    visiting.add(matchId);
    for (const dependency of outgoing.get(matchId) ?? []) {
      visit(dependency.downstreamMatchId, [...path, matchId]);
    }
    visiting.delete(matchId);
    visited.add(matchId);
  };

  visit(correctedMatchId, []);
}

function classifyAction(
  match: RepairMatchSnapshot,
  slot: RepairSlot,
  currentEntryId: string | null,
  proposedEntryId: string | null,
): Pick<AffectedMatchAction, "action" | "reason" | "control"> {
  const control = slot === "home" ? match.homeControl : match.awayControl;
  if (currentEntryId === proposedEntryId) {
    return { action: "no_change", reason: "Resolved participant is unchanged", control };
  }
  if (match.state === "final" || match.state === "corrected") {
    return {
      action: "protected_finalised_match",
      reason: "A finalised downstream match cannot be silently rewritten",
      control,
    };
  }
  if (match.state === "in_progress") {
    return {
      action: "protected_started_match",
      reason: "A started downstream match cannot be silently rewritten",
      control,
    };
  }
  if (control === "manual") {
    return {
      action: "protected_manual_slot",
      reason: "The downstream participant slot is under manual organiser control",
      control,
    };
  }
  if (proposedEntryId === null) {
    return {
      action: "requires_organiser_decision",
      reason: "The corrected dependency does not yet resolve a replacement participant",
      control,
    };
  }
  if (match.state === "ready" && match.operationallyLocked === true) {
    return {
      action: "requires_organiser_decision",
      reason: "The ready match is operationally locked and requires organiser review",
      control,
    };
  }
  return {
    action: "automatic_update",
    reason: "The unstarted automatic participant slot can be updated in a private repair revision",
    control,
  };
}

function proposedParticipant(
  dependency: RepairDependency,
  outcomes: ReadonlyMap<string, RepairOutcomeSnapshot>,
): string | null {
  const outcome = outcomes.get(dependency.sourceMatchId);
  return dependency.outcome === "winner" ? (outcome?.winnerEntryId ?? null) : (outcome?.loserEntryId ?? null);
}

function normalizedAction(action: AffectedMatchAction): Record<string, unknown> {
  return {
    action: action.action,
    control: action.control,
    current_entry_id: action.currentEntryId,
    dependency_path: action.dependencyPath.map((step) => ({
      downstream_match_id: step.downstreamMatchId,
      outcome: step.outcome,
      slot: step.slot,
      source_match_id: step.sourceMatchId,
    })),
    division_id: action.divisionId,
    match_id: action.matchId,
    match_state: action.matchState,
    proposed_entry_id: action.proposedEntryId,
    reason: action.reason,
    slot: action.slot,
  };
}

export function calculateAffectedMatchClosure(input: AffectedMatchClosureInput): AffectedMatchClosure {
  const { matches, outcomes, outgoing } = validateInput(input);
  assertReachableGraphIsAcyclic(input.correctedMatchId, outgoing);

  const bestPathByMatch = new Map<string, readonly RepairDependencyPathStep[]>([[input.correctedMatchId, []]]);
  const pending = [input.correctedMatchId];
  const actions: AffectedMatchAction[] = [];

  while (pending.length > 0) {
    pending.sort((left, right) => {
      const leftPath = bestPathByMatch.get(left) ?? [];
      const rightPath = bestPathByMatch.get(right) ?? [];
      return leftPath.length - rightPath.length || pathKey(leftPath).localeCompare(pathKey(rightPath));
    });
    const sourceMatchId = pending.shift();
    if (!sourceMatchId) break;
    const sourcePath = bestPathByMatch.get(sourceMatchId) ?? [];

    for (const dependency of outgoing.get(sourceMatchId) ?? []) {
      const match = matches.get(dependency.downstreamMatchId);
      if (!match) throw new Error(`Repair dependency references unknown match ${dependency.downstreamMatchId}`);
      const dependencyStep: RepairDependencyPathStep = { ...dependency };
      const dependencyPath = [...sourcePath, dependencyStep];
      const currentEntryId = dependency.slot === "home" ? match.homeEntryId : match.awayEntryId;
      const proposedEntryId = proposedParticipant(dependency, outcomes);
      const classification = classifyAction(match, dependency.slot, currentEntryId, proposedEntryId);
      actions.push({
        matchId: match.matchId,
        divisionId: match.divisionId,
        slot: dependency.slot,
        currentEntryId,
        proposedEntryId,
        matchState: match.state,
        control: classification.control,
        action: classification.action,
        reason: classification.reason,
        dependencyPath,
      });

      const existingPath = bestPathByMatch.get(match.matchId);
      if (
        !existingPath ||
        dependencyPath.length < existingPath.length ||
        (dependencyPath.length === existingPath.length && pathKey(dependencyPath) < pathKey(existingPath))
      ) {
        bestPathByMatch.set(match.matchId, dependencyPath);
        if (!pending.includes(match.matchId)) pending.push(match.matchId);
      }
    }
  }

  actions.sort(
    (left, right) =>
      left.dependencyPath.length - right.dependencyPath.length ||
      pathKey(left.dependencyPath).localeCompare(pathKey(right.dependencyPath)) ||
      left.matchId.localeCompare(right.matchId) ||
      left.slot.localeCompare(right.slot),
  );
  const affectedDivisionIds = [...new Set(actions.map((action) => action.divisionId))].sort();
  const analysisFingerprintInput = stableJson({
    schema_version: 1,
    competition_id: input.competitionId,
    corrected_match_id: input.correctedMatchId,
    source_result_version: input.sourceResultVersion,
    source_schedule_version: input.sourceScheduleVersion,
    affected_division_ids: affectedDivisionIds,
    actions: actions.map(normalizedAction),
  });

  return {
    schemaVersion: 1,
    competitionId: input.competitionId,
    correctedMatchId: input.correctedMatchId,
    sourceResultVersion: input.sourceResultVersion,
    sourceScheduleVersion: input.sourceScheduleVersion,
    affectedDivisionIds,
    actions,
    analysisFingerprintInput,
  };
}
