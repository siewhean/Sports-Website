import {
  SPORT_PACKS,
  assertValidSportSettings,
  type MatchEventDefinition,
  type SportId,
  type SportPack,
  type SportPackSettings,
} from "./sport-packs.js";
import type { FiveSportScoreEvent, MatchSide } from "./five-sport-scoring.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYSTEM_EVENT_TYPES = new Set(["match_started", "match_reopened"]);
const SEGMENT_COMPLETION_TYPES = new Set(["game_completion", "set_completion"]);
const EXCEPTIONAL_OUTCOME_TYPES = new Set(["retirement", "walkover"]);
const REASON_REQUIRED_TYPES = new Set(["match_reopened", "reversal"]);

export type FiveSportScoreCommand = Readonly<{
  clientEventId: string;
  type: string;
  occurredAt: string;
  side?: MatchSide;
  participantId?: string | null;
  unknownParticipant?: boolean;
  segmentNumber?: number;
  manualTimeSeconds?: number | null;
  reversalTargetEventId?: string;
  reason?: string;
}>;

export type FiveSportScoreEventMetadata = Readonly<{
  eventId: string;
  matchId: string;
  sequence: number;
  actorId: string;
  scoringSessionId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INVALID_OPTIONAL = Symbol("invalid_optional");

type ParsedOptional<T> = T | null | undefined | typeof INVALID_OPTIONAL;

function optionalString(value: unknown, maximum: number): ParsedOptional<string> {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return INVALID_OPTIONAL;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : INVALID_OPTIONAL;
}

function optionalInteger(value: unknown, minimum: number, maximum: number): ParsedOptional<number> {
  if (value === undefined || value === null) return value;
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : INVALID_OPTIONAL;
}

function booleanSetting(settings: SportPackSettings, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function effectiveSettings(pack: SportPack, override?: SportPackSettings): SportPackSettings {
  const settings = { ...pack.recommendedSettings, ...(override ?? {}) };
  assertValidSportSettings(pack, settings);
  return Object.freeze(settings);
}

function definitionFor(pack: SportPack, type: string): MatchEventDefinition | null {
  return pack.eventTypes.find((definition) => definition.id === type) ?? null;
}

function eventEnabled(sportId: SportId, type: string, settings: SportPackSettings): boolean {
  if (sportId === "canoe_polo") {
    if (["green_card", "yellow_card", "red_card"].includes(type)) {
      return booleanSetting(settings, "cardsEnabled", true);
    }
    if (type === "timeout") return booleanSetting(settings, "timeoutsEnabled", true);
    if (type === "incident") return booleanSetting(settings, "incidentsEnabled", true);
  }
  if ((sportId === "badminton" || sportId === "table_tennis") && type === "server_change") {
    return booleanSetting(settings, "serverIndicatorEnabled", false);
  }
  return true;
}

export function parseFiveSportScoreCommand(value: unknown): FiveSportScoreCommand | null {
  if (!isRecord(value)) return null;

  const clientEventId = value.client_event_id;
  const type = value.type;
  const occurredAt = value.occurred_at;
  const side = value.team_slot;
  const participantId = optionalString(value.participant_id, 120);
  const unknownParticipant = value.unknown_participant;
  const segmentNumber = optionalInteger(value.segment_number, 1, 99);
  const manualTimeSeconds = optionalInteger(value.manual_time_seconds, 0, 3_599);
  const reversalTargetEventId = value.reversal_target_event_id;
  const reason = optionalString(value.reason, 500);

  if (
    typeof clientEventId !== "string" ||
    !UUID_PATTERN.test(clientEventId) ||
    typeof type !== "string" ||
    type.length < 1 ||
    type.length > 80 ||
    typeof occurredAt !== "string" ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    (side !== undefined && side !== "home" && side !== "away") ||
    participantId === INVALID_OPTIONAL ||
    (unknownParticipant !== undefined && typeof unknownParticipant !== "boolean") ||
    segmentNumber === INVALID_OPTIONAL ||
    manualTimeSeconds === INVALID_OPTIONAL ||
    (reversalTargetEventId !== undefined &&
      (typeof reversalTargetEventId !== "string" || !UUID_PATTERN.test(reversalTargetEventId))) ||
    reason === INVALID_OPTIONAL
  ) {
    return null;
  }

  return Object.freeze({
    clientEventId,
    type,
    occurredAt,
    ...(side ? { side } : {}),
    ...(typeof participantId === "string" ? { participantId } : participantId === null ? { participantId: null } : {}),
    ...(typeof unknownParticipant === "boolean" ? { unknownParticipant } : {}),
    ...(typeof segmentNumber === "number" ? { segmentNumber } : {}),
    ...(typeof manualTimeSeconds === "number"
      ? { manualTimeSeconds }
      : manualTimeSeconds === null
        ? { manualTimeSeconds: null }
        : {}),
    ...(typeof reversalTargetEventId === "string" ? { reversalTargetEventId } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  });
}

export function assertFiveSportScoreCommandAllowed(
  sportId: SportId,
  command: FiveSportScoreCommand,
  settingsOverride?: SportPackSettings,
): void {
  const pack = SPORT_PACKS[sportId];
  const settings = effectiveSettings(pack, settingsOverride);
  const definition = definitionFor(pack, command.type);

  if (!definition && !SYSTEM_EVENT_TYPES.has(command.type)) {
    throw new Error(`Event type ${command.type} is not supported by ${pack.displayName}`);
  }
  if (definition && !eventEnabled(sportId, command.type, settings)) {
    throw new Error(`Event type ${command.type} is disabled by the effective ${pack.displayName} settings`);
  }

  const sideRequired =
    definition?.requiresSide === true ||
    SEGMENT_COMPLETION_TYPES.has(command.type) ||
    EXCEPTIONAL_OUTCOME_TYPES.has(command.type);
  if (sideRequired && !command.side) throw new Error(`${command.type} requires a side`);

  if (definition?.participantAttribution === "required" && !command.participantId) {
    const allowedUnknownScorer =
      sportId === "canoe_polo" &&
      command.type === "goal" &&
      command.unknownParticipant === true &&
      booleanSetting(settings, "allowUnknownScorer", false);
    if (!allowedUnknownScorer) throw new Error(`${command.type} requires participant attribution`);
  }

  if (command.unknownParticipant === true && !(sportId === "canoe_polo" && command.type === "goal")) {
    throw new Error("Unknown participant attribution is only supported for Canoe Polo goals");
  }

  if (REASON_REQUIRED_TYPES.has(command.type) && (!command.reason || command.reason.length < 3)) {
    throw new Error(`${command.type} requires a reason`);
  }
  if (command.type === "reversal" && !command.reversalTargetEventId) {
    throw new Error("Reversal requires a target event");
  }
  if (command.type !== "reversal" && command.reversalTargetEventId) {
    throw new Error("Only reversal events may identify a reversal target");
  }
}

export function materialiseFiveSportScoreEvent(
  command: FiveSportScoreCommand,
  metadata: FiveSportScoreEventMetadata,
): FiveSportScoreEvent {
  if (!UUID_PATTERN.test(metadata.eventId)) throw new Error("Invalid server score-event ID");
  if (!UUID_PATTERN.test(metadata.matchId)) throw new Error("Invalid match ID");
  if (!UUID_PATTERN.test(metadata.actorId)) throw new Error("Invalid score-event actor ID");
  if (!UUID_PATTERN.test(metadata.scoringSessionId)) throw new Error("Invalid scoring-session ID");
  if (!Number.isInteger(metadata.sequence) || metadata.sequence < 1) throw new Error("Invalid score-event sequence");

  return Object.freeze({
    eventId: metadata.eventId,
    clientEventId: command.clientEventId,
    matchId: metadata.matchId,
    sequence: metadata.sequence,
    actorId: metadata.actorId,
    scoringSessionId: metadata.scoringSessionId,
    occurredAt: command.occurredAt,
    type: command.type,
    ...(command.side ? { side: command.side } : {}),
    ...(command.participantId !== undefined ? { participantId: command.participantId } : {}),
    ...(command.unknownParticipant !== undefined ? { unknownParticipant: command.unknownParticipant } : {}),
    ...(command.segmentNumber !== undefined ? { segmentNumber: command.segmentNumber } : {}),
    ...(command.manualTimeSeconds !== undefined ? { manualTimeSeconds: command.manualTimeSeconds } : {}),
    ...(command.reversalTargetEventId ? { reversalTargetEventId: command.reversalTargetEventId } : {}),
    ...(command.reason ? { reason: command.reason } : {}),
  });
}
