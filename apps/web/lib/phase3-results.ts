export type ResultsSurfaceState = "ready" | "loading" | "empty" | "error" | "offline" | "permission" | "read-only";

export type StandingsMetric =
  | "table_points"
  | "match_wins"
  | "score_difference"
  | "score_for"
  | "segment_difference"
  | "segment_ratio"
  | "score_ratio"
  | "head_to_head"
  | "discipline"
  | "seed"
  | "terminal_fallback";

export type StandingsTrace = Readonly<{
  criterion: StandingsMetric;
  value: number | string;
  comparedWithinEntryIds: readonly string[];
  summary: string;
}>;

export type StandingsRow = Readonly<{
  rank: number;
  displayOrder: number;
  entryId: string;
  entryName: string;
  seed: number;
  status: "active" | "withdrawn";
  eligibleForAdvancement: boolean;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  tablePoints: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDifference: number;
  segmentsWon: number;
  segmentsLost: number;
  disciplinePoints: number;
  sportingTie: boolean;
  resolvedBy: Exclude<StandingsMetric, "terminal_fallback"> | "entry_id" | "unresolved";
  explanations: readonly StandingsTrace[];
}>;

export type StandingsGroup = Readonly<{
  snapshotId: string;
  competitionId: string;
  divisionId: string;
  groupId: string;
  resultVersion: number;
  configVersion: string;
  calculatedAt: string;
  fingerprint: string;
  rows: readonly StandingsRow[];
}>;

export type CrossGroupRow = Readonly<{
  rank: number;
  displayOrder: number;
  groupId: string;
  entryId: string;
  provisional: boolean;
  resolved: boolean;
  explanations: readonly Readonly<{ criterion: string; value: number | string }>[];
}>;

export type AdvancementChange = Readonly<{
  slotId: string;
  previousEntryId: string | null;
  entryId: string | null;
}>;

export type AdvancementConflict = Readonly<{
  ruleId: string;
  targetSlotId: string;
  reason: string;
  id?: string;
  status?: "open";
  resultVersion?: number;
  createdAt?: string;
}>;

export type AdvancementSlot = Readonly<{
  matchId: string;
  slot: "home" | "away";
  entryId: string | null;
  control: "manual" | "automatic";
  controlledByRuleId: string | null;
  sourceSnapshotId: string | null;
  sourceFingerprint: string | null;
  resultVersion: number;
  updatedAt: string;
}>;

export type StandingsSnapshot = Readonly<{
  id: string;
  competitionId: string;
  divisionId: string;
  resultVersion: number;
  groups: Readonly<Record<string, StandingsGroup>>;
  crossGroup: readonly CrossGroupRow[];
  configVersion: string;
  groupCount: number;
  sourceResultHash: string;
  settingsVersion: string;
  snapshotFingerprint: string;
  createdAt: string;
  advancementSlots: readonly AdvancementSlot[];
  advancementConflicts: readonly AdvancementConflict[];
}>;

export type ResultsDocument = Readonly<{
  state: ResultsSurfaceState;
  competitionId: string;
  competitionName: string;
  divisionId: string;
  divisionName: string;
  timeZone: string;
  canRecalculate: boolean;
  currentResultVersion: number;
  snapshot: StandingsSnapshot | null;
  advancement: Readonly<{
    status: "not-returned" | "persisted" | "recalculated";
    slots: readonly AdvancementSlot[];
    changes: readonly AdvancementChange[];
    conflicts: readonly AdvancementConflict[];
  }>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{16,64}$/;
const metrics = new Set<StandingsMetric>([
  "table_points",
  "match_wins",
  "score_difference",
  "score_for",
  "segment_difference",
  "segment_ratio",
  "score_ratio",
  "head_to_head",
  "discipline",
  "seed",
  "terminal_fallback",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function iso(value: unknown): value is string {
  return string(value) && !Number.isNaN(Date.parse(value));
}

function nullableString(value: unknown): value is string | null {
  return value === null || string(value);
}

function scalar(value: unknown): value is number | string {
  return typeof value === "number" ? Number.isFinite(value) : string(value);
}

function parseTrace(value: unknown): StandingsTrace | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, ["criterion", "value", "comparedWithinEntryIds", "summary"]) ||
    !string(item.criterion) ||
    !metrics.has(item.criterion as StandingsMetric) ||
    !scalar(item.value) ||
    !Array.isArray(item.comparedWithinEntryIds) ||
    !item.comparedWithinEntryIds.every(string) ||
    !string(item.summary)
  )
    return null;
  return item as StandingsTrace;
}

function parseRow(value: unknown): StandingsRow | null {
  const item = record(value);
  const keys = [
    "rank",
    "displayOrder",
    "entryId",
    "entryName",
    "seed",
    "status",
    "eligibleForAdvancement",
    "played",
    "won",
    "drawn",
    "lost",
    "tablePoints",
    "scoreFor",
    "scoreAgainst",
    "scoreDifference",
    "segmentsWon",
    "segmentsLost",
    "disciplinePoints",
    "sportingTie",
    "resolvedBy",
    "explanations",
  ] as const;
  if (!item || !exact(item, keys)) return null;
  const numeric = [
    "rank",
    "displayOrder",
    "seed",
    "played",
    "won",
    "drawn",
    "lost",
    "tablePoints",
    "scoreFor",
    "scoreAgainst",
    "segmentsWon",
    "segmentsLost",
    "disciplinePoints",
  ] as const;
  if (
    numeric.some((key) => !integer(item[key], key === "rank" || key === "displayOrder" ? 1 : 0)) ||
    !Number.isSafeInteger(item.scoreDifference) ||
    !string(item.entryId) ||
    !string(item.entryName) ||
    !["active", "withdrawn"].includes(String(item.status)) ||
    typeof item.eligibleForAdvancement !== "boolean" ||
    typeof item.sportingTie !== "boolean" ||
    !string(item.resolvedBy) ||
    (!metrics.has(item.resolvedBy as StandingsMetric) && !["entry_id", "unresolved"].includes(item.resolvedBy)) ||
    !Array.isArray(item.explanations)
  )
    return null;
  const explanations = item.explanations.map(parseTrace);
  return explanations.some((trace) => !trace)
    ? null
    : ({ ...item, explanations: explanations as StandingsTrace[] } as unknown as StandingsRow);
}

function parseGroup(value: unknown, competitionId: string, divisionId: string): StandingsGroup | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, [
      "snapshotId",
      "competitionId",
      "divisionId",
      "groupId",
      "resultVersion",
      "configVersion",
      "calculatedAt",
      "fingerprint",
      "rows",
    ]) ||
    !string(item.snapshotId) ||
    item.competitionId !== competitionId ||
    item.divisionId !== divisionId ||
    !string(item.groupId) ||
    !integer(item.resultVersion, 1) ||
    !string(item.configVersion) ||
    !iso(item.calculatedAt) ||
    !string(item.fingerprint) ||
    !Array.isArray(item.rows)
  )
    return null;
  const rows = item.rows.map(parseRow);
  return rows.some((row) => !row) ? null : ({ ...item, rows: rows as StandingsRow[] } as unknown as StandingsGroup);
}

function parseCrossGroup(value: unknown): CrossGroupRow | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, ["rank", "displayOrder", "groupId", "entryId", "provisional", "resolved", "explanations"]) ||
    !integer(item.rank, 1) ||
    !integer(item.displayOrder, 1) ||
    !string(item.groupId) ||
    !string(item.entryId) ||
    typeof item.provisional !== "boolean" ||
    typeof item.resolved !== "boolean" ||
    !Array.isArray(item.explanations) ||
    !item.explanations.every((entry) => {
      const explanation = record(entry);
      return (
        explanation &&
        exact(explanation, ["criterion", "value"]) &&
        string(explanation.criterion) &&
        scalar(explanation.value)
      );
    })
  )
    return null;
  return item as CrossGroupRow;
}

export function parseStandingsSnapshot(
  value: unknown,
  competitionId: string,
  divisionId: string,
): StandingsSnapshot | null {
  const item = record(value);
  const hasPersistedAdvancement = Array.isArray(item?.advancement_slots) && Array.isArray(item?.advancement_conflicts);
  const expectedKeys = [
    "id",
    "competition_id",
    "division_id",
    "result_version",
    "standings",
    "explanation",
    "calculation_input_hash",
    "source_result_hash",
    "settings_version",
    "snapshot_fingerprint",
    "created_at",
    ...(hasPersistedAdvancement ? ["advancement_slots", "advancement_conflicts"] : []),
  ];
  if (
    !item ||
    !exact(item, expectedKeys) ||
    !UUID.test(String(item.id)) ||
    item.competition_id !== competitionId ||
    item.division_id !== divisionId ||
    !integer(item.result_version, 1) ||
    !HASH.test(String(item.calculation_input_hash)) ||
    item.source_result_hash !== item.calculation_input_hash ||
    !string(item.settings_version) ||
    !HASH.test(String(item.snapshot_fingerprint)) ||
    !iso(item.created_at)
  )
    return null;
  const standings = record(item.standings);
  const explanation = record(item.explanation);
  const groupsValue = record(standings?.groups);
  if (
    !standings ||
    !exact(standings, ["groups", "cross_group"]) ||
    !groupsValue ||
    !Array.isArray(standings.cross_group) ||
    !explanation ||
    !exact(explanation, ["config_version", "group_count"]) ||
    !string(explanation.config_version) ||
    !integer(explanation.group_count, 1)
  )
    return null;
  const groups = Object.fromEntries(
    Object.entries(groupsValue).map(([key, group]) => [key, parseGroup(group, competitionId, divisionId)]),
  );
  const crossGroup = standings.cross_group.map(parseCrossGroup);
  if (
    Object.keys(groups).length !== explanation.group_count ||
    Object.values(groups).some((group) => !group) ||
    crossGroup.some((row) => !row)
  )
    return null;
  const advancementSlots = hasPersistedAdvancement
    ? (item.advancement_slots as unknown[]).map((value) => parsePersistedSlot(value, item.result_version as number))
    : [];
  const advancementConflicts = hasPersistedAdvancement
    ? (item.advancement_conflicts as unknown[]).map((value) =>
        parsePersistedConflict(value, item.result_version as number),
      )
    : [];
  if (advancementSlots.some((slot) => !slot) || advancementConflicts.some((conflict) => !conflict)) return null;
  return {
    id: item.id as string,
    competitionId,
    divisionId,
    resultVersion: item.result_version,
    groups: groups as Record<string, StandingsGroup>,
    crossGroup: crossGroup as CrossGroupRow[],
    configVersion: explanation.config_version,
    groupCount: explanation.group_count,
    sourceResultHash: item.source_result_hash as string,
    settingsVersion: item.settings_version,
    snapshotFingerprint: item.snapshot_fingerprint as string,
    createdAt: item.created_at,
    advancementSlots: advancementSlots as AdvancementSlot[],
    advancementConflicts: advancementConflicts as AdvancementConflict[],
  };
}

function parsePersistedSlot(value: unknown, currentResultVersion: number): AdvancementSlot | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, [
      "match_id",
      "slot",
      "entry_id",
      "control",
      "controlled_by_rule_id",
      "source_snapshot_id",
      "source_fingerprint",
      "result_version",
      "updated_at",
    ]) ||
    !UUID.test(String(item.match_id)) ||
    !["home", "away"].includes(String(item.slot)) ||
    !nullableString(item.entry_id) ||
    !["manual", "automatic"].includes(String(item.control)) ||
    !nullableString(item.controlled_by_rule_id) ||
    !nullableString(item.source_snapshot_id) ||
    !nullableString(item.source_fingerprint) ||
    !integer(item.result_version) ||
    (item.result_version as number) > currentResultVersion ||
    !iso(item.updated_at)
  )
    return null;
  if (
    item.control === "manual" &&
    (item.controlled_by_rule_id !== null || item.source_snapshot_id !== null || item.source_fingerprint !== null)
  )
    return null;
  if (
    item.control === "automatic" &&
    (!string(item.controlled_by_rule_id) ||
      (item.entry_id !== null &&
        (!UUID.test(String(item.source_snapshot_id)) || !HASH.test(String(item.source_fingerprint)))))
  )
    return null;
  return {
    matchId: item.match_id as string,
    slot: item.slot as "home" | "away",
    entryId: item.entry_id as string | null,
    control: item.control as "manual" | "automatic",
    controlledByRuleId: item.controlled_by_rule_id as string | null,
    sourceSnapshotId: item.source_snapshot_id as string | null,
    sourceFingerprint: item.source_fingerprint as string | null,
    resultVersion: item.result_version as number,
    updatedAt: item.updated_at,
  };
}

function parsePersistedConflict(value: unknown, resultVersion: number): AdvancementConflict | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, ["id", "rule_id", "target_slot_id", "reason", "status", "result_version", "created_at"]) ||
    !UUID.test(String(item.id)) ||
    !string(item.rule_id) ||
    !string(item.target_slot_id) ||
    !string(item.reason) ||
    item.status !== "open" ||
    item.result_version !== resultVersion ||
    !iso(item.created_at)
  )
    return null;
  return {
    id: item.id as string,
    ruleId: item.rule_id,
    targetSlotId: item.target_slot_id,
    reason: item.reason,
    status: "open",
    resultVersion,
    createdAt: item.created_at,
  };
}

function parseChange(value: unknown): AdvancementChange | null {
  const item = record(value);
  return item &&
    exact(item, ["slotId", "previousEntryId", "entryId"]) &&
    string(item.slotId) &&
    nullableString(item.previousEntryId) &&
    nullableString(item.entryId)
    ? (item as AdvancementChange)
    : null;
}

function parseConflict(value: unknown): AdvancementConflict | null {
  const item = record(value);
  return item &&
    exact(item, ["ruleId", "targetSlotId", "reason"]) &&
    string(item.ruleId) &&
    string(item.targetSlotId) &&
    string(item.reason)
    ? (item as AdvancementConflict)
    : null;
}

export function parseRecalculationResponse(
  value: unknown,
  competitionId: string,
  divisionId: string,
): {
  snapshot: StandingsSnapshot;
  changes: readonly AdvancementChange[];
  conflicts: readonly AdvancementConflict[];
} | null {
  const item = record(value);
  const advancement = record(item?.advancement);
  if (
    !item ||
    !advancement ||
    !exact(advancement, ["changes", "conflicts"]) ||
    !Array.isArray(advancement.changes) ||
    !Array.isArray(advancement.conflicts)
  )
    return null;
  const snapshotValue = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "advancement"));
  const snapshot = parseStandingsSnapshot(snapshotValue, competitionId, divisionId);
  const changes = advancement.changes.map(parseChange);
  const conflicts = advancement.conflicts.map(parseConflict);
  if (!snapshot || changes.some((change) => !change) || conflicts.some((conflict) => !conflict)) return null;
  return { snapshot, changes: changes as AdvancementChange[], conflicts: conflicts as AdvancementConflict[] };
}

export function sportNameFromConfig(version: string): string {
  if (version.startsWith("canoe-polo")) return "Canoe Polo";
  if (version.startsWith("badminton")) return "Badminton";
  if (version.startsWith("table-tennis")) return "Table Tennis";
  if (version.startsWith("volleyball")) return "Volleyball";
  if (version.startsWith("basketball")) return "Basketball";
  return "Competition";
}

export function metricLabel(metric: string): string {
  const labels: Record<string, string> = {
    table_points: "table points",
    match_wins: "match wins",
    score_difference: "score difference",
    score_for: "score scored",
    segment_difference: "set or game difference",
    segment_ratio: "set ratio",
    score_ratio: "score ratio",
    head_to_head: "head-to-head result",
    discipline: "discipline record",
    seed: "seed",
    entry_id: "stable entry order",
    terminal_fallback: "terminal policy",
    unresolved: "manual resolution required",
  };
  return labels[metric] ?? metric.replaceAll("_", " ");
}

export function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export const phase3ResultsCopy = {
  title: "Standings and advancement",
  intro: "Review server-calculated tables, tie-break evidence and qualifier changes from final results.",
  eyebrow: "Results control",
  recalculate: "Recalculate from final results",
  recalculating: "Recalculating standings",
  recalculated: "Standings recalculated from persisted results.",
  resultVersion: "Result version",
  calculation: "Calculation",
  source: "Result source",
  settings: "Settings version",
  calculatedAt: "Calculated",
  current: "Current",
  stale: "Recalculation required",
  staleBody: "A newer persisted result version exists. Recalculate before using these standings for advancement.",
  noStandings: "No standings snapshot yet",
  noStandingsBody: "Finalise at least one result, then calculate the division standings.",
  loading: "Loading standings",
  error: "Standings could not load",
  errorBody: "The saved results were not changed. Retry when the results service is available.",
  offline: "Working offline",
  offlineBody: "The last saved standings are unavailable in this session. Reconnect to read or recalculate them.",
  permission: "Standings access required",
  permissionBody: "Ask an organisation administrator for competition manager access.",
  readOnly: "Results are read only",
  readOnlyBody: "You can inspect the calculation evidence, but this account cannot request a recalculation.",
  advancement: "Advancement decisions",
  advancementUnavailable: "Persisted slot provenance is not included in the standings read response.",
  advancementUnavailableBody:
    "Recalculate to review automatic changes and correction conflicts for the current result version.",
  noChanges: "No qualifier slots changed in this calculation.",
  noConflicts: "No advancement conflicts were returned for this calculation.",
  automatic: "Automatic",
  protected: "Protected or manual",
  explanation: "Ranking explanation",
  withdrawn: "Withdrawn",
  ineligible: "Not eligible to advance",
  tie: "Sporting tie",
  sourceOwned: "Server calculated",
  malformed: "The results service returned an invalid response.",
  conflict: "A correction needs organiser review",
  conflictBody: "A downstream or manually controlled qualifier slot was not overwritten.",
  calculatedStandings: "Calculated standings",
  calculatedTables: "Calculated tables",
  calculatedTablesBody: "Every rank is reproduced from final, persisted match results and the pinned sport pack.",
  entries: "entries",
  rank: "Rank",
  entry: "Entry",
  record: "Record",
  score: "Score",
  difference: "Difference",
  points: "Points",
  rankBasis: "Rank basis",
  qualifierLineage: "Qualifier lineage",
  waitingSource: "waiting for source",
  organiserControlled: "organiser controlled",
  provenance: "Standings provenance",
  evidence: "Calculation evidence",
  snapshot: "Snapshot",
  evidenceBody:
    "The source hash binds this snapshot to the current persisted result version. Corrections produce a new immutable calculation.",
  service: "Standings service",
  unassigned: "Unassigned",
} as const;

export const phase3ResultsMachine = {
  section: "results" as const,
  ready: "ready" as const,
  empty: "empty" as const,
  offline: "offline" as const,
  permission: "permission" as const,
  readOnly: "read-only" as const,
  conflict: "conflict" as const,
  saved: "saved" as const,
  unavailable: "unavailable" as const,
  recalculated: "recalculated" as const,
  persisted: "persisted" as const,
  automatic: "automatic" as const,
  manual: "manual" as const,
  post: "POST" as const,
  columnScope: "col" as const,
  rowScope: "row" as const,
  dateLocale: "en-SG" as const,
  numeric: "numeric" as const,
  short: "short" as const,
} as const;

export function resultVersionLabel(version: number): string {
  return `res_${version}`;
}

export function entryCountLabel(count: number): string {
  return `${count} ${phase3ResultsCopy.entries}`;
}

export function formatResultsTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}
