import { describe, expect, it } from "vitest";
import {
  InvalidCompetitionBriefError,
  mapBriefToFormatRecommendationInput,
  mapBriefToSetupInput,
  validateCompetitionBrief,
} from "../src/index.js";

function incompleteBrief() {
  return {
    schema_version: "1.0",
    name: null,
    sport: "canoe_polo",
    entry_count: 12,
    division_count: 2,
    divisions: null,
    location: null,
    dates: { start: null, end: null },
    playing_areas: null,
    daily_availability: null,
    time_slot_minutes: 30,
    minimum_matches_per_entry: 3,
    knockout_required: true,
    rank_all_entries: null,
    placement_required: null,
    cross_group_qualification_allowed: null,
    organiser_priority: null,
    missing_fields: [],
  };
}

describe("competition brief validation", () => {
  it("recalculates missing information instead of trusting provider claims", () => {
    const result = validateCompetitionBrief(incompleteBrief());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.missing_fields).toEqual([
      "divisions",
      "location",
      "dates.start",
      "dates.end",
      "playing_areas",
      "daily_availability",
      "rank_all_entries",
      "placement_required",
      "cross_group_qualification_allowed",
      "organiser_priority",
    ]);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects unknown keys and unsafe coercions", () => {
    expect(validateCompetitionBrief({ ...incompleteBrief(), publish: true }).ok).toBe(false);
    expect(validateCompetitionBrief({ ...incompleteBrief(), entry_count: "12" }).ok).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    expect(
      validateCompetitionBrief({
        ...incompleteBrief(),
        dates: { start: "2026-02-29", end: "2026-99-99" },
      }).ok,
    ).toBe(false);
    expect(
      validateCompetitionBrief({
        ...incompleteBrief(),
        dates: { start: "2028-02-29", end: "2028-02-29" },
      }).ok,
    ).toBe(true);
  });

  it("enforces division totals and uniqueness business rules", () => {
    const result = validateCompetitionBrief({
      ...incompleteBrief(),
      entry_count: 12,
      division_count: 2,
      divisions: [
        { name: "Open", entry_count: 6 },
        { name: "Open", entry_count: 5 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["entry_total", "duplicate_division"]),
    );
  });

  it("keeps full-ranking and placement preferences independent", () => {
    const result = validateCompetitionBrief({
      ...incompleteBrief(),
      entry_count: 8,
      division_count: 1,
      divisions: [{ name: "Open", entry_count: 8 }],
      rank_all_entries: true,
      placement_required: false,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses recommendation mapping until all deterministic inputs exist", () => {
    const result = validateCompetitionBrief(incompleteBrief());
    if (!result.ok) throw new Error("fixture should validate");
    expect(mapBriefToFormatRecommendationInput(result.brief, { availableMatchSlots: 20 })).toEqual({
      ok: false,
      missing_fields: result.brief.missing_fields,
    });
    expect(
      mapBriefToFormatRecommendationInput({ ...result.brief, missing_fields: [] }, { availableMatchSlots: -1 }),
    ).toEqual({ ok: false, missing_fields: result.brief.missing_fields });

    const complete = validateCompetitionBrief({
      ...incompleteBrief(),
      division_count: 1,
      divisions: [{ name: "Open", entry_count: 12 }],
      location: { venue: "Basin", address: null, locality: null, country_code: "SG" },
      dates: { start: "2026-08-01", end: "2026-08-01" },
      playing_areas: 2,
      daily_availability: [{ date: "2026-08-01", start_time: "09:00", end_time: "17:00" }],
      rank_all_entries: true,
      placement_required: true,
      cross_group_qualification_allowed: true,
      organiser_priority: "participation",
    });
    if (!complete.ok) throw new Error("complete fixture should validate");
    expect(() => mapBriefToFormatRecommendationInput(complete.brief, { availableMatchSlots: -1 })).toThrow(
      "availableMatchSlots",
    );
  });

  it("revalidates public mapper inputs instead of trusting TypeScript or missing_fields", () => {
    const forged = {
      ...incompleteBrief(),
      missing_fields: [],
      divisions: [
        { name: "Open", entry_count: 8 },
        { name: "Open", entry_count: 4 },
      ],
    };
    expect(() => mapBriefToSetupInput(forged)).toThrow(InvalidCompetitionBriefError);
  });
});
