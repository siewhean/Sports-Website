import { describe, expect, it } from "vitest";
import type { GateCRepairActionKind, GateCRepairDecision } from "@matchday/contracts";
import {
  gateCC4DecisionAllowed,
  gateCC4DecisionOptions,
  gateCC4DecisionRequired,
  gateCC4DecisionValues,
  gateCC4MatchScheduleAdjustmentAllowed,
} from "./gate-c-c4-decisions";

const decisions = Object.values(gateCC4DecisionValues);
const policyCases: ReadonlyArray<readonly [GateCRepairActionKind, readonly GateCRepairDecision["decision"][]]> = [
  ["no_change", []],
  ["automatic_update", ["accept_proposed", "keep_current", "set_manual_entry"]],
  ["protected_started_match", ["keep_current", "leave_protected"]],
  ["protected_finalised_match", ["keep_current", "leave_protected"]],
  ["protected_manual_slot", ["accept_proposed", "keep_current", "set_manual_entry"]],
  ["requires_organiser_decision", decisions],
];

describe("Gate C C4 repair decision policy", () => {
  it.each(policyCases)("offers only server-permitted decisions for %s", (action, expected) => {
    expect(gateCC4DecisionOptions(action, true)).toEqual(expected);
    for (const decision of decisions) {
      expect(gateCC4DecisionAllowed(action, decision)).toBe(expected.includes(decision));
    }
  });

  it("omits an unavailable proposed-participant option and requires only protected decisions", () => {
    expect(gateCC4DecisionOptions("automatic_update", false)).toEqual(["keep_current", "set_manual_entry"]);
    expect(gateCC4DecisionRequired("automatic_update")).toBe(false);
    expect(gateCC4DecisionRequired("protected_started_match")).toBe(true);
    expect(gateCC4DecisionRequired("requires_organiser_decision")).toBe(true);
  });

  it("suppresses rescheduling when any action for the match is started or finalised", () => {
    expect(gateCC4MatchScheduleAdjustmentAllowed(["automatic_update", "protected_manual_slot"])).toBe(true);
    expect(gateCC4MatchScheduleAdjustmentAllowed(["automatic_update", "protected_started_match"])).toBe(false);
    expect(gateCC4MatchScheduleAdjustmentAllowed(["protected_finalised_match"])).toBe(false);
  });

  it("does not infer a schedule adjustment for an empty match action group", () => {
    expect(gateCC4MatchScheduleAdjustmentAllowed([] as GateCRepairActionKind[])).toBe(false);
  });
});
