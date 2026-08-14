import {
  competitionCreateFieldOrder,
  type CompetitionCreateDraft,
  type CompetitionCreateField,
} from "./phase3-competition-create";

const competitionDraftStorageVersion = 1;
const competitionDraftStoragePrefix = "matchday:v1:competition-create:";
const maximumStoredDraftBytes = 131_072;
const persistedFieldMaximums: Record<CompetitionCreateField, number> = {
  organisation_id: 128,
  name: 160,
  slug: 120,
  sport_code: 64,
  venue: 16_384,
  address: 16_384,
  locality: 16_384,
  country_code: 8,
  starts_on: 32,
  ends_on: 32,
  timezone: 128,
  locale: 64,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isPersistableDraft(value: unknown): value is CompetitionCreateDraft {
  if (!isRecord(value) || !hasExactKeys(value, competitionCreateFieldOrder)) return false;
  return competitionCreateFieldOrder.every((field) => {
    const fieldValue = value[field];
    return typeof fieldValue === "string" && fieldValue.length <= persistedFieldMaximums[field];
  });
}

export function competitionCreateDraftStorageKey(accountId: string): string {
  const normalized = accountId.trim();
  if (normalized.length < 1 || normalized.length > 128) throw new Error("Invalid competition draft owner");
  return `${competitionDraftStoragePrefix}${encodeURIComponent(normalized)}`;
}

export function serializeCompetitionCreateDraft(draft: CompetitionCreateDraft): string {
  if (!isPersistableDraft(draft)) throw new Error("Competition draft is too large to save");
  const serialized = JSON.stringify({ version: competitionDraftStorageVersion, draft });
  if (serialized.length > maximumStoredDraftBytes) throw new Error("Competition draft is too large to save");
  return serialized;
}

export function parseCompetitionCreateDraft(raw: string): CompetitionCreateDraft | null {
  if (raw.length < 1 || raw.length > maximumStoredDraftBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["version", "draft"])) return null;
  if (value.version !== competitionDraftStorageVersion || !isPersistableDraft(value.draft)) return null;
  return value.draft;
}
