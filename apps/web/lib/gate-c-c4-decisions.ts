import type { GateCRepairActionKind, GateCRepairDecision } from "@matchday/contracts";

export type GateCC4DecisionValue = GateCRepairDecision["decision"];

export const gateCC4DecisionValues = {
  acceptProposed: "accept_proposed",
  keepCurrent: "keep_current",
  setManualEntry: "set_manual_entry",
  leaveProtected: "leave_protected",
} as const satisfies Readonly<Record<string, GateCC4DecisionValue>>;

const protectedMatchActions = new Set<GateCRepairActionKind>(["protected_started_match", "protected_finalised_match"]);

export function gateCC4DecisionAllowed(action: GateCRepairActionKind, decision: GateCC4DecisionValue): boolean {
  switch (action) {
    case "no_change":
      return false;
    case "automatic_update":
      return (
        decision === gateCC4DecisionValues.acceptProposed ||
        decision === gateCC4DecisionValues.keepCurrent ||
        decision === gateCC4DecisionValues.setManualEntry
      );
    case "protected_started_match":
    case "protected_finalised_match":
      return decision === gateCC4DecisionValues.leaveProtected || decision === gateCC4DecisionValues.keepCurrent;
    case "protected_manual_slot":
      return (
        decision === gateCC4DecisionValues.keepCurrent ||
        decision === gateCC4DecisionValues.setManualEntry ||
        decision === gateCC4DecisionValues.acceptProposed
      );
    case "requires_organiser_decision":
      return true;
  }
}

export function gateCC4ScheduleAdjustmentAllowed(action: GateCRepairActionKind): boolean {
  return !protectedMatchActions.has(action);
}

export function gateCC4MatchScheduleAdjustmentAllowed(actions: readonly GateCRepairActionKind[]): boolean {
  return actions.length > 0 && actions.every(gateCC4ScheduleAdjustmentAllowed);
}
