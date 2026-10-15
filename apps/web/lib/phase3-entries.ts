export type EntryType = "team" | "individual" | "placeholder";

export type EntryEditorEntry = Readonly<{
  id: string;
  name: string;
  seed: number | null;
  status: string;
  /** Missing on legacy reads; treat as "team". */
  entryType?: EntryType;
  /** Missing on legacy reads; treat as 1. */
  revision?: number;
}>;

export type EntryEditorDivision = Readonly<{
  id: string;
  name: string;
  entryLimit: number;
  entries: readonly EntryEditorEntry[];
}>;

export const phase3EntriesMachine = {
  section: "entries" as const,
  post: "POST" as const,
  patch: "PATCH" as const,
  delete: "DELETE" as const,
  applicationJson: "application/json" as const,
  maximumFreeEntries: 16,
  defaultDivisionLimit: 16,
  divisionCommandInvalid: "DIVISION_COMMAND_INVALID",
  entryCommandInvalid: "ENTRY_COMMAND_INVALID",
  divisionNameField: "division-name",
  divisionCodeField: "division-code",
  divisionLimitField: "division-limit",
  entryNameField: "entry-name",
  entrySeedField: "entry-seed",
  plannedCountField: "planned-entry-count",
  planCountField: "plan-entry-count",
  renameField: "placeholder-name",
  maximumPlannedEntries: 48,
  entryLimitToken: "{entryLimit}",
  lockedByFormatCode: "ENTRY_MUTATION_LOCKED_BY_FORMAT",
  archivedCode: "COMPETITION_ARCHIVED",
  revisionConflictCode: "REVISION_CONFLICT",
  placeholderEntryType: "placeholder" as const,
  entryNameToken: "{entryName}",
  teamEntryType: "team" as const,
  freePlanMessageFragment: "free plan",
};

export const phase3EntriesCopy = {
  title: "Divisions and entries",
  intro:
    "Create every division, then add entries. You can plan how many teams each division has and name them later. Free competitions allow at most 16 active entries across all divisions, including unnamed teams.",
  eyebrow: "Competition structure",
  divisionName: "Division name",
  divisionCode: "Division code",
  divisionLimit: "Division entry limit",
  addDivision: "Add division",
  entryName: "Entry name",
  seed: "Seed",
  addEntry: "Add entry",
  confirmed: "Confirmed entries",
  freeUsage: "Free-plan entry usage",
  freeLimit: "16 entries maximum across this competition",
  divisionCreated: "Division created.",
  entryCreated: "Entry added.",
  divisionNameRequired: "Enter a division name between 2 and 100 characters.",
  divisionLimitInvalid: "Select a division entry limit between 2 and 128.",
  entryNameRequired: "Enter a team or competitor name between 2 and 120 characters.",
  entrySeedInvalid: "Enter a whole number seed between 1 and 48, or leave blank.",
  commandFailed: "The change could not be saved. Your current entries remain unchanged.",
  invalidResponse: "The entries service returned an invalid response.",
  authRequired: "Your session can no longer change this competition.",
  freeLimitReached: "Free plan permits at most 16 active entries across all divisions.",
  duplicate: "That division or entry already exists.",
  empty: "No entries yet.",
  busy: "Saving…",
  readOnly: "You can review entries, but only an owner or organiser can change them.",
  plannedTeams: "Planned teams (optional)",
  plannedTeamsHint: "Add this many unnamed teams now and name them later.",
  plannedTeamsInvalid: "Enter a whole number of planned teams from 1 to 48, or leave blank.",
  plannedTeamsExceedsLimit:
    "Enter a number of planned teams no higher than the {entryLimit} places left in this division.",
  planCountRequired: "Enter how many unnamed teams to plan, from 1 to 48.",
  unnamedBadge: "Unnamed",
  rename: "Name this team",
  renameSave: "Save name",
  planMore: "Plan more teams",
  planMoreCount: "Unnamed teams to add",
  planned: "Planned teams added.",
  renamed: "Team named.",
  lockedByFormat: "Teams cannot be added after a format is saved. You can still name the teams already planned.",
  archived: "This competition is archived, so its entries can no longer change.",
  revisionConflict: "This team was changed elsewhere. Refresh the page and try again.",
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) && (value as number) >= minimum;
}

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/;

function hasAllowedKeys(
  item: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(item);
  return (
    required.every((key) => Object.hasOwn(item, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function plannedCount(value: unknown): value is number {
  return integer(value, 1) && value <= phase3EntriesMachine.maximumPlannedEntries;
}

export function isDivisionCreateBody(value: unknown): value is {
  name: string;
  code?: string;
  entry_limit: 8 | 12 | 16 | 24 | 48;
  planned_entry_count?: number;
  idempotency_key: string;
} {
  const item = record(value);
  if (!item) return false;
  if (!hasAllowedKeys(item, ["entry_limit", "idempotency_key", "name"], ["code", "planned_entry_count"])) return false;
  return (
    (item.planned_entry_count === undefined ||
      (plannedCount(item.planned_entry_count) && item.planned_entry_count <= (item.entry_limit as number))) &&
    typeof item.name === "string" &&
    item.name.trim().length > 0 &&
    item.name.trim().length <= 100 &&
    typeof item.idempotency_key === "string" &&
    /^[A-Za-z0-9._:-]{8,200}$/.test(item.idempotency_key) &&
    (item.code === undefined ||
      (typeof item.code === "string" && item.code.trim().length > 0 && item.code.trim().length <= 24)) &&
    [8, 12, 16, 24, 48].includes(item.entry_limit as number)
  );
}

export function isEntryCreateBody(value: unknown): value is {
  name: string;
  entry_type?: "team" | "individual" | "placeholder";
  seed?: number | null;
  idempotency_key: string;
} {
  const item = record(value);
  if (!item) return false;
  const keys = Object.keys(item).sort().join(",");
  if (
    ![
      "idempotency_key,name",
      "entry_type,idempotency_key,name",
      "idempotency_key,name,seed",
      "entry_type,idempotency_key,name,seed",
    ].includes(keys)
  )
    return false;
  return (
    typeof item.name === "string" &&
    item.name.trim().length > 0 &&
    item.name.trim().length <= 120 &&
    typeof item.idempotency_key === "string" &&
    /^[A-Za-z0-9._:-]{8,200}$/.test(item.idempotency_key) &&
    (item.entry_type === undefined || ["team", "individual", "placeholder"].includes(String(item.entry_type))) &&
    (item.seed === undefined || item.seed === null || (integer(item.seed, 1) && item.seed <= 48))
  );
}

export function parseCreatedEntry(value: unknown, expectedDivisionId?: string): EntryEditorEntry | null {
  const item = record(value);
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.division_id !== "string" ||
    (expectedDivisionId !== undefined && item.division_id !== expectedDivisionId) ||
    typeof item.name !== "string" ||
    (item.status !== "active" && item.status !== "confirmed") ||
    !(item.seed === null || integer(item.seed, 1)) ||
    !(item.entry_type === undefined || ["team", "individual", "placeholder"].includes(String(item.entry_type))) ||
    !(item.revision === undefined || integer(item.revision, 1))
  )
    return null;
  return {
    id: item.id,
    name: item.name,
    seed: item.seed as number | null,
    status: item.status,
    entryType: (item.entry_type as EntryType | undefined) ?? phase3EntriesMachine.teamEntryType,
    revision: (item.revision as number | undefined) ?? 1,
  };
}

function parseEntryList(value: unknown, divisionId: string): EntryEditorEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => parseCreatedEntry(entry, divisionId));
  return entries.every((entry): entry is EntryEditorEntry => entry !== null) ? entries : null;
}

export function parseCreatedDivision(
  value: unknown,
  expectedCompetitionId?: string,
  expectedEntryLimit?: number,
  expectedPlannedCount?: number,
): EntryEditorDivision | null {
  const item = record(value);
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.competition_id !== "string" ||
    (expectedCompetitionId !== undefined && item.competition_id !== expectedCompetitionId) ||
    typeof item.name !== "string" ||
    !integer(item.team_limit, 1) ||
    ![8, 12, 16, 24, 48].includes(item.team_limit) ||
    (expectedEntryLimit !== undefined && item.team_limit !== expectedEntryLimit)
  )
    return null;
  // Older API builds omit `entries`; treat that as "no placeholders created".
  const entries = item.entries === undefined ? [] : parseEntryList(item.entries, item.id);
  if (!entries || (expectedPlannedCount !== undefined && entries.length !== expectedPlannedCount)) return null;
  return { id: item.id, name: item.name, entryLimit: item.team_limit, entries };
}

export function parsePlannedEntries(value: unknown, expectedDivisionId: string): EntryEditorEntry[] | null {
  const item = record(value);
  if (!item || item.division_id !== expectedDivisionId) return null;
  const entries = parseEntryList(item.entries, expectedDivisionId);
  return entries && entries.length > 0 ? entries : null;
}

export function isPlaceholderEntry(entry: Pick<EntryEditorEntry, "entryType">): boolean {
  return entry.entryType === phase3EntriesMachine.placeholderEntryType;
}

export function isEntryPlanBody(value: unknown): value is { count: number; idempotency_key: string } {
  const item = record(value);
  return Boolean(
    item &&
    hasAllowedKeys(item, ["count", "idempotency_key"], []) &&
    plannedCount(item.count) &&
    typeof item.idempotency_key === "string" &&
    idempotencyKeyPattern.test(item.idempotency_key),
  );
}

export function isEntryRenameBody(value: unknown): value is {
  revision: number;
  name: string;
  entry_type?: EntryType;
  idempotency_key: string;
} {
  const item = record(value);
  return Boolean(
    item &&
    hasAllowedKeys(item, ["idempotency_key", "name", "revision"], ["entry_type"]) &&
    integer(item.revision, 1) &&
    typeof item.name === "string" &&
    item.name.trim().length > 0 &&
    item.name.trim().length <= 120 &&
    (item.entry_type === undefined || ["team", "individual", "placeholder"].includes(String(item.entry_type))) &&
    typeof item.idempotency_key === "string" &&
    idempotencyKeyPattern.test(item.idempotency_key),
  );
}

export function totalActiveEntries(divisions: readonly EntryEditorDivision[]): number {
  return divisions.reduce(
    (total, division) =>
      total + division.entries.filter((entry) => entry.status === "active" || entry.status === "confirmed").length,
    0,
  );
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateDivisionInput(
  rawName: unknown,
  rawLimit: unknown,
): ValidationResult<{ name: string; entryLimit: number }> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length < 2 || name.length > 100) {
    return { ok: false, error: phase3EntriesCopy.divisionNameRequired };
  }
  const limit = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 2 || limit > 128) {
    return { ok: false, error: phase3EntriesCopy.divisionLimitInvalid };
  }
  return { ok: true, value: { name, entryLimit: limit } };
}

/**
 * Validates an optional planned-team count typed by the organiser.
 * Blank means "not planned" (null). Only ASCII digits are accepted; leading
 * zeros are ignored. `placesLeft` is the remaining capacity of the division.
 */
export function normalisePlannedCount(raw: unknown, placesLeft?: number): ValidationResult<number | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
  if (text === null) return { ok: false, error: phase3EntriesCopy.plannedTeamsInvalid };
  if (text === "") return { ok: true, value: null };
  if (!/^[0-9]+$/.test(text)) return { ok: false, error: phase3EntriesCopy.plannedTeamsInvalid };
  const count = Number(text.replace(/^0+(?=\d)/, ""));
  if (!Number.isSafeInteger(count) || count < 1 || count > phase3EntriesMachine.maximumPlannedEntries) {
    return { ok: false, error: phase3EntriesCopy.plannedTeamsInvalid };
  }
  if (placesLeft !== undefined && count > placesLeft) {
    return {
      ok: false,
      error: phase3EntriesCopy.plannedTeamsExceedsLimit.replace(
        phase3EntriesMachine.entryLimitToken,
        String(Math.max(0, placesLeft)),
      ),
    };
  }
  return { ok: true, value: count };
}

/** Tidies the planned-count field on blur: trims, strips leading zeros, clears anything invalid. */
export function tidyPlannedCountInput(raw: string): string {
  const result = normalisePlannedCount(raw);
  return result.ok && result.value !== null ? String(result.value) : "";
}

export function validateEntryInput(
  rawName: unknown,
  rawSeed?: unknown,
): ValidationResult<{ name: string; seed: number | null }> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length < 2 || name.length > 120) {
    return { ok: false, error: phase3EntriesCopy.entryNameRequired };
  }
  if (rawSeed === undefined || rawSeed === null || (typeof rawSeed === "string" && rawSeed.trim() === "")) {
    return { ok: true, value: { name, seed: null } };
  }
  const seed = typeof rawSeed === "number" ? rawSeed : Number(rawSeed);
  if (!Number.isInteger(seed) || seed < 1 || seed > 48) {
    return { ok: false, error: phase3EntriesCopy.entrySeedInvalid };
  }
  return { ok: true, value: { name, seed } };
}
