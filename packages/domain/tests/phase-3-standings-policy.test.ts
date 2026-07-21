import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STANDINGS_SPORT_PACKS,
  applyAutomaticAdvancement,
  applyWithdrawalPolicy,
  calculateStandings,
  compareAcrossGroups,
  createStandingsSnapshot,
  type AdvancementSlot,
  type StandingsMatchResult,
  type StandingsParticipant,
} from "../src/index.js";

const entries: StandingsParticipant[] = [
  { id: "a", name: "Alpha", seed: 1 },
  { id: "b", name: "Bravo", seed: 2 },
  { id: "c", name: "Charlie", seed: 3 },
];

const firstResult: StandingsMatchResult = {
  matchId: "m1",
  homeEntryId: "a",
  awayEntryId: "b",
  homeScore: 2,
  awayScore: 1,
  status: "final",
  version: 1,
};

const policyFixture = JSON.parse(
  readFileSync(
    new URL("../../../validation/phase-3/standings/withdrawal-and-advancement.json", import.meta.url),
    "utf8",
  ),
) as {
  withdrawnEntryId: string;
  futureForfeitMatchIds: readonly string[];
  replacementEntryId: string;
};

function snapshot(groupId: string, results: readonly StandingsMatchResult[], resultVersion = 1) {
  return createStandingsSnapshot({
    competitionId: "competition-1",
    divisionId: "division-1",
    groupId,
    resultVersion,
    configVersion: STANDINGS_SPORT_PACKS.canoe_polo.version,
    calculatedAt: `2026-08-01T00:00:0${resultVersion}.000Z`,
    rows: calculateStandings(entries, results, STANDINGS_SPORT_PACKS.canoe_polo),
  });
}

describe("Phase 3 withdrawal, cross-group, snapshot, and advancement policies", () => {
  it("keeps completed results and turns remaining withdrawal fixtures into sport-pack forfeits", () => {
    const applied = applyWithdrawalPolicy(
      entries,
      [firstResult],
      [
        { matchId: "m1", homeEntryId: "a", awayEntryId: "b" },
        { matchId: "m2", homeEntryId: "b", awayEntryId: "c" },
      ],
      { entryId: policyFixture.withdrawnEntryId },
      STANDINGS_SPORT_PACKS.canoe_polo,
    );
    expect(applied.results[0]).toEqual(firstResult);
    expect(applied.generatedForfeitMatchIds).toEqual(policyFixture.futureForfeitMatchIds);
    expect(applied.results[1]).toMatchObject({
      homeEntryId: "b",
      awayEntryId: "c",
      homeScore: 0,
      awayScore: 3,
      status: "forfeit",
      forfeitLoserEntryId: "b",
    });
    const standings = calculateStandings(applied.entries, applied.results, STANDINGS_SPORT_PACKS.canoe_polo);
    expect(standings.find((row) => row.entryId === "b")).toMatchObject({
      played: 2,
      status: "withdrawn",
      eligibleForAdvancement: false,
    });
  });

  it("replaces only future fixtures while preserving the withdrawn entry's completed history", () => {
    const replacement = { id: policyFixture.replacementEntryId, name: "Replacement", seed: 4 };
    const applied = applyWithdrawalPolicy(
      entries,
      [firstResult],
      [
        { matchId: "m1", homeEntryId: "a", awayEntryId: "b" },
        { matchId: "m2", homeEntryId: "b", awayEntryId: "c" },
      ],
      { entryId: policyFixture.withdrawnEntryId, replacement },
      STANDINGS_SPORT_PACKS.canoe_polo,
    );
    expect(applied.results).toEqual([firstResult]);
    expect(applied.futureMatches[0]).toMatchObject({ homeEntryId: "a", awayEntryId: "b" });
    expect(applied.futureMatches[1]).toMatchObject({ homeEntryId: policyFixture.replacementEntryId, awayEntryId: "c" });
    expect(applied.generatedForfeitMatchIds).toEqual([]);
  });

  it("normalises unequal and incomplete groups with exact per-match fractions", () => {
    const groupA = calculateStandings(
      entries,
      [
        firstResult,
        { matchId: "m2", homeEntryId: "a", awayEntryId: "c", homeScore: 1, awayScore: 0, status: "final", version: 1 },
      ],
      STANDINGS_SPORT_PACKS.canoe_polo,
    )[0]!;
    const groupB = calculateStandings(
      entries,
      [{ matchId: "m3", homeEntryId: "b", awayEntryId: "c", homeScore: 2, awayScore: 0, status: "final", version: 1 }],
      STANDINGS_SPORT_PACKS.canoe_polo,
    )[0]!;
    const candidates = [
      { groupId: "A", row: groupA, groupComplete: true },
      { groupId: "B", row: groupB, groupComplete: false },
    ];
    const provisional = compareAcrossGroups(candidates, {
      criteria: ["table_points_per_match", "score_difference_per_match", "seed"],
      incompleteGroupPolicy: "provisional",
    });
    expect(provisional.map((row) => row.groupId)).toEqual(["B", "A"]);
    expect(provisional[0]).toMatchObject({ provisional: true });
    expect(provisional[0]?.explanations[0]?.value).toBe("3/1");
    expect(provisional[1]?.explanations[0]?.value).toBe("6/2");
    expect(
      compareAcrossGroups(candidates, {
        criteria: ["table_points_per_match"],
        incompleteGroupPolicy: "exclude",
      }).map((row) => row.groupId),
    ).toEqual(["A"]);
    expect(() =>
      compareAcrossGroups(candidates, {
        criteria: ["table_points_per_match"],
        incompleteGroupPolicy: "reject",
      }),
    ).toThrow(/complete groups/);
  });

  it("excludes withdrawn, ineligible, and unresolved candidates from cross-group comparisons", () => {
    const resolved = calculateStandings(
      entries,
      [
        firstResult,
        { matchId: "m2", homeEntryId: "a", awayEntryId: "c", homeScore: 1, awayScore: 0, status: "final", version: 1 },
      ],
      STANDINGS_SPORT_PACKS.canoe_polo,
    )[0]!;
    const unresolved = calculateStandings(entries, [], STANDINGS_SPORT_PACKS.canoe_polo)[0]!;
    const compared = compareAcrossGroups(
      [
        { groupId: "A", row: resolved, groupComplete: true },
        {
          groupId: "B",
          row: { ...resolved, entryId: "withdrawn", status: "withdrawn", eligibleForAdvancement: false },
          groupComplete: true,
        },
        { groupId: "C", row: unresolved, groupComplete: true },
      ],
      { criteria: ["table_points_per_match"], incompleteGroupPolicy: "provisional" },
    );
    expect(compared.map((row) => row.groupId)).toEqual(["A"]);
  });

  it("keeps an exact cross-group tie unresolved and blocks its automatic slot", () => {
    const resolved = calculateStandings(
      entries,
      [
        firstResult,
        { matchId: "m2", homeEntryId: "a", awayEntryId: "c", homeScore: 1, awayScore: 0, status: "final", version: 1 },
      ],
      STANDINGS_SPORT_PACKS.canoe_polo,
    )[0]!;
    const tied = compareAcrossGroups(
      [
        { groupId: "A", row: resolved, groupComplete: true },
        { groupId: "B", row: { ...resolved, entryId: "other" }, groupComplete: true },
      ],
      { criteria: ["table_points_per_match"], incompleteGroupPolicy: "provisional" },
    );
    expect(tied.map((row) => row.rank)).toEqual([1, 1]);
    expect(tied.map((row) => row.displayOrder)).toEqual([1, 2]);
    expect(tied.every((row) => !row.resolved)).toBe(true);

    const advanced = applyAutomaticAdvancement({
      rules: [{ ruleId: "x1", source: { type: "cross_group_rank", rank: 1 }, targetSlotId: "semi-away" }],
      groupSnapshots: {},
      crossGroupStandings: tied,
      currentSlots: [
        {
          slotId: "semi-away",
          entryId: "stale",
          control: "automatic",
          controlledByRuleId: "x1",
          sourceFingerprint: "stale",
        },
      ],
    });
    expect(advanced.conflicts[0]?.reason).toBe("source_tie_unresolved");
    expect(advanced.slots[0]?.entryId).toBeNull();
    expect(advanced.slots[0]).not.toHaveProperty("sourceFingerprint");
  });

  it("creates immutable, reproducible snapshots and leaves prior versions unchanged after correction", () => {
    const original = snapshot("A", [firstResult]);
    const duplicate = snapshot("A", [firstResult]);
    expect(duplicate.fingerprint).toBe(original.fingerprint);
    expect(duplicate.snapshotId).toBe(original.snapshotId);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.rows)).toBe(true);
    expect(() => {
      (original.rows as unknown as { entryName: string }[])[0]!.entryName = "Mutated";
    }).toThrow();

    const corrected = snapshot(
      "A",
      [{ ...firstResult, homeScore: 0, awayScore: 2, status: "corrected", version: 2 }],
      2,
    );
    expect(corrected.fingerprint).not.toBe(original.fingerprint);
    expect(corrected.rows[0]?.entryId).toBe("b");
    expect(original.rows[0]?.entryId).toBe("a");
  });

  it("feeds only rule-controlled stage slots and recalculates them after a correction", () => {
    const original = snapshot("A", [firstResult]);
    const slots: AdvancementSlot[] = [
      { slotId: "semi-home", entryId: null, control: "automatic", controlledByRuleId: "a1" },
      { slotId: "host-seed", entryId: "host", control: "manual" },
    ];
    const rules = [
      { ruleId: "a1", source: { type: "group_rank" as const, groupId: "A", rank: 1 }, targetSlotId: "semi-home" },
      { ruleId: "a2", source: { type: "group_rank" as const, groupId: "A", rank: 2 }, targetSlotId: "host-seed" },
    ];
    const first = applyAutomaticAdvancement({ rules, groupSnapshots: { A: original }, currentSlots: slots });
    expect(first.slots).toEqual([
      expect.objectContaining({ slotId: "semi-home", entryId: "a", controlledByRuleId: "a1" }),
      { slotId: "host-seed", entryId: "host", control: "manual" },
    ]);
    expect(first.conflicts).toEqual([
      { ruleId: "a2", targetSlotId: "host-seed", reason: "target_slot_not_controlled_by_rule" },
    ]);

    const corrected = snapshot(
      "A",
      [{ ...firstResult, homeScore: 0, awayScore: 2, status: "corrected", version: 2 }],
      2,
    );
    const recalculated = applyAutomaticAdvancement({
      rules: rules.slice(0, 1),
      groupSnapshots: { A: corrected },
      currentSlots: first.slots,
    });
    expect(recalculated.changes).toEqual([{ slotId: "semi-home", previousEntryId: "a", entryId: "b" }]);
    expect(recalculated.slots[0]).toMatchObject({ entryId: "b", sourceFingerprint: corrected.fingerprint });
    expect(recalculated.slots[1]).toEqual({ slotId: "host-seed", entryId: "host", control: "manual" });
  });

  it("clears stale automatic qualifiers when a correction creates an unresolved tie", () => {
    const correctedTie = snapshot(
      "A",
      [{ ...firstResult, homeScore: 0, awayScore: 0, status: "corrected", version: 2 }],
      2,
    );
    const result = applyAutomaticAdvancement({
      rules: [{ ruleId: "a1", source: { type: "group_rank", groupId: "A", rank: 1 }, targetSlotId: "semi-home" }],
      groupSnapshots: { A: correctedTie },
      currentSlots: [
        {
          slotId: "semi-home",
          entryId: "a",
          control: "automatic",
          controlledByRuleId: "a1",
          sourceFingerprint: "stale-fingerprint",
        },
      ],
    });
    expect(result.conflicts).toEqual([{ ruleId: "a1", targetSlotId: "semi-home", reason: "source_tie_unresolved" }]);
    expect(result.changes).toEqual([{ slotId: "semi-home", previousEntryId: "a", entryId: null }]);
    expect(result.slots[0]).toEqual({
      slotId: "semi-home",
      entryId: null,
      control: "automatic",
      controlledByRuleId: "a1",
    });
  });

  it("invalidates stale automatic slots for unavailable and provisional cross-group sources", () => {
    const unavailable = applyAutomaticAdvancement({
      rules: [{ ruleId: "a1", source: { type: "group_rank", groupId: "missing", rank: 1 }, targetSlotId: "semi-home" }],
      groupSnapshots: {},
      currentSlots: [
        {
          slotId: "semi-home",
          entryId: "old-team",
          control: "automatic",
          controlledByRuleId: "a1",
          sourceFingerprint: "stale",
        },
      ],
    });
    expect(unavailable.conflicts[0]?.reason).toBe("source_rank_unavailable");
    expect(unavailable.slots[0]).not.toHaveProperty("sourceFingerprint");
    expect(unavailable.slots[0]?.entryId).toBeNull();

    const provisional = applyAutomaticAdvancement({
      rules: [{ ruleId: "x1", source: { type: "cross_group_rank", rank: 1 }, targetSlotId: "semi-away" }],
      groupSnapshots: {},
      crossGroupStandings: [
        {
          rank: 1,
          displayOrder: 1,
          groupId: "B",
          entryId: "candidate",
          provisional: true,
          resolved: true,
          explanations: [],
        },
      ],
      currentSlots: [
        {
          slotId: "semi-away",
          entryId: "old-team",
          control: "automatic",
          controlledByRuleId: "x1",
          sourceFingerprint: "stale",
        },
      ],
    });
    expect(provisional.conflicts).toEqual([
      { ruleId: "x1", targetSlotId: "semi-away", reason: "source_group_incomplete" },
    ]);
    expect(provisional.slots[0]).toEqual({
      slotId: "semi-away",
      entryId: null,
      control: "automatic",
      controlledByRuleId: "x1",
    });
  });
});
