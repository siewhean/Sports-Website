import type {
  Phase4FormatBuilderDocument,
  Phase4FormatDraftView,
  Phase4FormatGraph,
  Phase4FormatGraphStage,
  Phase4FormatValidationResponse,
  Phase4OrganiserTemplateView,
  Phase4SaveFormatRevisionRequest,
} from "@matchday/contracts";

export type FormatSurfaceState =
  "ready" | "loading" | "empty" | "error" | "offline" | "permission" | "read-only" | "conflict" | "quota" | "plan";

export type FormatBuilderPageDocument = Readonly<{
  state: FormatSurfaceState;
  competitionId: string;
  competitionName: string;
  divisionId: string;
  divisionName: string;
  organisationId: string;
  sportCode: string;
  draft: Phase4FormatDraftView | null;
  templates: readonly Phase4OrganiserTemplateView[];
}>;

export type FormatBuilderWorkspaceResponse = Readonly<{
  revisions: readonly unknown[];
  draft: Phase4FormatDraftView | null;
}>;

export type FormatMaterialisationResponse = Readonly<{
  revision: {
    revision_id: string;
    revision: number;
    parent_revision_id: string | null;
    root_revision_id: string;
    competition_id: string;
    division_id: string;
    status: "draft" | "published" | "superseded";
    definition_hash: string;
    document: Phase4FormatBuilderDocument;
    created_at: string;
    published_at: string | null;
  };
  materialised: true;
  match_count: number;
  materialisation_hash: string;
  idempotent_replay: boolean;
}>;

export type FormatEditorMode = "visual" | "manual";

export type FormatEditorState = Readonly<{
  document: Phase4FormatBuilderDocument;
  selectedStageId: string | null;
  mode: FormatEditorMode;
  dirty: boolean;
  validation: Phase4FormatValidationResponse | null;
}>;

export type FormatEditorAction =
  | { type: "set_mode"; mode: FormatEditorMode }
  | { type: "select_stage"; stageId: string | null }
  | { type: "move_stage"; stageId: string; x: number; y: number }
  | { type: "update_stage"; stageId: string; patch: Partial<Phase4FormatGraphStage> }
  | { type: "add_stage"; stage: Phase4FormatGraphStage; x: number; y: number }
  | { type: "remove_stage"; stageId: string }
  | { type: "replace_document"; document: Phase4FormatBuilderDocument }
  | { type: "validation"; validation: Phase4FormatValidationResponse };

export const formatStageKinds = [
  "group",
  "round_robin",
  "single_elimination",
  "placement",
  "consolation",
  "classification",
  "bronze",
] as const;

export const formatStageLibrary: ReadonlyArray<{
  kind: Phase4FormatGraphStage["kind"];
  label: string;
  detail: string;
}> = [
  { kind: "group", label: "Group stage", detail: "Pools with explicit rank outputs." },
  { kind: "round_robin", label: "Round robin", detail: "Every entry meets every other entry." },
  { kind: "single_elimination", label: "Single elimination", detail: "Winner advances through a bracket." },
  { kind: "placement", label: "Placement", detail: "Rank entries beyond the podium." },
  { kind: "consolation", label: "Consolation", detail: "Give eliminated entries an additional path." },
  { kind: "classification", label: "Classification", detail: "Resolve specific final positions." },
  { kind: "bronze", label: "Third-place", detail: "A controlled bronze-medal match." },
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isPhase4IdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,200}$/.test(value);
}

function parseParticipant(value: unknown): boolean {
  const item = record(value);
  if (!item || typeof item.type !== "string") return false;
  if (item.type === "entry_seed") return integer(item.seed, 1);
  if (item.type === "stage_rank")
    return (
      typeof item.stageId === "string" &&
      integer(item.rank, 1) &&
      (item.groupId === undefined || typeof item.groupId === "string")
    );
  if (item.type === "manual_qualifier") return typeof item.qualifierId === "string" && typeof item.stageId === "string";
  if (item.type === "winner" || item.type === "loser") return typeof item.matchId === "string";
  return false;
}

export function parseFormatBuilderDocument(value: unknown): Phase4FormatBuilderDocument | null {
  const item = record(value);
  const graph = record(item?.graph);
  const layout = record(item?.layout);
  if (
    !item ||
    !exactKeys(item, ["schema_version", "graph", "layout"]) ||
    item.schema_version !== 1 ||
    !graph ||
    !layout ||
    !exactKeys(layout, ["schema_version", "stage_positions"]) ||
    layout.schema_version !== 1
  )
    return null;
  if (
    typeof graph.id !== "string" ||
    graph.schemaVersion !== 1 ||
    !integer(graph.entryCount, 2) ||
    !Array.isArray(graph.stages) ||
    !Array.isArray(graph.matches) ||
    !stringArray(graph.terminalMatchIds) ||
    !Array.isArray(layout.stage_positions)
  )
    return null;
  const stageIds = new Set<string>();
  for (const raw of graph.stages) {
    const stage = record(raw);
    if (
      !stage ||
      typeof stage.id !== "string" ||
      stageIds.has(stage.id) ||
      typeof stage.label !== "string" ||
      !formatStageKinds.includes(stage.kind as (typeof formatStageKinds)[number]) ||
      !integer(stage.order, 1) ||
      !stringArray(stage.groupIds) ||
      (stage.groupSize !== null && !integer(stage.groupSize, 2)) ||
      !integer(stage.outputRanks) ||
      !stringArray(stage.matchIds)
    )
      return null;
    stageIds.add(stage.id);
  }
  for (const raw of graph.matches) {
    const match = record(raw);
    if (
      !match ||
      typeof match.id !== "string" ||
      typeof match.stageId !== "string" ||
      !stageIds.has(match.stageId) ||
      !integer(match.round, 1) ||
      !integer(match.order, 1) ||
      !["pool", "progression", "championship", "placement", "classification"].includes(String(match.purpose)) ||
      !parseParticipant(match.home) ||
      !parseParticipant(match.away)
    )
      return null;
  }
  const positions = new Set<string>();
  for (const raw of layout.stage_positions) {
    const position = record(raw);
    if (
      !position ||
      typeof position.stage_id !== "string" ||
      !stageIds.has(position.stage_id) ||
      positions.has(position.stage_id) ||
      typeof position.x !== "number" ||
      !Number.isFinite(position.x) ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.y)
    )
      return null;
    positions.add(position.stage_id);
  }
  if (positions.size !== stageIds.size) return null;
  return item as unknown as Phase4FormatBuilderDocument;
}

export function parseFormatDraft(
  value: unknown,
  competitionId: string,
  divisionId: string,
): Phase4FormatDraftView | null {
  const item = record(value);
  if (!item || item.competition_id !== competitionId || item.division_id !== divisionId) return null;
  const document = parseFormatBuilderDocument(item.document);
  const metrics = record(item.metrics);
  const capacity = record(item.capacity);
  const validation = record(item.validation);
  if (
    !document ||
    typeof item.draft_id !== "string" ||
    !integer(item.revision, 1) ||
    !["draft", "published", "superseded"].includes(String(item.status)) ||
    !["edit", "view"].includes(String(item.permission)) ||
    typeof item.read_only !== "boolean" ||
    typeof item.definition_hash !== "string" ||
    !metrics ||
    !integer(metrics.match_count) ||
    !integer(metrics.guaranteed_matches) ||
    !integer(metrics.maximum_matches) ||
    !capacity ||
    !integer(capacity.available_match_slots) ||
    !integer(capacity.required_match_slots) ||
    !Number.isSafeInteger(capacity.spare_match_slots) ||
    !["comfortable", "tight", "does_not_fit"].includes(String(capacity.status)) ||
    !integer(capacity.evidence_revision, 1) ||
    !validation ||
    typeof validation.pending !== "boolean" ||
    !Array.isArray(validation.issues)
  )
    return null;
  return item as unknown as Phase4FormatDraftView;
}

export function parseFormatWorkspaceResponse(
  value: unknown,
  competitionId: string,
  divisionId: string,
): FormatBuilderWorkspaceResponse | null {
  const item = record(value);
  if (!item || !Array.isArray(item.revisions) || !("draft" in item)) return null;
  if (item.draft === null) return { revisions: item.revisions, draft: null };
  const draft = parseFormatDraft(item.draft, competitionId, divisionId);
  return draft ? { revisions: item.revisions, draft } : null;
}

export function parseFormatValidation(value: unknown): Phase4FormatValidationResponse | null {
  const item = record(value);
  if (!item || typeof item.valid !== "boolean" || !Array.isArray(item.issues)) return null;
  if (!item.valid)
    return item.graph_hash === null && item.materialisation === null
      ? (item as unknown as Phase4FormatValidationResponse)
      : null;
  const materialisation = record(item.materialisation);
  return typeof item.graph_hash === "string" && materialisation && integer(materialisation.match_count)
    ? (item as unknown as Phase4FormatValidationResponse)
    : null;
}

export function parseFormatMaterialisation(value: unknown, formatId: string): FormatMaterialisationResponse | null {
  const item = record(value);
  const revision = record(item?.revision);
  if (
    !item ||
    !exactKeys(item, ["revision", "materialised", "match_count", "materialisation_hash", "idempotent_replay"]) ||
    !revision ||
    !exactKeys(revision, [
      "revision_id",
      "revision",
      "parent_revision_id",
      "root_revision_id",
      "competition_id",
      "division_id",
      "status",
      "definition_hash",
      "document",
      "created_at",
      "published_at",
    ]) ||
    revision.revision_id !== formatId ||
    !integer(revision.revision, 1) ||
    !(revision.parent_revision_id === null || typeof revision.parent_revision_id === "string") ||
    typeof revision.root_revision_id !== "string" ||
    typeof revision.competition_id !== "string" ||
    typeof revision.division_id !== "string" ||
    !["draft", "published", "superseded"].includes(String(revision.status)) ||
    typeof revision.definition_hash !== "string" ||
    !parseFormatBuilderDocument(revision.document) ||
    typeof revision.created_at !== "string" ||
    Number.isNaN(Date.parse(revision.created_at)) ||
    !(
      revision.published_at === null ||
      (typeof revision.published_at === "string" && !Number.isNaN(Date.parse(revision.published_at)))
    ) ||
    item.materialised !== true ||
    !integer(item.match_count, 1) ||
    typeof item.materialisation_hash !== "string" ||
    typeof item.idempotent_replay !== "boolean"
  )
    return null;
  return item as unknown as FormatMaterialisationResponse;
}

export function parseOrganiserTemplate(value: unknown, organisationId: string): Phase4OrganiserTemplateView | null {
  const item = record(value);
  if (
    !item ||
    item.organisation_id !== organisationId ||
    typeof item.template_id !== "string" ||
    typeof item.template_version_id !== "string" ||
    typeof item.created_by_account_id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.sport_code !== "string" ||
    typeof item.source_format_revision_id !== "string" ||
    !["active", "archived"].includes(String(item.status)) ||
    typeof item.definition_hash !== "string" ||
    !integer(item.revision, 1) ||
    !parseFormatBuilderDocument(item.document)
  )
    return null;
  return item as unknown as Phase4OrganiserTemplateView;
}

export function parseOrganiserTemplateList(
  value: unknown,
  organisationId: string,
): readonly Phase4OrganiserTemplateView[] | null {
  const values = Array.isArray(value)
    ? value
    : Array.isArray(record(value)?.templates)
      ? (record(value)!.templates as unknown[])
      : null;
  if (!values) return null;
  const parsed = values.map((item) => parseOrganiserTemplate(item, organisationId));
  return parsed.some((item) => !item) ? null : (parsed as Phase4OrganiserTemplateView[]);
}

export function mergeOrganiserTemplate(
  current: readonly Phase4OrganiserTemplateView[],
  saved: Phase4OrganiserTemplateView,
): readonly Phase4OrganiserTemplateView[] {
  return [...current.filter((item) => item.template_id !== saved.template_id), saved].sort(
    (left, right) => left.name.localeCompare(right.name) || right.revision - left.revision,
  );
}

export function isSaveFormatRequest(
  value: unknown,
): value is Phase4SaveFormatRevisionRequest & { idempotency_key: string } {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, ["draft_id", "expected_revision", "parent_revision_id", "document", "idempotency_key"]) ||
    !isPhase4IdempotencyKey(item.idempotency_key)
  )
    return false;
  if (!(item.draft_id === null || typeof item.draft_id === "string")) return false;
  if (!(item.expected_revision === null || integer(item.expected_revision, 1))) return false;
  if (!(item.parent_revision_id === null || typeof item.parent_revision_id === "string")) return false;
  return parseFormatBuilderDocument(item.document) !== null;
}

export function formatSaveBody(draft: Phase4FormatDraftView, document: Phase4FormatBuilderDocument) {
  return {
    draft_id: draft.draft_id,
    expected_revision: draft.revision,
    parent_revision_id: draft.draft_id,
    document,
    idempotency_key: crypto.randomUUID(),
  };
}

export function formatEditorReducer(state: FormatEditorState, action: FormatEditorAction): FormatEditorState {
  if (action.type === "set_mode") return { ...state, mode: action.mode };
  if (action.type === "select_stage") return { ...state, selectedStageId: action.stageId };
  if (action.type === "validation") return { ...state, validation: action.validation };
  if (action.type === "replace_document")
    return {
      ...state,
      document: structuredClone(action.document),
      selectedStageId: action.document.graph.stages[0]?.id ?? null,
      dirty: false,
      validation: null,
    };
  if (action.type === "move_stage") {
    return {
      ...state,
      dirty: true,
      validation: null,
      document: {
        ...state.document,
        layout: {
          ...state.document.layout,
          stage_positions: state.document.layout.stage_positions.map((position) =>
            position.stage_id === action.stageId
              ? { ...position, x: Math.max(0, Math.round(action.x)), y: Math.max(0, Math.round(action.y)) }
              : position,
          ),
        },
      },
    };
  }
  if (action.type === "update_stage") {
    return {
      ...state,
      dirty: true,
      validation: null,
      document: {
        ...state.document,
        graph: {
          ...state.document.graph,
          stages: state.document.graph.stages.map((stage) =>
            stage.id === action.stageId ? { ...stage, ...action.patch, id: stage.id } : stage,
          ),
        },
      },
    };
  }
  if (action.type === "add_stage") {
    return {
      ...state,
      selectedStageId: action.stage.id,
      dirty: true,
      validation: null,
      document: {
        ...state.document,
        graph: { ...state.document.graph, stages: [...state.document.graph.stages, action.stage] },
        layout: {
          ...state.document.layout,
          stage_positions: [
            ...state.document.layout.stage_positions,
            { stage_id: action.stage.id, x: action.x, y: action.y },
          ],
        },
      },
    };
  }
  const removedMatchIds = new Set(
    state.document.graph.matches.filter((match) => match.stageId === action.stageId).map((match) => match.id),
  );
  return {
    ...state,
    selectedStageId: state.document.graph.stages.find((stage) => stage.id !== action.stageId)?.id ?? null,
    dirty: true,
    validation: null,
    document: {
      ...state.document,
      graph: {
        ...state.document.graph,
        stages: state.document.graph.stages.filter((stage) => stage.id !== action.stageId),
        matches: state.document.graph.matches.filter((match) => match.stageId !== action.stageId),
        terminalMatchIds: state.document.graph.terminalMatchIds.filter((id) => !removedMatchIds.has(id)),
      },
      layout: {
        ...state.document.layout,
        stage_positions: state.document.layout.stage_positions.filter(
          (position) => position.stage_id !== action.stageId,
        ),
      },
    },
  };
}

export function nextStageId(graph: Phase4FormatGraph, label: string): string {
  const base = `stage-${
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "new"
  }`;
  const ids = new Set(graph.stages.map((stage) => stage.id));
  if (!ids.has(base)) return base;
  let sequence = 2;
  while (ids.has(`${base}-${sequence}`)) sequence += 1;
  return `${base}-${sequence}`;
}
