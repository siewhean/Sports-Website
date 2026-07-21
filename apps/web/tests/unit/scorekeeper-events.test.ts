import { opaqueId } from "@matchday/ui";
import { describe, expect, it } from "vitest";
import type { ScoreEventsAction, ScoreEventsState } from "../../components/scorekeeper/useScoreEvents";
import {
  deriveScores,
  findLastReversibleEvent,
  initialScoreEventsState,
  scoreEventsReducer,
} from "../../components/scorekeeper/useScoreEvents";

function append(
  state: ScoreEventsState,
  input: { id: string; team?: "blue" | "gold"; scoreDelta?: number; reversedEventId?: string },
) {
  const action: ScoreEventsAction = {
    type: "append",
    id: input.id,
    generation: 7,
    defaultSync: "pending",
    event: {
      kind: input.reversedEventId ? "reversal" : "goal",
      label: input.id,
      occurredAt: "07:32",
      team: input.team,
      scoreDelta: input.scoreDelta,
      reversedEventId: input.reversedEventId,
    },
  };
  return scoreEventsReducer(state, action);
}

describe("scorekeeper event reducer", () => {
  it("assigns stable monotonic sequence numbers during rapid appends", () => {
    const state = Array.from({ length: 25 }, (_, index) => index).reduce(
      (current, index) => append(current, { id: `goal-${index}`, team: "blue", scoreDelta: 1 }),
      initialScoreEventsState,
    );

    expect(state.events.map((event) => event.sequence)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(deriveScores(state.events)).toEqual({ blue: 25, gold: 0 });
  });

  it("appends a reversal without deleting its original event and prevents a second reversal", () => {
    const scored = append(initialScoreEventsState, { id: "goal-1", team: "blue", scoreDelta: 1 });
    const reversed = append(scored, {
      id: "reversal-1",
      team: "blue",
      scoreDelta: -1,
      reversedEventId: "goal-1",
    });

    expect(reversed.events.map((event) => event.id)).toEqual(["goal-1", "reversal-1"]);
    expect(deriveScores(reversed.events)).toEqual({ blue: 0, gold: 0 });
    expect(findLastReversibleEvent(reversed.events)).toBeUndefined();
  });

  it("keeps old-generation pending facts out of the score after a takeover", () => {
    const scored = append(initialScoreEventsState, { id: "goal-1", team: "gold", scoreDelta: 1 });
    const fenced = scoreEventsReducer(scored, { type: "fence_generation", generation: 7 });

    expect(fenced.events[0]).toMatchObject({ id: "goal-1", sync: "conflict" });
    expect(deriveScores(fenced.events)).toEqual({ blue: 0, gold: 0 });
  });
});

describe("opaqueId SSR contract", () => {
  it("is a deterministic identity helper and cannot introduce hydration drift", () => {
    expect(opaqueId("access")).toBe("access");
    expect(opaqueId("offline")).toBe("offline");
    expect(opaqueId("access")).toBe(opaqueId("access"));
  });
});
