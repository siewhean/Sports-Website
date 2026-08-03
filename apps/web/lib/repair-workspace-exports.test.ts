import { describe, expect, it } from "vitest";
import type { GateCRepairActionView } from "@matchday/contracts";
import { repairActionMatchLabel, scoreSheetExportMatches } from "@/components/gate-c/RepairWorkspace";

const action: GateCRepairActionView = {
  repair_action_id: "action",
  repair_revision_id: "revision",
  ordinal: 1,
  match_id: "downstream-match",
  division_id: "division",
  slot: "home",
  source_action: "automatic_update",
  decision: null,
  current_entry_id: "marina",
  proposed_entry_id: "harbour",
  resolved_entry_id: null,
  reason: "Update the downstream slot.",
  dependency_path: [],
  created_at: "2026-08-01T00:00:00.000Z",
  match_code: "M13",
  current_entry_name: "Marina Blue",
  proposed_entry_name: "Harbour Gold",
  resolved_entry_name: null,
  adjustment: null,
};

describe("repair workspace score-sheet exports", () => {
  it("uses a match code or neutral copy instead of an internal match identifier", () => {
    expect(repairActionMatchLabel(action)).toBe("M13");
    expect(repairActionMatchLabel({ ...action, match_code: null })).toBe("Affected match");
  });

  it("never renders a match identifier as a missing participant", () => {
    expect(scoreSheetExportMatches([], [action], "corrected-match")).toEqual([
      { id: "corrected-match", label: "Affected match", home: "", away: "" },
      { id: "downstream-match", label: "M13", home: "Marina Blue", away: "" },
    ]);
  });

  it("keeps the authoritative reference match when an action targets it", () => {
    expect(
      scoreSheetExportMatches(
        [{ id: "downstream-match", label: "M13", home: "Marina Blue", away: "Harbour Gold" }],
        [action],
        null,
      ),
    ).toEqual([{ id: "downstream-match", label: "M13", home: "Marina Blue", away: "Harbour Gold" }]);
  });
});
