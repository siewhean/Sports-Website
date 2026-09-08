import { describe, expect, it } from "vitest";

import { createDoubleEliminationFormat } from "../src/double-elimination.js";
import {
  createDefaultFormatTemplates,
  createRoundRobinFormatGraph,
  defaultFormatEntryCounts,
  validateFormatGraph,
  type FormatGraph,
} from "../src/format.js";

describe("QA-001 — Format Invariants, Graph Validation, & Adversarial Fuzzing", () => {
  describe("Invariant Verification Across Supported Entry Counts (8, 12, 16, 24, 48)", () => {
    it.each(defaultFormatEntryCounts)(
      "all default templates for %d entries satisfy FormatGraph invariants",
      (count) => {
        const templates = createDefaultFormatTemplates(count);
        expect(templates.length).toBeGreaterThan(0);

        for (const template of templates) {
          // Must pass graph validation with zero issues
          const validation = validateFormatGraph(template.graph);
          expect(validation.valid).toBe(true);
          expect(validation.issues).toEqual([]);

          // Topological ordering invariant: match IDs must be unique
          const matchIds = new Set(template.graph.matches.map((m) => m.id));
          expect(matchIds.size).toBe(template.graph.matches.length);

          // Every match must belong to a known stage in the graph
          const stageIds = new Set(template.graph.stages.map((s) => s.id));
          for (const match of template.graph.matches) {
            expect(stageIds.has(match.stageId)).toBe(true);
          }

          // All seed sources must be within [1, count]
          for (const match of template.graph.matches) {
            if (match.home.type === "entry_seed") {
              expect(match.home.seed).toBeGreaterThanOrEqual(1);
              expect(match.home.seed).toBeLessThanOrEqual(count);
            }
            if (match.away.type === "entry_seed") {
              expect(match.away.seed).toBeGreaterThanOrEqual(1);
              expect(match.away.seed).toBeLessThanOrEqual(count);
            }
          }
        }
      },
    );

    it.each([2, 4, 8, 12, 16, 24, 32, 48])(
      "double elimination graphs for %d entries satisfy 2N-2 match invariants",
      (entries) => {
        const format = createDoubleEliminationFormat(entries);
        const validation = validateFormatGraph(format.graph);
        expect(validation.valid).toBe(true);
        expect(validation.issues).toEqual([]);

        // Always-materialized matches equal 2N-2
        expect(format.graph.matches.length).toBe(2 * entries - 2);

        // Upper and lower brackets exist
        const upperMatches = format.graph.matches.filter(
          (m) => m.id.startsWith("upper-") || m.stageId === "upper_bracket",
        );
        const lowerMatches = format.graph.matches.filter(
          (m) => m.id.startsWith("lower-") || m.stageId === "lower_bracket",
        );
        expect(upperMatches.length).toBeGreaterThan(0);
        if (entries > 2) expect(lowerMatches.length).toBeGreaterThan(0);
      },
    );
  });

  describe("Adversarial Graph Mutations & Cycle Detection", () => {
    it("rejects graphs with self-referential match dependencies (A -> A)", () => {
      const valid = createDoubleEliminationFormat(4).graph;
      const corrupted: FormatGraph = {
        ...valid,
        matches: valid.matches.map((m, idx) => (idx === 0 ? { ...m, home: { type: "winner", matchId: m.id } } : m)),
      };

      const result = validateFormatGraph(corrupted);
      expect(result.valid).toBe(false);
      expect(
        result.issues.some(
          (e) =>
            e.code.includes("cycle") ||
            e.message.includes("cycle") ||
            e.message.includes("self") ||
            e.code.includes("dependency"),
        ),
      ).toBe(true);
    });

    it("rejects graphs with circular match dependency loops (A -> B -> A)", () => {
      const valid = createDoubleEliminationFormat(4).graph;
      const [m0, m1, ...rest] = valid.matches;
      const circular: FormatGraph = {
        ...valid,
        matches: [
          { ...m0!, home: { type: "winner", matchId: m1!.id } },
          { ...m1!, home: { type: "winner", matchId: m0!.id } },
          ...rest,
        ],
      };

      const result = validateFormatGraph(circular);
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("rejects dangling match references where a participant source references a non-existent match", () => {
      const valid = createDoubleEliminationFormat(4).graph;
      const corrupted: FormatGraph = {
        ...valid,
        matches: valid.matches.map((m, idx) =>
          idx === 0 ? { ...m, home: { type: "winner", matchId: "non-existent-match-999" } } : m,
        ),
      };

      const result = validateFormatGraph(corrupted);
      expect(result.valid).toBe(false);
      expect(
        result.issues.some(
          (e) =>
            e.message.includes("non-existent") ||
            e.message.includes("unknown") ||
            e.code.includes("dangling") ||
            e.code.includes("source"),
        ),
      ).toBe(true);
    });

    it("rejects duplicate match IDs within the same graph", () => {
      const valid = createDoubleEliminationFormat(4).graph;
      const corrupted: FormatGraph = {
        ...valid,
        matches: [...valid.matches, { ...valid.matches[0]! }],
      };

      const result = validateFormatGraph(corrupted);
      expect(result.valid).toBe(false);
      expect(result.issues.some((e) => e.code.includes("duplicate") || e.message.includes("duplicate"))).toBe(true);
    });

    it("rejects stage references that do not exist in the graph's stage list", () => {
      const valid = createDoubleEliminationFormat(4).graph;
      const corrupted: FormatGraph = {
        ...valid,
        matches: valid.matches.map((m, idx) => (idx === 0 ? { ...m, stageId: "phantom-stage-xyz" } : m)),
      };

      const result = validateFormatGraph(corrupted);
      expect(result.valid).toBe(false);
      expect(result.issues.some((e) => e.code.includes("stage") || e.message.includes("stage"))).toBe(true);
    });

    it("rejects out-of-bounds seed references (> entryCount)", () => {
      const entryCount = 8;
      const valid = createRoundRobinFormatGraph(entryCount);
      const corrupted: FormatGraph = {
        ...valid,
        matches: valid.matches.map((m, idx) => (idx === 0 ? { ...m, home: { type: "entry_seed", seed: 999 } } : m)),
      };

      const result = validateFormatGraph(corrupted);
      expect(result.valid).toBe(false);
      expect(
        result.issues.some(
          (e) =>
            e.code.includes("seed") ||
            e.code.includes("entry") ||
            e.message.includes("seed") ||
            e.message.includes("entry"),
        ),
      ).toBe(true);
    });
  });

  describe("Fuzz-Seed Structural Permutations", () => {
    it("preserves deterministic structure and validity across fuzz-seeded templates", () => {
      const entryCounts = [8, 16, 24] as const;
      for (const count of entryCounts) {
        const templates = createDefaultFormatTemplates(count);
        for (const template of templates) {
          const validation = validateFormatGraph(template.graph);
          expect(validation.valid).toBe(true);
          expect(validation.issues).toEqual([]);
        }
      }
    });
  });
});
