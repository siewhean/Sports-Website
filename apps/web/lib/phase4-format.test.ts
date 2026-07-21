import { describe, expect, it } from "vitest";
import type { Phase4FormatBuilderDocument } from "@matchday/contracts";
import {
  formatEditorReducer,
  parseFormatBuilderDocument,
  parseFormatMaterialisation,
  parseFormatValidation,
} from "./phase4-format";

const document: Phase4FormatBuilderDocument = {
  schema_version: 1,
  graph: {
    id: "format-a",
    schemaVersion: 1,
    entryCount: 2,
    stages: [
      {
        id: "stage-final",
        label: "Final",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 1,
        matchIds: ["match-final"],
      },
    ],
    matches: [
      {
        id: "match-final",
        stageId: "stage-final",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: ["match-final"],
  },
  layout: { schema_version: 1, stage_positions: [{ stage_id: "stage-final", x: 64, y: 72 }] },
};

describe("Phase 4 format web contract", () => {
  it("accepts the exact canonical builder document and rejects unknown fields", () => {
    expect(parseFormatBuilderDocument(document)).toEqual(document);
    expect(parseFormatBuilderDocument({ ...document, browser_only_hash: "forged" })).toBeNull();
  });

  it("visual and manual actions preserve stable graph identity in one reducer", () => {
    const initial = {
      document,
      selectedStageId: "stage-final",
      mode: "visual" as const,
      dirty: false,
      validation: null,
    };
    const manual = formatEditorReducer(initial, { type: "set_mode", mode: "manual" });
    const renamed = formatEditorReducer(manual, {
      type: "update_stage",
      stageId: "stage-final",
      patch: { label: "Championship final" },
    });
    const visual = formatEditorReducer(renamed, { type: "set_mode", mode: "visual" });
    expect(visual.document.graph.id).toBe(document.graph.id);
    expect(visual.document.graph.stages[0]?.id).toBe("stage-final");
    expect(visual.document.graph.matches).toEqual(document.graph.matches);
    expect(visual.document.layout).toEqual(document.layout);
    expect(visual.document.graph.stages[0]?.label).toBe("Championship final");
  });

  it("only accepts server validation with materialisation evidence", () => {
    expect(
      parseFormatValidation({
        valid: true,
        issues: [],
        graph_hash: "graph-hash",
        materialisation: { match_count: 1 },
      })?.valid,
    ).toBe(true);
    expect(parseFormatValidation({ valid: true, issues: [], graph_hash: "graph-hash", materialisation: null })).toBeNull();
  });

  it("strictly accepts materialisation for the requested revision", () => {
    const response = {
      revision: {
        revision_id: "format-revision-a",
        revision: 2,
        parent_revision_id: null,
        root_revision_id: "format-revision-a",
        competition_id: "competition-a",
        division_id: "division-a",
        status: "draft",
        definition_hash: "definition-hash",
        document,
        created_at: "2026-07-20T00:00:00.000Z",
        published_at: null,
      },
      materialised: true,
      match_count: 1,
      materialisation_hash: "materialisation-hash",
      idempotent_replay: false,
    };
    expect(parseFormatMaterialisation(response, "format-revision-a")?.match_count).toBe(1);
    expect(parseFormatMaterialisation({ ...response, extra: true }, "format-revision-a")).toBeNull();
    expect(parseFormatMaterialisation(response, "format-revision-b")).toBeNull();
  });
});
