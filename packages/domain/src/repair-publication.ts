import type { AffectedMatchAction, AffectedMatchClosure, RepairSlot } from "./result-repair.js";

export type RepairDecisionKind =
  | "accept_proposed"
  | "keep_current"
  | "set_manual_entry"
  | "leave_protected";

export type RepairPublicationDecision = Readonly<{
  matchId: string;
  slot: RepairSlot;
  decision: RepairDecisionKind;
  selectedEntryId?: string | null;
  reason?: string;
}>;

export type RepairActionResolution = Readonly<{
  matchId: string;
  divisionId: string;
  slot: RepairSlot;
  sourceAction: AffectedMatchAction["action"];
  decision: RepairDecisionKind;
  resolvedEntryId: string | null;
  reason: string;
}>;

export type RepairPublicationUnresolved = Readonly<{
  matchId: string;
  slot: RepairSlot;
  action: AffectedMatchAction["action"];
  reason: string;
}>;

export type RepairPublicationPlan = Readonly<{
  ready: boolean;
  unresolved: readonly RepairPublicationUnresolved[];
  resolutions: readonly RepairActionResolution[];
  publicationFingerprintInput: string;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Repair publication input contains an unsupported value");
  return serialized;
}

function actionKey(matchId: string, slot: RepairSlot): string {
  return `${matchId}\u0000${slot}`;
}

function normalizedReason(reason: string | undefined): string {
  return reason?.trim() ?? "";
}

function reasonRequired(decision: RepairDecisionKind): boolean {
  return decision !== "accept_proposed";
}

function validateDecisionShape(decision: RepairPublicationDecision): void {
  if (!decision.matchId) throw new Error("Repair publication decisions require a match ID");
  const reason = normalizedReason(decision.reason);
  if (reasonRequired(decision.decision) && reason.length < 3) {
    throw new Error(`Repair decision ${decision.matchId}/${decision.slot} requires a reason`);
  }
  if (decision.decision === "set_manual_entry") {
    if (!decision.selectedEntryId?.trim()) {
      throw new Error(`Manual repair decision ${decision.matchId}/${decision.slot} requires an entry`);
    }
  } else if (decision.selectedEntryId !== undefined) {
    throw new Error(`Only manual repair decisions may select an entry for ${decision.matchId}/${decision.slot}`);
  }
}

function permittedDecision(action: AffectedMatchAction, decision: RepairPublicationDecision): boolean {
  switch (action.action) {
    case "no_change":
      return false;
    case "automatic_update":
      return (
        decision.decision === "accept_proposed" ||
        decision.decision === "keep_current" ||
        decision.decision === "set_manual_entry"
      );
    case "protected_started_match":
    case "protected_finalised_match":
      return decision.decision === "leave_protected" || decision.decision === "keep_current";
    case "protected_manual_slot":
      return (
        decision.decision === "keep_current" ||
        decision.decision === "set_manual_entry" ||
        decision.decision === "accept_proposed"
      );
    case "requires_organiser_decision":
      return true;
  }
  return false;
}

function resolveDecision(action: AffectedMatchAction, decision: RepairPublicationDecision): RepairActionResolution {
  if (!permittedDecision(action, decision)) {
    throw new Error(`Decision ${decision.decision} is not permitted for ${action.matchId}/${action.slot}/${action.action}`);
  }
  if (decision.decision === "accept_proposed" && action.proposedEntryId === null) {
    throw new Error(`Repair decision ${action.matchId}/${action.slot} cannot accept an unresolved participant`);
  }
  const reason =
    decision.decision === "accept_proposed"
      ? normalizedReason(decision.reason) || "Organiser accepted the proposed dependency result"
      : normalizedReason(decision.reason);
  const resolvedEntryId =
    decision.decision === "accept_proposed"
      ? action.proposedEntryId
      : decision.decision === "set_manual_entry"
        ? decision.selectedEntryId!
        : action.currentEntryId;
  return {
    matchId: action.matchId,
    divisionId: action.divisionId,
    slot: action.slot,
    sourceAction: action.action,
    decision: decision.decision,
    resolvedEntryId,
    reason,
  };
}

function defaultResolution(action: AffectedMatchAction): RepairActionResolution | null {
  if (action.action === "no_change") {
    return {
      matchId: action.matchId,
      divisionId: action.divisionId,
      slot: action.slot,
      sourceAction: action.action,
      decision: "keep_current",
      resolvedEntryId: action.currentEntryId,
      reason: "Resolved participant is unchanged",
    };
  }
  if (action.action === "automatic_update" && action.proposedEntryId !== null) {
    return {
      matchId: action.matchId,
      divisionId: action.divisionId,
      slot: action.slot,
      sourceAction: action.action,
      decision: "accept_proposed",
      resolvedEntryId: action.proposedEntryId,
      reason: "Safe automatic repair accepted by policy",
    };
  }
  return null;
}

function normalizedResolution(resolution: RepairActionResolution): Record<string, unknown> {
  return {
    decision: resolution.decision,
    division_id: resolution.divisionId,
    match_id: resolution.matchId,
    reason: resolution.reason,
    resolved_entry_id: resolution.resolvedEntryId,
    slot: resolution.slot,
    source_action: resolution.sourceAction,
  };
}

export function buildRepairPublicationPlan(
  closure: AffectedMatchClosure,
  decisions: readonly RepairPublicationDecision[],
): RepairPublicationPlan {
  const actions = new Map(closure.actions.map((action) => [actionKey(action.matchId, action.slot), action]));
  const decisionByAction = new Map<string, RepairPublicationDecision>();
  for (const decision of decisions) {
    validateDecisionShape(decision);
    const key = actionKey(decision.matchId, decision.slot);
    if (!actions.has(key)) throw new Error(`Repair decision references unknown action ${decision.matchId}/${decision.slot}`);
    if (decisionByAction.has(key)) throw new Error(`Duplicate repair decision for ${decision.matchId}/${decision.slot}`);
    if (actions.get(key)?.action === "no_change") {
      throw new Error(`Unchanged repair action ${decision.matchId}/${decision.slot} cannot be overridden`);
    }
    decisionByAction.set(key, decision);
  }

  const unresolved: RepairPublicationUnresolved[] = [];
  const resolutions: RepairActionResolution[] = [];
  for (const action of closure.actions) {
    const key = actionKey(action.matchId, action.slot);
    const decision = decisionByAction.get(key);
    if (decision) {
      resolutions.push(resolveDecision(action, decision));
      continue;
    }
    const automatic = defaultResolution(action);
    if (automatic) {
      resolutions.push(automatic);
      continue;
    }
    unresolved.push({
      matchId: action.matchId,
      slot: action.slot,
      action: action.action,
      reason: action.reason,
    });
  }

  unresolved.sort((left, right) => left.matchId.localeCompare(right.matchId) || left.slot.localeCompare(right.slot));
  resolutions.sort((left, right) => left.matchId.localeCompare(right.matchId) || left.slot.localeCompare(right.slot));
  const publicationFingerprintInput = stableJson({
    schema_version: 1,
    competition_id: closure.competitionId,
    corrected_match_id: closure.correctedMatchId,
    source_result_version: closure.sourceResultVersion,
    source_schedule_version: closure.sourceScheduleVersion,
    analysis_fingerprint_input: closure.analysisFingerprintInput,
    resolutions: resolutions.map(normalizedResolution),
    unresolved: unresolved.map((item) => ({
      action: item.action,
      match_id: item.matchId,
      reason: item.reason,
      slot: item.slot,
    })),
  });

  return {
    ready: unresolved.length === 0,
    unresolved,
    resolutions,
    publicationFingerprintInput,
  };
}
