import { describe, expect, it } from "vitest";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { v1FormatReadiness } from "./v1-format-readiness";

function setupWith(values: Partial<Phase4SetupDocument["values"]>): Phase4SetupDocument {
  return {
    schema_version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    organisation_id: "00000000-0000-4000-8000-000000000002",
    competition_id: "00000000-0000-4000-8000-000000000003",
    competition_status: "draft",
    revision: 1,
    status: "active",
    current_step: "entries",
    completed_steps: [],
    steps: [],
    values: {
      basics: null,
      capacity: null,
      settings: null,
      entries: null,
      format_preferences: null,
      format_recommendations: null,
      schedule_review: null,
      review_publish: null,
      ...values,
    },
    permission: "write",
    read_only: false,
    autosave: {
      status: "idle",
      last_saved_at: null,
      expires_at: "2027-01-01T00:00:00.000Z",
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
  };
}

describe("v1FormatReadiness", () => {
  it("blocks format selection until entries and capacity are both usable", () => {
    const readiness = v1FormatReadiness(null);
    expect(readiness.ready).toBe(false);
    expect(readiness.prerequisites.map((item) => [item.id, item.ready])).toEqual([
      ["entries", false],
      ["capacity", false],
    ]);
  });

  it("requires at least two entries in every division", () => {
    const readiness = v1FormatReadiness(
      setupWith({
        entries: {
          competition_id: "00000000-0000-4000-8000-000000000003",
          total_entry_count: 3,
          imports: [],
          divisions: [
            {
              division_id: "00000000-0000-4000-8000-000000000004",
              division_revision: 1,
              entry_ids: ["00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006"],
              confirmed_count: 2,
              placeholder_count: 0,
            },
            {
              division_id: "00000000-0000-4000-8000-000000000007",
              division_revision: 1,
              entry_ids: ["00000000-0000-4000-8000-000000000008"],
              confirmed_count: 1,
              placeholder_count: 0,
            },
          ],
        },
      }),
    );
    expect(readiness.prerequisites.find((item) => item.id === "entries")?.ready).toBe(false);
  });

  it("is ready when every division has entries and usable capacity exists", () => {
    const readiness = v1FormatReadiness(
      setupWith({
        entries: {
          competition_id: "00000000-0000-4000-8000-000000000003",
          total_entry_count: 2,
          imports: [],
          divisions: [
            {
              division_id: "00000000-0000-4000-8000-000000000004",
              division_revision: 1,
              entry_ids: ["00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006"],
              confirmed_count: 2,
              placeholder_count: 0,
            },
          ],
        },
        capacity: {
          kind: "phase3_capacity_revision",
          competition_id: "00000000-0000-4000-8000-000000000003",
          revision: 1,
          time_zone: "Asia/Singapore",
          area_ids: ["00000000-0000-4000-8000-000000000009"],
          source_hash: "a".repeat(64),
          effective: {
            slotMinutes: 30,
            rawTotalSlots: 8,
            fixedReserveSlots: 0,
            availableMatchSlots: 8,
            requiredMatchSlots: 0,
            remainingMatchSlots: 8,
            status: "comfortable",
          },
        },
      }),
    );
    expect(readiness.ready).toBe(true);
  });
});
