import { describe, expect, it } from "vitest";
import { SPORT_PACKS, type SportId } from "@matchday/domain";
import { buildFiveSportScorecardDefinition } from "./five-sport-scorecard";

const sportIds = Object.keys(SPORT_PACKS) as SportId[];

describe("Gate C five-sport scorecard adapter", () => {
  it("builds a deterministic, clock-free definition for all five sports", () => {
    expect(sportIds).toEqual(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]);
    for (const sportId of sportIds) {
      const definition = buildFiveSportScorecardDefinition(sportId);
      expect(definition.sportId).toBe(sportId);
      expect(definition.noLiveClock).toBe(true);
      expect(definition.scoreControls.length).toBeGreaterThan(0);
      expect(new Set(definition.scoreControls.map((control) => control.id)).size).toBe(definition.scoreControls.length);
    }
  });

  it("derives Canoe Polo scorer, card, timeout, incident, period, and manual-time controls", () => {
    const definition = buildFiveSportScorecardDefinition("canoe_polo");
    expect(definition.scoreMode).toBe("total");
    expect(definition.drawAllowed).toBe(true);
    expect(definition.segments).toHaveLength(2);
    expect(definition.scoreControls).toEqual([
      expect.objectContaining({
        id: "goal",
        scoreDelta: 1,
        requiresSide: true,
        participantAttribution: "required",
      }),
    ]);
    expect(definition.operationalControls.map((control) => control.id)).toEqual([
      "green_card",
      "yellow_card",
      "red_card",
      "timeout",
      "incident",
      "period_change",
    ]);
    expect(definition.fields.filter((field) => field.enabled).map((field) => field.id)).toEqual([
      "period_selector",
      "manual_event_time",
      "scorer_attribution",
      "cards",
      "timeouts",
      "incidents",
    ]);
  });

  it("removes optional Canoe Polo controls when their effective settings are disabled", () => {
    const definition = buildFiveSportScorecardDefinition("canoe_polo", {
      cardsEnabled: false,
      timeoutsEnabled: false,
      incidentsEnabled: false,
      manualEventTime: false,
    });
    expect(definition.operationalControls.map((control) => control.id)).toEqual(["period_change"]);
    expect(definition.fields.filter((field) => field.enabled).map((field) => field.id)).toEqual([
      "period_selector",
      "scorer_attribution",
    ]);
  });

  it("derives Badminton and Table Tennis best-of scoring without enabling server indication by default", () => {
    const badminton = buildFiveSportScorecardDefinition("badminton");
    const tableTennis = buildFiveSportScorecardDefinition("table_tennis");

    expect(badminton.scoreMode).toBe("segments");
    expect(badminton.segments).toHaveLength(3);
    expect(badminton.segments.every((segment) => segment.targetPoints === 21)).toBe(true);
    expect(badminton.scoreControls.map((control) => control.id)).toEqual(["point"]);
    expect(badminton.segmentCompletionControls).toEqual([
      expect.objectContaining({ id: "game_completion", requiresSide: true }),
    ]);
    expect(badminton.exceptionalOutcomeControls).toEqual([
      expect.objectContaining({ id: "retirement", requiresSide: true }),
      expect.objectContaining({ id: "walkover", requiresSide: true }),
    ]);
    expect(badminton.operationalControls.map((control) => control.id)).not.toContain("server_change");

    expect(tableTennis.segments).toHaveLength(5);
    expect(tableTennis.segments.every((segment) => segment.targetPoints === 11)).toBe(true);
    expect(tableTennis.operationalControls.map((control) => control.id)).not.toContain("server_change");
  });

  it("exposes server indication only when enabled for racket sports", () => {
    for (const sportId of ["badminton", "table_tennis"] as const) {
      const definition = buildFiveSportScorecardDefinition(sportId, { serverIndicatorEnabled: true });
      expect(definition.operationalControls.map((control) => control.id)).toContain("server_change");
      expect(definition.fields.find((field) => field.id === "server_indicator")).toMatchObject({
        enabled: true,
      });
    }
  });

  it("uses the deciding-set target for the final possible Volleyball set", () => {
    const definition = buildFiveSportScorecardDefinition("volleyball");
    expect(definition.scoreMode).toBe("segments");
    expect(definition.segments).toEqual([
      { number: 1, targetPoints: 25, deciding: false },
      { number: 2, targetPoints: 25, deciding: false },
      { number: 3, targetPoints: 15, deciding: true },
    ]);
    expect(definition.segmentCompletionControls.map((control) => control.id)).toEqual(["set_completion"]);
  });

  it("derives Basketball score buttons, periods, overtime, and no-draw policy", () => {
    const definition = buildFiveSportScorecardDefinition("basketball");
    expect(definition.scoreMode).toBe("total");
    expect(definition.drawAllowed).toBe(false);
    expect(definition.allowedScoreIncrements).toEqual([1, 2, 3]);
    expect(definition.scoreControls.map((control) => [control.id, control.scoreDelta])).toEqual([
      ["one_point_score", 1],
      ["two_point_score", 2],
      ["three_point_score", 3],
    ]);
    expect(definition.segments).toHaveLength(4);
    expect(definition.operationalControls.map((control) => control.id)).toContain("overtime");
    expect(definition.fields.find((field) => field.id === "manual_event_time")).toMatchObject({ enabled: true });
  });

  it("fails closed for invalid effective sport settings", () => {
    expect(() => buildFiveSportScorecardDefinition("badminton", { bestOf: 2 })).toThrow(/Invalid sport settings/);
  });

  it("never invents controls outside the selected sport pack", () => {
    for (const sportId of sportIds) {
      const allowed = new Set(SPORT_PACKS[sportId].eventTypes.map((event) => event.id));
      const definition = buildFiveSportScorecardDefinition(sportId);
      const controls = [
        ...definition.scoreControls,
        ...definition.segmentCompletionControls,
        ...definition.operationalControls,
        ...definition.exceptionalOutcomeControls,
      ];
      expect(controls.every((control) => allowed.has(control.id))).toBe(true);
    }
  });
});
