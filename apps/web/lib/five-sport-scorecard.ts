import {
  SPORT_PACKS,
  assertValidSportSettings,
  type MatchEventDefinition,
  type ScorecardComponent,
  type SportId,
  type SportPack,
  type SportPackSettings,
} from "@matchday/domain";

export type ScorecardControlKind = "score" | "segment_completion" | "operational" | "exceptional_outcome";

export type ScorecardControl = Readonly<{
  id: string;
  label: string;
  kind: ScorecardControlKind;
  scoreDelta: number;
  requiresSide: boolean;
  participantAttribution: "required" | "optional" | "none";
  reversible: boolean;
}>;

export type ScorecardField = Readonly<{
  id: string;
  required: boolean;
  enabled: boolean;
}>;

export type SegmentOption = Readonly<{
  number: number;
  targetPoints: number | null;
  deciding: boolean;
}>;

export type FiveSportScorecardDefinition = Readonly<{
  sportId: SportId;
  displayName: string;
  scoreMode: "total" | "segments";
  segmentLabel: string;
  scoringUnitLabel: string;
  allowedScoreIncrements: readonly number[];
  drawAllowed: boolean;
  noLiveClock: true;
  scoreControls: readonly ScorecardControl[];
  segmentCompletionControls: readonly ScorecardControl[];
  operationalControls: readonly ScorecardControl[];
  exceptionalOutcomeControls: readonly ScorecardControl[];
  fields: readonly ScorecardField[];
  segments: readonly SegmentOption[];
}>;

const SEGMENT_COMPLETION_EVENTS = new Set(["game_completion", "set_completion"]);
const EXCEPTIONAL_OUTCOME_EVENTS = new Set(["retirement", "walkover"]);
const LIFECYCLE_EVENTS = new Set(["finalisation", "reversal"]);

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

function effectiveSettings(pack: SportPack, overrides?: SportPackSettings): SportPackSettings {
  const settings = { ...pack.recommendedSettings, ...(overrides ?? {}) };
  assertValidSportSettings(pack, settings);
  return Object.freeze(settings);
}

function eventEnabled(sportId: SportId, eventId: string, settings: SportPackSettings): boolean {
  if (sportId === "canoe_polo") {
    if (["green_card", "yellow_card", "red_card"].includes(eventId)) {
      return booleanSetting(settings, "cardsEnabled", true);
    }
    if (eventId === "timeout") return booleanSetting(settings, "timeoutsEnabled", true);
    if (eventId === "incident") return booleanSetting(settings, "incidentsEnabled", true);
  }
  if ((sportId === "badminton" || sportId === "table_tennis") && eventId === "server_change") {
    return booleanSetting(settings, "serverIndicatorEnabled", false);
  }
  return true;
}

function controlKind(event: MatchEventDefinition): ScorecardControlKind {
  if (event.scoreDelta > 0) return "score";
  if (SEGMENT_COMPLETION_EVENTS.has(event.id)) return "segment_completion";
  if (EXCEPTIONAL_OUTCOME_EVENTS.has(event.id)) return "exceptional_outcome";
  return "operational";
}

function toControl(event: MatchEventDefinition): ScorecardControl {
  return Object.freeze({
    id: event.id,
    label: event.label,
    kind: controlKind(event),
    scoreDelta: event.scoreDelta,
    requiresSide:
      event.requiresSide || SEGMENT_COMPLETION_EVENTS.has(event.id) || EXCEPTIONAL_OUTCOME_EVENTS.has(event.id),
    participantAttribution: event.participantAttribution,
    reversible: event.reversable,
  });
}

function fieldEnabled(component: ScorecardComponent, settings: SportPackSettings): boolean {
  switch (component.id) {
    case "manual_event_time":
      return booleanSetting(settings, "manualEventTime", component.enabledByDefault);
    case "server_indicator":
      return booleanSetting(settings, "serverIndicatorEnabled", component.enabledByDefault);
    case "cards":
      return booleanSetting(settings, "cardsEnabled", component.enabledByDefault);
    case "timeouts":
      return booleanSetting(settings, "timeoutsEnabled", component.enabledByDefault);
    case "incidents":
      return booleanSetting(settings, "incidentsEnabled", component.enabledByDefault);
    default:
      return component.enabledByDefault;
  }
}

function segmentOptions(pack: SportPack, settings: SportPackSettings): readonly SegmentOption[] {
  if (pack.matchStructure.kind === "timed_periods") {
    const count = integerSetting(settings, "periods", pack.matchStructure.regulationSegments);
    return Object.freeze(
      Array.from({ length: count }, (_, index) =>
        Object.freeze({ number: index + 1, targetPoints: null, deciding: false }),
      ),
    );
  }

  const count = integerSetting(settings, "bestOf", pack.matchStructure.regulationSegments);
  const regularTarget = integerSetting(settings, "regularTargetPoints", pack.matchStructure.targetPoints?.[0] ?? 1);
  const decidingTarget = integerSetting(
    settings,
    "decidingTargetPoints",
    pack.matchStructure.targetPoints?.at(-1) ?? regularTarget,
  );
  const cap = nullableIntegerSetting(settings, "pointCap", pack.matchStructure.pointCap ?? null);

  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      const deciding = pack.sportId === "volleyball" && number === count;
      const target = deciding ? decidingTarget : regularTarget;
      return Object.freeze({
        number,
        targetPoints: cap === null ? target : Math.min(target, cap),
        deciding,
      });
    }),
  );
}

export function buildFiveSportScorecardDefinition(
  sportId: SportId,
  settingsOverride?: SportPackSettings,
): FiveSportScorecardDefinition {
  const pack = SPORT_PACKS[sportId];
  const settings = effectiveSettings(pack, settingsOverride);
  const controls = pack.eventTypes
    .filter((event) => !LIFECYCLE_EVENTS.has(event.id))
    .filter((event) => eventEnabled(sportId, event.id, settings))
    .map(toControl);

  return Object.freeze({
    sportId,
    displayName: pack.displayName,
    scoreMode: pack.scoreStructure.aggregate === "segments_won" ? "segments" : "total",
    segmentLabel: pack.terminology.segment,
    scoringUnitLabel: pack.terminology.scoringUnit,
    allowedScoreIncrements: Object.freeze([...pack.scoreStructure.allowedIncrements]),
    drawAllowed: pack.scoreStructure.drawAllowed,
    noLiveClock: true,
    scoreControls: Object.freeze(controls.filter((control) => control.kind === "score")),
    segmentCompletionControls: Object.freeze(controls.filter((control) => control.kind === "segment_completion")),
    operationalControls: Object.freeze(controls.filter((control) => control.kind === "operational")),
    exceptionalOutcomeControls: Object.freeze(controls.filter((control) => control.kind === "exceptional_outcome")),
    fields: Object.freeze(
      pack.scorecard.map((component) =>
        Object.freeze({
          id: component.id,
          required: component.required,
          enabled: fieldEnabled(component, settings),
        }),
      ),
    ),
    segments: segmentOptions(pack, settings),
  });
}
