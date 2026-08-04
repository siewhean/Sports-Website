import type {
  GateCRepairDecisionCommand,
  GateCRepairRevisionCreateRequest,
  GateCRepairWorkspaceView,
} from "@matchday/contracts";

export type GateCC4DecisionValue = GateCRepairDecisionCommand["decision"];

export type GateCC4RepairQueueItem = Readonly<{
  repair_id: string;
  corrected_match_id: string;
  corrected_match_code: string;
  division_id: string;
  division_name: string;
  source_result_version: number;
  source_schedule_version: number;
  source_projection_version: number;
  analysis_fingerprint: string;
  latest_revision_id: string | null;
  latest_revision: number | null;
  latest_status: "draft" | "ready" | "published" | "abandoned" | null;
  affected_action_count: number;
  unresolved_action_count: number;
  created_at: string;
}>;

export type GateCC4DecisionDraft = GateCRepairDecisionCommand &
  Readonly<{
    starts_at?: string;
    ends_at?: string;
    playing_area_id?: string;
  }>;

export const gateCC4Machine = {
  forceDynamic: "force-dynamic",
  results: "results",
  saved: "saved",
  readOnly: "read-only",
  section: "repairs",
  get: "GET",
  post: "POST",
  openWorkspaceEvent: "matchday:gate-c-c4:open-repair-workspace",
  cacheNoStore: "no-store",
  jsonContentType: "application/json",
  contentSha256Header: "x-matchday-content-sha256",
  contentDispositionHeader: "content-disposition",
  anchorElement: "a",
  noChange: "no_change",
  automaticUpdate: "automatic_update",
  analyse: "analyse",
  publish: "publish",
  abandon: "abandon",
  scheduleExport: "schedule-export",
  draft: "draft",
  ready: "ready",
  published: "published",
  abandoned: "abandoned",
  decisions: [
    "accept_proposed",
    "keep_current",
    "set_manual_entry",
    "leave_protected",
  ] as const satisfies readonly GateCC4DecisionValue[],
} as const;

export const gateCC4Copy = {
  title: "Result repairs",
  intro: "Review every downstream participant change before publishing a new schedule version.",
  eyebrow: "Public truth and repair control",
  openRepairs: "Open repair workspace",
  noRepairs: "No repairs are waiting",
  noRepairsBody: "Corrected results are already reflected publicly and there is no unpublished schedule repair.",
  analyseTitle: "Analyse a corrected result",
  analyseBody: "Use the correction receipt ID to calculate every direct and transitive downstream effect.",
  correctionId: "Correction transaction ID",
  analyse: "Analyse correction",
  analysing: "Analysing correction",
  sourceVersions: "Source versions",
  resultVersion: "Results",
  scheduleVersion: "Schedule",
  projectionVersion: "Projection",
  affected: "Affected slots",
  unresolved: "Unresolved decisions",
  protected: "Protected",
  automatic: "Automatic",
  currentEntry: "Current participant",
  proposedEntry: "Proposed participant",
  dependency: "Dependency path",
  decision: "Organiser decision",
  reason: "Decision reason",
  selectedEntry: "Manual participant",
  startsAt: "New start time",
  endsAt: "New end time",
  playingArea: "New playing-area ID",
  unchanged: "Keep existing time and area",
  saveDraft: "Save repair draft",
  markReady: "Mark ready for publication",
  saving: "Saving repair revision",
  publish: "Publish repaired schedule",
  publishing: "Publishing repaired schedule",
  abandon: "Abandon latest draft",
  abandoning: "Abandoning draft",
  publishBlocked: "Resolve every required decision before publication.",
  publicationReady: "Ready to publish",
  publicationNotReady: "Decisions still required",
  audit: "Repair audit history",
  schedulePdf: "Download published schedule PDF",
  scoreSheet: "Emergency score sheet",
  exportHelp: "Exports are generated from the exact published schedule and retained with SHA-256 manifests.",
  refresh: "Refresh repairs",
  loading: "Loading repairs",
  failed: "Repair data could not be loaded.",
  saved: "Repair revision saved.",
  publishedMessage: "The repaired schedule is now public.",
  abandonedMessage: "The latest repair draft was abandoned.",
  acceptProposed: "Accept proposed participant",
  keepCurrent: "Keep current participant",
  setManual: "Select a participant manually",
  leaveProtected: "Leave protected match unchanged",
  required: "Required",
  optional: "Optional",
  close: "Close repair details",
  pendingRepairsTitle: "Corrections awaiting analysis",
  pendingRepairsIntro: "These private repair cases were created atomically with corrected public results.",
  pendingRepairsEmpty: "No corrected result is waiting for affected-match analysis.",
  pendingRepairsAnalyse: "Build affected-match workspace",
  pendingRepairsAnalysing: "Building workspace",
  pendingRepairsFailed: "Pending repair cases could not be loaded.",
  pendingRepairsLoading: "Loading pending repair cases",
  pendingRepairsCount: "pending repair cases",
  pendingRepairsResultVersion: "result version",
  pendingRepairsWorkspaceOpened: "Repair workspace opened.",
} as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const shaPattern = /^[a-f0-9]{64}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && uuidPattern.test(value));
}

export function parseGateCC4RepairQueue(value: unknown): GateCC4RepairQueueItem[] | null {
  if (!Array.isArray(value)) return null;
  const output: GateCC4RepairQueueItem[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !record(item) ||
      typeof item.repair_id !== "string" ||
      !uuidPattern.test(item.repair_id) ||
      seen.has(item.repair_id) ||
      typeof item.corrected_match_id !== "string" ||
      !uuidPattern.test(item.corrected_match_id) ||
      typeof item.corrected_match_code !== "string" ||
      typeof item.division_id !== "string" ||
      !uuidPattern.test(item.division_id) ||
      typeof item.division_name !== "string" ||
      !integer(item.source_result_version, 1) ||
      !integer(item.source_schedule_version) ||
      !integer(item.source_projection_version) ||
      typeof item.analysis_fingerprint !== "string" ||
      !shaPattern.test(item.analysis_fingerprint) ||
      !nullableUuid(item.latest_revision_id) ||
      !(item.latest_revision === null || integer(item.latest_revision, 1)) ||
      !(
        item.latest_status === null || ["draft", "ready", "published", "abandoned"].includes(String(item.latest_status))
      ) ||
      !integer(item.affected_action_count) ||
      !integer(item.unresolved_action_count) ||
      typeof item.created_at !== "string" ||
      !Number.isFinite(Date.parse(item.created_at))
    ) {
      return null;
    }
    seen.add(item.repair_id);
    output.push(item as GateCC4RepairQueueItem);
  }
  return output;
}

export function parseGateCC4Workspace(value: unknown): GateCRepairWorkspaceView | null {
  if (
    !record(value) ||
    !record(value.repair) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.unresolved_action_keys)
  ) {
    return null;
  }
  if (
    typeof value.repair.repair_id !== "string" ||
    !uuidPattern.test(value.repair.repair_id) ||
    !integer(value.current_result_version) ||
    !integer(value.published_schedule_version) ||
    typeof value.publication_ready !== "boolean" ||
    !record(value.public_projection_versions) ||
    !Array.isArray(value.audit)
  ) {
    return null;
  }
  if (
    value.latest_revision !== null &&
    (!record(value.latest_revision) ||
      typeof value.latest_revision.repair_revision_id !== "string" ||
      !uuidPattern.test(value.latest_revision.repair_revision_id) ||
      typeof value.latest_revision.analysis_fingerprint !== "string" ||
      !shaPattern.test(value.latest_revision.analysis_fingerprint))
  ) {
    return null;
  }
  for (const action of value.actions) {
    if (
      !record(action) ||
      typeof action.repair_action_id !== "string" ||
      !uuidPattern.test(action.repair_action_id) ||
      typeof action.match_id !== "string" ||
      !uuidPattern.test(action.match_id) ||
      typeof action.division_id !== "string" ||
      !uuidPattern.test(action.division_id) ||
      (action.slot !== "home" && action.slot !== "away") ||
      typeof action.source_action !== "string" ||
      !Array.isArray(action.dependency_path) ||
      typeof action.reason !== "string"
    ) {
      return null;
    }
  }
  return value as unknown as GateCRepairWorkspaceView;
}

export function repairRevisionRequest(input: {
  workspace: GateCRepairWorkspaceView;
  status: "draft" | "ready";
  decisions: readonly GateCC4DecisionDraft[];
}): GateCRepairRevisionCreateRequest {
  const fingerprint = input.workspace.latest_revision?.analysis_fingerprint;
  if (!fingerprint) throw new Error("The repair workspace has no retained analysis fingerprint");
  const decisions: GateCRepairDecisionCommand[] = input.decisions.map((decision) => ({
    client_event_id: decision.client_event_id,
    match_id: decision.match_id,
    slot: decision.slot,
    decision: decision.decision,
    ...(decision.selected_entry_id === undefined ? {} : { selected_entry_id: decision.selected_entry_id }),
    reason: decision.reason,
  }));
  const adjustmentByMatch = new Map<string, GateCRepairRevisionCreateRequest["schedule_adjustments"][number]>();
  for (const decision of input.decisions) {
    if (!decision.starts_at && !decision.ends_at && !decision.playing_area_id) continue;
    const action = input.workspace.actions.find(
      (candidate) => candidate.match_id === decision.match_id && candidate.slot === decision.slot,
    );
    if (!action) throw new Error("Repair action is missing from the current workspace");
    const previous = adjustmentByMatch.get(decision.match_id);
    adjustmentByMatch.set(decision.match_id, {
      match_id: decision.match_id,
      division_id: action.division_id,
      ...(previous?.starts_at ? { starts_at: previous.starts_at } : {}),
      ...(previous?.ends_at ? { ends_at: previous.ends_at } : {}),
      ...(previous?.playing_area_id ? { playing_area_id: previous.playing_area_id } : {}),
      ...(decision.starts_at ? { starts_at: new Date(decision.starts_at).toISOString() } : {}),
      ...(decision.ends_at ? { ends_at: new Date(decision.ends_at).toISOString() } : {}),
      ...(decision.playing_area_id ? { playing_area_id: decision.playing_area_id } : {}),
      reason: decision.reason,
    });
  }
  return {
    parent_revision_id: input.workspace.latest_revision?.repair_revision_id ?? null,
    expected_result_version: input.workspace.current_result_version,
    expected_schedule_version: input.workspace.published_schedule_version,
    expected_analysis_fingerprint: fingerprint,
    status: input.status,
    decisions,
    schedule_adjustments: [...adjustmentByMatch.values()],
  };
}
