import { describe, expect, it } from "vitest";
import {
  canRegistrationReplacePlaceholder,
  generateDivisionShortCode,
  placeholderGroupsFromGraph,
  placeholderLabel,
  resolvePlaceholderLabels,
  type PlaceholderFormatGraph,
  type PlaceholderLabelEntry,
} from "../src/placeholders.js";

describe("placeholders domain engine", () => {
  describe("generateDivisionShortCode", () => {
    it("suggests expected standard codes for division names", () => {
      expect(generateDivisionShortCode("Men's Open")).toBe("M");
      expect(generateDivisionShortCode("Women's Open")).toBe("W");
      expect(generateDivisionShortCode("Mixed Open")).toBe("X");
      expect(generateDivisionShortCode("Open")).toBe("O");
      expect(generateDivisionShortCode("Boys U14")).toBe("B");
      expect(generateDivisionShortCode("Girls U14")).toBe("G");
      expect(generateDivisionShortCode("Under 18")).toBe("U18");
      expect(generateDivisionShortCode("Under 21")).toBe("U21");
      expect(generateDivisionShortCode("U-16")).toBe("U16");
      expect(generateDivisionShortCode("Division 1")).toBe("D");
    });

    it("resolves collisions by appending digits within 4 characters", () => {
      expect(generateDivisionShortCode("Men's Open", ["M"])).toBe("M2");
      expect(generateDivisionShortCode("Men's Open", ["M", "M2"])).toBe("M3");
      expect(generateDivisionShortCode("Under 18", ["U18"])).toBe("U182");
      expect(generateDivisionShortCode("Under 18", ["U18", "U182"])).toBe("U183");
      // If code is 4 characters, prefix is truncated to fit suffix
      expect(generateDivisionShortCode("U180", ["U180"])).toBe("U182");
    });
  });

  describe("placeholderLabel (D16 derived labels)", () => {
    it("derives labels before a format is created", () => {
      const placeholder = { id: "p1", entry_type: "placeholder", seed: 1 };

      // Single division
      expect(placeholderLabel({ entry: placeholder })).toBe("Team 1");
      expect(placeholderLabel({ entry: placeholder, isPublic: true })).toBe("Team 1 (TBC)");

      // Multi-division with division code
      expect(
        placeholderLabel({
          entry: placeholder,
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("M-1");

      expect(
        placeholderLabel({
          entry: placeholder,
          divisionShortCode: "M",
          multiDivision: true,
          isPublic: true,
        }),
      ).toBe("Team M-1 (TBC)");
    });

    it("derives labels after format from group membership and updates on move", () => {
      const placeholder = { id: "p1", entry_type: "placeholder", seed: 1 };

      // Group A position 1
      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
        }),
      ).toBe("A1");

      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
          isPublic: true,
        }),
      ).toBe("Team A1 (TBC)");

      // Multi-division after format
      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("M-A1");

      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
          divisionShortCode: "M",
          multiDivision: true,
          isPublic: true,
        }),
      ).toBe("Team M-A1 (TBC)");

      // Moving to Group B position 2 automatically reflects in label
      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "B", position: 2 },
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("M-B2");
    });

    it("returns real team name when entry is not a placeholder", () => {
      const realTeam = {
        id: "t1",
        name: "Vikings RFC",
        entry_type: "team",
        seed: 1,
      };

      // Real name replaces label everywhere, even if groupMembership is provided
      expect(
        placeholderLabel({
          entry: realTeam,
          groupMembership: { groupLabel: "A", position: 1 },
          divisionShortCode: "M",
          multiDivision: true,
          isPublic: true,
        }),
      ).toBe("Vikings RFC");

      expect(
        placeholderLabel({
          entry: realTeam,
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("Vikings RFC");
    });
  });

  describe("canRegistrationReplacePlaceholder", () => {
    it("allows replacement only for approved registrations, never pending", () => {
      expect(canRegistrationReplacePlaceholder("pending")).toBe(false);
      expect(canRegistrationReplacePlaceholder("unverified")).toBe(false);
      expect(canRegistrationReplacePlaceholder("rejected")).toBe(false);
      expect(canRegistrationReplacePlaceholder("approved")).toBe(true);
    });
  });

  describe("resolvePlaceholderLabels (shared organiser/public helper)", () => {
    // Two pools; the graph lists pool "z-pool" before "a-pool", so letters must follow the graph,
    // not the pool id or any row id ordering.
    const graph: PlaceholderFormatGraph = {
      stages: [{ id: "stage-groups", kind: "group", order: 1, groupIds: ["z-pool", "a-pool"] }],
      matches: [
        {
          stageId: "stage-groups",
          poolId: "z-pool",
          purpose: "pool",
          home: { type: "entry_seed", seed: 3 },
          away: { type: "entry_seed", seed: 1 },
        },
        {
          stageId: "stage-groups",
          poolId: "a-pool",
          purpose: "pool",
          home: { type: "entry_seed", seed: 4 },
          away: { type: "entry_seed", seed: 2 },
        },
        {
          stageId: "stage-final",
          purpose: "championship",
          home: { type: "stage_rank" },
          away: { type: "stage_rank" },
        },
      ],
    };
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
    const placeholder = (id: string, seed: number | null, minute: number): PlaceholderLabelEntry => ({
      id,
      name: `stored ${id}`,
      entryType: "placeholder",
      seed,
      createdAt: at(minute),
    });

    it("derives group letters from the graph's group order and positions from seed order", () => {
      expect(placeholderGroupsFromGraph(graph).map((group) => [group.label, group.graphGroupId, group.seeds])).toEqual([
        ["A", "z-pool", [1, 3]],
        ["B", "a-pool", [2, 4]],
      ]);
      // Ids sort opposite to seeds, so a UUID-ordered implementation would get these wrong.
      const labels = resolvePlaceholderLabels([
        {
          id: "div",
          shortCode: "M",
          graph,
          entries: [
            placeholder("ffff", 1, 0),
            placeholder("eeee", 2, 1),
            placeholder("dddd", 3, 2),
            placeholder("cccc", 4, 3),
          ],
        },
      ]);
      expect(["ffff", "eeee", "dddd", "cccc"].map((id) => labels.get(id)?.organiserLabel)).toEqual([
        "A1",
        "B1",
        "A2",
        "B2",
      ]);
      expect(labels.get("dddd")?.publicLabel).toBe("Team A2 (TBC)");
      expect(labels.get("dddd")?.groupMembership).toEqual({ groupLabel: "A", position: 2 });
    });

    it("moves an entry with its seed when the seed lands in another group", () => {
      const before = resolvePlaceholderLabels([
        { id: "div", shortCode: null, graph, entries: [placeholder("p", 1, 0)] },
      ]);
      const after = resolvePlaceholderLabels([
        { id: "div", shortCode: null, graph, entries: [placeholder("p", 4, 0)] },
      ]);
      expect(before.get("p")?.organiserLabel).toBe("A1");
      expect(after.get("p")?.organiserLabel).toBe("B2");
    });

    it("prefixes the division short code only when the competition has several divisions", () => {
      const divisions = [
        { id: "m", shortCode: "M", graph, entries: [placeholder("m1", 3, 0)] },
        { id: "w", shortCode: "W", graph: null, entries: [placeholder("w1", 2, 0)] },
      ];
      const labels = resolvePlaceholderLabels(divisions);
      expect(labels.get("m1")?.organiserLabel).toBe("M-A2");
      expect(labels.get("m1")?.publicLabel).toBe("Team M-A2 (TBC)");
      expect(labels.get("w1")?.organiserLabel).toBe("W-2");
      expect(labels.get("w1")?.publicLabel).toBe("Team W-2 (TBC)");
      const single = resolvePlaceholderLabels([divisions[1]!]);
      expect(single.get("w1")?.organiserLabel).toBe("Team 2");
      expect(single.get("w1")?.publicLabel).toBe("Team 2 (TBC)");
    });

    it("gives null-seed placeholders distinct stable ordinals that skip used seeds", () => {
      const entries = [
        placeholder("late", null, 9),
        placeholder("seeded", 1, 0),
        placeholder("early", null, 1),
        placeholder("mid", null, 5),
        placeholder("seeded3", 3, 2),
      ];
      const labels = resolvePlaceholderLabels([{ id: "div", shortCode: null, graph: null, entries }]);
      expect(labels.get("early")?.publicLabel).toBe("Team 2 (TBC)");
      expect(labels.get("mid")?.publicLabel).toBe("Team 4 (TBC)");
      expect(labels.get("late")?.publicLabel).toBe("Team 5 (TBC)");
      // Caller row order must not matter.
      const reversed = resolvePlaceholderLabels([
        { id: "div", shortCode: null, graph: null, entries: [...entries].reverse() },
      ]);
      expect([...reversed.entries()].map(([id, v]) => [id, v.organiserLabel]).sort()).toEqual(
        [...labels.entries()].map(([id, v]) => [id, v.organiserLabel]).sort(),
      );
      // A null-seed entry is never placed in a group even when a graph exists.
      const withGraph = resolvePlaceholderLabels([{ id: "div", shortCode: null, graph, entries }]);
      expect(withGraph.get("early")?.organiserLabel).toBe("Team 2");
      expect(withGraph.get("seeded")?.organiserLabel).toBe("A1");
    });

    it("returns real entry names unchanged", () => {
      const labels = resolvePlaceholderLabels([
        {
          id: "div",
          shortCode: null,
          graph,
          entries: [{ id: "real", name: "Sharks", entryType: "team", seed: 1, createdAt: at(0) }],
        },
      ]);
      expect(labels.get("real")?.organiserLabel).toBe("Sharks");
      expect(labels.get("real")?.publicLabel).toBe("Sharks");
    });
  });
});
