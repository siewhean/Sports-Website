/**
 * Versioned, federation-neutral product defaults for the five launch sports.
 *
 * These packs are editable product starting points. They deliberately make no
 * claim of compliance with a federation rule book. A competition snapshots the
 * pack version and recommended settings at creation time so later pack releases
 * cannot rewrite an existing event.
 */

export const SPORT_PACK_SCHEMA_VERSION = 1 as const;
export const DRAFT_SPORT_PACK_VERSION = "0.1.0-draft.1" as const;

export type SportId = "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
export type EntryType = "team" | "singles" | "doubles";
export type SettingsMode = "recommended" | "customised";
export type SettingValue = boolean | number | string | null | readonly string[];
export type SportPackSettings = Readonly<Record<string, SettingValue>>;
export type SportPackOverride = Readonly<Record<string, SettingValue>>;

export type Terminology = Readonly<{
  entrySingular: string;
  entryPlural: string;
  participantSingular: string;
  participantPlural: string;
  playingArea: string;
  match: string;
  segment: string;
  scoringUnit: string;
}>;

export type MatchStructure = Readonly<{
  kind: "timed_periods" | "best_of_segments";
  regulationSegments: number;
  segmentDurationMinutes?: number;
  decidingSegmentDurationMinutes?: number;
  targetPoints?: readonly number[];
  winBy?: number;
  pointCap?: number | null;
  overtimeDurationMinutes?: number;
  successiveOvertime?: boolean;
}>;

export type ScoreStructure = Readonly<{
  hierarchy: readonly string[];
  primaryUnit: string;
  allowedIncrements: readonly number[];
  aggregate: "sum" | "segments_won";
  drawAllowed: boolean;
}>;

export type MatchEventDefinition = Readonly<{
  id: string;
  label: string;
  scoreDelta: number;
  requiresSide: boolean;
  participantAttribution: "required" | "optional" | "none";
  reversable: boolean;
}>;

export type StandingsCriterionDefinition = Readonly<{
  id: string;
  label: string;
  direction: "higher" | "lower" | "resolution";
  zeroDenominator?: "zero" | "infinity_when_numerator_positive";
}>;

export type StandingsConfiguration = Readonly<{
  points: Readonly<{ win: number; draw: number; loss: number }> | null;
  defaultOrder: readonly string[];
  availableCriteria: readonly StandingsCriterionDefinition[];
  unresolvedTie: "audited_manual_resolution";
}>;

export type ForfeitConfiguration = Readonly<{
  winnerScore: number;
  loserScore: number;
  awardedSegments: number;
  preserveCompletedPlay: boolean;
}>;

export type ScorecardComponent = Readonly<{
  id: string;
  required: boolean;
  enabledByDefault: boolean;
}>;

export type SettingsConstraint =
  | Readonly<{ kind: "odd_integer"; field: string }>
  | Readonly<{ kind: "greater_than"; greaterField: string; lesserField: string }>
  | Readonly<{ kind: "less_than_or_equal"; lesserField: string; greaterField: string }>
  | Readonly<{ kind: "nullable_at_least"; field: string; minimumField: string }>
  | Readonly<{ kind: "equals"; field: string; value: boolean | number | string }>
  | Readonly<{ kind: "requires_true"; whenField: string; requiredField: string }>;

export type ValidationRule = Readonly<{
  id: string;
  description: string;
  severity: "error" | "cleanup";
  settingsConstraint?: SettingsConstraint;
}>;

export type SettingDefinition =
  | Readonly<{ type: "boolean"; label: string }>
  | Readonly<{ type: "integer"; label: string; minimum: number; maximum: number; nullable?: boolean }>
  | Readonly<{ type: "enum"; label: string; values: readonly string[] }>
  | Readonly<{ type: "ordered_enum"; label: string; values: readonly string[]; minimumItems: number }>;

export type SportPack = Readonly<{
  schemaVersion: typeof SPORT_PACK_SCHEMA_VERSION;
  sportId: SportId;
  version: string;
  status: "provisional_product_baseline";
  authority: "product_recommendation_not_federation_profile";
  displayName: string;
  terminology: Terminology;
  entryTypes: readonly EntryType[];
  matchStructure: MatchStructure;
  scoreStructure: ScoreStructure;
  eventTypes: readonly MatchEventDefinition[];
  standings: StandingsConfiguration;
  forfeit: ForfeitConfiguration;
  scorecard: readonly ScorecardComponent[];
  validationRules: readonly ValidationRule[];
  recommendedSlotMinutes: number;
  settingsSchema: Readonly<Record<string, SettingDefinition>>;
  recommendedSettings: SportPackSettings;
}>;

export type ValidationIssue = Readonly<{ path: string; code: string; message: string }>;

export class SportPackValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SportPackValidationError";
    this.issues = issues;
  }
}

export type CompetitionSportSettings = Readonly<{
  competitionId: string;
  sportId: SportId;
  packSchemaVersion: typeof SPORT_PACK_SCHEMA_VERSION;
  packVersion: string;
  recommendedSnapshot: SportPackSettings;
  override: SportPackOverride;
  effective: SportPackSettings;
  mode: SettingsMode;
}>;

export type DivisionSportSettings = Readonly<{
  divisionId: string;
  competitionId: string;
  sportId: SportId;
  packSchemaVersion: typeof SPORT_PACK_SCHEMA_VERSION;
  packVersion: string;
  override: SportPackOverride;
  effective: SportPackSettings;
  mode: SettingsMode;
}>;

export type UserSportDefault = Readonly<{
  userId: string;
  sportId: SportId;
  sourcePackSchemaVersion: typeof SPORT_PACK_SCHEMA_VERSION;
  sourcePackVersion: string;
  settings: SportPackSettings;
}>;

export type SaveSportSettingsAsUserDefaultCommand = Readonly<{
  type: "sport_settings.save_as_user_default";
  commandId: string;
  userId: string;
  competitionId: string;
  sportId: SportId;
  sourcePackSchemaVersion: typeof SPORT_PACK_SCHEMA_VERSION;
  sourcePackVersion: string;
  settings: SportPackSettings;
}>;

export type CopySportSettingsFromPreviousCompetitionCommand = Readonly<{
  type: "sport_settings.copy_from_previous_competition";
  commandId: string;
  sourceCompetitionId: string;
  targetCompetitionId: string;
  sportId: SportId;
  sourcePackSchemaVersion: typeof SPORT_PACK_SCHEMA_VERSION;
  targetPackSchemaVersion: typeof SPORT_PACK_SCHEMA_VERSION;
  sourcePackVersion: string;
  targetPackVersion: string;
  settings: SportPackSettings;
}>;

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function frozenClone<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameValue(left: SettingValue, right: SettingValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push({ path: `${path}.${key}`, code: "unknown_key", message: "Unknown property" });
  }
  for (const key of allowed) {
    if (!(key in value))
      issues.push({ path: `${path}.${key}`, code: "required", message: "Required property is missing" });
  }
}

function validateSettingValue(definition: SettingDefinition, value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") issues.push({ path, code: "type", message: "Expected a boolean" });
    return issues;
  }
  if (definition.type === "integer") {
    if (value === null && definition.nullable) return issues;
    if (!Number.isInteger(value)) return [{ path, code: "type", message: "Expected an integer" }];
    const number = value as number;
    if (number < definition.minimum || number > definition.maximum) {
      issues.push({ path, code: "range", message: `Expected ${definition.minimum}–${definition.maximum}` });
    }
    return issues;
  }
  if (definition.type === "enum") {
    if (typeof value !== "string" || !definition.values.includes(value)) {
      issues.push({ path, code: "enum", message: `Expected one of: ${definition.values.join(", ")}` });
    }
    return issues;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return [{ path, code: "type", message: "Expected an ordered string array" }];
  }
  if (
    value.length < definition.minimumItems ||
    !unique(value) ||
    value.some((item) => !definition.values.includes(item))
  ) {
    issues.push({ path, code: "ordered_enum", message: "Expected a unique ordered subset of allowed values" });
  }
  return issues;
}

function isSettingDefinition(value: unknown): value is SettingDefinition {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.label !== "string") return false;
  if (value.type === "boolean") return true;
  if (value.type === "integer") {
    return (
      Number.isInteger(value.minimum) &&
      Number.isInteger(value.maximum) &&
      Number(value.minimum) <= Number(value.maximum) &&
      (value.nullable === undefined || typeof value.nullable === "boolean")
    );
  }
  if (value.type === "enum") {
    return (
      Array.isArray(value.values) && value.values.length > 0 && value.values.every((item) => typeof item === "string")
    );
  }
  if (value.type === "ordered_enum") {
    return (
      Array.isArray(value.values) &&
      value.values.length > 0 &&
      value.values.every((item) => typeof item === "string") &&
      Number.isInteger(value.minimumItems) &&
      Number(value.minimumItems) > 0
    );
  }
  return false;
}

function constraintFields(constraint: SettingsConstraint): readonly string[] {
  switch (constraint.kind) {
    case "odd_integer":
    case "equals":
      return [constraint.field];
    case "greater_than":
      return [constraint.greaterField, constraint.lesserField];
    case "less_than_or_equal":
      return [constraint.lesserField, constraint.greaterField];
    case "nullable_at_least":
      return [constraint.field, constraint.minimumField];
    case "requires_true":
      return [constraint.whenField, constraint.requiredField];
    default:
      return [];
  }
}

function validateSettingsConstraints(pack: SportPack, settings: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const rule of pack.validationRules) {
    const constraint = rule.settingsConstraint;
    if (!constraint || constraintFields(constraint).some((field) => !(field in settings))) continue;
    let valid = true;
    switch (constraint.kind) {
      case "odd_integer": {
        const value = settings[constraint.field];
        valid = Number.isInteger(value) && Number(value) > 0 && Number(value) % 2 === 1;
        break;
      }
      case "greater_than":
        valid = Number(settings[constraint.greaterField]) > Number(settings[constraint.lesserField]);
        break;
      case "less_than_or_equal":
        valid = Number(settings[constraint.lesserField]) <= Number(settings[constraint.greaterField]);
        break;
      case "nullable_at_least": {
        const value = settings[constraint.field];
        valid = value === null || Number(value) >= Number(settings[constraint.minimumField]);
        break;
      }
      case "equals":
        valid = settings[constraint.field] === constraint.value;
        break;
      case "requires_true":
        valid = settings[constraint.whenField] !== true || settings[constraint.requiredField] === true;
        break;
      default:
        continue;
    }
    if (!valid) {
      issues.push({
        path: `settings.${constraintFields(constraint).join("+")}`,
        code: `invariant.${rule.id}`,
        message: rule.description,
      });
    }
  }
  return issues;
}

export function validateSportSettings(
  pack: SportPack,
  value: unknown,
  options: Readonly<{ partial?: boolean }> = {},
): readonly ValidationIssue[] {
  if (!isRecord(value)) return [{ path: "settings", code: "type", message: "Expected an object" }];
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(value)) {
    const definition = pack.settingsSchema[key];
    if (!definition) issues.push({ path: `settings.${key}`, code: "unknown_key", message: "Unknown setting" });
    else if (!isSettingDefinition(definition))
      issues.push({ path: `settingsSchema.${key}`, code: "schema_definition", message: "Invalid setting definition" });
    else issues.push(...validateSettingValue(definition, value[key], `settings.${key}`));
  }
  if (!options.partial) {
    for (const key of Object.keys(pack.settingsSchema)) {
      if (!(key in value))
        issues.push({ path: `settings.${key}`, code: "required", message: "Required setting is missing" });
    }
  }
  issues.push(...validateSettingsConstraints(pack, value));
  return issues;
}

export function assertValidSportSettings(
  pack: SportPack,
  value: unknown,
  options: Readonly<{ partial?: boolean }> = {},
): asserts value is SportPackSettings {
  const issues = validateSportSettings(pack, value, options);
  if (issues.length > 0) throw new SportPackValidationError("Invalid sport settings", issues);
}

const topLevelKeys = [
  "schemaVersion",
  "sportId",
  "version",
  "status",
  "authority",
  "displayName",
  "terminology",
  "entryTypes",
  "matchStructure",
  "scoreStructure",
  "eventTypes",
  "standings",
  "forfeit",
  "scorecard",
  "validationRules",
  "recommendedSlotMinutes",
  "settingsSchema",
  "recommendedSettings",
] as const;

function strictShape(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, code: "unknown_key", message: "Unknown property" });
  }
  for (const key of required) {
    if (!(key in value))
      issues.push({ path: `${path}.${key}`, code: "required", message: "Required property is missing" });
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validateSettingDefinitionShape(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, code: "type", message: "Expected a setting definition object" });
    return;
  }
  const type = value.type;
  if (type === "boolean") strictShape(value, ["type", "label"], [], path, issues);
  else if (type === "integer") strictShape(value, ["type", "label", "minimum", "maximum"], ["nullable"], path, issues);
  else if (type === "enum") strictShape(value, ["type", "label", "values"], [], path, issues);
  else if (type === "ordered_enum") strictShape(value, ["type", "label", "values", "minimumItems"], [], path, issues);
  else {
    issues.push({ path: `${path}.type`, code: "enum", message: "Unsupported setting definition type" });
    return;
  }
  if (!nonEmptyString(value.label))
    issues.push({ path: `${path}.label`, code: "type", message: "Expected non-empty text" });
  if (type === "integer") {
    if (
      !Number.isInteger(value.minimum) ||
      !Number.isInteger(value.maximum) ||
      Number(value.minimum) > Number(value.maximum)
    )
      issues.push({ path, code: "range", message: "Expected an ordered integer range" });
    if (value.nullable !== undefined && typeof value.nullable !== "boolean")
      issues.push({ path: `${path}.nullable`, code: "type", message: "Expected a boolean" });
  }
  if (type === "enum" || type === "ordered_enum") {
    if (
      !Array.isArray(value.values) ||
      value.values.length === 0 ||
      value.values.some((item) => !nonEmptyString(item)) ||
      !unique(value.values as string[])
    )
      issues.push({ path: `${path}.values`, code: "enum_values", message: "Expected unique non-empty values" });
  }
  if (
    type === "ordered_enum" &&
    (!positiveInteger(value.minimumItems) ||
      (Array.isArray(value.values) && Number(value.minimumItems) > value.values.length))
  )
    issues.push({ path: `${path}.minimumItems`, code: "range", message: "Expected a valid minimum item count" });
}

function validateConstraintShape(
  constraint: unknown,
  settingKeys: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRecord(constraint)) {
    issues.push({ path, code: "type", message: "Expected a settings constraint object" });
    return;
  }
  const shapes: Record<string, readonly string[]> = {
    odd_integer: ["kind", "field"],
    greater_than: ["kind", "greaterField", "lesserField"],
    less_than_or_equal: ["kind", "lesserField", "greaterField"],
    nullable_at_least: ["kind", "field", "minimumField"],
    equals: ["kind", "field", "value"],
    requires_true: ["kind", "whenField", "requiredField"],
  };
  const fields = typeof constraint.kind === "string" ? shapes[constraint.kind] : undefined;
  if (!fields) {
    issues.push({ path: `${path}.kind`, code: "enum", message: "Unsupported constraint kind" });
    return;
  }
  strictShape(constraint, fields, [], path, issues);
  for (const key of fields.filter((key) => key !== "kind" && key !== "value")) {
    const field = constraint[key];
    if (!nonEmptyString(field) || !settingKeys.has(field))
      issues.push({
        path: `${path}.${key}`,
        code: "setting_reference",
        message: "Constraint must reference a declared setting",
      });
  }
  if (constraint.kind === "equals" && !["boolean", "number", "string"].includes(typeof constraint.value))
    issues.push({ path: `${path}.value`, code: "type", message: "Expected a scalar value" });
}

function validateNestedPackContract(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  const match = value.matchStructure;
  if (isRecord(match)) {
    strictShape(
      match,
      ["kind", "regulationSegments"],
      [
        "segmentDurationMinutes",
        "decidingSegmentDurationMinutes",
        "targetPoints",
        "winBy",
        "pointCap",
        "overtimeDurationMinutes",
        "successiveOvertime",
      ],
      "pack.matchStructure",
      issues,
    );
    if (match.kind !== "timed_periods" && match.kind !== "best_of_segments")
      issues.push({ path: "pack.matchStructure.kind", code: "enum", message: "Unsupported structure kind" });
    if (!positiveInteger(match.regulationSegments))
      issues.push({
        path: "pack.matchStructure.regulationSegments",
        code: "type",
        message: "Expected a positive integer",
      });
    for (const key of ["segmentDurationMinutes", "decidingSegmentDurationMinutes", "winBy", "overtimeDurationMinutes"])
      if (match[key] !== undefined && !positiveInteger(match[key]))
        issues.push({ path: `pack.matchStructure.${key}`, code: "type", message: "Expected a positive integer" });
    if (match.pointCap !== undefined && match.pointCap !== null && !positiveInteger(match.pointCap))
      issues.push({
        path: "pack.matchStructure.pointCap",
        code: "type",
        message: "Expected a positive integer or null",
      });
    if (match.successiveOvertime !== undefined && typeof match.successiveOvertime !== "boolean")
      issues.push({ path: "pack.matchStructure.successiveOvertime", code: "type", message: "Expected a boolean" });
    if (
      match.targetPoints !== undefined &&
      (!Array.isArray(match.targetPoints) || match.targetPoints.some((point) => !positiveInteger(point)))
    )
      issues.push({
        path: "pack.matchStructure.targetPoints",
        code: "type",
        message: "Expected positive integer targets",
      });
    if (match.kind === "best_of_segments") {
      if (!Array.isArray(match.targetPoints) || match.targetPoints.length !== match.regulationSegments)
        issues.push({
          path: "pack.matchStructure.targetPoints",
          code: "segment_count",
          message: "Targets must match the segment count",
        });
      if (!positiveInteger(match.winBy))
        issues.push({ path: "pack.matchStructure.winBy", code: "required", message: "Best-of scoring requires winBy" });
      if (!("pointCap" in match))
        issues.push({
          path: "pack.matchStructure.pointCap",
          code: "required",
          message: "Best-of scoring requires an explicit cap or null",
        });
    }
  }

  const score = value.scoreStructure;
  if (isRecord(score)) {
    strictShape(
      score,
      ["hierarchy", "primaryUnit", "allowedIncrements", "aggregate", "drawAllowed"],
      [],
      "pack.scoreStructure",
      issues,
    );
    if (
      !Array.isArray(score.hierarchy) ||
      score.hierarchy.length === 0 ||
      score.hierarchy.some((item) => !nonEmptyString(item)) ||
      !unique(score.hierarchy as string[])
    )
      issues.push({
        path: "pack.scoreStructure.hierarchy",
        code: "type",
        message: "Expected unique non-empty hierarchy labels",
      });
    if (!nonEmptyString(score.primaryUnit))
      issues.push({ path: "pack.scoreStructure.primaryUnit", code: "type", message: "Expected non-empty text" });
    if (
      !Array.isArray(score.allowedIncrements) ||
      score.allowedIncrements.length === 0 ||
      score.allowedIncrements.some((item) => !positiveInteger(item)) ||
      new Set(score.allowedIncrements).size !== score.allowedIncrements.length
    )
      issues.push({
        path: "pack.scoreStructure.allowedIncrements",
        code: "type",
        message: "Expected unique positive integer increments",
      });
    if (score.aggregate !== "sum" && score.aggregate !== "segments_won")
      issues.push({ path: "pack.scoreStructure.aggregate", code: "enum", message: "Unsupported aggregate" });
    if (typeof score.drawAllowed !== "boolean")
      issues.push({ path: "pack.scoreStructure.drawAllowed", code: "type", message: "Expected a boolean" });
  }

  const events = value.eventTypes;
  if (Array.isArray(events)) {
    events.forEach((event, index) => {
      const path = `pack.eventTypes[${index}]`;
      if (!isRecord(event)) return;
      strictShape(
        event,
        ["id", "label", "scoreDelta", "requiresSide", "participantAttribution", "reversable"],
        [],
        path,
        issues,
      );
      if (!nonEmptyString(event.id))
        issues.push({ path: `${path}.id`, code: "type", message: "Expected non-empty text" });
      if (!nonEmptyString(event.label))
        issues.push({ path: `${path}.label`, code: "type", message: "Expected non-empty text" });
      if (!nonNegativeInteger(event.scoreDelta))
        issues.push({ path: `${path}.scoreDelta`, code: "type", message: "Expected a non-negative integer" });
      if (typeof event.requiresSide !== "boolean")
        issues.push({ path: `${path}.requiresSide`, code: "type", message: "Expected a boolean" });
      if (
        typeof event.participantAttribution !== "string" ||
        !["required", "optional", "none"].includes(event.participantAttribution)
      )
        issues.push({ path: `${path}.participantAttribution`, code: "enum", message: "Unsupported attribution" });
      if (typeof event.reversable !== "boolean")
        issues.push({ path: `${path}.reversable`, code: "type", message: "Expected a boolean" });
    });
  }

  const standings = value.standings;
  if (isRecord(standings)) {
    strictShape(
      standings,
      ["points", "defaultOrder", "availableCriteria", "unresolvedTie"],
      [],
      "pack.standings",
      issues,
    );
    if (standings.points !== null) {
      if (!isRecord(standings.points))
        issues.push({ path: "pack.standings.points", code: "type", message: "Expected points or null" });
      else {
        strictShape(standings.points, ["win", "draw", "loss"], [], "pack.standings.points", issues);
        for (const key of ["win", "draw", "loss"])
          if (!nonNegativeInteger(standings.points[key]))
            issues.push({
              path: `pack.standings.points.${key}`,
              code: "type",
              message: "Expected a non-negative integer",
            });
        if (
          Number(standings.points.win) < Number(standings.points.draw) ||
          Number(standings.points.draw) < Number(standings.points.loss)
        )
          issues.push({ path: "pack.standings.points", code: "orientation", message: "Expected win >= draw >= loss" });
      }
    }
    if (!Array.isArray(standings.defaultOrder) || standings.defaultOrder.some((item) => !nonEmptyString(item)))
      issues.push({ path: "pack.standings.defaultOrder", code: "type", message: "Expected string criteria" });
    if (standings.unresolvedTie !== "audited_manual_resolution")
      issues.push({
        path: "pack.standings.unresolvedTie",
        code: "enum",
        message: "Unsupported unresolved-tie behavior",
      });
    if (Array.isArray(standings.availableCriteria)) {
      standings.availableCriteria.forEach((criterion, index) => {
        const path = `pack.standings.availableCriteria[${index}]`;
        if (!isRecord(criterion)) {
          issues.push({ path, code: "type", message: "Expected a criterion object" });
          return;
        }
        strictShape(criterion, ["id", "label", "direction"], ["zeroDenominator"], path, issues);
        if (!nonEmptyString(criterion.id) || !nonEmptyString(criterion.label))
          issues.push({ path, code: "type", message: "Expected non-empty id and label" });
        if (typeof criterion.direction !== "string" || !["higher", "lower", "resolution"].includes(criterion.direction))
          issues.push({ path: `${path}.direction`, code: "enum", message: "Unsupported direction" });
        if (
          criterion.zeroDenominator !== undefined &&
          (typeof criterion.zeroDenominator !== "string" ||
            !["zero", "infinity_when_numerator_positive"].includes(criterion.zeroDenominator))
        )
          issues.push({
            path: `${path}.zeroDenominator`,
            code: "enum",
            message: "Unsupported zero-denominator behavior",
          });
      });
    } else issues.push({ path: "pack.standings.availableCriteria", code: "type", message: "Expected criteria" });
  }

  const forfeit = value.forfeit;
  if (isRecord(forfeit)) {
    strictShape(
      forfeit,
      ["winnerScore", "loserScore", "awardedSegments", "preserveCompletedPlay"],
      [],
      "pack.forfeit",
      issues,
    );
    if (![forfeit.winnerScore, forfeit.loserScore, forfeit.awardedSegments].every(nonNegativeInteger))
      issues.push({ path: "pack.forfeit", code: "type", message: "Expected non-negative integer scores" });
    if (Number(forfeit.winnerScore) <= Number(forfeit.loserScore))
      issues.push({
        path: "pack.forfeit",
        code: "orientation",
        message: "Forfeit winner score must exceed loser score",
      });
    if (!positiveInteger(forfeit.awardedSegments))
      issues.push({
        path: "pack.forfeit.awardedSegments",
        code: "range",
        message: "At least one segment must be awarded",
      });
    if (typeof forfeit.preserveCompletedPlay !== "boolean")
      issues.push({ path: "pack.forfeit.preserveCompletedPlay", code: "type", message: "Expected a boolean" });
  }

  if (Array.isArray(value.scorecard)) {
    value.scorecard.forEach((component, index) => {
      const path = `pack.scorecard[${index}]`;
      if (!isRecord(component)) return;
      strictShape(component, ["id", "required", "enabledByDefault"], [], path, issues);
      if (!nonEmptyString(component.id))
        issues.push({ path: `${path}.id`, code: "type", message: "Expected non-empty text" });
      if (typeof component.required !== "boolean")
        issues.push({ path: `${path}.required`, code: "type", message: "Expected a boolean" });
      if (typeof component.enabledByDefault !== "boolean")
        issues.push({ path: `${path}.enabledByDefault`, code: "type", message: "Expected a boolean" });
      if (component.required === true && component.enabledByDefault !== true)
        issues.push({ path, code: "required_disabled", message: "Required scorecard components must be enabled" });
    });
  }

  const settingKeys = new Set(isRecord(value.settingsSchema) ? Object.keys(value.settingsSchema) : []);
  if (isRecord(value.settingsSchema)) {
    if (settingKeys.size === 0)
      issues.push({ path: "pack.settingsSchema", code: "required", message: "At least one setting is required" });
    for (const [key, definition] of Object.entries(value.settingsSchema)) {
      if (!nonEmptyString(key))
        issues.push({ path: "pack.settingsSchema", code: "key", message: "Setting keys must be non-empty" });
      validateSettingDefinitionShape(definition, `pack.settingsSchema.${key}`, issues);
    }
  }

  if (Array.isArray(value.validationRules)) {
    value.validationRules.forEach((rule, index) => {
      const path = `pack.validationRules[${index}]`;
      if (!isRecord(rule)) return;
      strictShape(rule, ["id", "description", "severity"], ["settingsConstraint"], path, issues);
      if (!nonEmptyString(rule.id) || !nonEmptyString(rule.description))
        issues.push({ path, code: "type", message: "Expected non-empty id and description" });
      if (rule.severity !== "error" && rule.severity !== "cleanup")
        issues.push({ path: `${path}.severity`, code: "enum", message: "Unsupported severity" });
      if (rule.settingsConstraint !== undefined)
        validateConstraintShape(rule.settingsConstraint, settingKeys, `${path}.settingsConstraint`, issues);
    });
  }

  if (isRecord(match) && match.kind === "best_of_segments" && positiveInteger(match.regulationSegments)) {
    if (Number(match.regulationSegments) % 2 !== 1)
      issues.push({
        path: "pack.matchStructure.regulationSegments",
        code: "odd_best_of",
        message: "Best-of segment count must be odd",
      });
    if (Array.isArray(match.targetPoints) && positiveInteger(match.winBy)) {
      const targets = match.targetPoints.filter(positiveInteger).map(Number);
      if (targets.some((target) => Number(match.winBy) > target))
        issues.push({
          path: "pack.matchStructure.winBy",
          code: "target_consistency",
          message: "Win-by cannot exceed a target",
        });
      if (
        match.pointCap !== null &&
        match.pointCap !== undefined &&
        targets.some((target) => Number(match.pointCap) < target)
      )
        issues.push({
          path: "pack.matchStructure.pointCap",
          code: "cap_consistency",
          message: "Point cap cannot be below a target",
        });
    }
  }
  if (isRecord(match) && match.successiveOvertime === true && !positiveInteger(match.overtimeDurationMinutes))
    issues.push({
      path: "pack.matchStructure.overtimeDurationMinutes",
      code: "overtime_consistency",
      message: "Successive overtime requires a duration",
    });
  if (
    isRecord(score) &&
    Array.isArray(score.hierarchy) &&
    nonEmptyString(score.primaryUnit) &&
    score.hierarchy.at(-1) !== score.primaryUnit
  )
    issues.push({
      path: "pack.scoreStructure.primaryUnit",
      code: "hierarchy_consistency",
      message: "Primary unit must be the lowest score hierarchy level",
    });
  if (isRecord(score) && Array.isArray(score.allowedIncrements) && Array.isArray(events)) {
    for (const [index, candidate] of events.entries()) {
      if (
        isRecord(candidate) &&
        typeof candidate.scoreDelta === "number" &&
        candidate.scoreDelta > 0 &&
        !score.allowedIncrements.includes(candidate.scoreDelta)
      )
        issues.push({
          path: `pack.eventTypes[${index}].scoreDelta`,
          code: "increment_consistency",
          message: "Scoring event delta must be an allowed increment",
        });
    }
  }
  if (
    isRecord(match) &&
    isRecord(forfeit) &&
    positiveInteger(match.regulationSegments) &&
    positiveInteger(forfeit.awardedSegments) &&
    Number(forfeit.awardedSegments) > Number(match.regulationSegments)
  )
    issues.push({
      path: "pack.forfeit.awardedSegments",
      code: "segment_count",
      message: "Forfeit cannot award more segments than the match contains",
    });
}

export function validateSportPack(value: unknown): readonly ValidationIssue[] {
  if (!isRecord(value)) return [{ path: "pack", code: "type", message: "Expected an object" }];
  const issues: ValidationIssue[] = [];
  strictKeys(value, topLevelKeys, "pack", issues);
  validateNestedPackContract(value, issues);
  if (value.schemaVersion !== SPORT_PACK_SCHEMA_VERSION)
    issues.push({ path: "pack.schemaVersion", code: "schema_version", message: "Unsupported schema version" });
  if (
    typeof value.sportId !== "string" ||
    !["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"].includes(value.sportId)
  )
    issues.push({ path: "pack.sportId", code: "sport_id", message: "Unsupported sport" });
  if (typeof value.version !== "string" || !semverPattern.test(value.version))
    issues.push({ path: "pack.version", code: "semver", message: "Expected semantic version" });
  if (value.status !== "provisional_product_baseline")
    issues.push({ path: "pack.status", code: "status", message: "Pack must retain provisional status" });
  if (value.authority !== "product_recommendation_not_federation_profile")
    issues.push({ path: "pack.authority", code: "authority", message: "Pack must not imply federation authority" });
  if (typeof value.displayName !== "string" || value.displayName.trim() === "")
    issues.push({ path: "pack.displayName", code: "required", message: "Display name is required" });

  if (!isRecord(value.terminology))
    issues.push({ path: "pack.terminology", code: "type", message: "Expected an object" });
  else {
    const keys = [
      "entrySingular",
      "entryPlural",
      "participantSingular",
      "participantPlural",
      "playingArea",
      "match",
      "segment",
      "scoringUnit",
    ];
    strictKeys(value.terminology, keys, "pack.terminology", issues);
    for (const key of keys)
      if (typeof value.terminology[key] !== "string" || value.terminology[key] === "")
        issues.push({ path: `pack.terminology.${key}`, code: "type", message: "Expected non-empty text" });
  }
  if (
    !Array.isArray(value.entryTypes) ||
    value.entryTypes.length === 0 ||
    !unique(value.entryTypes as string[]) ||
    value.entryTypes.some((entry) => typeof entry !== "string" || !["team", "singles", "doubles"].includes(entry))
  )
    issues.push({ path: "pack.entryTypes", code: "entry_types", message: "Expected unique supported entry types" });

  if (!isRecord(value.matchStructure))
    issues.push({ path: "pack.matchStructure", code: "type", message: "Expected an object" });
  else {
    const allowed = [
      "kind",
      "regulationSegments",
      "segmentDurationMinutes",
      "decidingSegmentDurationMinutes",
      "targetPoints",
      "winBy",
      "pointCap",
      "overtimeDurationMinutes",
      "successiveOvertime",
    ];
    for (const key of Object.keys(value.matchStructure))
      if (!allowed.includes(key))
        issues.push({ path: `pack.matchStructure.${key}`, code: "unknown_key", message: "Unknown property" });
    if (
      typeof value.matchStructure.kind !== "string" ||
      !["timed_periods", "best_of_segments"].includes(value.matchStructure.kind)
    )
      issues.push({ path: "pack.matchStructure.kind", code: "enum", message: "Unsupported structure kind" });
    if (
      !Number.isInteger(value.matchStructure.regulationSegments) ||
      Number(value.matchStructure.regulationSegments) < 1
    )
      issues.push({
        path: "pack.matchStructure.regulationSegments",
        code: "range",
        message: "Expected a positive integer",
      });
  }

  if (!isRecord(value.scoreStructure))
    issues.push({ path: "pack.scoreStructure", code: "type", message: "Expected an object" });
  else {
    strictKeys(
      value.scoreStructure,
      ["hierarchy", "primaryUnit", "allowedIncrements", "aggregate", "drawAllowed"],
      "pack.scoreStructure",
      issues,
    );
    if (
      !Array.isArray(value.scoreStructure.hierarchy) ||
      value.scoreStructure.hierarchy.length === 0 ||
      !unique(value.scoreStructure.hierarchy as string[])
    )
      issues.push({
        path: "pack.scoreStructure.hierarchy",
        code: "hierarchy",
        message: "Expected a unique score hierarchy",
      });
    if (
      !Array.isArray(value.scoreStructure.allowedIncrements) ||
      value.scoreStructure.allowedIncrements.length === 0 ||
      value.scoreStructure.allowedIncrements.some((n) => typeof n !== "number" || n <= 0)
    )
      issues.push({
        path: "pack.scoreStructure.allowedIncrements",
        code: "increments",
        message: "Expected positive score increments",
      });
  }

  if (!Array.isArray(value.eventTypes) || value.eventTypes.length === 0)
    issues.push({ path: "pack.eventTypes", code: "type", message: "Expected event definitions" });
  else {
    const ids = value.eventTypes
      .filter(isRecord)
      .map((event) => event.id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length !== value.eventTypes.length || !unique(ids))
      issues.push({ path: "pack.eventTypes", code: "event_ids", message: "Event ids must be unique objects" });
    value.eventTypes.forEach((event, index) => {
      if (!isRecord(event)) return;
      strictKeys(
        event,
        ["id", "label", "scoreDelta", "requiresSide", "participantAttribution", "reversable"],
        `pack.eventTypes[${index}]`,
        issues,
      );
    });
  }

  if (!isRecord(value.standings)) issues.push({ path: "pack.standings", code: "type", message: "Expected an object" });
  else {
    strictKeys(
      value.standings,
      ["points", "defaultOrder", "availableCriteria", "unresolvedTie"],
      "pack.standings",
      issues,
    );
    const criteria = Array.isArray(value.standings.availableCriteria)
      ? value.standings.availableCriteria
          .filter(isRecord)
          .map((criterion) => criterion.id)
          .filter((id): id is string => typeof id === "string")
      : [];
    const order = Array.isArray(value.standings.defaultOrder)
      ? value.standings.defaultOrder.filter((id): id is string => typeof id === "string")
      : [];
    if (criteria.length === 0 || !unique(criteria))
      issues.push({
        path: "pack.standings.availableCriteria",
        code: "criteria",
        message: "Criteria ids must be unique",
      });
    if (order.length === 0 || !unique(order) || order.some((id) => !criteria.includes(id)))
      issues.push({
        path: "pack.standings.defaultOrder",
        code: "criteria_order",
        message: "Default order must be a unique subset of criteria",
      });
  }

  if (!isRecord(value.forfeit)) issues.push({ path: "pack.forfeit", code: "type", message: "Expected an object" });
  else {
    strictKeys(
      value.forfeit,
      ["winnerScore", "loserScore", "awardedSegments", "preserveCompletedPlay"],
      "pack.forfeit",
      issues,
    );
    if (
      ![value.forfeit.winnerScore, value.forfeit.loserScore, value.forfeit.awardedSegments].every(
        (n) => Number.isInteger(n) && Number(n) >= 0,
      )
    )
      issues.push({ path: "pack.forfeit", code: "score", message: "Forfeit scores must be non-negative integers" });
  }

  for (const [field, idCode] of [
    ["scorecard", "scorecard_ids"],
    ["validationRules", "validation_rule_ids"],
  ] as const) {
    const list = value[field];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.some((item) => !isRecord(item)) ||
      !unique(
        list.map((item) => (item as Record<string, unknown>).id).filter((id): id is string => typeof id === "string"),
      ) ||
      list.some((item) => typeof (item as Record<string, unknown>).id !== "string")
    )
      issues.push({ path: `pack.${field}`, code: idCode, message: "Expected unique definitions" });
  }
  if (
    !Number.isInteger(value.recommendedSlotMinutes) ||
    Number(value.recommendedSlotMinutes) < 5 ||
    Number(value.recommendedSlotMinutes) > 480
  )
    issues.push({ path: "pack.recommendedSlotMinutes", code: "range", message: "Expected 5–480 minutes" });
  if (!isRecord(value.settingsSchema))
    issues.push({ path: "pack.settingsSchema", code: "type", message: "Expected an object" });
  if (!isRecord(value.recommendedSettings))
    issues.push({ path: "pack.recommendedSettings", code: "type", message: "Expected an object" });
  if (
    isRecord(value.settingsSchema) &&
    Object.values(value.settingsSchema).every(isSettingDefinition) &&
    Array.isArray(value.validationRules) &&
    value.validationRules.every(isRecord) &&
    isRecord(value.recommendedSettings)
  ) {
    issues.push(...validateSportSettings(value as unknown as SportPack, value.recommendedSettings));
    if (value.recommendedSettings.slotMinutes !== value.recommendedSlotMinutes)
      issues.push({
        path: "pack.recommendedSettings.slotMinutes",
        code: "slot_mismatch",
        message: "Recommended slot must match pack metadata",
      });
    const settings = value.recommendedSettings;
    const match = value.matchStructure;
    const forfeit = value.forfeit;
    if (isRecord(match)) {
      const segmentSetting = value.sportId === "basketball" || value.sportId === "canoe_polo" ? "periods" : "bestOf";
      if (settings[segmentSetting] !== match.regulationSegments)
        issues.push({
          path: `pack.recommendedSettings.${segmentSetting}`,
          code: "structure_mismatch",
          message: "Recommended segment count must match the pack structure",
        });
      if (settings.winBy !== undefined && settings.winBy !== match.winBy)
        issues.push({
          path: "pack.recommendedSettings.winBy",
          code: "structure_mismatch",
          message: "Recommended winBy must match the pack structure",
        });
      if (settings.pointCap !== undefined && settings.pointCap !== match.pointCap)
        issues.push({
          path: "pack.recommendedSettings.pointCap",
          code: "structure_mismatch",
          message: "Recommended cap must match the pack structure",
        });
      if (
        settings.regularTargetPoints !== undefined &&
        Array.isArray(match.targetPoints) &&
        settings.regularTargetPoints !== match.targetPoints[0]
      )
        issues.push({
          path: "pack.recommendedSettings.regularTargetPoints",
          code: "structure_mismatch",
          message: "Recommended target must match the pack structure",
        });
      if (
        settings.decidingTargetPoints !== undefined &&
        Array.isArray(match.targetPoints) &&
        settings.decidingTargetPoints !== match.targetPoints.at(-1)
      )
        issues.push({
          path: "pack.recommendedSettings.decidingTargetPoints",
          code: "structure_mismatch",
          message: "Recommended deciding target must match the pack structure",
        });
      if (
        settings.periodDurationMinutes !== undefined &&
        settings.periodDurationMinutes !== match.segmentDurationMinutes
      )
        issues.push({
          path: "pack.recommendedSettings.periodDurationMinutes",
          code: "structure_mismatch",
          message: "Recommended period duration must match the pack structure",
        });
      if (
        settings.overtimeDurationMinutes !== undefined &&
        settings.overtimeDurationMinutes !== match.overtimeDurationMinutes
      )
        issues.push({
          path: "pack.recommendedSettings.overtimeDurationMinutes",
          code: "structure_mismatch",
          message: "Recommended overtime must match the pack structure",
        });
    }
    if (isRecord(forfeit)) {
      if (settings.forfeitWinnerScore !== forfeit.winnerScore || settings.forfeitLoserScore !== forfeit.loserScore)
        issues.push({
          path: "pack.recommendedSettings",
          code: "forfeit_mismatch",
          message: "Recommended forfeit scores must match pack metadata",
        });
    }
  }
  return issues;
}

export function assertValidSportPack(value: unknown): asserts value is SportPack {
  const issues = validateSportPack(value);
  if (issues.length > 0) throw new SportPackValidationError("Invalid sport pack", issues);
}

const event = (
  id: string,
  label: string,
  scoreDelta = 0,
  participantAttribution: MatchEventDefinition["participantAttribution"] = "none",
  requiresSide = false,
): MatchEventDefinition => ({ id, label, scoreDelta, requiresSide, participantAttribution, reversable: true });

const criterion = (
  id: string,
  label: string,
  direction: StandingsCriterionDefinition["direction"] = "higher",
  zeroDenominator?: StandingsCriterionDefinition["zeroDenominator"],
): StandingsCriterionDefinition => ({ id, label, direction, ...(zeroDenominator ? { zeroDenominator } : {}) });

const integer = (label: string, minimum: number, maximum: number, nullable = false): SettingDefinition => ({
  type: "integer",
  label,
  minimum,
  maximum,
  ...(nullable ? { nullable: true } : {}),
});
const bool = (label: string): SettingDefinition => ({ type: "boolean", label });
const ordered = (label: string, values: readonly string[]): SettingDefinition => ({
  type: "ordered_enum",
  label,
  values,
  minimumItems: 1,
});

function definePack(pack: SportPack): SportPack {
  assertValidSportPack(pack);
  return frozenClone(pack);
}

const sharedFinalEvents = [event("reversal", "Reversal"), event("finalisation", "Finalisation")];

export const CANOE_POLO_SPORT_PACK = definePack({
  schemaVersion: 1,
  sportId: "canoe_polo",
  version: DRAFT_SPORT_PACK_VERSION,
  status: "provisional_product_baseline",
  authority: "product_recommendation_not_federation_profile",
  displayName: "Canoe Polo",
  terminology: {
    entrySingular: "team",
    entryPlural: "teams",
    participantSingular: "player",
    participantPlural: "players",
    playingArea: "pitch",
    match: "match",
    segment: "period",
    scoringUnit: "goal",
  },
  entryTypes: ["team"],
  matchStructure: { kind: "timed_periods", regulationSegments: 2 },
  scoreStructure: {
    hierarchy: ["match", "goal"],
    primaryUnit: "goal",
    allowedIncrements: [1],
    aggregate: "sum",
    drawAllowed: true,
  },
  eventTypes: [
    event("goal", "Goal", 1, "required", true),
    event("green_card", "Green card", 0, "required", true),
    event("yellow_card", "Yellow card", 0, "required", true),
    event("red_card", "Red card", 0, "required", true),
    event("timeout", "Timeout", 0, "none", true),
    event("incident", "Incident"),
    event("period_change", "Period change"),
    ...sharedFinalEvents,
  ],
  standings: {
    points: { win: 3, draw: 1, loss: 0 },
    defaultOrder: ["points", "goal_difference", "goals_for", "head_to_head", "discipline"],
    availableCriteria: [
      criterion("points", "Points"),
      criterion("goal_difference", "Goal difference"),
      criterion("goals_for", "Goals scored"),
      criterion("head_to_head", "Head-to-head", "resolution"),
      criterion("discipline", "Discipline", "lower"),
      criterion("seed", "Seed", "lower"),
    ],
    unresolvedTie: "audited_manual_resolution",
  },
  forfeit: { winnerScore: 3, loserScore: 0, awardedSegments: 1, preserveCompletedPlay: true },
  scorecard: [
    { id: "period_selector", required: true, enabledByDefault: true },
    { id: "manual_event_time", required: false, enabledByDefault: true },
    { id: "scorer_attribution", required: true, enabledByDefault: true },
    { id: "cards", required: false, enabledByDefault: true },
    { id: "timeouts", required: false, enabledByDefault: true },
    { id: "incidents", required: false, enabledByDefault: true },
  ],
  validationRules: [
    {
      id: "scorer_required",
      description: "Scorer attribution remains required; the unknown-scorer toggle supplies an explicit placeholder.",
      severity: "error",
      settingsConstraint: { kind: "equals", field: "scorerRequired", value: true },
    },
    {
      id: "unknown_scorer_cleanup",
      description: "Unknown scorers create a post-event cleanup flag.",
      severity: "cleanup",
    },
    {
      id: "no_live_clock",
      description: "The MVP records manual event time and does not run a live clock.",
      severity: "error",
    },
    {
      id: "unknown_scorer_requires_attribution",
      description: "Unknown scorer can only be enabled while scorer attribution is required.",
      severity: "error",
      settingsConstraint: { kind: "requires_true", whenField: "allowUnknownScorer", requiredField: "scorerRequired" },
    },
    {
      id: "forfeit_score_orientation",
      description: "The forfeit winner score must exceed the loser score.",
      severity: "error",
      settingsConstraint: {
        kind: "greater_than",
        greaterField: "forfeitWinnerScore",
        lesserField: "forfeitLoserScore",
      },
    },
  ],
  recommendedSlotMinutes: 30,
  settingsSchema: {
    periods: integer("Periods", 1, 8),
    slotMinutes: integer("Match slot", 5, 480),
    manualEventTime: bool("Manual event time"),
    scorerRequired: bool("Require scorer"),
    allowUnknownScorer: bool("Allow unknown scorer"),
    cardsEnabled: bool("Cards"),
    timeoutsEnabled: bool("Timeouts"),
    incidentsEnabled: bool("Incidents"),
    winPoints: integer("Win points", 0, 20),
    drawPoints: integer("Draw points", 0, 20),
    lossPoints: integer("Loss points", 0, 20),
    forfeitWinnerScore: integer("Forfeit winner score", 0, 100),
    forfeitLoserScore: integer("Forfeit loser score", 0, 100),
    standingsOrder: ordered("Standings order", [
      "points",
      "goal_difference",
      "goals_for",
      "head_to_head",
      "discipline",
      "seed",
    ]),
  },
  recommendedSettings: {
    periods: 2,
    slotMinutes: 30,
    manualEventTime: true,
    scorerRequired: true,
    allowUnknownScorer: false,
    cardsEnabled: true,
    timeoutsEnabled: true,
    incidentsEnabled: true,
    winPoints: 3,
    drawPoints: 1,
    lossPoints: 0,
    forfeitWinnerScore: 3,
    forfeitLoserScore: 0,
    standingsOrder: ["points", "goal_difference", "goals_for", "head_to_head", "discipline"],
  },
});

export const BADMINTON_SPORT_PACK = definePack({
  schemaVersion: 1,
  sportId: "badminton",
  version: DRAFT_SPORT_PACK_VERSION,
  status: "provisional_product_baseline",
  authority: "product_recommendation_not_federation_profile",
  displayName: "Badminton",
  terminology: {
    entrySingular: "player or pair",
    entryPlural: "players or pairs",
    participantSingular: "player",
    participantPlural: "players",
    playingArea: "court",
    match: "match",
    segment: "game",
    scoringUnit: "point",
  },
  entryTypes: ["singles", "doubles"],
  matchStructure: {
    kind: "best_of_segments",
    regulationSegments: 3,
    targetPoints: [21, 21, 21],
    winBy: 2,
    pointCap: 30,
  },
  scoreStructure: {
    hierarchy: ["match", "game", "point"],
    primaryUnit: "point",
    allowedIncrements: [1],
    aggregate: "segments_won",
    drawAllowed: false,
  },
  eventTypes: [
    event("point", "Point", 1, "optional", true),
    event("game_completion", "Game completion"),
    event("server_change", "Server change", 0, "optional", true),
    event("retirement", "Retirement", 0, "none", true),
    event("walkover", "Walkover", 0, "none", true),
    ...sharedFinalEvents,
  ],
  standings: {
    points: null,
    defaultOrder: ["match_wins", "game_difference", "point_difference", "head_to_head"],
    availableCriteria: [
      criterion("match_wins", "Match wins"),
      criterion("game_difference", "Game difference"),
      criterion("point_difference", "Point difference"),
      criterion("head_to_head", "Head-to-head", "resolution"),
      criterion("seed", "Seed", "lower"),
    ],
    unresolvedTie: "audited_manual_resolution",
  },
  forfeit: { winnerScore: 21, loserScore: 0, awardedSegments: 2, preserveCompletedPlay: true },
  scorecard: [
    { id: "game_score", required: true, enabledByDefault: true },
    { id: "server_indicator", required: false, enabledByDefault: false },
    { id: "retirement", required: false, enabledByDefault: true },
    { id: "walkover", required: false, enabledByDefault: true },
  ],
  validationRules: [
    {
      id: "win_by_two_with_cap",
      description: "A game is won by two points, capped at the configured point cap.",
      severity: "error",
    },
    {
      id: "retirement_preserves_score",
      description: "Retirement preserves completed and current game scores.",
      severity: "error",
    },
    {
      id: "best_of_is_odd",
      description: "Best-of game count must be a positive odd number.",
      severity: "error",
      settingsConstraint: { kind: "odd_integer", field: "bestOf" },
    },
    {
      id: "win_by_within_target",
      description: "Win-by must not exceed the game target.",
      severity: "error",
      settingsConstraint: { kind: "less_than_or_equal", lesserField: "winBy", greaterField: "regularTargetPoints" },
    },
    {
      id: "cap_reaches_target",
      description: "A point cap must be at least the game target.",
      severity: "error",
      settingsConstraint: { kind: "nullable_at_least", field: "pointCap", minimumField: "regularTargetPoints" },
    },
    {
      id: "forfeit_score_orientation",
      description: "The forfeit winner score must exceed the loser score.",
      severity: "error",
      settingsConstraint: {
        kind: "greater_than",
        greaterField: "forfeitWinnerScore",
        lesserField: "forfeitLoserScore",
      },
    },
  ],
  recommendedSlotMinutes: 20,
  settingsSchema: {
    bestOf: integer("Best of games", 1, 9),
    regularTargetPoints: integer("Points per game", 1, 99),
    winBy: integer("Win by", 1, 20),
    pointCap: integer("Point cap", 1, 200, true),
    slotMinutes: integer("Match slot", 5, 480),
    serverIndicatorEnabled: bool("Server indicator"),
    forfeitWinnerScore: integer("Forfeit winner score", 0, 200),
    forfeitLoserScore: integer("Forfeit loser score", 0, 200),
    standingsOrder: ordered("Standings order", [
      "match_wins",
      "game_difference",
      "point_difference",
      "head_to_head",
      "seed",
    ]),
  },
  recommendedSettings: {
    bestOf: 3,
    regularTargetPoints: 21,
    winBy: 2,
    pointCap: 30,
    slotMinutes: 20,
    serverIndicatorEnabled: false,
    forfeitWinnerScore: 21,
    forfeitLoserScore: 0,
    standingsOrder: ["match_wins", "game_difference", "point_difference", "head_to_head"],
  },
});

export const TABLE_TENNIS_SPORT_PACK = definePack({
  schemaVersion: 1,
  sportId: "table_tennis",
  version: DRAFT_SPORT_PACK_VERSION,
  status: "provisional_product_baseline",
  authority: "product_recommendation_not_federation_profile",
  displayName: "Table Tennis",
  terminology: {
    entrySingular: "player or pair",
    entryPlural: "players or pairs",
    participantSingular: "player",
    participantPlural: "players",
    playingArea: "table",
    match: "match",
    segment: "game",
    scoringUnit: "point",
  },
  entryTypes: ["singles", "doubles"],
  matchStructure: {
    kind: "best_of_segments",
    regulationSegments: 5,
    targetPoints: [11, 11, 11, 11, 11],
    winBy: 2,
    pointCap: null,
  },
  scoreStructure: {
    hierarchy: ["match", "game", "point"],
    primaryUnit: "point",
    allowedIncrements: [1],
    aggregate: "segments_won",
    drawAllowed: false,
  },
  eventTypes: [
    event("point", "Point", 1, "optional", true),
    event("game_completion", "Game completion"),
    event("timeout", "Timeout", 0, "none", true),
    event("server_change", "Server change", 0, "optional", true),
    event("retirement", "Retirement", 0, "none", true),
    event("walkover", "Walkover", 0, "none", true),
    ...sharedFinalEvents,
  ],
  standings: {
    points: null,
    defaultOrder: ["match_wins", "game_difference", "point_difference", "head_to_head"],
    availableCriteria: [
      criterion("match_wins", "Match wins"),
      criterion("game_difference", "Game difference"),
      criterion("point_difference", "Point difference"),
      criterion("head_to_head", "Head-to-head", "resolution"),
      criterion("seed", "Seed", "lower"),
    ],
    unresolvedTie: "audited_manual_resolution",
  },
  forfeit: { winnerScore: 11, loserScore: 0, awardedSegments: 3, preserveCompletedPlay: true },
  scorecard: [
    { id: "game_score", required: true, enabledByDefault: true },
    { id: "server_indicator", required: false, enabledByDefault: false },
    { id: "timeouts", required: false, enabledByDefault: true },
    { id: "retirement", required: false, enabledByDefault: true },
    { id: "walkover", required: false, enabledByDefault: true },
  ],
  validationRules: [
    { id: "win_by_two", description: "A game is won by two points without a default cap.", severity: "error" },
    {
      id: "retirement_preserves_score",
      description: "Retirement preserves completed and current game scores.",
      severity: "error",
    },
    {
      id: "best_of_is_odd",
      description: "Best-of game count must be a positive odd number.",
      severity: "error",
      settingsConstraint: { kind: "odd_integer", field: "bestOf" },
    },
    {
      id: "win_by_within_target",
      description: "Win-by must not exceed the game target.",
      severity: "error",
      settingsConstraint: { kind: "less_than_or_equal", lesserField: "winBy", greaterField: "regularTargetPoints" },
    },
    {
      id: "cap_reaches_target",
      description: "A point cap must be null or at least the game target.",
      severity: "error",
      settingsConstraint: { kind: "nullable_at_least", field: "pointCap", minimumField: "regularTargetPoints" },
    },
    {
      id: "forfeit_score_orientation",
      description: "The forfeit winner score must exceed the loser score.",
      severity: "error",
      settingsConstraint: {
        kind: "greater_than",
        greaterField: "forfeitWinnerScore",
        lesserField: "forfeitLoserScore",
      },
    },
  ],
  recommendedSlotMinutes: 15,
  settingsSchema: {
    bestOf: integer("Best of games", 1, 11),
    regularTargetPoints: integer("Points per game", 1, 99),
    winBy: integer("Win by", 1, 20),
    pointCap: integer("Point cap", 1, 200, true),
    slotMinutes: integer("Match slot", 5, 480),
    serverIndicatorEnabled: bool("Server indicator"),
    forfeitWinnerScore: integer("Forfeit winner score", 0, 200),
    forfeitLoserScore: integer("Forfeit loser score", 0, 200),
    standingsOrder: ordered("Standings order", [
      "match_wins",
      "game_difference",
      "point_difference",
      "head_to_head",
      "seed",
    ]),
  },
  recommendedSettings: {
    bestOf: 5,
    regularTargetPoints: 11,
    winBy: 2,
    pointCap: null,
    slotMinutes: 15,
    serverIndicatorEnabled: false,
    forfeitWinnerScore: 11,
    forfeitLoserScore: 0,
    standingsOrder: ["match_wins", "game_difference", "point_difference", "head_to_head"],
  },
});

export const VOLLEYBALL_SPORT_PACK = definePack({
  schemaVersion: 1,
  sportId: "volleyball",
  version: DRAFT_SPORT_PACK_VERSION,
  status: "provisional_product_baseline",
  authority: "product_recommendation_not_federation_profile",
  displayName: "Volleyball",
  terminology: {
    entrySingular: "team",
    entryPlural: "teams",
    participantSingular: "player",
    participantPlural: "players",
    playingArea: "court",
    match: "match",
    segment: "set",
    scoringUnit: "point",
  },
  entryTypes: ["team"],
  matchStructure: {
    kind: "best_of_segments",
    regulationSegments: 3,
    targetPoints: [25, 25, 15],
    winBy: 2,
    pointCap: null,
  },
  scoreStructure: {
    hierarchy: ["match", "set", "point"],
    primaryUnit: "point",
    allowedIncrements: [1],
    aggregate: "segments_won",
    drawAllowed: false,
  },
  eventTypes: [
    event("point", "Point", 1, "none", true),
    event("set_completion", "Set completion"),
    event("timeout", "Timeout", 0, "none", true),
    event("deciding_set", "Deciding set"),
    ...sharedFinalEvents,
  ],
  standings: {
    points: null,
    defaultOrder: ["match_wins", "set_ratio", "point_ratio", "head_to_head"],
    availableCriteria: [
      criterion("match_wins", "Match wins"),
      criterion("set_ratio", "Set ratio", "higher", "infinity_when_numerator_positive"),
      criterion("point_ratio", "Point ratio", "higher", "infinity_when_numerator_positive"),
      criterion("head_to_head", "Head-to-head", "resolution"),
      criterion("seed", "Seed", "lower"),
    ],
    unresolvedTie: "audited_manual_resolution",
  },
  forfeit: { winnerScore: 25, loserScore: 0, awardedSegments: 2, preserveCompletedPlay: true },
  scorecard: [
    { id: "set_score", required: true, enabledByDefault: true },
    { id: "deciding_set", required: true, enabledByDefault: true },
    { id: "timeouts", required: false, enabledByDefault: true },
  ],
  validationRules: [
    {
      id: "set_targets",
      description: "Regular and deciding sets use their configured target scores.",
      severity: "error",
    },
    {
      id: "ratio_zero_denominator",
      description: "A positive numerator over zero is ranked as infinity; 0/0 is zero.",
      severity: "error",
    },
    {
      id: "best_of_is_odd",
      description: "Best-of set count must be a positive odd number.",
      severity: "error",
      settingsConstraint: { kind: "odd_integer", field: "bestOf" },
    },
    {
      id: "deciding_target_not_higher",
      description: "The deciding-set target must not exceed the regular-set target.",
      severity: "error",
      settingsConstraint: {
        kind: "less_than_or_equal",
        lesserField: "decidingTargetPoints",
        greaterField: "regularTargetPoints",
      },
    },
    {
      id: "win_by_within_deciding_target",
      description: "Win-by must not exceed the deciding-set target.",
      severity: "error",
      settingsConstraint: { kind: "less_than_or_equal", lesserField: "winBy", greaterField: "decidingTargetPoints" },
    },
    {
      id: "cap_reaches_regular_target",
      description: "A point cap must be null or at least the regular-set target.",
      severity: "error",
      settingsConstraint: { kind: "nullable_at_least", field: "pointCap", minimumField: "regularTargetPoints" },
    },
    {
      id: "forfeit_score_orientation",
      description: "The forfeit winner score must exceed the loser score.",
      severity: "error",
      settingsConstraint: {
        kind: "greater_than",
        greaterField: "forfeitWinnerScore",
        lesserField: "forfeitLoserScore",
      },
    },
  ],
  recommendedSlotMinutes: 45,
  settingsSchema: {
    bestOf: integer("Best of sets", 1, 9),
    regularTargetPoints: integer("Regular set target", 1, 99),
    decidingTargetPoints: integer("Deciding set target", 1, 99),
    winBy: integer("Win by", 1, 20),
    pointCap: integer("Point cap", 1, 200, true),
    slotMinutes: integer("Match slot", 5, 480),
    forfeitWinnerScore: integer("Forfeit winner score", 0, 200),
    forfeitLoserScore: integer("Forfeit loser score", 0, 200),
    standingsOrder: ordered("Standings order", ["match_wins", "set_ratio", "point_ratio", "head_to_head", "seed"]),
  },
  recommendedSettings: {
    bestOf: 3,
    regularTargetPoints: 25,
    decidingTargetPoints: 15,
    winBy: 2,
    pointCap: null,
    slotMinutes: 45,
    forfeitWinnerScore: 25,
    forfeitLoserScore: 0,
    standingsOrder: ["match_wins", "set_ratio", "point_ratio", "head_to_head"],
  },
});

export const BASKETBALL_SPORT_PACK = definePack({
  schemaVersion: 1,
  sportId: "basketball",
  version: DRAFT_SPORT_PACK_VERSION,
  status: "provisional_product_baseline",
  authority: "product_recommendation_not_federation_profile",
  displayName: "Basketball",
  terminology: {
    entrySingular: "team",
    entryPlural: "teams",
    participantSingular: "player",
    participantPlural: "players",
    playingArea: "court",
    match: "match",
    segment: "period",
    scoringUnit: "point",
  },
  entryTypes: ["team"],
  matchStructure: {
    kind: "timed_periods",
    regulationSegments: 4,
    segmentDurationMinutes: 10,
    overtimeDurationMinutes: 5,
    successiveOvertime: true,
  },
  scoreStructure: {
    hierarchy: ["match", "period", "point"],
    primaryUnit: "point",
    allowedIncrements: [1, 2, 3],
    aggregate: "sum",
    drawAllowed: false,
  },
  eventTypes: [
    event("one_point_score", "One-point score", 1, "optional", true),
    event("two_point_score", "Two-point score", 2, "optional", true),
    event("three_point_score", "Three-point score", 3, "optional", true),
    event("team_foul", "Team foul", 0, "none", true),
    event("player_foul", "Player foul", 0, "required", true),
    event("timeout", "Timeout", 0, "none", true),
    event("period_change", "Period change"),
    event("overtime", "Overtime"),
    ...sharedFinalEvents,
  ],
  standings: {
    points: null,
    defaultOrder: ["wins", "head_to_head", "point_difference", "points_for"],
    availableCriteria: [
      criterion("wins", "Wins"),
      criterion("head_to_head", "Head-to-head", "resolution"),
      criterion("point_difference", "Point difference"),
      criterion("points_for", "Points scored"),
      criterion("seed", "Seed", "lower"),
    ],
    unresolvedTie: "audited_manual_resolution",
  },
  forfeit: { winnerScore: 20, loserScore: 0, awardedSegments: 1, preserveCompletedPlay: true },
  scorecard: [
    { id: "period_selector", required: true, enabledByDefault: true },
    { id: "manual_event_time", required: false, enabledByDefault: true },
    { id: "score_buttons", required: true, enabledByDefault: true },
    { id: "team_fouls", required: false, enabledByDefault: true },
    { id: "player_fouls", required: false, enabledByDefault: true },
    { id: "timeouts", required: false, enabledByDefault: true },
    { id: "overtime", required: true, enabledByDefault: true },
  ],
  validationRules: [
    {
      id: "no_draw",
      description: "Successive overtime periods are required until a winner is produced.",
      severity: "error",
      settingsConstraint: { kind: "equals", field: "successiveOvertime", value: true },
    },
    { id: "manual_clock", description: "The MVP records manual period and event time only.", severity: "error" },
    {
      id: "forfeit_score_orientation",
      description: "The forfeit winner score must exceed the loser score.",
      severity: "error",
      settingsConstraint: {
        kind: "greater_than",
        greaterField: "forfeitWinnerScore",
        lesserField: "forfeitLoserScore",
      },
    },
  ],
  recommendedSlotMinutes: 40,
  settingsSchema: {
    periods: integer("Regulation periods", 1, 12),
    periodDurationMinutes: integer("Period duration", 1, 60),
    overtimeDurationMinutes: integer("Overtime duration", 1, 30),
    successiveOvertime: bool("Successive overtime"),
    slotMinutes: integer("Match slot", 5, 480),
    manualEventTime: bool("Manual event time"),
    forfeitWinnerScore: integer("Forfeit winner score", 0, 300),
    forfeitLoserScore: integer("Forfeit loser score", 0, 300),
    standingsOrder: ordered("Standings order", ["wins", "head_to_head", "point_difference", "points_for", "seed"]),
  },
  recommendedSettings: {
    periods: 4,
    periodDurationMinutes: 10,
    overtimeDurationMinutes: 5,
    successiveOvertime: true,
    slotMinutes: 40,
    manualEventTime: true,
    forfeitWinnerScore: 20,
    forfeitLoserScore: 0,
    standingsOrder: ["wins", "head_to_head", "point_difference", "points_for"],
  },
});

export const SPORT_PACKS: Readonly<Record<SportId, SportPack>> = deepFreeze({
  canoe_polo: CANOE_POLO_SPORT_PACK,
  badminton: BADMINTON_SPORT_PACK,
  table_tennis: TABLE_TENNIS_SPORT_PACK,
  volleyball: VOLLEYBALL_SPORT_PACK,
  basketball: BASKETBALL_SPORT_PACK,
});

function effectiveSettings(base: SportPackSettings, override: SportPackOverride): SportPackSettings {
  return frozenClone({ ...base, ...override });
}

function modeFor(override: SportPackOverride): SettingsMode {
  return Object.keys(override).length === 0 ? "recommended" : "customised";
}

function assertCompetitionStateIdentity(competition: CompetitionSportSettings): void {
  if (
    typeof competition.competitionId !== "string" ||
    !competition.competitionId.trim() ||
    typeof competition.sportId !== "string" ||
    !["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"].includes(competition.sportId) ||
    competition.packSchemaVersion !== SPORT_PACK_SCHEMA_VERSION ||
    typeof competition.packVersion !== "string" ||
    !semverPattern.test(competition.packVersion) ||
    !isRecord(competition.recommendedSnapshot) ||
    !isRecord(competition.override) ||
    !isRecord(competition.effective)
  )
    throw new Error("Invalid competition sport-pack snapshot");
}

function assertCompetitionPackCompatibility(pack: SportPack, competition: CompetitionSportSettings): void {
  assertValidSportPack(pack);
  assertCompetitionStateIdentity(competition);
  if (
    competition.sportId !== pack.sportId ||
    competition.packSchemaVersion !== pack.schemaVersion ||
    competition.packVersion !== pack.version
  )
    throw new Error("Sport pack does not match the competition snapshot");
}

function assertDivisionCompetitionCompatibility(
  competition: CompetitionSportSettings,
  division: DivisionSportSettings,
): void {
  assertCompetitionStateIdentity(competition);
  if (
    typeof division.divisionId !== "string" ||
    !division.divisionId.trim() ||
    division.competitionId !== competition.competitionId ||
    division.sportId !== competition.sportId ||
    division.packSchemaVersion !== competition.packSchemaVersion ||
    division.packVersion !== competition.packVersion
  )
    throw new Error("Division does not match the competition sport-pack snapshot");
}

export function createCompetitionSportSettings(
  pack: SportPack,
  competitionId: string,
  override: SportPackOverride = {},
): CompetitionSportSettings {
  assertValidSportPack(pack);
  if (!competitionId.trim()) throw new Error("competitionId is required");
  assertValidSportSettings(pack, override, { partial: true });
  const recommendedSnapshot = frozenClone(pack.recommendedSettings);
  const safeOverride = frozenClone(override);
  const effective = effectiveSettings(recommendedSnapshot, safeOverride);
  assertValidSportSettings(pack, effective);
  return deepFreeze({
    competitionId,
    sportId: pack.sportId,
    packSchemaVersion: pack.schemaVersion,
    packVersion: pack.version,
    recommendedSnapshot,
    override: safeOverride,
    effective,
    mode: modeFor(safeOverride),
  });
}

export function customiseCompetitionSportSettings(
  pack: SportPack,
  current: CompetitionSportSettings,
  patch: SportPackOverride,
): CompetitionSportSettings {
  assertCompetitionPackCompatibility(pack, current);
  assertValidSportSettings(pack, patch, { partial: true });
  const nextOverride = { ...current.override, ...patch };
  assertValidSportSettings(pack, effectiveSettings(current.recommendedSnapshot, nextOverride));
  return deepFreeze({
    ...current,
    override: frozenClone(nextOverride),
    effective: effectiveSettings(current.recommendedSnapshot, nextOverride),
    mode: modeFor(nextOverride),
  });
}

export function resetCompetitionSportSettings(current: CompetitionSportSettings): CompetitionSportSettings {
  assertCompetitionStateIdentity(current);
  return deepFreeze({
    ...current,
    override: {},
    effective: frozenClone(current.recommendedSnapshot),
    mode: "recommended",
  });
}

export function createDivisionSportSettings(
  pack: SportPack,
  competition: CompetitionSportSettings,
  divisionId: string,
  override: SportPackOverride = {},
): DivisionSportSettings {
  if (!divisionId.trim()) throw new Error("divisionId is required");
  assertCompetitionPackCompatibility(pack, competition);
  assertValidSportSettings(pack, override, { partial: true });
  const effective = effectiveSettings(competition.effective, override);
  assertValidSportSettings(pack, effective);
  return deepFreeze({
    divisionId,
    competitionId: competition.competitionId,
    sportId: competition.sportId,
    packSchemaVersion: competition.packSchemaVersion,
    packVersion: competition.packVersion,
    override: frozenClone(override),
    effective,
    mode: modeFor(override),
  });
}

export function customiseDivisionSportSettings(
  pack: SportPack,
  competition: CompetitionSportSettings,
  current: DivisionSportSettings,
  patch: SportPackOverride,
): DivisionSportSettings {
  assertCompetitionPackCompatibility(pack, competition);
  assertDivisionCompetitionCompatibility(competition, current);
  assertValidSportSettings(pack, patch, { partial: true });
  const nextOverride = { ...current.override, ...patch };
  assertValidSportSettings(pack, effectiveSettings(competition.effective, nextOverride));
  return deepFreeze({
    ...current,
    override: frozenClone(nextOverride),
    effective: effectiveSettings(competition.effective, nextOverride),
    mode: modeFor(nextOverride),
  });
}

export function resetDivisionSportSettings(
  competition: CompetitionSportSettings,
  current: DivisionSportSettings,
): DivisionSportSettings {
  assertDivisionCompetitionCompatibility(competition, current);
  return deepFreeze({ ...current, override: {}, effective: frozenClone(competition.effective), mode: "recommended" });
}

export function createSaveAsUserDefaultCommand(
  commandId: string,
  userId: string,
  competition: CompetitionSportSettings,
): SaveSportSettingsAsUserDefaultCommand {
  if (!commandId.trim() || !userId.trim()) throw new Error("commandId and userId are required");
  assertCompetitionStateIdentity(competition);
  return deepFreeze({
    type: "sport_settings.save_as_user_default",
    commandId,
    userId,
    competitionId: competition.competitionId,
    sportId: competition.sportId,
    sourcePackSchemaVersion: competition.packSchemaVersion,
    sourcePackVersion: competition.packVersion,
    settings: frozenClone(competition.effective),
  });
}

export function applySaveAsUserDefaultCommand(command: SaveSportSettingsAsUserDefaultCommand): UserSportDefault {
  return deepFreeze({
    userId: command.userId,
    sportId: command.sportId,
    sourcePackSchemaVersion: command.sourcePackSchemaVersion,
    sourcePackVersion: command.sourcePackVersion,
    settings: frozenClone(command.settings),
  });
}

export function createCopyFromPreviousCompetitionCommand(
  commandId: string,
  source: CompetitionSportSettings,
  target: CompetitionSportSettings,
): CopySportSettingsFromPreviousCompetitionCommand {
  if (!commandId.trim()) throw new Error("commandId is required");
  assertCompetitionStateIdentity(source);
  assertCompetitionStateIdentity(target);
  if (source.sportId !== target.sportId) throw new Error("Cannot copy settings between different sports");
  if (source.packSchemaVersion !== target.packSchemaVersion)
    throw new Error("Cannot copy settings between incompatible sport-pack schemas");
  return deepFreeze({
    type: "sport_settings.copy_from_previous_competition",
    commandId,
    sourceCompetitionId: source.competitionId,
    targetCompetitionId: target.competitionId,
    sportId: target.sportId,
    sourcePackSchemaVersion: source.packSchemaVersion,
    targetPackSchemaVersion: target.packSchemaVersion,
    sourcePackVersion: source.packVersion,
    targetPackVersion: target.packVersion,
    settings: frozenClone(source.effective),
  });
}

function differenceFromRecommended(settings: SportPackSettings, recommended: SportPackSettings): SportPackOverride {
  const difference: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(settings)) {
    const baseline = recommended[key];
    if (baseline === undefined || !sameValue(value, baseline)) difference[key] = value;
  }
  return difference;
}

export function applyCopyFromPreviousCompetitionCommand(
  pack: SportPack,
  target: CompetitionSportSettings,
  command: CopySportSettingsFromPreviousCompetitionCommand,
): CompetitionSportSettings {
  if (target.competitionId !== command.targetCompetitionId || target.sportId !== command.sportId)
    throw new Error("Copy command does not target this competition");
  assertCompetitionPackCompatibility(pack, target);
  if (
    target.packSchemaVersion !== command.targetPackSchemaVersion ||
    command.sourcePackSchemaVersion !== command.targetPackSchemaVersion ||
    target.packVersion !== command.targetPackVersion ||
    pack.version !== target.packVersion
  )
    throw new Error("Target pack version changed after the command was created");
  assertValidSportSettings(pack, command.settings);
  const override = differenceFromRecommended(command.settings, target.recommendedSnapshot);
  return deepFreeze({
    ...target,
    override: frozenClone(override),
    effective: frozenClone(command.settings),
    mode: modeFor(override),
  });
}

export type SportPackRegistry = Readonly<{
  resolve(sportId: SportId, version: string): SportPack | undefined;
  has(sportId: SportId, version: string): boolean;
  versions(sportId: SportId): readonly string[];
  sportIds(): readonly SportId[];
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function createSportPackRegistry(packs: readonly SportPack[]): SportPackRegistry {
  const mutable = new Map<SportId, Map<string, SportPack>>();
  for (const candidate of packs) {
    assertValidSportPack(candidate);
    const versions = mutable.get(candidate.sportId) ?? new Map<string, SportPack>();
    const existing = versions.get(candidate.version);
    if (existing && canonical(existing) !== canonical(candidate))
      throw new Error(`Sport pack ${candidate.sportId}@${candidate.version} is immutable`);
    versions.set(candidate.version, frozenClone(candidate));
    mutable.set(candidate.sportId, versions);
  }
  const sportIds = Object.freeze([...mutable.keys()]);
  return Object.freeze({
    resolve(sportId: SportId, version: string): SportPack | undefined {
      return mutable.get(sportId)?.get(version);
    },
    has(sportId: SportId, version: string): boolean {
      return mutable.get(sportId)?.has(version) ?? false;
    },
    versions(sportId: SportId): readonly string[] {
      return Object.freeze([...(mutable.get(sportId)?.keys() ?? [])]);
    },
    sportIds(): readonly SportId[] {
      return sportIds;
    },
  });
}

export function resolveSportPack(registry: SportPackRegistry, sportId: SportId, version: string): SportPack {
  const pack = registry.resolve(sportId, version);
  if (!pack) throw new Error(`Unknown sport pack ${sportId}@${version}`);
  return pack;
}
