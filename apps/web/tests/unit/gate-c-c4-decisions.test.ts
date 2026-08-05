import { describe, expect, it } from "vitest";
import {
  gateCC4DecisionAllowed,
  gateCC4DecisionValues,
  gateCC4MatchScheduleAdjustmentAllowed,
  gateCC4ScheduleAdjustmentAllowed,
} from "../../lib/gate-c-c4-decisions";
import { gateCRepairActionKinds } from "@matchday/contracts";

const decisions = Object.values(gateCC4DecisionValues);

describe("Gate C C4 repair decision policy", () => {
  it("offers exactly the server-permitted decision values for every action", () => {
    const allowed = new Map([
      ["no_change", []],
      ["automatic_update", ["accept_proposed", "keep_current", "set_manual_entry"]],
      ["protected_started_match", ["keep_current", "leave_protected"]],
      ["protected_finalised_match", ["keep_current", "leave_protected"]],
      ["protected_manual_slot", ["accept_proposed", "keep_current", "set_manual_entry"]],
      ["requires_organiser_decision", decisions],
    ] as const);

    for (const action of gateCRepairActionKinds) {
      expect(decisions.filter((decision) => gateCC4DecisionAllowed(action, decision))).toEqual(allowed.get(action));
    }
  });

  it("suppresses schedule changes for protected actions and any match containing one", () => {
    expect(gateCC4ScheduleAdjustmentAllowed("protected_started_match")).toBe(false);
    expect(gateCC4ScheduleAdjustmentAllowed("protected_finalised_match")).toBe(false);
    expect(gateCC4MatchScheduleAdjustmentAllowed(["automatic_update", "protected_started_match"])).toBe(false);
    expect(gateCC4MatchScheduleAdjustmentAllowed(["requires_organiser_decision", "protected_finalised_match"])).toBe(
      false,
    );
    expect(gateCC4MatchScheduleAdjustmentAllowed(["automatic_update", "protected_manual_slot"])).toBe(true);
  });
});
