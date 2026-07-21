import { describe, expect, it, vi } from "vitest";
import type {
  Phase4FormatBuilderDocument,
  Phase4FormatDraftView,
  Phase4OrganiserTemplateView,
} from "@matchday/contracts";
import { formatSaveBody, upsertOrganiserTemplate } from "./phase4-format-persistence";

const document: Phase4FormatBuilderDocument = {
  schema_version: 1,
  graph: {
    id: "format-eight",
    schemaVersion: 1,
    entryCount: 8,
    stages: [
      {
        id: "round-robin",
        label: "Round robin",
        kind: "round_robin",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 8,
        matchIds: ["match-one"],
      },
    ],
    matches: [
      {
        id: "match-one",
        stageId: "round-robin",
        round: 1,
        order: 1,
        purpose: "pool",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: [],
  },
  layout: { schema_version: 1, stage_positions: [{ stage_id: "round-robin", x: 80, y: 80 }] },
};

function draft(): Phase4FormatDraftView {
  return {
    competition_id: "00000000-0000-4000-8000-000000000001",
    division_id: "00000000-0000-4000-8000-000000000002",
    draft_id: "00000000-0000-4000-8000-000000000003",
    parent_revision_id: "00000000-0000-4000-8000-000000000000",
    root_revision_id: "00000000-0000-4000-8000-000000000000",
    revision: 4,
    status: "draft",
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
    permission: "edit",
    read_only: false,
    definition_hash: "a".repeat(64),
    document,
    metrics: { match_count: 1, guaranteed_matches: 1, maximum_matches: 1 },
    capacity: {
      available_match_slots: 20,
      required_match_slots: 1,
      spare_match_slots: 19,
      status: "comfortable",
      evidence_revision: 1,
    },
    validation: { pending: false, validated_definition_hash: "a".repeat(64), issues: [] },
  };
}

function template(input: {
  templateId: string;
  versionId: string;
  revision: number;
  name: string;
}): Phase4OrganiserTemplateView {
  return {
    template_id: input.templateId,
    template_version_id: input.versionId,
    parent_version_id: input.revision === 1 ? null : "00000000-0000-4000-8000-000000000010",
    organisation_id: "00000000-0000-4000-8000-000000000020",
    created_by_account_id: "00000000-0000-4000-8000-000000000021",
    name: input.name,
    description: null,
    sport_code: "badminton",
    source_format_revision_id: "00000000-0000-4000-8000-000000000022",
    status: "active",
    definition_hash: "b".repeat(64),
    document,
    revision: input.revision,
    template_created_at: "2026-07-22T00:00:00.000Z",
    version_created_at: "2026-07-22T00:00:00.000Z",
    archived_by_account_id: null,
    archived_at: null,
  };
}

describe("Phase 4 format persistence semantics", () => {
  it("makes the currently loaded draft the direct parent of the next revision", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000099" });
    const current = draft();
    expect(formatSaveBody(current, document)).toEqual({
      draft_id: current.draft_id,
      expected_revision: 4,
      parent_revision_id: current.draft_id,
      document,
      idempotency_key: "00000000-0000-4000-8000-000000000099",
    });
    vi.unstubAllGlobals();
  });

  it("replaces the visible version of one logical template without duplicating pinned history", () => {
    const oldVersion = template({
      templateId: "00000000-0000-4000-8000-000000000030",
      versionId: "00000000-0000-4000-8000-000000000031",
      revision: 1,
      name: "Balanced",
    });
    const other = template({
      templateId: "00000000-0000-4000-8000-000000000040",
      versionId: "00000000-0000-4000-8000-000000000041",
      revision: 1,
      name: "Compact",
    });
    const saved = template({
      templateId: oldVersion.template_id,
      versionId: "00000000-0000-4000-8000-000000000032",
      revision: 2,
      name: "Balanced",
    });

    expect(upsertOrganiserTemplate([other, oldVersion], saved)).toEqual([saved, other]);
  });
});
