"use client";

import { useCallback, useMemo, useReducer } from "react";
import type { ConflictResolution, EventSync, NewScoreEvent, ScoreEvent, ScorekeeperTeam } from "./types";

export type ScoreEventsState = {
  events: ScoreEvent[];
  nextSequence: number;
};

export type ScoreEventsAction =
  | { type: "append"; event: NewScoreEvent; id: string; generation: number; defaultSync: EventSync }
  | { type: "acknowledge_generation"; generation: number }
  | { type: "fence_generation"; generation: number }
  | { type: "resolve_conflict"; eventId: string; resolution: ConflictResolution; reason: string };

export const initialScoreEventsState: ScoreEventsState = { events: [], nextSequence: 1 };

export function scoreEventsReducer(state: ScoreEventsState, action: ScoreEventsAction): ScoreEventsState {
  switch (action.type) {
    case "append": {
      const event: ScoreEvent = {
        ...action.event,
        id: action.id,
        sequence: state.nextSequence,
        generation: action.generation,
        sync: action.event.sync ?? action.defaultSync,
      };

      return { events: [...state.events, event], nextSequence: state.nextSequence + 1 };
    }
    case "acknowledge_generation":
      return {
        ...state,
        events: state.events.map((event) =>
          event.sync === "pending" && event.generation === action.generation
            ? { ...event, sync: "acknowledged" }
            : event,
        ),
      };
    case "fence_generation":
      return {
        ...state,
        events: state.events.map((event) =>
          event.sync === "pending" && event.generation === action.generation ? { ...event, sync: "conflict" } : event,
        ),
      };
    case "resolve_conflict":
      return {
        ...state,
        events: state.events.map((event) =>
          event.id === action.eventId ? { ...event, resolution: action.resolution, reason: action.reason } : event,
        ),
      };
  }
}

export function deriveScores(events: readonly ScoreEvent[]): Record<ScorekeeperTeam, number> {
  return events.reduce<Record<ScorekeeperTeam, number>>(
    (scores, event) => {
      if (event.sync !== "conflict" && event.team && event.scoreDelta) scores[event.team] += event.scoreDelta;
      return scores;
    },
    { blue: 0, gold: 0 },
  );
}

export function findLastReversibleEvent(events: readonly ScoreEvent[]) {
  const reversedIds = new Set(
    events.filter((event) => event.kind === "reversal" && event.reversedEventId).map((event) => event.reversedEventId),
  );

  return [...events]
    .reverse()
    .find(
      (event) =>
        (event.kind === "goal" || event.kind === "neutral") && event.sync !== "conflict" && !reversedIds.has(event.id),
    );
}

function createClientEventId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `event-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useScoreEvents() {
  const [state, dispatch] = useReducer(scoreEventsReducer, initialScoreEventsState);

  const appendEvent = useCallback((event: NewScoreEvent, generation: number, defaultSync: EventSync) => {
    dispatch({ type: "append", event, id: createClientEventId(), generation, defaultSync });
  }, []);

  const acknowledgeGeneration = useCallback((generation: number) => {
    dispatch({ type: "acknowledge_generation", generation });
  }, []);

  const fenceGeneration = useCallback((generation: number) => {
    dispatch({ type: "fence_generation", generation });
  }, []);

  const resolveConflict = useCallback((eventId: string, resolution: ConflictResolution, reason: string) => {
    dispatch({ type: "resolve_conflict", eventId, resolution, reason });
  }, []);

  const scores = useMemo(() => deriveScores(state.events), [state.events]);
  const lastReversibleEvent = useMemo(() => findLastReversibleEvent(state.events), [state.events]);
  const pendingCount = useMemo(() => state.events.filter((event) => event.sync === "pending").length, [state.events]);
  const unresolvedConflicts = useMemo(
    () => state.events.filter((event) => event.sync === "conflict" && !event.resolution),
    [state.events],
  );

  return {
    events: state.events,
    scores,
    lastReversibleEvent,
    pendingCount,
    unresolvedConflicts,
    appendEvent,
    acknowledgeGeneration,
    fenceGeneration,
    resolveConflict,
  };
}
