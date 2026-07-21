import { describe, expect, it } from "vitest";
import {
  createDefaultFormatTemplates,
  createFormatBuilderDocument,
  createFormatGraphHash,
  createRoundRobinFormatGraph,
  createStableFormatMatchId,
  createStableFormatStageId,
  defaultFormatEntryCounts,
  deriveFormatAdvancementConnectors,
  materialiseFormatGraph,
  moveFormatBuilderStage,
  projectFormatBuilder,
  replaceFormatBuilderGraph,
  serializeFormatBuilderView,
  validateFormatBuilderDocument,
  type FormatBuilderDocument,
  type FormatGraph,
} from "../src/index.js";

function graph(entryCount: 8 | 12 = 8): FormatGraph {
  return createDefaultFormatTemplates(entryCount)[0]!.graph;
}

function authoredGraph(): FormatGraph {
  const configured = structuredClone(graph()) as FormatGraph;
  const groups = configured.stages.find((stage) => stage.id === "groups");
  if (!groups) throw new Error("Expected groups stage");
  Object.assign(groups, {
    repetitions: 1,
    qualificationPositions: [1, 2],
    additionalQualifiers: [
      { method: "bottom_from_each_group", count: 2, destinationStageId: "placement" },
      { method: "bottom_from_each_group", count: 2, destinationStageId: "consolation" },
    ],
    destinationStageIds: ["championship", "placement", "consolation"],
    seeding: "snake",
    carriedResults: "none",
  });
  return configured;
}

describe("Phase 4 format builder projections", () => {
  it("round-trips manual and visual modes without changing graph or layout", () => {
    const source = createFormatBuilderDocument(authoredGraph(), [
      { stageId: "groups", x: 41.5, y: 89.25 },
      { stageId: "championship", x: 440, y: 92 },
      { stageId: "bronze", x: 790, y: 260 },
      { stageId: "placement", x: 805, y: 510 },
      { stageId: "consolation", x: 805, y: 745 },
    ]);
    const manual = serializeFormatBuilderView(projectFormatBuilder(source, "manual"));
    const visual = serializeFormatBuilderView(projectFormatBuilder(manual, "visual"));
    const backToManual = serializeFormatBuilderView(projectFormatBuilder(visual, "manual"));

    expect(manual).toEqual(source);
    expect(visual).toEqual(source);
    expect(backToManual).toEqual(source);
    expect(createFormatGraphHash(backToManual.graph)).toBe(createFormatGraphHash(source.graph));
    expect(Object.isFrozen(backToManual)).toBe(true);
  });

  it("keeps a layout-only move outside the canonical graph hash across both views", () => {
    const source = createFormatBuilderDocument(authoredGraph());
    const beforeHash = createFormatGraphHash(source.graph);
    const moved = moveFormatBuilderStage(source, "groups", { x: 999.5, y: 411.25 });
    const roundTrip = serializeFormatBuilderView(
      projectFormatBuilder(serializeFormatBuilderView(projectFormatBuilder(moved, "manual")), "visual"),
    );
    expect(createFormatGraphHash(moved.graph)).toBe(beforeHash);
    expect(createFormatGraphHash(roundTrip.graph)).toBe(beforeHash);
    expect(roundTrip.layout.stagePositions.find((position) => position.stageId === "groups")).toEqual({
      stageId: "groups",
      x: 999.5,
      y: 411.25,
    });
  });

  it.each([
    { x: 0, y: 0 },
    { x: 17.25, y: 999.75 },
    { x: -40, y: 260 },
    { x: 4096, y: -128.5 },
  ])("property-round-trips a layout-only point $x,$y without semantic drift", (point) => {
    const source = createFormatBuilderDocument(authoredGraph());
    const hash = createFormatGraphHash(source.graph);
    const moved = moveFormatBuilderStage(source, "championship", point);
    const manual = serializeFormatBuilderView(projectFormatBuilder(moved, "manual"));
    const visual = serializeFormatBuilderView(projectFormatBuilder(manual, "visual"));
    expect(createFormatGraphHash(visual.graph)).toBe(hash);
    expect(visual.layout.stagePositions.find((position) => position.stageId === "championship")).toEqual({
      stageId: "championship",
      ...point,
    });
  });

  it.each([
    [
      "additional qualifier",
      (document: FormatBuilderDocument) =>
        Object.assign(document.graph.stages[0]!, {
          additionalQualifiers: [
            {
              method: "bottom_from_each_group",
              count: 2,
              destinationStageId: "placement",
              clientHash: "forged",
            },
          ],
        }),
    ],
    [
      "placement rule",
      (document: FormatBuilderDocument) =>
        Object.assign(document.graph.stages[0]!, {
          placementRule: { coverage: "champion_only", positions: [1], clientHash: "forged" },
        }),
    ],
    [
      "manual qualifier source",
      (document: FormatBuilderDocument) =>
        Object.assign(
          document.graph.matches.find((match) => match.stageId === "placement")!,
          {
            home: {
              type: "manual_qualifier",
              qualifierId: "wildcard-1",
              stageId: "groups",
              clientHash: "forged",
            },
          },
        ),
    ],
  ] as const)("rejects unexpected keys in a %s child object", (_label, corrupt) => {
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    corrupt(document);
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toEqual([expect.objectContaining({ code: "invalid_shape" })]);
  });

  it("assigns deterministic positions and preserves them by stable stage ID", () => {
    const first = createFormatBuilderDocument(graph());
    const second = createFormatBuilderDocument(graph());
    expect(first.layout).toEqual(second.layout);
    expect(first.layout.stagePositions.map((position) => position.stageId)).toEqual(
      [...graph().stages].sort((left, right) => left.order - right.order).map((stage) => stage.id),
    );

    const moved = moveFormatBuilderStage(first, "groups", { x: 213.75, y: 317.5 });
    const replaced = replaceFormatBuilderGraph(moved, graph(12));
    expect(replaced.layout.stagePositions.find((position) => position.stageId === "groups")).toEqual({
      stageId: "groups",
      x: 213.75,
      y: 317.5,
    });
    expect(replaced.graph.id).toBe("default-12-full-placement");
  });

  it("rejects duplicate, unknown, and non-finite layout positions", () => {
    expect(() =>
      createFormatBuilderDocument(graph(), [
        { stageId: "groups", x: 0, y: 0 },
        { stageId: "groups", x: 1, y: 1 },
      ]),
    ).toThrow(/Duplicate canvas position/);
    expect(() => createFormatBuilderDocument(graph(), [{ stageId: "missing", x: 0, y: 0 }])).toThrow(/unknown stage/);
    expect(() => createFormatBuilderDocument(graph(), [{ stageId: "groups", x: Number.NaN, y: 0 }])).toThrow(
      /finite coordinates/,
    );
  });

  it("derives stable advancement connector identities from graph semantics", () => {
    const first = deriveFormatAdvancementConnectors(graph());
    const second = deriveFormatAdvancementConnectors(graph());
    expect(first).toEqual(second);
    expect(new Set(first.map((connector) => connector.id)).size).toBe(first.length);
    expect(
      first.some((connector) => connector.fromStageId === "groups" && connector.toStageId === "championship"),
    ).toBe(true);
    expect(first.every((connector) => connector.fromStageId !== connector.toStageId)).toBe(true);
  });

  it("allocates predictable collision-safe stage and match IDs", () => {
    expect(createStableFormatStageId("Final stage", [])).toBe("stage-final-stage");
    expect(createStableFormatStageId("Final stage", ["stage-final-stage", "stage-final-stage-2"])).toBe(
      "stage-final-stage-3",
    );
    expect(createStableFormatMatchId("stage-final", 2, 1, ["stage-final-r2-m1"])).toBe("stage-final-r2-m1-2");
    expect(() => createStableFormatMatchId("final", 0, 1, [])).toThrow(/positive integer/);
  });
});

describe("Phase 4 validation-only preview and materialisation", () => {
  it("matches the server/database canonical SHA-256 fixed vector", () => {
    const source = graph();
    expect(createFormatGraphHash(source)).toBe("935c9ff5b8e0aa2c859464cb8cd17fc0177466ca183da9adba172492a7d46222");
    expect(createFormatGraphHash(source)).toMatch(/^[a-f0-9]{64}$/);
    const withRuntimeUndefined = structuredClone(source) as FormatGraph;
    Object.assign(withRuntimeUndefined.stages[0]!, { carriedResults: undefined });
    expect(createFormatGraphHash(withRuntimeUndefined)).toBe(createFormatGraphHash(source));
  });

  it("creates a deterministic match plan ordered independently of array order", () => {
    const source = graph();
    const reordered = structuredClone(source) as FormatGraph;
    (reordered as unknown as { matches: FormatGraph["matches"] }).matches = [...reordered.matches].reverse();
    const first = materialiseFormatGraph(source);
    const second = materialiseFormatGraph(reordered);

    expect(second.matches).toEqual(first.matches);
    // The definition hash remains content-sensitive even though materialised
    // sequence is normalised by explicit match order.
    expect(second.graphHash).not.toBe(first.graphHash);
    expect(first.matchCount).toBe(source.matches.length);
    expect(first.matches.map((match) => match.sequence)).toEqual(
      Array.from({ length: source.matches.length }, (_, index) => index + 1),
    );
    expect(first.matches.map((match) => match.graphMatchId)).toEqual(
      [...source.matches].sort((left, right) => left.order - right.order).map((match) => match.id),
    );
    expect(Object.isFrozen(first.matches[0])).toBe(true);
  });

  it.each(defaultFormatEntryCounts)(
    "materialises every %i-entry default with a graph-to-match bijection",
    (entryCount) => {
      for (const template of createDefaultFormatTemplates(entryCount)) {
        const first = materialiseFormatGraph(template.graph);
        const second = materialiseFormatGraph(template.graph);
        expect(first).toEqual(second);
        expect(first.matchCount).toBe(template.graph.matches.length);
        expect(new Set(first.matches.map((match) => match.graphMatchId))).toEqual(
          new Set(template.graph.matches.map((match) => match.id)),
        );
      }
    },
  );

  it("includes only direct result dependencies and preserves participant sources", () => {
    const plan = materialiseFormatGraph(graph());
    const final = plan.matches.find((match) => match.graphMatchId === "championship-r2-m1");
    expect(final?.dependencyMatchIds).toEqual(["championship-r1-m1", "championship-r1-m2"]);
    expect(final?.home).toEqual({ type: "winner", matchId: "championship-r1-m1" });
  });

  it("supports explicit repeated round-robin pairings deterministically", () => {
    const repeated = structuredClone(createRoundRobinFormatGraph(4)) as FormatGraph;
    const original = [...repeated.matches];
    const returnLegs = original.map((match, index) => ({
      ...match,
      id: `${match.id}-return`,
      order: original.length + index + 1,
      home: match.away,
      away: match.home,
    }));
    (repeated as unknown as { matches: FormatGraph["matches"] }).matches = [...original, ...returnLegs];
    const stage = repeated.stages[0];
    if (!stage) throw new Error("Expected round robin stage");
    Object.assign(stage, {
      repetitions: 2,
      matchIds: [...original, ...returnLegs].map((match) => match.id),
    });
    const validation = validateFormatBuilderDocument(createFormatBuilderDocument(repeated));
    expect(validation.valid).toBe(true);
    if (validation.valid) expect(validation.materialisation.matchCount).toBe(12);
  });

  it("returns a validation preview without mutating its document", () => {
    const document = createFormatBuilderDocument(graph());
    const before = structuredClone(document);
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.graphHash).toBe(createFormatGraphHash(document.graph));
      expect(result.materialisation.matchCount).toBe(document.graph.matches.length);
    }
    expect(document).toEqual(before);
  });

  it("returns graph issues and no materialisation for an invalid document", () => {
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    const invalidGraph = document.graph as unknown as { terminalMatchIds: string[] };
    invalidGraph.terminalMatchIds = ["missing"];
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.graphHash).toBeNull();
      expect(result.materialisation).toBeNull();
      expect(result.issues.some((issue) => issue.code === "invalid_terminal")).toBe(true);
    }
  });

  it("rejects a persisted layout that does not cover every stage", () => {
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    const result = validateFormatBuilderDocument({
      ...document,
      layout: { ...document.layout, stagePositions: document.layout.stagePositions.slice(1) },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toEqual([expect.objectContaining({ code: "invalid_layout" })]);
  });

  it.each([
    ["document", (document: FormatBuilderDocument) => Object.assign(document, { schemaVersion: 2 })],
    ["layout", (document: FormatBuilderDocument) => Object.assign(document.layout, { schemaVersion: 2 })],
    ["graph", (document: FormatBuilderDocument) => Object.assign(document.graph, { schemaVersion: 2 })],
  ] as const)("rejects an unsupported %s schema version at runtime", (_label, corrupt) => {
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    corrupt(document);
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("invalid_schema_version");
  });

  it.each([
    ["stage kind", (graphValue: FormatGraph) => Object.assign(graphValue.stages[0]!, { kind: "freeform" })],
    ["seeding", (graphValue: FormatGraph) => Object.assign(graphValue.stages[0]!, { seeding: "weighted" })],
    ["carried results", (graphValue: FormatGraph) => Object.assign(graphValue.stages[0]!, { carriedResults: "maybe" })],
    [
      "placement coverage",
      (graphValue: FormatGraph) =>
        Object.assign(graphValue.stages[0]!, { placementRule: { coverage: "partial", positions: [1] } }),
    ],
    [
      "additional qualifier method",
      (graphValue: FormatGraph) =>
        Object.assign(graphValue.stages[0]!, {
          additionalQualifiers: [{ method: "lottery", count: 1, destinationStageId: "championship" }],
        }),
    ],
    ["match purpose", (graphValue: FormatGraph) => Object.assign(graphValue.matches[0]!, { purpose: "friendly" })],
    [
      "participant source",
      (graphValue: FormatGraph) => Object.assign(graphValue.matches[0]!, { home: { type: "free_text", value: "A" } }),
    ],
  ] as const)("rejects an unsupported %s enum at the untrusted boundary", (_label, corrupt) => {
    const graphValue = structuredClone(graph()) as FormatGraph;
    corrupt(graphValue);
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    Object.assign(document, { graph: graphValue });
    expect(() => validateFormatBuilderDocument(document)).not.toThrow();
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("invalid_enum");
  });

  it("validates Phase 4 manual authoring fields without requiring them on legacy graphs", () => {
    expect(validateFormatBuilderDocument(createFormatBuilderDocument(graph())).valid).toBe(true);
    const configured = authoredGraph();
    const groups = configured.stages.find((stage) => stage.id === "groups");
    if (!groups) throw new Error("Expected groups stage");
    expect(validateFormatBuilderDocument(createFormatBuilderDocument(configured)).valid).toBe(true);

    const disconnected = structuredClone(configured) as FormatGraph;
    const disconnectedGroups = disconnected.stages.find((stage) => stage.id === "groups");
    if (!disconnectedGroups) throw new Error("Expected groups stage");
    Object.assign(disconnectedGroups, { destinationStageIds: ["bronze"] });
    const disconnectedResult = validateFormatBuilderDocument(createFormatBuilderDocument(disconnected));
    expect(disconnectedResult.valid).toBe(false);
    if (!disconnectedResult.valid) {
      expect(disconnectedResult.issues).toEqual([expect.objectContaining({ code: "invalid_advancement" })]);
    }

    const partial = structuredClone(configured) as FormatGraph;
    const partialGroups = partial.stages.find((stage) => stage.id === "groups");
    if (!partialGroups) throw new Error("Expected groups stage");
    Object.assign(partialGroups, { destinationStageIds: ["championship"] });
    const partialResult = validateFormatBuilderDocument(createFormatBuilderDocument(partial));
    expect(partialResult.valid).toBe(false);
    if (!partialResult.valid) {
      expect(partialResult.issues).toEqual([expect.objectContaining({ code: "invalid_advancement" })]);
    }

    for (const additionalQualifiers of [
      [{ method: "bottom_from_each_group", count: 8, destinationStageId: "placement" }],
      [
        { method: "bottom_from_each_group", count: 2, destinationStageId: "placement" },
        { method: "bottom_from_each_group", count: 2, destinationStageId: "placement" },
      ],
    ]) {
      const impossible = structuredClone(configured) as FormatGraph;
      const impossibleGroups = impossible.stages.find((stage) => stage.id === "groups");
      if (!impossibleGroups) throw new Error("Expected groups stage");
      Object.assign(impossibleGroups, { additionalQualifiers });
      const impossibleResult = validateFormatBuilderDocument(createFormatBuilderDocument(impossible));
      expect(impossibleResult.valid).toBe(false);
      if (!impossibleResult.valid) {
        expect(impossibleResult.issues).toEqual([expect.objectContaining({ code: "invalid_advancement" })]);
      }
    }

    const unexplained = structuredClone(graph()) as FormatGraph;
    const unexplainedGroups = unexplained.stages.find((stage) => stage.id === "groups");
    if (!unexplainedGroups) throw new Error("Expected groups stage");
    Object.assign(unexplainedGroups, {
      qualificationPositions: [1, 2],
      destinationStageIds: ["championship", "placement", "consolation"],
    });
    const unexplainedResult = validateFormatBuilderDocument(createFormatBuilderDocument(unexplained));
    expect(unexplainedResult.valid).toBe(false);
    if (!unexplainedResult.valid) {
      expect(unexplainedResult.issues).toEqual([expect.objectContaining({ code: "invalid_advancement" })]);
    }

    const invalid = structuredClone(configured) as FormatGraph;
    const invalidGroups = invalid.stages.find((stage) => stage.id === "groups");
    if (!invalidGroups) throw new Error("Expected groups stage");
    Object.assign(invalidGroups, { qualificationPositions: [1, 1], repetitions: 0 });
    const result = validateFormatBuilderDocument({
      schemaVersion: 1,
      graph: invalid,
      layout: createFormatBuilderDocument(graph()).layout,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["invalid_stage_shape", "impossible_rank"]),
      );
    }
  });

  it("round-trips and materialises a stable unresolved manual qualifier", () => {
    const configured = authoredGraph();
    const placement = configured.matches.find((match) => match.stageId === "placement");
    if (!placement) throw new Error("Expected placement match");
    Object.assign(placement, {
      home: { type: "manual_qualifier", qualifierId: "wildcard-1", stageId: "groups" },
    });
    const groups = configured.stages.find((stage) => stage.id === "groups");
    if (!groups) throw new Error("Expected groups stage");
    Object.assign(groups, {
      additionalQualifiers: [
        { method: "bottom_from_each_group", count: 1, destinationStageId: "placement" },
        { method: "manual", count: 1, destinationStageId: "placement" },
        { method: "bottom_from_each_group", count: 2, destinationStageId: "consolation" },
      ],
    });

    const source = createFormatBuilderDocument(configured);
    const validation = validateFormatBuilderDocument(source);
    expect(validation.valid).toBe(true);
    const roundTrip = serializeFormatBuilderView(
      projectFormatBuilder(serializeFormatBuilderView(projectFormatBuilder(source, "manual")), "visual"),
    );
    expect(roundTrip).toEqual(source);
    const materialised = materialiseFormatGraph(roundTrip.graph);
    expect(materialised.matches.find((match) => match.graphMatchId === placement.id)?.home).toEqual({
      type: "manual_qualifier",
      qualifierId: "wildcard-1",
      stageId: "groups",
    });
    expect(
      deriveFormatAdvancementConnectors(roundTrip.graph).some(
        (connector) =>
          connector.fromStageId === "groups" && connector.toStageId === "placement" && connector.outcome === "manual",
      ),
    ).toBe(true);
  });

  it.each([
    { type: "manual_qualifier", qualifierId: "", stageId: "groups" },
    { type: "manual_qualifier", qualifierId: "wildcard-1", stageId: "missing" },
  ])("rejects an invalid manual qualifier source $qualifierId/$stageId", (source) => {
    const invalid = structuredClone(graph()) as FormatGraph;
    Object.assign(
      invalid.matches.find((match) => match.stageId === "placement")!,
      { home: source },
    );
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    Object.assign(document, { graph: invalid });
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
  });

  it("rejects a duplicated manual qualifier ID", () => {
    const invalid = structuredClone(graph()) as FormatGraph;
    const placement = invalid.matches.find((match) => match.stageId === "placement");
    if (!placement) throw new Error("Expected placement match");
    Object.assign(placement, {
      home: { type: "manual_qualifier", qualifierId: "wildcard-1", stageId: "groups" },
      away: { type: "manual_qualifier", qualifierId: "wildcard-1", stageId: "groups" },
    });
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    Object.assign(document, { graph: invalid });
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("duplicate_slot");
  });

  it("rejects a blank manual stage name", () => {
    const invalid = structuredClone(graph()) as FormatGraph;
    Object.assign(invalid.stages[0]!, { label: "   " });
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    Object.assign(document, { graph: invalid });
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toEqual([expect.objectContaining({ path: "stages[0].label" })]);
  });

  it.each([
    ["champion_only", [1, 2]],
    ["podium", [1, 2]],
    ["podium", [3, 2, 1]],
    ["full", [1]],
  ] as const)("rejects %s placement coverage with contradictory positions", (coverage, positions) => {
    const invalid = structuredClone(graph()) as FormatGraph;
    Object.assign(invalid.stages[0]!, { placementRule: { coverage, positions } });
    const document = structuredClone(createFormatBuilderDocument(graph())) as FormatBuilderDocument;
    Object.assign(document, { graph: invalid });
    const result = validateFormatBuilderDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toEqual([expect.objectContaining({ code: "invalid_stage_shape" })]);
  });

  it.each([
    ["champion_only", [1]],
    ["podium", [1, 2, 3]],
    ["full", [1, 2, 3, 4, 5, 6, 7, 8]],
    ["custom", [2, 4, 6]],
  ] as const)("accepts %s placement coverage with equivalent positions", (coverage, positions) => {
    const configured = structuredClone(graph()) as FormatGraph;
    Object.assign(configured.stages[0]!, { placementRule: { coverage, positions } });
    expect(validateFormatBuilderDocument(createFormatBuilderDocument(configured)).valid).toBe(true);
  });
});
