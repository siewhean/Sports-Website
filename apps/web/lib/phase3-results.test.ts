import { describe, expect, it } from "vitest";
import { metricLabel, parseRecalculationResponse, parseStandingsSnapshot, sportNameFromConfig } from "./phase3-results";

const competitionId = "10000000-0000-4000-8000-000000000001";
const divisionId = "20000000-0000-4000-8000-000000000002";
const snapshotId = "30000000-0000-4000-8000-000000000003";
const matchId = "40000000-0000-4000-8000-000000000004";
const entryId = "50000000-0000-4000-8000-000000000005";
const sourceHash = "1".repeat(64);

function row() {
  return {
    rank: 1,
    displayOrder: 1,
    entryId,
    entryName: "Harbour Paddlers",
    seed: 1,
    status: "active",
    eligibleForAdvancement: true,
    played: 2,
    won: 2,
    drawn: 0,
    lost: 0,
    tablePoints: 6,
    scoreFor: 8,
    scoreAgainst: 2,
    scoreDifference: 6,
    segmentsWon: 0,
    segmentsLost: 0,
    disciplinePoints: 0,
    sportingTie: false,
    resolvedBy: "table_points",
    explanations: [
      {
        criterion: "table_points",
        value: 6,
        comparedWithinEntryIds: [],
        summary: "Six table points",
      },
    ],
  };
}

function snapshot() {
  return {
    id: snapshotId,
    competition_id: competitionId,
    division_id: divisionId,
    result_version: 4,
    standings: {
      groups: {
        division: {
          snapshotId: "standings-4-abc",
          competitionId,
          divisionId,
          groupId: "division",
          resultVersion: 4,
          configVersion: "basketball-standings-v1",
          calculatedAt: "2026-07-19T10:00:00.000Z",
          fingerprint: "abcdef1234567890",
          rows: [row()],
        },
      },
      cross_group: [],
    },
    explanation: { config_version: "basketball-standings-v1", group_count: 1 },
    calculation_input_hash: sourceHash,
    source_result_hash: sourceHash,
    settings_version: "basketball-standings-v1",
    snapshot_fingerprint: "abcdef1234567890",
    created_at: "2026-07-19T10:00:00.000Z",
  };
}

describe("Phase 3 results boundary", () => {
  it("accepts exact-version persisted automatic/manual provenance and open conflicts", () => {
    const parsed = parseStandingsSnapshot(
      {
        ...snapshot(),
        advancement_slots: [
          {
            match_id: matchId,
            slot: "home",
            entry_id: entryId,
            control: "automatic",
            controlled_by_rule_id: "final:home:division:1",
            source_snapshot_id: snapshotId,
            source_fingerprint: "abcdef1234567890",
            result_version: 4,
            updated_at: "2026-07-19T10:00:00.000Z",
          },
          {
            match_id: matchId,
            slot: "away",
            entry_id: null,
            control: "manual",
            controlled_by_rule_id: null,
            source_snapshot_id: null,
            source_fingerprint: null,
            result_version: 4,
            updated_at: "2026-07-19T10:01:00.000Z",
          },
        ],
        advancement_conflicts: [
          {
            id: "60000000-0000-4000-8000-000000000006",
            rule_id: "final:away:division:2",
            target_slot_id: `${matchId}:away`,
            reason: "target_slot_not_controlled_by_rule",
            status: "open",
            result_version: 4,
            created_at: "2026-07-19T10:01:00.000Z",
          },
        ],
      },
      competitionId,
      divisionId,
    );
    expect(parsed?.advancementSlots.map((slot) => slot.control)).toEqual(["automatic", "manual"]);
    expect(parsed?.advancementConflicts[0]).toMatchObject({ status: "open", resultVersion: 4 });
  });

  it("accepts preserved older slots but rejects future versions, forged hashes and unknown fields", () => {
    expect(
      parseStandingsSnapshot({ ...snapshot(), source_result_hash: "2".repeat(64) }, competitionId, divisionId),
    ).toBeNull();
    expect(
      parseStandingsSnapshot(
        {
          ...snapshot(),
          advancement_slots: [
            {
              match_id: matchId,
              slot: "home",
              entry_id: entryId,
              control: "automatic",
              controlled_by_rule_id: "rule",
              source_snapshot_id: snapshotId,
              source_fingerprint: "abcdef1234567890",
              result_version: 3,
              updated_at: "2026-07-19T10:00:00.000Z",
            },
            {
              match_id: matchId,
              slot: "away",
              entry_id: null,
              control: "manual",
              controlled_by_rule_id: null,
              source_snapshot_id: null,
              source_fingerprint: null,
              result_version: 0,
              updated_at: "2026-07-19T10:01:00.000Z",
            },
          ],
          advancement_conflicts: [],
        },
        competitionId,
        divisionId,
      ),
    ).toMatchObject({
      advancementSlots: [
        { control: "automatic", resultVersion: 3 },
        { control: "manual", resultVersion: 0 },
      ],
    });
    expect(
      parseStandingsSnapshot(
        {
          ...snapshot(),
          advancement_slots: [
            {
              match_id: matchId,
              slot: "home",
              entry_id: entryId,
              control: "automatic",
              controlled_by_rule_id: "rule",
              source_snapshot_id: snapshotId,
              source_fingerprint: "abcdef1234567890",
              result_version: 5,
              updated_at: "2026-07-19T10:00:00.000Z",
            },
          ],
          advancement_conflicts: [],
        },
        competitionId,
        divisionId,
      ),
    ).toBeNull();
    expect(parseStandingsSnapshot({ ...snapshot(), injected: true }, competitionId, divisionId)).toBeNull();
  });

  it("accepts only server recalculation receipts without arbitrary standings fields", () => {
    const parsed = parseRecalculationResponse(
      {
        ...snapshot(),
        advancement: {
          changes: [{ slotId: `${matchId}:home`, previousEntryId: null, entryId }],
          conflicts: [{ ruleId: "rule", targetSlotId: `${matchId}:away`, reason: "source_tie_unresolved" }],
        },
      },
      competitionId,
      divisionId,
    );
    expect(parsed?.changes).toHaveLength(1);
    expect(
      parseRecalculationResponse(
        { ...snapshot(), arbitrary_standings: row(), advancement: { changes: [], conflicts: [] } },
        competitionId,
        divisionId,
      ),
    ).toBeNull();
  });

  it("explains all five supported sport engines with neutral labels", () => {
    expect(
      [
        "canoe-polo-standings-v1",
        "badminton-standings-v1",
        "table-tennis-standings-v1",
        "volleyball-standings-v1",
        "basketball-standings-v1",
      ].map(sportNameFromConfig),
    ).toEqual(["Canoe Polo", "Badminton", "Table Tennis", "Volleyball", "Basketball"]);
    expect(metricLabel("segment_ratio")).toBe("set ratio");
    expect(metricLabel("head_to_head")).toBe("head-to-head result");
  });
});
