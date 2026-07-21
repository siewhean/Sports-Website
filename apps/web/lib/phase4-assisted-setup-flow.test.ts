import { describe, expect, it } from "vitest";
import type {
  Phase4SetupBasics,
  Phase4SetupDocument,
  Phase4SetupFormatPreferences,
} from "@matchday/contracts";
import {
  basicsReadyToPersist,
  patchableSetupStep,
  setupMutationDocument,
  setupMutationSucceeded,
  setupSportLabel,
  setupStepForSave,
} from "./phase4-assisted-setup-flow";

const basics: Phase4SetupBasics = {
  name: "Badminton Open",
  sport_code: "badminton",
  location: { venue: "Sports Hall", address: "1 Test Street", locality: "Singapore", country_code: "SG" },
  starts_on: "2027-03-01",
  ends_on: "2027-03-02",
  time_zone: "Asia/Singapore",
  locale: "en-SG",
  entry_count: 8,
  division_count: 1,
  entry_count_status: "confirmed",
};

const preferences: Phase4SetupFormatPreferences = {
  minimum_matches: { per_entry: 3 },
  ranking: { rank_all_entries: true },
  knockout: { required: true },
  placement: { required: false },
  qualification: { cross_group_allowed: true },
  priority: { value: "participation" },
};

function document(currentStep: Phase4SetupDocument["current_step"], revision = 4): Phase4SetupDocument {
  return {
    schema_version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    organisation_id: "00000000-0000-4000-8000-000000000002",
    competition_id: "00000000-0000-4000-8000-000000000003",
    competition_status: "draft",
    revision,
    status: "active",
    current_step: currentStep,
    completed_steps: [],
    steps: [],
    values: {
      basics,
      capacity: null,
      settings: null,
      entries: null,
      format_preferences: preferences,
      format_recommendations: null,
      schedule_review: null,
      review_publish: null,
    },
    permission: "write",
    read_only: false,
    autosave: {
      status: "saved",
      last_saved_at: "2026-07-22T00:00:00.000Z",
      expires_at: "2026-08-22T00:00:00.000Z",
    },
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
    completed_at: null,
  };
}

describe("Assisted Setup client flow", () => {
  it("does not send an incomplete seeded Basics value", () => {
    expect(basicsReadyToPersist({ ...basics, entry_count: 0 })).toBe(false);
    expect(patchableSetupStep("basics", { ...basics, division_count: 0 }, preferences)).toBeNull();
  });

  it("builds a non-navigating sport-specific Basics patch", () => {
    expect(patchableSetupStep("basics", basics, preferences)).toEqual({ step_id: "basics", value: basics });
    expect(setupSportLabel("badminton")).toBe("Badminton");
  });

  it("uses the returned server document, including its new revision", () => {
    const next = document("capacity", 5);
    const response = { outcome: "saved" as const, document: next };
    expect(setupMutationSucceeded(response)).toBe(true);
    expect(setupMutationDocument(response)).toMatchObject({ revision: 5, current_step: "capacity" });
  });

  it("uses the conflict document rather than continuing with the submitted revision", () => {
    const current = document("basics", 7);
    const response = { outcome: "conflict" as const, current };
    expect(setupMutationSucceeded(response)).toBe(false);
    expect(setupMutationDocument(response)).toMatchObject({ revision: 7, current_step: "basics" });
  });

  it("saves the exact current editable value before advancing", () => {
    const changed = { ...preferences, minimum_matches: { per_entry: 4 } };
    expect(setupStepForSave(document("format_preferences"), basics, changed)).toEqual({
      step_id: "format_preferences",
      value: changed,
    });
  });
});
