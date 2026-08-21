import {
  calculateAffectedMatchClosure as calculateBaseAffectedMatchClosure,
  type AffectedMatchAction,
  type AffectedMatchClosure,
  type AffectedMatchClosureInput,
} from "./result-repair.js";

export * from "./result-repair.js";

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

/**
 * Public Gate C repair entrypoint.
 *
 * A competition can legitimately have schedule version zero before its first
 * schedule publication. Persistence has always modelled that state as a
 * non-negative version. Keep the public domain contract aligned while reusing
 * the established closure algorithm, whose actions do not depend on the
 * numeric schedule version.
 */
export function calculateAffectedMatchClosure(input: AffectedMatchClosureInput): AffectedMatchClosure {
  if (!Number.isSafeInteger(input.sourceScheduleVersion) || input.sourceScheduleVersion < 0) {
    throw new Error("Source schedule version must be a non-negative integer");
  }

  const closure = calculateBaseAffectedMatchClosure(
    input.sourceScheduleVersion === 0 ? { ...input, sourceScheduleVersion: 1 } : input,
  );

  if (input.sourceScheduleVersion !== 0) return closure;

  const analysisFingerprintInput = stableJson({
    schema_version: 1,
    competition_id: input.competitionId,
    corrected_match_id: input.correctedMatchId,
    source_result_version: input.sourceResultVersion,
    source_schedule_version: 0,
    affected_division_ids: closure.affectedDivisionIds,
    actions: closure.actions.map(normalizedAction),
  });

  return {
    ...closure,
    sourceScheduleVersion: 0,
    analysisFingerprintInput,
  };
}
