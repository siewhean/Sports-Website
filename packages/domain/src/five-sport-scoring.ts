import {
  SPORT_PACKS,
  assertValidSportSettings,
  type SportId,
  type SportPack,
  type SportPackSettings,
} from "./sport-packs.js";

export type MatchSide = "home" | "away";
export type MatchLifecycle = "not_started" | "in_progress" | "finalised";

export type FiveSportScoreEvent = Readonly<{
  eventId: string;
  clientEventId: string;
  matchId: string;
  sequence: number;
  actorId: string;
  scoringSessionId: string;
  occurredAt: string;
  type: string;
  side?: MatchSide;
  participantId?: string | null;
  unknownParticipant?: boolean;
  segmentNumber?: number;
  manualTimeSeconds?: number | null;
  reversalTargetEventId?: string;
  reason?: string;
}>;

export type AppliedSportAction = Readonly<{
  eventId: string;
  clientEventId: string;
  eventType: string;
  label: string;
  side: MatchSide | null;
  participantId: string | null;
  segmentNumber: number;
  scoreDelta: number;
  occurredAt: string;
  reversed: boolean;
}>;

export type SegmentScore = Readonly<{
  number: number;
  home: number;
  away: number;
  completed: boolean;
  winner: MatchSide | null;
  completionEventId: string | null;
}>;

export type ScoringConflict = Readonly<{
  code: "segment_reopened_after_reversal";
  segmentNumber: number;
  targetEventId: string;
  laterSegmentNumbers: readonly number[];
}>;

export type FiveSportScoreState = Readonly<{
  sportId: SportId;
  matchId: string | null;
  lifecycle: MatchLifecycle;
  currentSegment: number;
  lastSequence: number;
  winner: MatchSide | null;
  exceptionalOutcome: "retirement" | "walkover" | null;
  score: Readonly<Record<MatchSide, number>>;
  totalPoints: Readonly<Record<MatchSide, number>>;
  segmentWins: Readonly<Record<MatchSide, number>>;
  segments: readonly SegmentScore[];
  actions: readonly AppliedSportAction[];
  appliedClientEventIds: readonly string[];
  appliedEventIds: readonly string[];
  conflicts: readonly ScoringConflict[];
}>;

type MutableSegment = {
  number: number;
  home: number;
  away: number;
  completed: boolean;
  winner: MatchSide | null;
  completionEventId: string | null;
};

type MutableAction = {
  eventId: string;
  clientEventId: string;
  eventType: string;
  label: string;
  side: MatchSide | null;
  participantId: string | null;
  segmentNumber: number;
  scoreDelta: number;
  occurredAt: string;
  reversed: boolean;
};

type MutableState = {
  sportId: SportId;
  matchId: string | null;
  lifecycle: MatchLifecycle;
  currentSegment: number;
  lastSequence: number;
  winner: MatchSide | null;
  exceptionalOutcome: "retirement" | "walkover" | null;
  segments: Map<number, MutableSegment>;
  actions: Map<string, MutableAction>;
  clientEvents: Map<string, FiveSportScoreEvent>;
  eventIds: Set<string>;
  conflicts: ScoringConflict[];
};

const SYSTEM_EVENT_TYPES = new Set(["match_started", "match_reopened"]);
const SEGMENT_COMPLETION_TYPES = new Set(["game_completion", "set_completion"]);
const SEGMENT_TRANSITION_TYPES = new Set(["period_change", "deciding_set", "overtime"]);
const EXCEPTIONAL_OUTCOME_TYPES = new Set(["retirement", "walkover"]);
const NON_REVERSIBLE_TYPES = new Set([
  "match_started",
  "match_reopened",
  "finalisation",
  "reversal",
  "game_completion",
  "set_completion",
  ...SEGMENT_TRANSITION_TYPES,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function integerSetting(settings: SportPackSettings, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function nullableIntegerSetting(settings: SportPackSettings, key: string, fallback: number | null): number | null {
  const value = settings[key];
  return value === null || (typeof value === "number" && Number.isInteger(value)) ? value : fallback;
}

function booleanSetting(settings: SportPackSettings, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function mergedSettings(pack: SportPack, overrides?: SportPackSettings): SportPackSettings {
  const merged = { ...pack.recommendedSettings, ...(overrides ?? {}) };
  assertValidSportSettings(pack, merged);
  return Object.freeze(merged);
}

function segment(state: MutableState, number: number): MutableSegment {
  const existing = state.segments.get(number);
  if (existing) return existing;
  const created: MutableSegment = {
    number,
    home: 0,
    away: 0,
    completed: false,
    winner: null,
    completionEventId: null,
  };
  state.segments.set(number, created);
  return created;
}

function assertBase(event: FiveSportScoreEvent): void {
  if (!event.eventId || !event.clientEventId || !event.matchId || !event.actorId || !event.scoringSessionId) {
    throw new Error("Score events require event, client, match, actor, and scoring-session IDs");
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) {
    throw new Error("Score event sequence must be positive");
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) {
    throw new Error(`Invalid occurrence timestamp on ${event.eventId}`);
  }
  if (event.segmentNumber !== undefined && (!Number.isInteger(event.segmentNumber) || event.segmentNumber < 1)) {
    throw new Error(`Invalid segment number on ${event.eventId}`);
  }
  if (
    event.manualTimeSeconds !== undefined &&
    event.manualTimeSeconds !== null &&
    (!Number.isInteger(event.manualTimeSeconds) || event.manualTimeSeconds < 0)
  ) {
    throw new Error(`Invalid manual event time on ${event.eventId}`);
  }
  if (event.participantId !== undefined && event.participantId !== null && !event.participantId.trim()) {
    throw new Error(`Participant attribution cannot be blank on ${event.eventId}`);
  }
}

function matchEvent(pack: SportPack, type: string) {
  return pack.eventTypes.find((definition) => definition.id === type);
}

function bestOf(pack: SportPack, settings: SportPackSettings): number {
  return integerSetting(settings, "bestOf", pack.matchStructure.regulationSegments);
}

function segmentsToWin(pack: SportPack, settings: SportPackSettings): number {
  return Math.floor(bestOf(pack, settings) / 2) + 1;
}

function targetForSegment(pack: SportPack, settings: SportPackSettings, segmentNumber: number): number {
  const regularFallback = pack.matchStructure.targetPoints?.[0] ?? 1;
  const regular = integerSetting(settings, "regularTargetPoints", regularFallback);
  if (pack.sportId === "volleyball" && segmentNumber === bestOf(pack, settings)) {
    const decidingFallback = pack.matchStructure.targetPoints?.at(-1) ?? regular;
    return integerSetting(settings, "decidingTargetPoints", decidingFallback);
  }
  return regular;
}

function winBy(pack: SportPack, settings: SportPackSettings): number {
  return integerSetting(settings, "winBy", pack.matchStructure.winBy ?? 1);
}

function pointCap(pack: SportPack, settings: SportPackSettings): number | null {
  return nullableIntegerSetting(settings, "pointCap", pack.matchStructure.pointCap ?? null);
}

function isWinningSegmentScore(
  pack: SportPack,
  settings: SportPackSettings,
  segmentNumber: number,
  winnerScore: number,
  loserScore: number,
): boolean {
  if (winnerScore <= loserScore) return false;
  const target = targetForSegment(pack, settings, segmentNumber);
  const cap = pointCap(pack, settings);
  if (cap !== null && winnerScore >= cap) return true;
  return winnerScore >= target && winnerScore - loserScore >= winBy(pack, settings);
}

function winningSideForSegment(
  pack: SportPack,
  settings: SportPackSettings,
  current: MutableSegment,
): MatchSide | null {
  if (isWinningSegmentScore(pack, settings, current.number, current.home, current.away)) return "home";
  if (isWinningSegmentScore(pack, settings, current.number, current.away, current.home)) return "away";
  return null;
}

function totals(state: MutableState): Record<MatchSide, number> {
  let home = 0;
  let away = 0;
  for (const item of state.segments.values()) {
    home += item.home;
    away += item.away;
  }
  return { home, away };
}

function segmentWinTotals(state: MutableState): Record<MatchSide, number> {
  let home = 0;
  let away = 0;
  for (const item of state.segments.values()) {
    if (item.completed && item.winner === "home") home += 1;
    if (item.completed && item.winner === "away") away += 1;
  }
  return { home, away };
}

function laterSegmentNumbers(state: MutableState, segmentNumber: number): number[] {
  return [...state.segments.values()]
    .filter((item) => item.number > segmentNumber && (item.home > 0 || item.away > 0 || item.completed))
    .map((item) => item.number)
    .sort((left, right) => left - right);
}

function assertParticipantAttribution(
  pack: SportPack,
  settings: SportPackSettings,
  event: FiveSportScoreEvent,
  participantAttribution: "required" | "optional" | "none",
): void {
  if (participantAttribution !== "required") return;
  if (event.participantId?.trim()) return;
  const unknownCanoePoloScorer =
    pack.sportId === "canoe_polo" &&
    event.type === "goal" &&
    event.unknownParticipant === true &&
    booleanSetting(settings, "allowUnknownScorer", false);
  if (!unknownCanoePoloScorer) {
    throw new Error(`${event.type} requires participant attribution`);
  }
}

function startMatch(state: MutableState): void {
  if (state.lifecycle !== "not_started") throw new Error("Match has already started");
  state.lifecycle = "in_progress";
  state.currentSegment = 1;
  segment(state, 1);
}

function transitionSegment(
  state: MutableState,
  pack: SportPack,
  settings: SportPackSettings,
  event: FiveSportScoreEvent,
): void {
  const next = event.segmentNumber;
  if (!next) throw new Error(`${event.type} requires a segment number`);

  if (event.type === "deciding_set") {
    if (pack.sportId !== "volleyball" || pack.matchStructure.kind !== "best_of_segments") {
      throw new Error("Deciding-set selection is only valid for Volleyball");
    }
    const deciding = bestOf(pack, settings);
    if (next !== deciding || state.currentSegment !== deciding) {
      throw new Error(`Deciding set ${deciding} is not currently available`);
    }
    const incompletePrior = [...state.segments.values()].some((item) => item.number < deciding && !item.completed);
    if (incompletePrior) throw new Error("All prior sets must be completed before the deciding set");
    return;
  }

  if (next !== state.currentSegment + 1) {
    throw new Error(`Expected the next segment to be ${state.currentSegment + 1}`);
  }

  const regulation = integerSetting(settings, "periods", pack.matchStructure.regulationSegments);
  if (event.type === "overtime") {
    if (pack.sportId !== "basketball" || !booleanSetting(settings, "successiveOvertime", false)) {
      throw new Error("Overtime is not enabled for this sport configuration");
    }
    if (next <= regulation) throw new Error("Overtime must follow regulation periods");
  } else if (pack.matchStructure.kind === "timed_periods" && next > regulation) {
    throw new Error(`Segment ${next} exceeds the configured regulation-period limit`);
  } else if (pack.matchStructure.kind === "best_of_segments") {
    throw new Error(`${event.type} cannot advance a best-of-segments match`);
  }

  state.currentSegment = next;
  segment(state, next);
}

function completeSegment(
  state: MutableState,
  pack: SportPack,
  settings: SportPackSettings,
  event: FiveSportScoreEvent,
): void {
  if (pack.matchStructure.kind !== "best_of_segments") {
    throw new Error(`${event.type} is only valid for segmented scoring sports`);
  }
  const number = event.segmentNumber ?? state.currentSegment;
  if (number !== state.currentSegment) throw new Error("Only the current segment can be completed");
  if (!event.side) throw new Error(`${event.type} requires the winning side`);
  const current = segment(state, number);
  if (current.completed) throw new Error(`Segment ${number} is already complete`);
  const winnerScore = current[event.side];
  const loserScore = current[event.side === "home" ? "away" : "home"];
  if (!isWinningSegmentScore(pack, settings, number, winnerScore, loserScore)) {
    throw new Error(`Segment ${number} does not meet the configured winning score`);
  }
  current.completed = true;
  current.winner = event.side;
  current.completionEventId = event.eventId;
  const wins = segmentWinTotals(state);
  if (wins[event.side] < segmentsToWin(pack, settings)) {
    state.currentSegment = number + 1;
    segment(state, state.currentSegment);
  }
}

function recordAction(
  state: MutableState,
  definition: ReturnType<typeof matchEvent> extends infer T ? Exclude<T, undefined | null> : never,
  event: FiveSportScoreEvent,
  segmentNumber: number,
): void {
  state.actions.set(event.eventId, {
    eventId: event.eventId,
    clientEventId: event.clientEventId,
    eventType: event.type,
    label: definition.label,
    side: event.side ?? null,
    participantId: event.participantId ?? null,
    segmentNumber,
    scoreDelta: definition.scoreDelta,
    occurredAt: event.occurredAt,
    reversed: false,
  });
}

function applySportAction(
  state: MutableState,
  pack: SportPack,
  settings: SportPackSettings,
  event: FiveSportScoreEvent,
): void {
  const definition = matchEvent(pack, event.type);
  if (!definition) throw new Error(`Event type ${event.type} is not supported by ${pack.displayName}`);
  if (definition.requiresSide && !event.side) throw new Error(`${event.type} requires a side`);
  assertParticipantAttribution(pack, settings, event, definition.participantAttribution);

  if (SEGMENT_COMPLETION_TYPES.has(event.type)) {
    const number = event.segmentNumber ?? state.currentSegment;
    completeSegment(state, pack, settings, event);
    recordAction(state, definition, event, number);
    return;
  }
  if (SEGMENT_TRANSITION_TYPES.has(event.type)) {
    transitionSegment(state, pack, settings, event);
  }
  if (EXCEPTIONAL_OUTCOME_TYPES.has(event.type)) {
    if (!event.side) throw new Error(`${event.type} requires the winning side`);
    state.winner = event.side;
    state.exceptionalOutcome = event.type as "retirement" | "walkover";
  }

  const number = event.segmentNumber ?? state.currentSegment;
  const current = segment(state, number);
  if (number !== state.currentSegment) {
    throw new Error("Events can only be recorded in the current segment");
  }
  if (current.completed && definition.scoreDelta > 0) {
    throw new Error(`Segment ${number} is complete`);
  }
  if (definition.scoreDelta > 0) {
    if (!event.side) throw new Error(`${event.type} requires a side`);
    if (pack.matchStructure.kind === "best_of_segments") {
      if (winningSideForSegment(pack, settings, current)) {
        throw new Error(`Segment ${number} has a winning score and must be completed before more scoring`);
      }
      const cap = pointCap(pack, settings);
      if (cap !== null && current[event.side] + definition.scoreDelta > cap) {
        throw new Error(`Segment ${number} score cannot exceed the configured point cap`);
      }
    }
    current[event.side] += definition.scoreDelta;
  }
  recordAction(state, definition, event, number);
}

function reverseAction(
  state: MutableState,
  pack: SportPack,
  settings: SportPackSettings,
  event: FiveSportScoreEvent,
): void {
  if (!event.reason?.trim()) throw new Error("Reversal requires a reason");
  if (!event.reversalTargetEventId) throw new Error("Reversal requires a target event");
  const target = state.actions.get(event.reversalTargetEventId);
  if (!target || target.reversed || NON_REVERSIBLE_TYPES.has(target.eventType)) {
    throw new Error(`Reversal target is unavailable: ${event.reversalTargetEventId}`);
  }
  const definition = matchEvent(pack, target.eventType);
  if (!definition?.reversable) throw new Error(`Event ${target.eventType} is not reversible`);
  target.reversed = true;
  if (EXCEPTIONAL_OUTCOME_TYPES.has(target.eventType)) {
    state.exceptionalOutcome = null;
    state.winner = null;
  }
  if (target.scoreDelta > 0 && target.side) {
    const current = segment(state, target.segmentNumber);
    current[target.side] -= target.scoreDelta;
    if (current[target.side] < 0) throw new Error("Reversal would make a segment score negative");
    if (current.completed && current.winner) {
      const winnerScore = current[current.winner];
      const loserScore = current[current.winner === "home" ? "away" : "home"];
      if (!isWinningSegmentScore(pack, settings, current.number, winnerScore, loserScore)) {
        const later = laterSegmentNumbers(state, current.number);
        current.completed = false;
        current.winner = null;
        current.completionEventId = null;
        state.currentSegment = current.number;
        state.winner = null;
        state.conflicts.push({
          code: "segment_reopened_after_reversal",
          segmentNumber: current.number,
          targetEventId: target.eventId,
          laterSegmentNumbers: later,
        });
      }
    }
  }
}

function finaliseMatch(state: MutableState, pack: SportPack, settings: SportPackSettings): void {
  if (state.lifecycle !== "in_progress") throw new Error("Only an in-progress match can be finalised");
  if (state.conflicts.length > 0) throw new Error("Scoring conflicts must be resolved before finalisation");
  if (state.exceptionalOutcome && state.winner) {
    state.lifecycle = "finalised";
    return;
  }
  if (pack.matchStructure.kind === "best_of_segments") {
    const wins = segmentWinTotals(state);
    const required = segmentsToWin(pack, settings);
    if (wins.home < required && wins.away < required) {
      throw new Error(`A side must win ${required} segment(s) before finalisation`);
    }
    state.winner = wins.home > wins.away ? "home" : "away";
  } else {
    const points = totals(state);
    if (!pack.scoreStructure.drawAllowed && points.home === points.away) {
      throw new Error(`${pack.displayName} cannot be finalised as a draw`);
    }
    state.winner = points.home === points.away ? null : points.home > points.away ? "home" : "away";
  }
  if (
    pack.sportId === "canoe_polo" &&
    booleanSetting(settings, "scorerRequired", true) &&
    !booleanSetting(settings, "allowUnknownScorer", false)
  ) {
    const unattributed = [...state.actions.values()].filter(
      (action) => action.eventType === "goal" && !action.reversed && !action.participantId,
    );
    if (unattributed.length > 0) {
      throw new Error(`${unattributed.length} active goal(s) require scorer attribution`);
    }
  }
  state.lifecycle = "finalised";
}

function reopenMatch(state: MutableState, event: FiveSportScoreEvent): void {
  if (state.lifecycle !== "finalised") throw new Error("Only a finalised match can be reopened");
  if (!event.reason?.trim()) throw new Error("Reopening a match requires a reason");
  state.lifecycle = "in_progress";
  state.winner = null;
  state.exceptionalOutcome = null;
}

function snapshot(state: MutableState, pack: SportPack): FiveSportScoreState {
  const totalPoints = totals(state);
  const segmentWins = segmentWinTotals(state);
  const score = pack.scoreStructure.aggregate === "segments_won" ? segmentWins : totalPoints;
  return {
    sportId: state.sportId,
    matchId: state.matchId,
    lifecycle: state.lifecycle,
    currentSegment: state.currentSegment,
    lastSequence: state.lastSequence,
    winner: state.winner,
    exceptionalOutcome: state.exceptionalOutcome,
    score: Object.freeze({ ...score }),
    totalPoints: Object.freeze({ ...totalPoints }),
    segmentWins: Object.freeze({ ...segmentWins }),
    segments: [...state.segments.values()]
      .sort((left, right) => left.number - right.number)
      .map((item) => Object.freeze({ ...item })),
    actions: [...state.actions.values()].map((item) => Object.freeze({ ...item })),
    appliedClientEventIds: [...state.clientEvents.keys()],
    appliedEventIds: [...state.eventIds],
    conflicts: state.conflicts.map((item) =>
      Object.freeze({ ...item, laterSegmentNumbers: [...item.laterSegmentNumbers] }),
    ),
  };
}

export function reduceFiveSportScoreEvents(
  sportId: SportId,
  events: readonly FiveSportScoreEvent[],
  settingsOverride?: SportPackSettings,
): FiveSportScoreState {
  const pack = SPORT_PACKS[sportId];
  const settings = mergedSettings(pack, settingsOverride);
  const state: MutableState = {
    sportId,
    matchId: null,
    lifecycle: "not_started",
    currentSegment: 1,
    lastSequence: 0,
    winner: null,
    exceptionalOutcome: null,
    segments: new Map(),
    actions: new Map(),
    clientEvents: new Map(),
    eventIds: new Set(),
    conflicts: [],
  };

  for (const event of events) {
    assertBase(event);
    const duplicate = state.clientEvents.get(event.clientEventId);
    if (duplicate) {
      if (canonicalJson(duplicate) !== canonicalJson(event)) {
        throw new Error(`Client event ID ${event.clientEventId} was reused with different content`);
      }
      continue;
    }
    if (state.eventIds.has(event.eventId)) throw new Error(`Duplicate event ID ${event.eventId}`);
    if (event.sequence !== state.lastSequence + 1) {
      throw new Error(`Expected score event sequence ${state.lastSequence + 1}, received ${event.sequence}`);
    }
    if (state.matchId !== null && state.matchId !== event.matchId) {
      throw new Error("Score stream mixes multiple matches");
    }
    if (state.lifecycle === "finalised" && event.type !== "match_reopened") {
      throw new Error("Finalised match must be reopened before further events");
    }
    if (state.exceptionalOutcome && event.type !== "finalisation" && event.type !== "reversal") {
      throw new Error("Exceptional outcome must be finalised or reversed before further events");
    }

    state.matchId = event.matchId;
    state.lastSequence = event.sequence;
    state.clientEvents.set(event.clientEventId, event);
    state.eventIds.add(event.eventId);

    if (event.type === "match_started") {
      startMatch(state);
      continue;
    }
    if (state.lifecycle === "not_started") throw new Error("Match must be started before scoring events");
    if (event.type === "match_reopened") {
      reopenMatch(state, event);
      continue;
    }
    if (event.type === "reversal") {
      reverseAction(state, pack, settings, event);
      continue;
    }
    if (event.type === "finalisation") {
      finaliseMatch(state, pack, settings);
      continue;
    }
    if (SYSTEM_EVENT_TYPES.has(event.type)) throw new Error(`Unsupported system event ${event.type}`);
    applySportAction(state, pack, settings, event);
  }

  return snapshot(state, pack);
}
