import { describe, expect, it } from "vitest";
import type { Phase4FormatDraftView, Phase4SetupDocument } from "@matchday/contracts";
import { createDefaultFormatTemplates } from "@matchday/domain";
import {
  correctFormatDraftMetrics,
  normalizeSetupAutosaveResponse,
  readOnlySetupDocument,
} from "../../src/phase-4-reliable-runtime.js";

const now = "2026-07-22T00:00:00.000Z";

function completedSetup(status: "completed" | "expired" = "completed"): Phase4SetupDocument {
  const stepIds = [
    "basics",
    "capacity",
    "settings",
    "entries",
    "format_preferences",
    "format_recommendations",
    "schedule_review",
    "review_publish",
  ] as const;
  return {
    schema_version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    organisation_id: "00000000-0000-4000-8000-000000000002",
    competition_id: "00000000-0000-4000-8000-000000000003",
    competition_status: "ready",
    revision: 9,
    status,
    current_step: "review_publish",
    completed_steps: [...stepIds],
    steps: stepIds.map((id, index) => ({
      id,
      status: "completed" as const,
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
      errors: [],
      completed_at: now,
    })),
    values: {
      basics: null,
      capacity: null,
      settings: null,
      entries: null,
      format_preferences: null,
      format_recommendations: null,
      schedule_review: null,
      review_publish: null,
    },
    permission: "write",
    read_only: true,
    autosave: { status: "saved", last_saved_at: now, expires_at: "2026-08-22T00:00:00.000Z" },
    created_at: now,
    updated_at: now,
    completed_at: now,
  };
}

describe("Reliable Gate B response contracts", () => {
  it("returns completed setup documents with a truthful read-only permission", () => {
    const normalized = normalizeSetupAutosaveResponse({ outcome: "saved", document: completedSetup() });
    expect(normalized).toMatchObject({
      outcome: "saved",
      document: { permission: "read", read_only: true, autosave: { status: "read_only" } },
    });
  });

  it("preserves the expired autosave state while making the document read-only", () => {
    expect(readOnlySetupDocument(completedSetup("expired"))).toMatchObject({
      permission: "read",
      read_only: true,
      autosave: { status: "expired" },
    });
  });

  it("uses deterministic minimum and maximum participation instead of average participation", () => {
    const template = createDefaultFormatTemplates(8).find((candidate) => candidate.strategy === "championship_focus");
    if (!template) throw new Error("Expected the eight-entry championship-focus template");
    const draft: Phase4FormatDraftView = {
      competition_id: "00000000-0000-4000-8000-000000000003",
      division_id: "00000000-0000-4000-8000-000000000004",
      draft_id: "00000000-0000-4000-8000-000000000005",
      parent_revision_id: null,
      root_revision_id: "00000000-0000-4000-8000-000000000005",
      revision: 1,
      status: "draft",
      created_at: now,
      updated_at: now,
      permission: "edit",
      read_only: false,
      definition_hash: "a".repeat(64),
      document: {
        schema_version: 1,
        graph: template.graph,
        layout: {
          schema_version: 1,
          stage_positions: template.graph.stages.map((stage, index) => ({
            stage_id: stage.id,
            x: index * 200,
            y: 0,
          })),
        },
      },
      metrics: { match_count: 16, guaranteed_matches: 4, maximum_matches: 16 },
      capacity: {
        available_match_slots: 20,
        required_match_slots: 16,
        spare_match_slots: 4,
        status: "comfortable",
        evidence_revision: 1,
      },
      validation: { pending: false, validated_definition_hash: "a".repeat(64), issues: [] },
    };

    expect(correctFormatDraftMetrics(draft).metrics).toEqual({
      match_count: 16,
      guaranteed_matches: 3,
      maximum_matches: 5,
    });
  });
});
