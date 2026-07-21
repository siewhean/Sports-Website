import {
  assertValidFormatGraph,
  createFormatGraphHash,
  validateFormatGraph,
  type FormatGraph,
  type FormatGraphMatch,
  type FormatParticipantSource,
  type FormatValidationIssue,
} from "./format.js";

export type FormatBuilderMode = "manual" | "visual";

export type FormatCanvasPosition = {
  readonly stageId: string;
  readonly x: number;
  readonly y: number;
};

export type FormatBuilderLayout = {
  readonly schemaVersion: 1;
  readonly stagePositions: readonly FormatCanvasPosition[];
};

export type FormatBuilderDocument = {
  readonly schemaVersion: 1;
  readonly graph: FormatGraph;
  readonly layout: FormatBuilderLayout;
};

export type ManualFormatBuilderView = {
  readonly mode: "manual";
  readonly document: FormatBuilderDocument;
  readonly stages: FormatGraph["stages"];
  readonly matches: FormatGraph["matches"];
};

export type FormatAdvancementConnector = {
  readonly id: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly targetMatchId: string;
  readonly targetSlot: "home" | "away";
  readonly outcome: "rank" | "manual" | "winner" | "loser";
};

export type VisualFormatBuilderStage = {
  readonly stage: FormatGraph["stages"][number];
  readonly position: FormatCanvasPosition;
};

export type VisualFormatBuilderView = {
  readonly mode: "visual";
  readonly document: FormatBuilderDocument;
  readonly stages: readonly VisualFormatBuilderStage[];
  readonly connectors: readonly FormatAdvancementConnector[];
};

export type FormatBuilderView = ManualFormatBuilderView | VisualFormatBuilderView;

export type MaterialisedFormatMatch = {
  readonly graphMatchId: string;
  readonly stageId: string;
  readonly poolId: string | null;
  readonly round: number;
  readonly sequence: number;
  readonly purpose: FormatGraphMatch["purpose"];
  readonly home: FormatParticipantSource;
  readonly away: FormatParticipantSource;
  readonly dependencyMatchIds: readonly string[];
};

export type FormatMaterialisationPlan = {
  readonly schemaVersion: 1;
  readonly formatId: string;
  readonly graphHash: string;
  readonly entryCount: number;
  readonly matchCount: number;
  readonly matches: readonly MaterialisedFormatMatch[];
};

export type FormatBuilderValidationResult =
  | {
      readonly valid: true;
      readonly issues: readonly [];
      readonly graphHash: string;
      readonly materialisation: FormatMaterialisationPlan;
    }
  | {
      readonly valid: false;
      readonly issues: readonly FormatValidationIssue[];
      readonly graphHash: null;
      readonly materialisation: null;
    };

const DEFAULT_X = 64;
const DEFAULT_Y = 72;
const STAGE_X_GAP = 320;
const STAGE_Y_GAP = 184;

function stableSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "node";
}

function nextStableId(base: string, existingIds: ReadonlySet<string>): string {
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function createStableFormatStageId(label: string, existingIds: readonly string[]): string {
  return nextStableId(`stage-${stableSlug(label)}`, new Set(existingIds));
}

export function createStableFormatMatchId(
  stageId: string,
  round: number,
  matchInRound: number,
  existingIds: readonly string[],
): string {
  if (!Number.isInteger(round) || round < 1 || !Number.isInteger(matchInRound) || matchInRound < 1) {
    throw new Error("A stable match ID requires positive integer round and match indexes");
  }
  return nextStableId(`${stableSlug(stageId)}-r${round}-m${matchInRound}`, new Set(existingIds));
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[] = required,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => allowed.includes(key));
}

function shapeIssue(path: string, message: string): FormatValidationIssue {
  return { code: "invalid_shape", path, message };
}

function validateParticipantSourceShape(value: unknown, path: string): FormatValidationIssue | null {
  if (!isRecord(value) || typeof value.type !== "string")
    return shapeIssue(path, "Participant source must be an object");
  if (value.type === "entry_seed") {
    return hasExactKeys(value, ["type", "seed"]) && typeof value.seed === "number"
      ? null
      : shapeIssue(path, "Entry-seed source contains missing or unexpected fields");
  }
  if (value.type === "stage_rank") {
    return hasExactKeys(value, ["type", "stageId", "rank"], ["type", "stageId", "groupId", "rank"]) &&
      typeof value.stageId === "string" &&
      typeof value.rank === "number" &&
      (value.groupId === undefined || typeof value.groupId === "string")
      ? null
      : shapeIssue(path, "Stage-rank source contains missing or unexpected fields");
  }
  if (value.type === "manual_qualifier") {
    return hasExactKeys(value, ["type", "qualifierId", "stageId"]) &&
      typeof value.qualifierId === "string" &&
      typeof value.stageId === "string"
      ? null
      : shapeIssue(path, "Manual-qualifier source contains missing or unexpected fields");
  }
  if (value.type === "winner" || value.type === "loser") {
    return hasExactKeys(value, ["type", "matchId"]) && typeof value.matchId === "string"
      ? null
      : shapeIssue(path, "Match-outcome source contains missing or unexpected fields");
  }
  // The graph validator reports the more specific unsupported-enum issue.
  return null;
}

function validateBuilderDocumentShape(value: unknown): FormatValidationIssue | null {
  if (!hasExactKeys(value, ["schemaVersion", "graph", "layout"])) {
    return shapeIssue("", "Builder document contains missing or unexpected fields");
  }
  const layout = value.layout;
  if (!hasExactKeys(layout, ["schemaVersion", "stagePositions"]) || !Array.isArray(layout.stagePositions)) {
    return shapeIssue("layout", "Builder layout contains missing or unexpected fields");
  }
  for (const [index, position] of layout.stagePositions.entries()) {
    if (
      !hasExactKeys(position, ["stageId", "x", "y"]) ||
      typeof position.stageId !== "string" ||
      typeof position.x !== "number" ||
      typeof position.y !== "number"
    ) {
      return shapeIssue(`layout.stagePositions[${index}]`, "Canvas position contains missing or unexpected fields");
    }
  }
  const graph = value.graph;
  if (
    !hasExactKeys(graph, ["id", "schemaVersion", "entryCount", "stages", "matches", "terminalMatchIds"]) ||
    typeof graph.id !== "string" ||
    typeof graph.schemaVersion !== "number" ||
    typeof graph.entryCount !== "number" ||
    !Array.isArray(graph.stages) ||
    !Array.isArray(graph.matches) ||
    !Array.isArray(graph.terminalMatchIds) ||
    !graph.terminalMatchIds.every((item) => typeof item === "string")
  ) {
    return shapeIssue("graph", "Format graph contains missing or unexpected fields");
  }
  const stageRequired = ["id", "label", "kind", "order", "groupIds", "groupSize", "outputRanks", "matchIds"];
  const stageAllowed = [
    ...stageRequired,
    "repetitions",
    "qualificationPositions",
    "additionalQualifiers",
    "destinationStageIds",
    "seeding",
    "placementRule",
    "carriedResults",
  ];
  for (const [stageIndex, stage] of graph.stages.entries()) {
    if (
      !hasExactKeys(stage, stageRequired, stageAllowed) ||
      typeof stage.id !== "string" ||
      typeof stage.label !== "string" ||
      typeof stage.kind !== "string" ||
      typeof stage.order !== "number" ||
      !Array.isArray(stage.groupIds) ||
      !stage.groupIds.every((item) => typeof item === "string") ||
      (stage.groupSize !== null && typeof stage.groupSize !== "number") ||
      typeof stage.outputRanks !== "number" ||
      !Array.isArray(stage.matchIds) ||
      !stage.matchIds.every((item) => typeof item === "string") ||
      (stage.repetitions !== undefined && typeof stage.repetitions !== "number") ||
      (stage.seeding !== undefined && typeof stage.seeding !== "string") ||
      (stage.carriedResults !== undefined && typeof stage.carriedResults !== "string") ||
      (stage.qualificationPositions !== undefined &&
        (!Array.isArray(stage.qualificationPositions) ||
          !stage.qualificationPositions.every((item) => typeof item === "number"))) ||
      (stage.destinationStageIds !== undefined &&
        (!Array.isArray(stage.destinationStageIds) ||
          !stage.destinationStageIds.every((item) => typeof item === "string")))
    ) {
      return shapeIssue(`graph.stages[${stageIndex}]`, "Format stage contains missing or unexpected fields");
    }
    if (stage.additionalQualifiers !== undefined) {
      if (!Array.isArray(stage.additionalQualifiers)) {
        return shapeIssue(`graph.stages[${stageIndex}].additionalQualifiers`, "Additional qualifiers must be an array");
      }
      for (const [ruleIndex, rule] of stage.additionalQualifiers.entries()) {
        if (
          !hasExactKeys(rule, ["method", "count", "destinationStageId"]) ||
          typeof rule.method !== "string" ||
          typeof rule.count !== "number" ||
          typeof rule.destinationStageId !== "string"
        ) {
          return shapeIssue(
            `graph.stages[${stageIndex}].additionalQualifiers[${ruleIndex}]`,
            "Additional qualifier contains missing or unexpected fields",
          );
        }
      }
    }
    if (
      stage.placementRule !== undefined &&
      (!hasExactKeys(stage.placementRule, ["coverage", "positions"]) ||
        typeof stage.placementRule.coverage !== "string" ||
        !Array.isArray(stage.placementRule.positions) ||
        !stage.placementRule.positions.every((item) => typeof item === "number"))
    ) {
      return shapeIssue(
        `graph.stages[${stageIndex}].placementRule`,
        "Placement rule contains missing or unexpected fields",
      );
    }
  }
  for (const [matchIndex, match] of graph.matches.entries()) {
    if (
      !hasExactKeys(
        match,
        ["id", "stageId", "round", "order", "purpose", "home", "away"],
        ["id", "stageId", "poolId", "round", "order", "purpose", "home", "away"],
      ) ||
      typeof match.id !== "string" ||
      typeof match.stageId !== "string" ||
      (match.poolId !== undefined && typeof match.poolId !== "string") ||
      typeof match.round !== "number" ||
      typeof match.order !== "number" ||
      typeof match.purpose !== "string"
    ) {
      return shapeIssue(`graph.matches[${matchIndex}]`, "Format match contains missing or unexpected fields");
    }
    const homeIssue = validateParticipantSourceShape(match.home, `graph.matches[${matchIndex}].home`);
    if (homeIssue) return homeIssue;
    const awayIssue = validateParticipantSourceShape(match.away, `graph.matches[${matchIndex}].away`);
    if (awayIssue) return awayIssue;
  }
  return null;
}

function validatePosition(position: FormatCanvasPosition): void {
  if (!position.stageId) throw new Error("A canvas position requires a stage ID");
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error(`Canvas position for ${position.stageId} must use finite coordinates`);
  }
}

function defaultPosition(stage: FormatGraph["stages"][number], index: number): FormatCanvasPosition {
  return {
    stageId: stage.id,
    x: DEFAULT_X + (stage.order - 1) * STAGE_X_GAP,
    y: DEFAULT_Y + (index % 2) * STAGE_Y_GAP,
  };
}

function reconcileLayout(
  graph: FormatGraph,
  positions: readonly FormatCanvasPosition[],
): readonly FormatCanvasPosition[] {
  const stageIds = new Set(graph.stages.map((stage) => stage.id));
  const byStage = new Map<string, FormatCanvasPosition>();
  for (const position of positions) {
    validatePosition(position);
    if (!stageIds.has(position.stageId))
      throw new Error(`Canvas position references unknown stage ${position.stageId}`);
    if (byStage.has(position.stageId)) throw new Error(`Duplicate canvas position for stage ${position.stageId}`);
    byStage.set(position.stageId, position);
  }
  return [...graph.stages]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((stage, index) => clone(byStage.get(stage.id) ?? defaultPosition(stage, index)));
}

export function createFormatBuilderDocument(
  graph: FormatGraph,
  positions: readonly FormatCanvasPosition[] = [],
): FormatBuilderDocument {
  assertValidFormatGraph(graph);
  const document: FormatBuilderDocument = {
    schemaVersion: 1,
    graph: clone(graph),
    layout: { schemaVersion: 1, stagePositions: reconcileLayout(graph, positions) },
  };
  return freezeDeep(document) as FormatBuilderDocument;
}

/**
 * Replace the semantic graph while retaining coordinates for unchanged stage
 * IDs. Newly introduced stages receive deterministic coordinates.
 */
export function replaceFormatBuilderGraph(document: FormatBuilderDocument, graph: FormatGraph): FormatBuilderDocument {
  return createFormatBuilderDocument(
    graph,
    document.layout.stagePositions.filter((position) => graph.stages.some((stage) => stage.id === position.stageId)),
  );
}

export function moveFormatBuilderStage(
  document: FormatBuilderDocument,
  stageId: string,
  point: Readonly<{ x: number; y: number }>,
): FormatBuilderDocument {
  if (!document.graph.stages.some((stage) => stage.id === stageId)) throw new Error(`Unknown stage ${stageId}`);
  const next = document.layout.stagePositions.map((position) =>
    position.stageId === stageId ? { stageId, x: point.x, y: point.y } : position,
  );
  return createFormatBuilderDocument(document.graph, next);
}

function sourceStageId(
  source: FormatParticipantSource,
  matchStages: ReadonlyMap<string, string>,
): { stageId: string; outcome: FormatAdvancementConnector["outcome"] } | null {
  if (source.type === "stage_rank") return { stageId: source.stageId, outcome: "rank" };
  if (source.type === "manual_qualifier") return { stageId: source.stageId, outcome: "manual" };
  if (source.type === "winner" || source.type === "loser") {
    const stageId = matchStages.get(source.matchId);
    return stageId ? { stageId, outcome: source.type } : null;
  }
  return null;
}

export function deriveFormatAdvancementConnectors(graph: FormatGraph): readonly FormatAdvancementConnector[] {
  assertValidFormatGraph(graph);
  const matchStages = new Map(graph.matches.map((match) => [match.id, match.stageId]));
  const connectors: FormatAdvancementConnector[] = [];
  for (const match of [...graph.matches].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  )) {
    for (const slot of ["home", "away"] as const) {
      const source = sourceStageId(match[slot], matchStages);
      if (!source || source.stageId === match.stageId) continue;
      connectors.push({
        id: `${source.stageId}->${match.stageId}:${match.id}:${slot}:${source.outcome}`,
        fromStageId: source.stageId,
        toStageId: match.stageId,
        targetMatchId: match.id,
        targetSlot: slot,
        outcome: source.outcome,
      });
    }
  }
  return freezeDeep(connectors) as readonly FormatAdvancementConnector[];
}

export function projectManualFormatBuilder(document: FormatBuilderDocument): ManualFormatBuilderView {
  const copy = clone(document);
  return freezeDeep({
    mode: "manual",
    document: copy,
    stages: copy.graph.stages,
    matches: copy.graph.matches,
  }) as ManualFormatBuilderView;
}

export function projectVisualFormatBuilder(document: FormatBuilderDocument): VisualFormatBuilderView {
  const copy = clone(document);
  const positions = new Map(copy.layout.stagePositions.map((position) => [position.stageId, position]));
  const stages = copy.graph.stages.map((stage) => {
    const position = positions.get(stage.id);
    if (!position) throw new Error(`Missing canvas position for stage ${stage.id}`);
    return { stage, position };
  });
  return freezeDeep({
    mode: "visual",
    document: copy,
    stages,
    connectors: deriveFormatAdvancementConnectors(copy.graph),
  }) as VisualFormatBuilderView;
}

export function projectFormatBuilder(document: FormatBuilderDocument, mode: "manual"): ManualFormatBuilderView;
export function projectFormatBuilder(document: FormatBuilderDocument, mode: "visual"): VisualFormatBuilderView;
export function projectFormatBuilder(document: FormatBuilderDocument, mode: FormatBuilderMode): FormatBuilderView {
  return mode === "manual" ? projectManualFormatBuilder(document) : projectVisualFormatBuilder(document);
}

/** Both editor modes serialise the exact same canonical document. */
export function serializeFormatBuilderView(view: FormatBuilderView): FormatBuilderDocument {
  return createFormatBuilderDocument(view.document.graph, view.document.layout.stagePositions);
}

export function materialiseFormatGraph(graph: FormatGraph): FormatMaterialisationPlan {
  assertValidFormatGraph(graph);
  const matches = [...graph.matches]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((match, index): MaterialisedFormatMatch => ({
      graphMatchId: match.id,
      stageId: match.stageId,
      poolId: match.poolId ?? null,
      round: match.round,
      sequence: index + 1,
      purpose: match.purpose,
      home: clone(match.home),
      away: clone(match.away),
      dependencyMatchIds: [match.home, match.away]
        .flatMap((source) => (source.type === "winner" || source.type === "loser" ? [source.matchId] : []))
        .filter((matchId, dependencyIndex, all) => all.indexOf(matchId) === dependencyIndex),
    }));
  return freezeDeep({
    schemaVersion: 1,
    formatId: graph.id,
    graphHash: createFormatGraphHash(graph),
    entryCount: graph.entryCount,
    matchCount: matches.length,
    matches,
  }) as FormatMaterialisationPlan;
}

/** Validate and preview only; this helper has no persistence dependency or side effect. */
export function validateFormatBuilderDocument(document: FormatBuilderDocument): FormatBuilderValidationResult {
  const shape = validateBuilderDocumentShape(document);
  if (shape) return { valid: false, issues: [shape], graphHash: null, materialisation: null };
  if (document.schemaVersion !== 1) {
    return {
      valid: false,
      issues: [{ code: "invalid_schema_version", path: "schemaVersion", message: "Builder schema version must be 1" }],
      graphHash: null,
      materialisation: null,
    };
  }
  if (document.layout.schemaVersion !== 1) {
    return {
      valid: false,
      issues: [
        {
          code: "invalid_schema_version",
          path: "layout.schemaVersion",
          message: "Builder layout schema version must be 1",
        },
      ],
      graphHash: null,
      materialisation: null,
    };
  }
  const validation = validateFormatGraph(document.graph);
  if (!validation.valid) return { valid: false, issues: validation.issues, graphHash: null, materialisation: null };
  try {
    if (document.layout.stagePositions.length !== document.graph.stages.length) {
      throw new Error("Layout must contain exactly one position for every stage");
    }
    reconcileLayout(document.graph, document.layout.stagePositions);
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          code: "invalid_layout",
          path: "layout.stagePositions",
          message: error instanceof Error ? error.message : "Invalid layout",
        },
      ],
      graphHash: null,
      materialisation: null,
    };
  }
  const connectors = deriveFormatAdvancementConnectors(document.graph);
  for (const [stageIndex, stage] of document.graph.stages.entries()) {
    const actualDestinations = new Set(
      connectors.filter((connector) => connector.fromStageId === stage.id).map((connector) => connector.toStageId),
    );
    const hasAuthoredAdvancement =
      stage.destinationStageIds !== undefined ||
      stage.qualificationPositions !== undefined ||
      stage.additionalQualifiers !== undefined;
    if (hasAuthoredAdvancement && stage.destinationStageIds === undefined) {
      return {
        valid: false,
        issues: [
          {
            code: "invalid_advancement",
            path: `graph.stages[${stageIndex}].destinationStageIds`,
            message: "Authored advancement requires the complete canonical destination list",
          },
        ],
        graphHash: null,
        materialisation: null,
      };
    }
    if (stage.destinationStageIds !== undefined) {
      const configuredDestinations = new Set(stage.destinationStageIds);
      const missing = [...actualDestinations].filter((destination) => !configuredDestinations.has(destination));
      const extra = [...configuredDestinations].filter((destination) => !actualDestinations.has(destination));
      if (missing.length > 0 || extra.length > 0) {
        return {
          valid: false,
          issues: [
            {
              code: "invalid_advancement",
              path: `graph.stages[${stageIndex}].destinationStageIds`,
              message: `Authored destinations must exactly match canonical connections from ${stage.id}`,
            },
          ],
          graphHash: null,
          materialisation: null,
        };
      }
    }
    if (hasAuthoredAdvancement) {
      const qualificationPositions = new Set(stage.qualificationPositions ?? []);
      const rankSlots = document.graph.matches.flatMap((match) =>
        (["home", "away"] as const).flatMap((slot) => {
          const source = match[slot];
          return source.type === "stage_rank" && source.stageId === stage.id
            ? [{ id: `${match.id}:${slot}`, destinationStageId: match.stageId, source }]
            : [];
        }),
      );
      const manualSlots = document.graph.matches.flatMap((match) =>
        (["home", "away"] as const).flatMap((slot) => {
          const source = match[slot];
          return source.type === "manual_qualifier" && source.stageId === stage.id
            ? [{ id: `${match.id}:${slot}`, destinationStageId: match.stageId, source }]
            : [];
        }),
      );
      const additionalSlots = [
        ...rankSlots.filter(
          (slot) => slot.source.groupId === undefined || !qualificationPositions.has(slot.source.rank),
        ),
        ...manualSlots,
      ];
      for (const position of qualificationPositions) {
        if (!rankSlots.some((slot) => slot.source.groupId !== undefined && slot.source.rank === position)) {
          return {
            valid: false,
            issues: [
              {
                code: "invalid_advancement",
                path: `graph.stages[${stageIndex}].qualificationPositions`,
                message: `Qualification position ${position} has no canonical group-rank slot`,
              },
            ],
            graphHash: null,
            materialisation: null,
          };
        }
      }
      if (additionalSlots.length > 0 && stage.additionalQualifiers === undefined) {
        return {
          valid: false,
          issues: [
            {
              code: "invalid_advancement",
              path: `graph.stages[${stageIndex}].additionalQualifiers`,
              message:
                "Every canonical rank slot outside qualification positions requires an additional qualifier rule",
            },
          ],
          graphHash: null,
          materialisation: null,
        };
      }
      const ruleKeys = new Set<string>();
      const declaredSlots = new Set<string>();
      for (const [ruleIndex, rule] of (stage.additionalQualifiers ?? []).entries()) {
        const ruleKey = `${rule.method}:${rule.destinationStageId}`;
        if (ruleKeys.has(ruleKey)) {
          return {
            valid: false,
            issues: [
              {
                code: "invalid_advancement",
                path: `graph.stages[${stageIndex}].additionalQualifiers[${ruleIndex}]`,
                message: `Additional qualifier rule ${ruleKey} is duplicated`,
              },
            ],
            graphHash: null,
            materialisation: null,
          };
        }
        ruleKeys.add(ruleKey);
        const matchingSlots = additionalSlots.filter(
          (slot) =>
            slot.destinationStageId === rule.destinationStageId &&
            ((rule.method === "manual" && slot.source.type === "manual_qualifier") ||
              (slot.source.type === "stage_rank" &&
                ((rule.method === "best_across_groups" && slot.source.groupId === undefined) ||
                  (rule.method === "bottom_from_each_group" && slot.source.groupId !== undefined)))),
        );
        if (matchingSlots.length !== rule.count) {
          return {
            valid: false,
            issues: [
              {
                code: "invalid_advancement",
                path: `graph.stages[${stageIndex}].additionalQualifiers[${ruleIndex}].count`,
                message: `Declared qualifier count ${rule.count} does not match ${matchingSlots.length} canonical slots`,
              },
            ],
            graphHash: null,
            materialisation: null,
          };
        }
        for (const slot of matchingSlots) declaredSlots.add(slot.id);
      }
      if (declaredSlots.size !== additionalSlots.length) {
        return {
          valid: false,
          issues: [
            {
              code: "invalid_advancement",
              path: `graph.stages[${stageIndex}].additionalQualifiers`,
              message:
                "Additional qualifier declarations must cover every non-standard canonical rank slot exactly once",
            },
          ],
          graphHash: null,
          materialisation: null,
        };
      }
    }
  }
  const materialisation = materialiseFormatGraph(document.graph);
  return { valid: true, issues: [], graphHash: materialisation.graphHash, materialisation };
}
