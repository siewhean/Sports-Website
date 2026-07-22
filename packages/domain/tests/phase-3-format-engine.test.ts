import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calculateFormatMetrics,
  createDefaultFormatTemplates,
  createFormatRevision,
  createRoundRobinFormatGraph,
  defaultFormatEntryCounts,
  getDefaultFormatTemplate,
  recommendFormats,
  recommendCompetitionFormats,
  validateFormatGraph,
  type DefaultFormatEntryCount,
  type FormatGraph,
  type FormatGraphMatch,
} from "../src/format.js";

function fixture(entryCount: DefaultFormatEntryCount): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../validation/phase-3/formats/${String(entryCount).padStart(2, "0")}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function fixtureProjection(entryCount: DefaultFormatEntryCount) {
  const source = (value: FormatGraphMatch["home"]): string => {
    if (value.type === "entry_seed") return `s:${value.seed}`;
    if (value.type === "stage_rank") return `r:${value.stageId}:${value.groupId ?? "*"}:${value.rank}`;
    if (value.type === "manual_qualifier") return `q:${value.stageId}:${value.qualifierId}`;
    return `${value.type === "winner" ? "w" : "l"}:${value.matchId}`;
  };
  return {
    entryCount,
    templates: createDefaultFormatTemplates(entryCount).map((template) => ({
      strategy: template.strategy,
      metrics: template.metrics,
      stages: template.graph.stages.map((stage) => [
        stage.id,
        stage.kind,
        stage.order,
        stage.groupSize,
        stage.groupIds,
        stage.outputRanks,
        stage.matchIds,
      ]),
      matches: template.graph.matches.map((match) => [
        match.id,
        match.stageId,
        match.poolId ?? null,
        match.round,
        match.order,
        match.purpose,
        source(match.home),
        source(match.away),
      ]),
      terminals: template.graph.terminalMatchIds,
    })),
  };
}

function mutableGraph(graph: FormatGraph): FormatGraph {
  return JSON.parse(JSON.stringify(graph)) as FormatGraph;
}

const EXPECTED_TEMPLATE_METRICS = {
  8: [
    { matchCount: 18, guaranteedMatches: 4, maximumMatches: 5 },
    { matchCount: 16, guaranteedMatches: 3, maximumMatches: 5 },
    { matchCount: 8, guaranteedMatches: 1, maximumMatches: 3 },
  ],
  12: [
    { matchCount: 28, guaranteedMatches: 4, maximumMatches: 6 },
    { matchCount: 24, guaranteedMatches: 3, maximumMatches: 6 },
    { matchCount: 12, guaranteedMatches: 1, maximumMatches: 4 },
  ],
  16: [
    { matchCount: 38, guaranteedMatches: 4, maximumMatches: 6 },
    { matchCount: 32, guaranteedMatches: 3, maximumMatches: 6 },
    { matchCount: 16, guaranteedMatches: 1, maximumMatches: 4 },
  ],
  24: [
    { matchCount: 58, guaranteedMatches: 4, maximumMatches: 7 },
    { matchCount: 48, guaranteedMatches: 3, maximumMatches: 7 },
    { matchCount: 24, guaranteedMatches: 1, maximumMatches: 5 },
  ],
  48: [
    { matchCount: 118, guaranteedMatches: 4, maximumMatches: 8 },
    { matchCount: 96, guaranteedMatches: 3, maximumMatches: 8 },
    { matchCount: 48, guaranteedMatches: 1, maximumMatches: 6 },
  ],
} as const;

describe("Phase 3 format graph generation", () => {
  it.each(defaultFormatEntryCounts)("matches the independent %i-entry fixture", (entryCount) => {
    expect(fixtureProjection(entryCount)).toEqual(fixture(entryCount));
  });

  it.each(defaultFormatEntryCounts)("generates deterministic, valid %i-entry templates", (entryCount) => {
    const first = createDefaultFormatTemplates(entryCount);
    const second = createDefaultFormatTemplates(entryCount);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first.map((template) => template.metrics)).toEqual(EXPECTED_TEMPLATE_METRICS[entryCount]);
    expect(first.every((template) => validateFormatGraph(template.graph).valid)).toBe(true);
    for (const template of first) {
      expect(new Set(template.graph.matches.map((match) => match.id)).size).toBe(template.graph.matches.length);
      expect(new Set(template.graph.matches.map((match) => match.order)).size).toBe(template.graph.matches.length);
      expect(template.metrics).toEqual(calculateFormatMetrics(template.graph));
      expect(Object.isFrozen(template.graph)).toBe(true);
      expect(Object.isFrozen(template.graph.matches)).toBe(true);
    }
  });

  it.each(defaultFormatEntryCounts)("gives every %i-entry default at least four matches", (entryCount) => {
    const template = getDefaultFormatTemplate(entryCount);
    expect(template.strategy).toBe("full_placement");
    expect(template.metrics.guaranteedMatches).toBeGreaterThanOrEqual(4);
    expect(template.graph.stages.map((stage) => stage.kind)).toEqual([
      "group",
      "single_elimination",
      "bronze",
      "placement",
      "consolation",
    ]);
  });

  it("derives guarantees from the least-served group-rank path", () => {
    const full = createDefaultFormatTemplates(8).find((template) => template.strategy === "full_placement")!;
    const focus = createDefaultFormatTemplates(8).find((template) => template.strategy === "championship_focus")!;
    const advancedRanks = (graph: FormatGraph) =>
      new Set(
        graph.matches.flatMap((match) =>
          [match.home, match.away]
            .filter((source) => source.type === "stage_rank")
            .map((source) => (source.type === "stage_rank" ? `${source.groupId}:${source.rank}` : "")),
        ),
      );
    expect([...advancedRanks(full.graph)].sort()).toEqual([
      "G1:1",
      "G1:2",
      "G1:3",
      "G1:4",
      "G2:1",
      "G2:2",
      "G2:3",
      "G2:4",
    ]);
    expect([...advancedRanks(focus.graph)].sort()).toEqual(["G1:1", "G1:2", "G2:1", "G2:2"]);
    // Ranks 3 and 4 in the focused format stop after their three pool matches.
    expect(focus.metrics.guaranteedMatches).toBe(3);
    expect(full.metrics.guaranteedMatches).toBe(4);
  });

  it.each(defaultFormatEntryCounts)("uses every group seed exactly three times for %i entries", (entryCount) => {
    const graph = getDefaultFormatTemplate(entryCount).graph;
    const seedUses = new Map<number, number>();
    for (const match of graph.matches.filter((candidate) => candidate.stageId === "groups")) {
      for (const source of [match.home, match.away]) {
        if (source.type === "entry_seed") seedUses.set(source.seed, (seedUses.get(source.seed) ?? 0) + 1);
      }
    }
    expect([...seedUses.keys()].sort((left, right) => left - right)).toEqual(
      Array.from({ length: entryCount }, (_, index) => index + 1),
    );
    expect([...seedUses.values()].every((uses) => uses === 3)).toBe(true);
  });

  it("implements a complete deterministic round robin", () => {
    const graph = createRoundRobinFormatGraph(8);
    expect(graph.matches).toHaveLength(28);
    expect(calculateFormatMetrics(graph).guaranteedMatches).toBe(7);
    const pairs = graph.matches.map((match) => {
      if (match.home.type !== "entry_seed" || match.away.type !== "entry_seed") throw new Error("Expected seeds");
      return [match.home.seed, match.away.seed].sort((left, right) => left - right).join(":");
    });
    expect(new Set(pairs).size).toBe(28);
    expect(validateFormatGraph(graph)).toEqual({ valid: true, issues: [] });
    const oddGraph = createRoundRobinFormatGraph(7);
    expect(oddGraph.matches).toHaveLength(21);
    expect(calculateFormatMetrics(oddGraph).guaranteedMatches).toBe(6);
    expect(() => createRoundRobinFormatGraph(1)).toThrow(/at least two/);
  });

  it("advances whole-table round-robin ranks without a synthetic group ID", () => {
    const graph = mutableGraph(createRoundRobinFormatGraph(4));
    (graph as unknown as { stages: Array<FormatGraph["stages"][number]> }).stages.push({
      id: "final",
      label: "Final",
      kind: "single_elimination",
      order: 2,
      groupIds: [],
      groupSize: null,
      outputRanks: 2,
      matchIds: ["final-m1"],
    });
    (graph as unknown as { matches: FormatGraphMatch[] }).matches.push({
      id: "final-m1",
      stageId: "final",
      round: 1,
      order: 7,
      purpose: "championship",
      home: { type: "stage_rank", stageId: "round-robin", rank: 1 },
      away: { type: "stage_rank", stageId: "round-robin", rank: 2 },
    });
    (graph as unknown as { terminalMatchIds: string[] }).terminalMatchIds = ["final-m1"];
    expect(validateFormatGraph(graph)).toEqual({ valid: true, issues: [] });
    expect(calculateFormatMetrics(graph)).toEqual({ matchCount: 7, guaranteedMatches: 3, maximumMatches: 4 });
  });

  it("represents cross-group best-N advancement as a group-stage rank without a group ID", () => {
    const graph = mutableGraph(
      createDefaultFormatTemplates(8).find((template) => template.strategy === "championship_focus")!.graph,
    );
    const match = graph.matches.find((candidate) => candidate.stageId === "championship");
    if (!match) throw new Error("Expected championship match");
    (match as { home: FormatGraphMatch["home"] }).home = {
      type: "stage_rank",
      stageId: "groups",
      rank: 3,
    };
    expect(validateFormatGraph(graph)).toEqual({ valid: true, issues: [] });
  });
});

describe("Phase 3 structural validation and revisions", () => {
  it("rejects a duplicate participant slot", () => {
    const graph = mutableGraph(getDefaultFormatTemplate(8).graph);
    const match = graph.matches.find((candidate) => candidate.stageId === "championship") as FormatGraphMatch;
    (match as { home: FormatGraphMatch["home"] }).home = match.away;
    const result = validateFormatGraph(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("duplicate_slot");
  });

  it("rejects an impossible advancement rank", () => {
    const graph = mutableGraph(getDefaultFormatTemplate(12).graph);
    const match = graph.matches.find((candidate) => candidate.home.type === "stage_rank") as FormatGraphMatch;
    if (match.home.type !== "stage_rank") throw new Error("Expected stage rank");
    (match.home as { rank: number }).rank = 5;
    const result = validateFormatGraph(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("impossible_rank");
  });

  it("rejects dependency cycles even when ordering is also invalid", () => {
    const graph = mutableGraph(createDefaultFormatTemplates(8)[2]!.graph);
    const first = graph.matches[0] as FormatGraphMatch;
    const final = graph.matches.find((match) => match.id === graph.terminalMatchIds[0]) as FormatGraphMatch;
    (first as { home: FormatGraphMatch["home"] }).home = { type: "winner", matchId: final.id };
    (final as { home: FormatGraphMatch["home"] }).home = { type: "winner", matchId: first.id };
    const result = validateFormatGraph(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("cycle");
  });

  it("rejects unknown dependencies and orphan terminal matches", () => {
    const unknown = mutableGraph(createDefaultFormatTemplates(8)[2]!.graph);
    const match = unknown.matches[0] as FormatGraphMatch;
    (match as { home: FormatGraphMatch["home"] }).home = { type: "winner", matchId: "missing" };
    const unknownResult = validateFormatGraph(unknown);
    expect(unknownResult.valid).toBe(false);
    if (!unknownResult.valid) expect(unknownResult.issues.map((issue) => issue.code)).toContain("unknown_match");

    const orphan = mutableGraph(createDefaultFormatTemplates(8)[2]!.graph);
    (orphan as unknown as { terminalMatchIds: string[] }).terminalMatchIds = [];
    const orphanResult = validateFormatGraph(orphan);
    expect(orphanResult.valid).toBe(false);
    if (!orphanResult.valid) expect(orphanResult.issues.map((issue) => issue.code)).toContain("orphan_match");
  });

  it("rejects an orphan stage", () => {
    const graph = mutableGraph(getDefaultFormatTemplate(8).graph);
    (graph as unknown as { stages: Array<FormatGraph["stages"][number]> }).stages.push({
      id: "unused",
      label: "Unused",
      kind: "classification",
      order: graph.stages.length + 1,
      groupIds: [],
      groupSize: null,
      outputRanks: 2,
      matchIds: [],
    });
    const result = validateFormatGraph(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("orphan_stage");
  });

  it("rejects incomplete pool coverage before calculating guarantees", () => {
    const graph = mutableGraph(getDefaultFormatTemplate(8).graph);
    const removed = graph.matches.find((match) => match.stageId === "groups")!;
    (graph as unknown as { matches: FormatGraphMatch[] }).matches = graph.matches.filter(
      (match) => match.id !== removed.id,
    );
    const groupStage = graph.stages.find((stage) => stage.id === "groups")!;
    (groupStage as unknown as { matchIds: string[] }).matchIds = groupStage.matchIds.filter(
      (matchId) => matchId !== removed.id,
    );
    const result = validateFormatGraph(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("invalid_stage_shape");
    expect(() => calculateFormatMetrics(graph)).toThrow(/Invalid format graph/);
  });

  it("rejects a knockout graph that omits entrant seeds", () => {
    const graph: FormatGraph = {
      id: "truncated-48",
      schemaVersion: 1,
      entryCount: 48,
      stages: [
        {
          id: "knockout",
          label: "Knockout",
          kind: "single_elimination",
          order: 1,
          groupIds: [],
          groupSize: null,
          outputRanks: 2,
          matchIds: ["final"],
        },
      ],
      matches: [
        {
          id: "final",
          stageId: "knockout",
          round: 1,
          order: 1,
          purpose: "championship",
          home: { type: "entry_seed", seed: 1 },
          away: { type: "entry_seed", seed: 2 },
        },
      ],
      terminalMatchIds: ["final"],
    };
    const result = validateFormatGraph(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("incomplete_seed_coverage");
  });

  it.each([12, 24, 48] as const)("preserves compact-knockout bye coverage for %i entries", (entryCount) => {
    const compact = createDefaultFormatTemplates(entryCount).find(
      (template) => template.strategy === "compact_knockout",
    );
    expect(compact).toBeDefined();
    const coveredSeeds = new Set(
      compact?.graph.matches.flatMap((match) =>
        [match.home, match.away].flatMap((source) => (source.type === "entry_seed" ? [source.seed] : [])),
      ),
    );
    expect([...coveredSeeds].sort((left, right) => left - right)).toEqual(
      Array.from({ length: entryCount }, (_, index) => index + 1),
    );
    expect(validateFormatGraph(compact!.graph)).toEqual({ valid: true, issues: [] });
  });

  it("creates immutable, chained revisions with deterministic content hashes", () => {
    const graph = getDefaultFormatTemplate(16).graph;
    const first = createFormatRevision(graph, { createdAt: "2026-07-17T00:00:00.000Z" });
    const repeated = createFormatRevision(graph, { createdAt: "2026-07-17T00:00:00.000Z" });
    const second = createFormatRevision(graph, {
      parent: first,
      createdAt: "2026-07-17T00:01:00.000Z",
    });
    expect(first).toEqual(repeated);
    expect(first.revision).toBe(1);
    expect(second).toMatchObject({ revision: 2, parentRevision: 1, contentHash: first.contentHash });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.graph.matches[0])).toBe(true);
    expect(() => createFormatRevision(graph, { createdAt: "not-a-date" })).toThrow(/canonical ISO/);
  });
});

describe("Phase 3 capacity-first recommendations", () => {
  const sports = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const;

  it.each(sports)("generates deterministic capacity-filtered matrices for %s", (sportCode) => {
    for (const entryCount of defaultFormatEntryCounts) {
      const request = {
        sportCode,
        divisions: [{ id: `${sportCode}-${entryCount}`, entryCount }],
        availableMatchSlots: 1_000,
        minimumGuaranteedMatches: 1,
        priority: "participation" as const,
      };
      const first = recommendCompetitionFormats(request);
      expect(first).toEqual(recommendCompetitionFormats(request));
      expect(first.recommendations).toHaveLength(3);
      expect(first.requiresChanges).toBeNull();
      expect(first.recommendations.every((item) => item.matchCount <= item.availableMatchSlots)).toBe(true);
      expect(first.recommendations.every((item) => item.scheduleFeasibility === "not_checked")).toBe(true);
      expect(new Set(first.recommendations.map((item) => item.strategy)).size).toBe(first.recommendations.length);
    }
  });

  it("aggregates multi-division capacity and isolates one requires-changes option", () => {
    const result = recommendCompetitionFormats({
      sportCode: "basketball",
      divisions: [
        { id: "open", entryCount: 8 },
        { id: "women", entryCount: 12 },
      ],
      availableMatchSlots: 30,
      priority: "speed",
    });
    expect(result.recommendations.every((item) => item.divisions.length === 2)).toBe(true);
    expect(result.recommendations.every((item) => item.matchCount <= 30)).toBe(true);
    expect(result.requiresChanges?.matchCount).toBeGreaterThan(30);
    expect(result.requiresChanges?.capacityStatus).toBe("requires_changes");
    expect(result.requiresChanges?.scheduleFeasibility).toBe("infeasible");
  });

  it("applies every declared preference and rejects incomplete or unsupported inputs", () => {
    const compactOnly = recommendCompetitionFormats({
      sportCode: "canoe_polo",
      divisions: [{ id: "open", entryCount: 8 }],
      availableMatchSlots: 100,
      crossGroupAllowed: false,
    });
    expect(compactOnly.recommendations.map((item) => item.strategy)).toEqual(["compact_knockout"]);
    const ranked = recommendCompetitionFormats({
      sportCode: "volleyball",
      divisions: [{ id: "open", entryCount: 16 }],
      availableMatchSlots: 100,
      rankAllEntries: true,
      placementRequired: true,
    });
    expect(ranked.recommendations.map((item) => item.rankingCoverage)).toEqual(["all_entries"]);
    expect(() =>
      recommendCompetitionFormats({
        sportCode: "unknown",
        divisions: [{ id: "x", entryCount: 8 }],
        availableMatchSlots: 10,
      }),
    ).toThrow(/not supported/);
    expect(() =>
      recommendCompetitionFormats({ sportCode: "basketball", divisions: [], availableMatchSlots: 10 }),
    ).toThrow(/At least one/);
    expect(() =>
      recommendCompetitionFormats({
        sportCode: "basketball",
        divisions: [{ id: "x", entryCount: 10 }],
        availableMatchSlots: 10,
      }),
    ).toThrow(/unsupported/);
  });
  it("returns only capacity-feasible choices by default", () => {
    const recommendations = recommendFormats({ entryCount: 8, availableMatchSlots: 15 });
    expect(recommendations.map((item) => item.templateId)).toEqual(["8-compact_knockout"]);
    expect(recommendations.every((item) => item.feasible && item.spareMatchSlots >= 0)).toBe(true);
  });

  it("honours guaranteed-match and maximum-match constraints", () => {
    expect(
      recommendFormats({ entryCount: 8, availableMatchSlots: 18, minimumGuaranteedMatches: 4 }).map(
        (item) => item.templateId,
      ),
    ).toEqual(["8-full_placement"]);
    expect(
      recommendFormats({
        entryCount: 8,
        availableMatchSlots: 18,
        minimumGuaranteedMatches: 4,
        maximumMatchCount: 15,
      }),
    ).toEqual([]);
  });

  it.each(defaultFormatEntryCounts)("ranks %i-entry recommendations deterministically", (entryCount) => {
    const request = { entryCount, availableMatchSlots: 500, includeInfeasible: true } as const;
    const first = recommendFormats(request);
    expect(first).toEqual(recommendFormats(request));
    expect(first.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(first.every((item) => item.advantage.length <= 90 && item.advantage.endsWith("."))).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("explains infeasibility without recommending it as feasible", () => {
    const recommendations = recommendFormats({
      entryCount: 48,
      availableMatchSlots: 47,
      includeInfeasible: true,
    });
    expect(recommendations).toHaveLength(3);
    expect(recommendations.every((item) => !item.feasible && item.spareMatchSlots < 0)).toBe(true);
    expect(recommendations.every((item) => item.reasons.includes("insufficient_capacity"))).toBe(true);
  });

  it("rejects invalid constraints and unsupported sizes", () => {
    expect(recommendFormats({ entryCount: 10, availableMatchSlots: 100 })).toEqual([]);
    expect(() => recommendFormats({ entryCount: 8, availableMatchSlots: -1 })).toThrow(/non-negative/);
    expect(() => recommendFormats({ entryCount: 8, availableMatchSlots: 10, minimumGuaranteedMatches: 0 })).toThrow(
      /positive integer/,
    );
  });
});
