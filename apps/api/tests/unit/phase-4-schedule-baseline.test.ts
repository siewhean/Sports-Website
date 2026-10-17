import type { ScheduleConstraints } from "@matchday/contracts";
import { describe, expect, it } from "vitest";
import {
  PRESERVE_PREVIOUS_REVISION_WEIGHT,
  withPreviousRevisionBaseline,
  loadPreviousRevisionBaseline,
  type ScheduleBaseline,
} from "../../src/phase-4-schedule-baseline.js";

function constraints(
  preserve: ScheduleConstraints["preserve_existing_schedule"] = {
    mode: "ignored",
    value: { maximum_shift_minutes: 0, by_match_id: {} },
  },
): ScheduleConstraints {
  return {
    minimum_rest: { mode: "preferred", value: { minutes: 60 }, weight: 4 },
    maximum_matches_per_day: { mode: "required", value: { matches: 4 } },
    preferred_final_time: { mode: "ignored", value: { target_start_epoch_ms: 0, tolerance_minutes: 30 } },
    entry_unavailable: { mode: "ignored", value: { by_entry_id: {} } },
    official_availability: { mode: "ignored", value: { by_official_id: {} } },
    featured_playing_area: { mode: "ignored", value: { area_id: "area-1", match_ids: [] } },
    avoid_consecutive_matches: { mode: "preferred", value: { minutes: 30 }, weight: 4 },
    balance_early_matches: { mode: "preferred", value: { before_local_time: "09:00" }, weight: 2 },
    balance_late_matches: { mode: "preferred", value: { at_or_after_local_time: "16:00" }, weight: 2 },
    keep_division_together: { mode: "preferred", value: { maximum_area_count: 2 }, weight: 2 },
    preserve_existing_schedule: preserve,
  };
}

const baseline: ScheduleBaseline = {
  "match-1": { area_id: "area-1", start_epoch_ms: 1_000 },
  "match-2": { area_id: "area-2", start_epoch_ms: 2_000 },
};

describe("withPreviousRevisionBaseline", () => {
  it("leaves the constraints alone when the competition has no previous revision", () => {
    const input = constraints();
    expect(withPreviousRevisionBaseline(input, {})).toEqual(input);
  });

  it("promotes an ignored setting to preferred over the previous revision (QA scenario 5)", () => {
    const result = withPreviousRevisionBaseline(constraints(), baseline);
    expect(result.preserve_existing_schedule).toEqual({
      mode: "preferred",
      weight: PRESERVE_PREVIOUS_REVISION_WEIGHT,
      value: { maximum_shift_minutes: 0, by_match_id: baseline },
    });
    expect(result.minimum_rest).toEqual(constraints().minimum_rest);
  });

  it("keeps a requested mode, weight and tolerance but always uses the latest revision's placements", () => {
    const stale: ScheduleBaseline = { "match-1": { area_id: "area-9", start_epoch_ms: 9_000 } };
    const result = withPreviousRevisionBaseline(
      constraints({ mode: "preferred", weight: 7, value: { maximum_shift_minutes: 30, by_match_id: stale } }),
      baseline,
    );
    expect(result.preserve_existing_schedule).toEqual({
      mode: "preferred",
      weight: 7,
      value: { maximum_shift_minutes: 30, by_match_id: baseline },
    });
  });

  it("carries a required mode through without inventing a weight", () => {
    const result = withPreviousRevisionBaseline(
      constraints({ mode: "required", value: { maximum_shift_minutes: 15, by_match_id: {} } }),
      baseline,
    );
    expect(result.preserve_existing_schedule).toEqual({
      mode: "required",
      value: { maximum_shift_minutes: 15, by_match_id: baseline },
    });
  });
});

describe("published schedule baseline ownership", () => {
  it("clears client-supplied placements when no published schedule exists", () => {
    const input = constraints({
      mode: "preferred",
      weight: 7,
      value: { maximum_shift_minutes: 30, by_match_id: baseline },
    });
    expect(withPreviousRevisionBaseline(input, {}).preserve_existing_schedule).toEqual({
      mode: "preferred",
      weight: 7,
      value: { maximum_shift_minutes: 30, by_match_id: {} },
    });
  });

  it("queries only the latest published revision and filters matches", async () => {
    let query = "";
    const tx = {
      unsafe: async (sql: string) => {
        query = sql;
        return [
          { match_id: "match-1", playing_area_id: "area-1", starts_at: new Date(1000) },
          { match_id: "removed-match", playing_area_id: "area-2", starts_at: new Date(2000) },
        ];
      },
    };
    const actual = await loadPreviousRevisionBaseline(
      tx as unknown as Parameters<typeof loadPreviousRevisionBaseline>[0],
      "competition-1",
      new Set(["match-1"]),
    );
    expect(query).toContain("status='published'");
    expect(query).toContain("ORDER BY revision DESC,id DESC LIMIT 1");
    expect(actual).toEqual({ "match-1": baseline["match-1"] });
  });
});
