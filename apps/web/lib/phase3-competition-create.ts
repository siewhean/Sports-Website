export const phase3CompetitionSports = [
  { code: "canoe_polo" },
  { code: "badminton" },
  { code: "table_tennis" },
  { code: "volleyball" },
  { code: "basketball" },
] as const;

export type Phase3CompetitionSport = (typeof phase3CompetitionSports)[number]["code"];

// Every value here is guaranteed to satisfy isIanaTimeZone below, since both
// come from the same Intl.supportedValuesOf("timeZone") call. Falls back to
// just the configured default on a runtime that predates the API, so the
// timezone select never renders empty.
export const phase3TimeZones: readonly string[] =
  typeof Intl.supportedValuesOf === "function"
    ? [...Intl.supportedValuesOf("timeZone")].sort((a, b) => a.localeCompare(b))
    : ["Asia/Singapore"];

export const competitionCreateFieldOrder = [
  "organisation_id",
  "name",
  "slug",
  "sport_code",
  "venue",
  "address",
  "locality",
  "country_code",
  "starts_on",
  "ends_on",
  "timezone",
  "locale",
] as const;

export type CompetitionCreateField = (typeof competitionCreateFieldOrder)[number];

export type CompetitionCreateDraft = Record<CompetitionCreateField, string>;

export type CompetitionCreateCommand = CompetitionCreateDraft & {
  idempotency_key: string;
};

export type CompetitionCreateReceipt = Readonly<{
  id: string;
  status: "draft";
  sport_code: Phase3CompetitionSport;
  revision: number;
  account_default_applied: boolean;
}>;

export type CompetitionOrganisationOption = Readonly<{
  id: string;
  name: string;
  role: "owner" | "organiser";
}>;

export type CompetitionOrganisationBootstrapReceipt = CompetitionOrganisationOption &
  Readonly<{
    created: boolean;
  }>;

export type CompetitionCreateValidationOptions = Readonly<{
  allowOrganisationBootstrap?: boolean;
}>;

export const phase3CompetitionCreateMachine = {
  post: "POST",
  applicationJson: "application/json",
  noStore: "no-store",
  idempotencyKey: "idempotency_key",
  validationError: "VALIDATION_ERROR",
  invalidRequest: "The competition details are invalid",
  optionsPath: "/api/v1/organisations/competition-options",
  bootstrapPath: "/api/v1/organisations/competition-options/bootstrap",
  bootstrapRoute: "/api/phase3/organisations/bootstrap",
  optionsUnavailable: "The organisation service is unavailable",
  authRequired: "AUTH_REQUIRED",
  apiUnavailable: "API_UNAVAILABLE",
  organisationResponseInvalid: "ORGANISATION_RESPONSE_INVALID",
  defaults: { countryCode: "SG", timezone: "Asia/Singapore", locale: "en-SG" },
  fields: {
    organisationId: "organisation_id",
    name: "name",
    slug: "slug",
    sportCode: "sport_code",
    venue: "venue",
    address: "address",
    locality: "locality",
    countryCode: "country_code",
    startsOn: "starts_on",
    endsOn: "ends_on",
    timezone: "timezone",
    locale: "locale",
  },
  autocomplete: {
    venue: "off",
    address: "street-address",
    locality: "address-level2",
    country: "country",
  },
} as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const supportedSports = new Set<Phase3CompetitionSport>(phase3CompetitionSports.map(({ code }) => code));

// Derives a slug candidate from a competition name. Always satisfies
// slugPattern above (lowercase, digits, single hyphens between groups, no
// leading/trailing hyphen), so callers never need to re-validate the result.
export function slugifyCompetitionName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isCalendarDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function isPhase3CompetitionSport(value: unknown): value is Phase3CompetitionSport {
  return typeof value === "string" && supportedSports.has(value as Phase3CompetitionSport);
}

export function isCompetitionCreateRequest(value: unknown): value is CompetitionCreateCommand {
  if (!isRecord(value) || !hasExactKeys(value, [...competitionCreateFieldOrder, "idempotency_key"])) return false;
  if (!competitionCreateFieldOrder.every((field) => typeof value[field] === "string")) return false;
  const draft = value as CompetitionCreateDraft;
  return (
    typeof value.idempotency_key === "string" &&
    /^[A-Za-z0-9._:-]{8,200}$/.test(value.idempotency_key) &&
    competitionCreateFieldOrder.every((field) => competitionCreateFieldIsValid(field, draft))
  );
}

export function parseCompetitionCreateReceipt(value: unknown): CompetitionCreateReceipt | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "status", "sport_code", "revision", "account_default_applied"]) ||
    typeof value.id !== "string" ||
    !uuidPattern.test(value.id) ||
    value.status !== "draft" ||
    !isPhase3CompetitionSport(value.sport_code) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.account_default_applied !== "boolean"
  )
    return null;
  return value as CompetitionCreateReceipt;
}

export function parseCompetitionOrganisationOptions(value: unknown): CompetitionOrganisationOption[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const options: CompetitionOrganisationOption[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["id", "name", "role"]) ||
      typeof item.id !== "string" ||
      !uuidPattern.test(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== "string" ||
      item.name.trim().length === 0 ||
      (item.role !== "owner" && item.role !== "organiser")
    )
      return null;
    ids.add(item.id);
    options.push({ id: item.id, name: item.name, role: item.role });
  }
  return options;
}

export function parseCompetitionOrganisationBootstrapReceipt(
  value: unknown,
): CompetitionOrganisationBootstrapReceipt | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "name", "role", "created"]) ||
    typeof value.id !== "string" ||
    !uuidPattern.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    (value.role !== "owner" && value.role !== "organiser") ||
    typeof value.created !== "boolean"
  )
    return null;
  return value as CompetitionOrganisationBootstrapReceipt;
}

export function firstInvalidCompetitionCreateField(
  draft: CompetitionCreateDraft,
  options: CompetitionCreateValidationOptions = {},
): CompetitionCreateField | null {
  for (const field of competitionCreateFieldOrder) {
    if (
      field === "organisation_id" &&
      options.allowOrganisationBootstrap === true &&
      draft.organisation_id.length === 0
    ) {
      continue;
    }
    if (!competitionCreateFieldIsValid(field, draft)) return field;
  }
  return null;
}

function competitionCreateFieldIsValid(field: CompetitionCreateField, draft: CompetitionCreateDraft): boolean {
  switch (field) {
    case "organisation_id":
      return uuidPattern.test(draft.organisation_id);
    case "name":
      return draft.name.trim().length > 0 && draft.name.length <= 160;
    case "slug":
      return draft.slug.length <= 120 && slugPattern.test(draft.slug);
    case "sport_code":
      return isPhase3CompetitionSport(draft.sport_code);
    case "venue":
      return draft.venue.trim().length > 0;
    case "address":
      return draft.address.trim().length > 0;
    case "locality":
      return true;
    case "country_code":
      return /^[A-Z]{2}$/.test(draft.country_code);
    case "starts_on":
      return isCalendarDate(draft.starts_on);
    case "ends_on":
      return isCalendarDate(draft.ends_on) && draft.ends_on >= draft.starts_on;
    case "timezone":
      return isIanaTimeZone(draft.timezone);
    case "locale":
      return draft.locale.trim().length > 0;
  }
}
