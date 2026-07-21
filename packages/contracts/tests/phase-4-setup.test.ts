import { describe, expect, it } from "vitest";
import { mapSetupValuesToFormatRecommendationInput, phase4SetupStepIds, type Phase4SetupValues } from "../src/index.js";

function setupValues(): Phase4SetupValues {
  return {
    basics: {
      name: "National Championships",
      sport_code: "canoe_polo",
      location: { venue: "Sports Hub", address: "1 Stadium Drive", locality: "Singapore", country_code: "SG" },
      starts_on: "2026-08-14",
      ends_on: "2026-08-16",
      time_zone: "Asia/Singapore",
      locale: "en-SG",
      entry_count: 12,
      division_count: 2,
      entry_count_status: "confirmed",
    },
    capacity: {
      kind: "phase3_capacity_revision",
      competition_id: "competition-1",
      revision: 3,
      time_zone: "Asia/Singapore",
      area_ids: ["area-1"],
      source_hash: "capacity-hash",
      effective: {
        slotMinutes: 30,
        rawTotalSlots: 40,
        fixedReserveSlots: 2,
        availableMatchSlots: 38,
        requiredMatchSlots: 0,
        remainingMatchSlots: 38,
        status: "comfortable",
      },
    },
    settings: null,
    entries: null,
    format_preferences: {
      minimum_matches: { per_entry: 3 },
      ranking: { rank_all_entries: true },
      knockout: { required: true },
      placement: { required: true },
      qualification: { cross_group_allowed: false },
      priority: { value: "participation" },
    },
    format_recommendations: null,
    schedule_review: null,
    review_publish: null,
  };
}

describe("Phase 4 Assisted Setup contracts", () => {
  it("fixes the same eight ordered steps for all clients", () => {
    expect(phase4SetupStepIds).toEqual([
      "basics",
      "capacity",
      "settings",
      "entries",
      "format_preferences",
      "format_recommendations",
      "schedule_review",
      "review_publish",
    ]);
  });

  it("maps setup values without recalculating canonical capacity", () => {
    expect(mapSetupValuesToFormatRecommendationInput(setupValues())).toEqual({
      ok: true,
      value: {
        sport: "canoe_polo",
        entryCount: 12,
        divisionCount: 2,
        availableMatchSlots: 38,
        minimumMatchesPerEntry: 3,
        rankAllEntries: true,
        knockoutRequired: true,
        placementRequired: true,
        crossGroupQualificationAllowed: false,
        organiserPriority: "participation",
      },
    });
  });

  it("reports missing prerequisite steps in canonical order", () => {
    const values = { ...setupValues(), basics: null, format_preferences: null };
    expect(mapSetupValuesToFormatRecommendationInput(values)).toEqual({
      ok: false,
      missing_steps: ["basics", "format_preferences"],
    });
  });
});
