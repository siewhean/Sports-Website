export type EntryEditorEntry = Readonly<{
  id: string;
  name: string;
  seed: number | null;
  status: string;
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
  teamEntryType: "team" as const,
  freePlanMessageFragment: "free plan",
};

export const phase3EntriesCopy = {
  title: "Divisions and entries",
  intro:
    "Create every division, then add entries. Free competitions allow at most 16 active entries across all divisions.",
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
  commandFailed: "The change could not be saved. Your current entries remain unchanged.",
  invalidResponse: "The entries service returned an invalid response.",
  authRequired: "Your session can no longer change this competition.",
  freeLimitReached: "Free plan permits at most 16 active entries across all divisions.",
  duplicate: "That division or entry already exists.",
  empty: "No entries yet.",
  busy: "Saving…",
  readOnly: "You can review entries, but only an owner or organiser can change them.",
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) && (value as number) >= minimum;
}

export function isDivisionCreateBody(value: unknown): value is {
  name: string;
  code?: string;
  entry_limit: 8 | 12 | 16 | 24 | 48;
  idempotency_key: string;
} {
  const item = record(value);
  if (!item) return false;
  const keys = Object.keys(item).sort().join(",");
  if (keys !== "entry_limit,idempotency_key,name" && keys !== "code,entry_limit,idempotency_key,name") return false;
  return (
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

export function parseCreatedDivision(
  value: unknown,
  expectedCompetitionId?: string,
  expectedEntryLimit?: number,
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
  return { id: item.id, name: item.name, entryLimit: item.team_limit, entries: [] };
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
    !(item.seed === null || integer(item.seed, 1))
  )
    return null;
  return { id: item.id, name: item.name, seed: item.seed as number | null, status: item.status };
}

export function totalActiveEntries(divisions: readonly EntryEditorDivision[]): number {
  return divisions.reduce(
    (total, division) =>
      total + division.entries.filter((entry) => entry.status === "active" || entry.status === "confirmed").length,
    0,
  );
}
