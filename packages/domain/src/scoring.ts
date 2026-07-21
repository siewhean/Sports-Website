import { CANOE_POLO_DEFAULT_SETTINGS, type CanoePoloSettings } from "./canoe-polo.js";

export type CardColour = "green" | "yellow" | "red";

type ScoreEventBase = {
  eventId: string;
  clientEventId: string;
  matchId: string;
  sequence: number;
  actorId: string;
  scoringSessionId: string;
  deviceTimestamp: string;
  period: 1 | 2;
  manualTimeSeconds: number;
};

export type CanoePoloScoreEvent =
  | (ScoreEventBase & { type: "match_started" })
  | (ScoreEventBase & { type: "period_changed"; payload: { period: 1 | 2 } })
  | (ScoreEventBase & { type: "goal_added"; payload: { teamId: string; scorerId: string | null } })
  | (ScoreEventBase & { type: "goal_reversed"; reversalTargetEventId: string; reason: string })
  | (ScoreEventBase & {
      type: "card_added";
      payload: { teamId: string; personId: string; colour: CardColour };
    })
  | (ScoreEventBase & { type: "card_reversed"; reversalTargetEventId: string; reason: string })
  | (ScoreEventBase & { type: "timeout_added"; payload: { teamId: string } })
  | (ScoreEventBase & {
      type: "incident_added";
      payload: { teamId: string | null; personId: string | null; note: string };
    })
  | (ScoreEventBase & { type: "match_finalised" })
  | (ScoreEventBase & { type: "match_reopened"; reason: string });

export type AppliedGoal = {
  eventId: string;
  teamId: string;
  scorerId: string | null;
  period: 1 | 2;
  manualTimeSeconds: number;
  reversed: boolean;
};

export type AppliedCard = {
  eventId: string;
  teamId: string;
  personId: string;
  colour: CardColour;
  period: 1 | 2;
  manualTimeSeconds: number;
  reversed: boolean;
};

export type CanoePoloScoreState = {
  matchId: string | null;
  currentPeriod: 1 | 2;
  started: boolean;
  finalised: boolean;
  lastSequence: number;
  appliedClientEventIds: readonly string[];
  appliedEventIds: readonly string[];
  goals: readonly AppliedGoal[];
  cards: readonly AppliedCard[];
  timeouts: ReadonlyArray<{ eventId: string; teamId: string; period: 1 | 2; manualTimeSeconds: number }>;
  incidents: ReadonlyArray<{
    eventId: string;
    teamId: string | null;
    personId: string | null;
    note: string;
    period: 1 | 2;
    manualTimeSeconds: number;
  }>;
  scoreByTeam: Readonly<Record<string, number>>;
};

export type FinalisationValidation = {
  valid: boolean;
  errors: readonly string[];
};

function emptyState(): CanoePoloScoreState {
  return {
    matchId: null,
    currentPeriod: 1,
    started: false,
    finalised: false,
    lastSequence: 0,
    appliedClientEventIds: [],
    appliedEventIds: [],
    goals: [],
    cards: [],
    timeouts: [],
    incidents: [],
    scoreByTeam: {},
  };
}

function assertBase(event: CanoePoloScoreEvent): void {
  if (!event.eventId || !event.clientEventId || !event.matchId || !event.actorId || !event.scoringSessionId) {
    throw new Error("Score events require event, client, match, actor, and scoring-session IDs");
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new Error("Score event sequence must be positive");
  if (event.period !== 1 && event.period !== 2) throw new Error(`Invalid period on ${event.eventId}`);
  if (!Number.isInteger(event.manualTimeSeconds) || event.manualTimeSeconds < 0) {
    throw new Error(`Invalid manual event time on ${event.eventId}`);
  }
  if (!Number.isFinite(Date.parse(event.deviceTimestamp)))
    throw new Error(`Invalid device timestamp on ${event.eventId}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function reduceCanoePoloScoreEvents(events: readonly CanoePoloScoreEvent[]): CanoePoloScoreState {
  const state = emptyState();
  const clientEvents = new Map<string, CanoePoloScoreEvent>();
  const eventIds = new Set<string>();
  const goals = new Map<string, AppliedGoal>();
  const cards = new Map<string, AppliedCard>();
  const timeouts: CanoePoloScoreState["timeouts"][number][] = [];
  const incidents: CanoePoloScoreState["incidents"][number][] = [];

  for (const event of events) {
    assertBase(event);
    const duplicate = clientEvents.get(event.clientEventId);
    if (duplicate) {
      if (canonicalJson(duplicate) !== canonicalJson(event)) {
        throw new Error(`Client event ID ${event.clientEventId} was reused with different content`);
      }
      continue;
    }
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate event ID ${event.eventId}`);
    if (event.sequence !== state.lastSequence + 1) {
      throw new Error(`Expected score event sequence ${state.lastSequence + 1}, received ${event.sequence}`);
    }
    if (state.matchId !== null && state.matchId !== event.matchId)
      throw new Error("Score stream mixes multiple matches");
    if (state.finalised && event.type !== "match_reopened")
      throw new Error("Finalised match must be reopened before further events");

    state.matchId = event.matchId;
    state.lastSequence = event.sequence;
    state.currentPeriod = event.period;
    clientEvents.set(event.clientEventId, event);
    eventIds.add(event.eventId);

    switch (event.type) {
      case "match_started":
        state.started = true;
        break;
      case "period_changed":
        state.currentPeriod = event.payload.period;
        break;
      case "goal_added":
        if (!event.payload.teamId) throw new Error("Goal requires a team");
        goals.set(event.eventId, {
          eventId: event.eventId,
          teamId: event.payload.teamId,
          scorerId: event.payload.scorerId,
          period: event.period,
          manualTimeSeconds: event.manualTimeSeconds,
          reversed: false,
        });
        break;
      case "goal_reversed": {
        if (!event.reason.trim()) throw new Error("Goal reversal requires a reason");
        const goal = goals.get(event.reversalTargetEventId);
        if (!goal || goal.reversed)
          throw new Error(`Goal reversal target is unavailable: ${event.reversalTargetEventId}`);
        goal.reversed = true;
        break;
      }
      case "card_added":
        if (!event.payload.teamId || !event.payload.personId)
          throw new Error("Card requires team and person attribution");
        cards.set(event.eventId, {
          eventId: event.eventId,
          teamId: event.payload.teamId,
          personId: event.payload.personId,
          colour: event.payload.colour,
          period: event.period,
          manualTimeSeconds: event.manualTimeSeconds,
          reversed: false,
        });
        break;
      case "card_reversed": {
        if (!event.reason.trim()) throw new Error("Card reversal requires a reason");
        const card = cards.get(event.reversalTargetEventId);
        if (!card || card.reversed)
          throw new Error(`Card reversal target is unavailable: ${event.reversalTargetEventId}`);
        card.reversed = true;
        break;
      }
      case "timeout_added":
        if (!event.payload.teamId) throw new Error("Timeout requires a team");
        timeouts.push({
          eventId: event.eventId,
          teamId: event.payload.teamId,
          period: event.period,
          manualTimeSeconds: event.manualTimeSeconds,
        });
        break;
      case "incident_added":
        if (!event.payload.note.trim()) throw new Error("Incident requires a note");
        incidents.push({
          eventId: event.eventId,
          ...event.payload,
          period: event.period,
          manualTimeSeconds: event.manualTimeSeconds,
        });
        break;
      case "match_finalised":
        state.finalised = true;
        break;
      case "match_reopened":
        if (!event.reason.trim()) throw new Error("Reopening a match requires a reason");
        state.finalised = false;
        break;
    }
  }

  const activeGoals = [...goals.values()].filter((goal) => !goal.reversed);
  const scoreByTeam = activeGoals.reduce<Record<string, number>>((scores, goal) => {
    scores[goal.teamId] = (scores[goal.teamId] ?? 0) + 1;
    return scores;
  }, {});
  return {
    ...state,
    appliedClientEventIds: [...clientEvents.keys()],
    appliedEventIds: [...eventIds],
    goals: [...goals.values()],
    cards: [...cards.values()],
    timeouts,
    incidents,
    scoreByTeam,
  };
}

export function validateScoreFinalisation(
  state: CanoePoloScoreState,
  settings: Pick<CanoePoloSettings, "scorerRequired" | "allowUnknownScorer"> = CANOE_POLO_DEFAULT_SETTINGS,
): FinalisationValidation {
  const errors: string[] = [];
  if (!state.started) errors.push("Match has not started");
  if (!state.finalised) errors.push("Match has not been finalised");
  if (settings.scorerRequired && !settings.allowUnknownScorer) {
    const unattributed = state.goals.filter((goal) => !goal.reversed && !goal.scorerId);
    if (unattributed.length > 0) errors.push(`${unattributed.length} active goal(s) require scorer attribution`);
  }
  return { valid: errors.length === 0, errors };
}
