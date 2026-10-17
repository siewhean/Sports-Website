import { describe, expect, it } from "vitest";
import {
  BADMINTON_3X15_SPORT_PACK,
  CANOE_POLO_FEDERATION_SPORT_PACK,
  DRAFT_SPORT_PACK_VERSION,
  SPORT_PACKS,
  SPORT_PACK_REGISTRY,
  VOLLEYBALL_FEDERATION_SPORT_PACK,
  assertFiveSportScoreCommandAllowed,
  isRegisteredSportPackVersion,
  reduceFiveSportScoreEvents,
  registeredSportPack,
  type FiveSportScoreEvent,
  type MatchSide,
  type SportId,
} from "../src/index.js";

function event(
  sequence: number,
  input: Partial<FiveSportScoreEvent> & Pick<FiveSportScoreEvent, "type">,
): FiveSportScoreEvent {
  return {
    eventId: `event-${sequence}`,
    clientEventId: `client-${sequence}`,
    matchId: "match-1",
    sequence,
    actorId: "official-1",
    scoringSessionId: "session-1",
    occurredAt: new Date(Date.UTC(2027, 0, 10, 1, 0, sequence)).toISOString(),
    ...input,
  };
}

function points(first: number, count: number, side: MatchSide, segmentNumber: number): FiveSportScoreEvent[] {
  return Array.from({ length: count }, (_, offset) => event(first + offset, { type: "point", side, segmentNumber }));
}

describe("multi-version sport packs (redesign Phase 4)", () => {
  it("registers the draft and federation versions for every sport", () => {
    const sports = Object.keys(SPORT_PACKS) as SportId[];
    for (const sport of sports) {
      expect(isRegisteredSportPackVersion(sport, DRAFT_SPORT_PACK_VERSION)).toBe(true);
      expect(isRegisteredSportPackVersion(sport, "1.0.0")).toBe(true);
    }
    expect(SPORT_PACK_REGISTRY.versions("badminton")).toEqual([DRAFT_SPORT_PACK_VERSION, "1.0.0", "1.1.0"]);
    expect(isRegisteredSportPackVersion("volleyball", "1.1.0")).toBe(false);
    expect(isRegisteredSportPackVersion("canoe_polo", "9.9.9")).toBe(false);
  });

  it("keeps the draft pack as the default lookup, so existing competitions are unchanged", () => {
    for (const sport of Object.keys(SPORT_PACKS) as SportId[]) {
      expect(registeredSportPack(sport)).toBe(SPORT_PACKS[sport]);
      expect(registeredSportPack(sport, DRAFT_SPORT_PACK_VERSION)).toBe(SPORT_PACKS[sport]);
      expect(registeredSportPack(sport, null)).toBe(SPORT_PACKS[sport]);
    }
    expect(registeredSportPack("canoe_polo", "1.0.0")).toEqual(CANOE_POLO_FEDERATION_SPORT_PACK);
    expect(() => registeredSportPack("canoe_polo", "9.9.9")).toThrow(/Unknown sport pack/);
  });

  it("reduces a draft-pack stream identically with or without the explicit draft version", () => {
    const stream = [event(1, { type: "match_started" }), ...points(2, 3, "home", 1)];
    expect(
      reduceFiveSportScoreEvents("badminton", stream, undefined, { packVersion: DRAFT_SPORT_PACK_VERSION }),
    ).toEqual(reduceFiveSportScoreEvents("badminton", stream));
  });

  it("scores badminton 3×15 games on pack 1.1.0 and 3×21 on the draft pack", () => {
    const toFifteen = [event(1, { type: "match_started" }), ...points(2, 15, "home", 1)];
    const completed = [...toFifteen, event(17, { type: "game_completion", side: "home", segmentNumber: 1 })];
    const state = reduceFiveSportScoreEvents("badminton", completed, BADMINTON_3X15_SPORT_PACK.recommendedSettings, {
      packVersion: "1.1.0",
    });
    expect(state.segments[0]).toMatchObject({ home: 15, away: 0, completed: true, winner: "home" });
    expect(() => reduceFiveSportScoreEvents("badminton", completed)).toThrow(/winning score/);
  });

  it("caps a badminton 3×15 game at 21", () => {
    const atCap: FiveSportScoreEvent[] = [event(1, { type: "match_started" })];
    for (let rally = 0; rally < 40; rally += 1)
      atCap.push(event(rally + 2, { type: "point", side: rally % 2 === 0 ? "home" : "away", segmentNumber: 1 }));
    const capped = [...atCap, event(42, { type: "point", side: "home", segmentNumber: 1 })];
    const options = { packVersion: "1.1.0" } as const;
    expect(
      reduceFiveSportScoreEvents("badminton", capped, BADMINTON_3X15_SPORT_PACK.recommendedSettings, options)
        .segments[0],
    ).toMatchObject({ home: 21, away: 20 });
    expect(() =>
      reduceFiveSportScoreEvents(
        "badminton",
        [...capped, event(43, { type: "point", side: "away", segmentNumber: 1 })],
        BADMINTON_3X15_SPORT_PACK.recommendedSettings,
        options,
      ),
    ).toThrow(/must be completed before more scoring/);
  });

  it("accepts federation-only settings only on the federation pack", () => {
    const settings = CANOE_POLO_FEDERATION_SPORT_PACK.recommendedSettings;
    const stream = [event(1, { type: "match_started" })];
    expect(() => reduceFiveSportScoreEvents("canoe_polo", stream, settings)).toThrow(/Invalid sport settings/);
    expect(reduceFiveSportScoreEvents("canoe_polo", stream, settings, { packVersion: "1.0.0" }).lifecycle).toBe(
      "in_progress",
    );
  });

  it("applies the federation pack's rules to commands (ICF: no team timeouts)", () => {
    const timeout = {
      clientEventId: "00000000-0000-4000-8000-000000000001",
      type: "timeout",
      side: "home",
      occurredAt: "2027-01-10T01:00:00.000Z",
      manualTimeSeconds: 30,
    } as const;
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "canoe_polo",
        timeout,
        CANOE_POLO_FEDERATION_SPORT_PACK.recommendedSettings,
        "1.0.0",
      ),
    ).toThrow(/disabled/);
    expect(() => assertFiveSportScoreCommandAllowed("canoe_polo", timeout)).not.toThrow();
  });

  it("plays volleyball best of five with a deciding set to 15 on pack 1.0.0", () => {
    const settings = VOLLEYBALL_FEDERATION_SPORT_PACK.recommendedSettings;
    expect(settings.bestOf).toBe(5);
    let sequence = 1;
    const stream: FiveSportScoreEvent[] = [event(sequence++, { type: "match_started" })];
    for (let set = 1; set <= 4; set += 1) {
      const side: MatchSide = set % 2 === 1 ? "home" : "away";
      stream.push(...points(sequence, 25, side, set));
      sequence += 25;
      stream.push(event(sequence++, { type: "set_completion", side, segmentNumber: set }));
    }
    stream.push(...points(sequence, 15, "home", 5));
    sequence += 15;
    stream.push(event(sequence++, { type: "set_completion", side: "home", segmentNumber: 5 }));
    stream.push(event(sequence++, { type: "finalisation" }));
    const state = reduceFiveSportScoreEvents("volleyball", stream, settings, { packVersion: "1.0.0" });
    expect(state.segmentWins).toEqual({ home: 3, away: 2 });
    expect(state.winner).toBe("home");
  });
});
