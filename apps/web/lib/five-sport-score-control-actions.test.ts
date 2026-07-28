import { describe, expect, it } from "vitest";
import { buildFiveSportScorecardDefinition } from "./five-sport-scorecard";
import { buildFiveSportScoreControlGroups } from "./five-sport-score-control-actions";

describe("Gate C shared score-control action model", () => {
  it("creates unique home and away actions for every score control", () => {
    const groups = buildFiveSportScoreControlGroups(buildFiveSportScorecardDefinition("basketball"));
    const score = groups.find((group) => group.kind === "score");
    expect(score?.actions).toHaveLength(6);
    expect(score?.actions.map((action) => action.key)).toEqual([
      "score:one_point_score:home",
      "score:one_point_score:away",
      "score:two_point_score:home",
      "score:two_point_score:away",
      "score:three_point_score:home",
      "score:three_point_score:away",
    ]);
  });

  it("requires a side for segment completion and exceptional outcomes", () => {
    const groups = buildFiveSportScoreControlGroups(buildFiveSportScorecardDefinition("badminton"));
    expect(groups.find((group) => group.kind === "segment_completion")?.actions.map((action) => action.side)).toEqual([
      "home",
      "away",
    ]);
    expect(groups.find((group) => group.kind === "exceptional_outcome")?.actions.map((action) => action.key)).toEqual([
      "exceptional_outcome:retirement:home",
      "exceptional_outcome:retirement:away",
      "exceptional_outcome:walkover:home",
      "exceptional_outcome:walkover:away",
    ]);
  });

  it("keeps side-neutral operational actions global", () => {
    const groups = buildFiveSportScoreControlGroups(buildFiveSportScorecardDefinition("basketball"));
    const overtime = groups
      .find((group) => group.kind === "operational")
      ?.actions.find((action) => action.control.id === "overtime");
    expect(overtime).toMatchObject({ side: null, key: "operational:overtime:global" });
  });

  it("does not emit disabled optional controls", () => {
    const groups = buildFiveSportScoreControlGroups(
      buildFiveSportScorecardDefinition("canoe_polo", {
        cardsEnabled: false,
        timeoutsEnabled: false,
        incidentsEnabled: false,
      }),
    );
    expect(groups.flatMap((group) => group.actions).map((action) => action.control.id)).toEqual([
      "goal",
      "goal",
      "period_change",
    ]);
  });

  it("emits no duplicate action keys for any launch sport", () => {
    for (const sportId of ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const) {
      const actions = buildFiveSportScoreControlGroups(buildFiveSportScorecardDefinition(sportId)).flatMap(
        (group) => group.actions,
      );
      expect(new Set(actions.map((action) => action.key)).size).toBe(actions.length);
    }
  });
});
