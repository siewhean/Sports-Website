export const SUPPORTED_SPORTS = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const;

export type SportId = (typeof SUPPORTED_SPORTS)[number];
export type CompetitionStatus = "draft" | "ready" | "published" | "live" | "completed" | "archived";
export type RestorableCompetitionStatus = Exclude<CompetitionStatus, "archived">;
export type EntryType = "team" | "individual" | "placeholder";
export type EntryStatus = "active" | "withdrawn" | "replaced";
export type PlanTier = "free" | "organiser_pro" | "event_pass";

export type CompetitionLocation = {
  venue: string;
  address: string;
  locality: string | null;
  countryCode: string;
};

export type AvailabilityWindow = {
  start: string;
  end: string;
};

export type EntryMetadata = {
  club: string | null;
  association: string | null;
  countryCode: string | null;
};

export type CompetitionEntryRecord = {
  id: string;
  divisionId: string;
  name: string;
  type: EntryType;
  status: EntryStatus;
  seed: number | null;
  metadata: EntryMetadata;
  availability: readonly AvailabilityWindow[];
  replacementEntryId: string | null;
  replacesEntryId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompetitionDivision = {
  id: string;
  name: string;
  code: string | null;
  entries: readonly CompetitionEntryRecord[];
  createdAt: string;
  updatedAt: string;
};

export type Competition = {
  id: string;
  organisationId: string;
  name: string;
  slug: string;
  sport: SportId;
  status: CompetitionStatus;
  location: CompetitionLocation;
  startDate: string;
  endDate: string;
  timeZone: string;
  locale: string;
  firstMatchStartedAt: string | null;
  archivedFromStatus: RestorableCompetitionStatus | null;
  divisions: readonly CompetitionDivision[];
  createdAt: string;
  updatedAt: string;
};

export type CompetitionPermission =
  | "competition:create"
  | "competition:update"
  | "competition:delete"
  | "competition:transition"
  | "competition:duplicate"
  | "competition:archive"
  | "competition:restore"
  | "division:manage"
  | "entry:manage"
  | "entry:import";

export type AuditIntent = {
  action: string;
  actorId: string;
  aggregateType: "competition" | "division" | "entry" | "entry_import";
  aggregateId: string;
  competitionId: string;
  occurredAt: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
};

export type CommandContext = {
  actorId: string;
  occurredAt: string;
};

export type DomainErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_STATE_TRANSITION"
  | "SPORT_LOCKED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FREE_ENTRY_LIMIT_REACHED"
  | "IMPORT_VALIDATION_FAILED";

export type ValidationIssue = {
  code: string;
  path: string;
  message: string;
  row: number | null;
};

export type DomainError = {
  code: DomainErrorCode;
  message: string;
  issues: readonly ValidationIssue[];
  upgradeRequired: boolean;
  limit: number | null;
};

export type CommandSuccess<T> = {
  ok: true;
  value: T;
  requiredPermission: CompetitionPermission;
  audit: readonly AuditIntent[];
};

export type CommandResult<T> = CommandSuccess<T> | { ok: false; error: DomainError };

export type CompetitionInput = {
  id: string;
  organisationId: string;
  name: string;
  slug: string;
  sport: SportId;
  location: CompetitionLocation;
  startDate: string;
  endDate: string;
  timeZone: string;
  locale: string;
};

export type CompetitionPatch = Partial<
  Pick<Competition, "name" | "slug" | "sport" | "location" | "startDate" | "endDate" | "timeZone" | "locale">
>;

export type EntryInput = {
  id: string;
  name: string;
  type: EntryType;
  seed?: number | null;
  metadata?: Partial<EntryMetadata>;
  availability?: readonly AvailabilityWindow[];
};

const FREE_ENTRY_LIMIT = 16;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const STATUS_TRANSITIONS: Readonly<Record<RestorableCompetitionStatus, readonly CompetitionStatus[]>> = {
  draft: ["ready", "archived"],
  ready: ["draft", "published", "archived"],
  published: ["live", "archived"],
  live: ["completed", "archived"],
  completed: ["archived"],
};

function issue(code: string, path: string, message: string, row: number | null = null): ValidationIssue {
  return { code, path, message, row };
}

function failure<T>(
  code: DomainErrorCode,
  message: string,
  issues: readonly ValidationIssue[] = [],
  options: { upgradeRequired?: boolean; limit?: number | null } = {},
): CommandResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      issues,
      upgradeRequired: options.upgradeRequired ?? false,
      limit: options.limit ?? null,
    },
  };
}

function success<T>(
  value: T,
  requiredPermission: CompetitionPermission,
  audit: AuditIntent | readonly AuditIntent[],
): CommandResult<T> {
  return deepFreeze({
    ok: true,
    value: cloneAndFreeze(value),
    requiredPermission,
    audit: structuredClone(Array.isArray(audit) ? audit : [audit]),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function audit(
  context: CommandContext,
  competitionId: string,
  aggregateType: AuditIntent["aggregateType"],
  aggregateId: string,
  action: string,
  details: AuditIntent["details"] = {},
): AuditIntent {
  return {
    action,
    actorId: context.actorId,
    aggregateType,
    aggregateId,
    competitionId,
    occurredAt: context.occurredAt,
    details,
  };
}

function validInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function localDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function validateContext(context: CommandContext): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!context.actorId.trim()) issues.push(issue("required", "context.actorId", "Actor ID is required"));
  if (!validInstant(context.occurredAt)) {
    issues.push(issue("invalid_instant", "context.occurredAt", "Occurred-at must be a canonical ISO instant"));
  }
  return issues;
}

function validateCompetitionFields(input: CompetitionInput | Competition): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.id.trim()) issues.push(issue("required", "id", "Competition ID is required"));
  if (!input.organisationId.trim()) issues.push(issue("required", "organisationId", "Organisation ID is required"));
  if (!input.name.trim()) issues.push(issue("required", "name", "Competition name is required"));
  if (!SLUG_PATTERN.test(input.slug))
    issues.push(issue("invalid_slug", "slug", "Slug must use lowercase words and hyphens"));
  if (!(SUPPORTED_SPORTS as readonly string[]).includes(input.sport)) {
    issues.push(issue("unsupported_sport", "sport", "Competition must use one supported sport"));
  }
  if (!input.location.venue.trim()) issues.push(issue("required", "location.venue", "Venue is required"));
  if (!input.location.address.trim()) issues.push(issue("required", "location.address", "Address is required"));
  if (!COUNTRY_PATTERN.test(input.location.countryCode)) {
    issues.push(issue("invalid_country", "location.countryCode", "Country code must be ISO 3166-1 alpha-2"));
  }
  if (!validDate(input.startDate))
    issues.push(issue("invalid_date", "startDate", "Start date must be a real YYYY-MM-DD date"));
  if (!validDate(input.endDate))
    issues.push(issue("invalid_date", "endDate", "End date must be a real YYYY-MM-DD date"));
  if (validDate(input.startDate) && validDate(input.endDate) && input.endDate < input.startDate) {
    issues.push(issue("invalid_date_range", "endDate", "End date cannot be before start date"));
  }
  if (!validTimeZone(input.timeZone))
    issues.push(issue("invalid_time_zone", "timeZone", "Time zone must be a valid IANA zone"));
  if (!input.locale.trim()) issues.push(issue("required", "locale", "Locale is required"));
  return issues;
}

function validateAvailability(
  windows: readonly AvailabilityWindow[],
  competition: Pick<Competition, "startDate" | "endDate" | "timeZone">,
  path: string,
  row: number | null = null,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sorted = [...windows].sort((left, right) => left.start.localeCompare(right.start));
  for (let index = 0; index < sorted.length; index += 1) {
    const window = sorted[index]!;
    const itemPath = `${path}.${index}`;
    if (!validInstant(window.start))
      issues.push(issue("invalid_instant", `${itemPath}.start`, "Start must be a canonical ISO instant", row));
    if (!validInstant(window.end))
      issues.push(issue("invalid_instant", `${itemPath}.end`, "End must be a canonical ISO instant", row));
    if (validInstant(window.start) && validInstant(window.end)) {
      if (window.end <= window.start)
        issues.push(issue("invalid_interval", itemPath, "Availability end must be after start", row));
      const startLocal = localDate(window.start, competition.timeZone);
      const endLocal = localDate(new Date(Date.parse(window.end) - 1).toISOString(), competition.timeZone);
      if (startLocal < competition.startDate || endLocal > competition.endDate) {
        issues.push(
          issue(
            "outside_competition_dates",
            itemPath,
            "Availability must fall within competition dates in its time zone",
            row,
          ),
        );
      }
      const previous = sorted[index - 1];
      if (previous && window.start < previous.end) {
        issues.push(issue("overlapping_availability", itemPath, "Availability windows cannot overlap", row));
      }
    }
  }
  return issues;
}

function validateEntryInput(
  input: EntryInput,
  competition: Competition,
  path = "entry",
  row: number | null = null,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.id.trim()) issues.push(issue("required", `${path}.id`, "Entry ID is required", row));
  if (!input.name.trim()) issues.push(issue("required", `${path}.name`, "Entry name is required", row));
  if (!(["team", "individual", "placeholder"] as readonly string[]).includes(input.type)) {
    issues.push(issue("invalid_entry_type", `${path}.type`, "Entry type is invalid", row));
  }
  if (input.seed !== undefined && input.seed !== null && (!Number.isInteger(input.seed) || input.seed < 1)) {
    issues.push(issue("invalid_seed", `${path}.seed`, "Seed must be a positive integer", row));
  }
  const country = input.metadata?.countryCode;
  if (country !== undefined && country !== null && !COUNTRY_PATTERN.test(country)) {
    issues.push(
      issue("invalid_country", `${path}.metadata.countryCode`, "Country code must be ISO 3166-1 alpha-2", row),
    );
  }
  issues.push(...validateAvailability(input.availability ?? [], competition, `${path}.availability`, row));
  return issues;
}

function mapDivision(
  competition: Competition,
  divisionId: string,
  mapper: (division: CompetitionDivision) => CompetitionDivision,
  occurredAt: string,
): Competition {
  return {
    ...competition,
    divisions: competition.divisions.map((division) => (division.id === divisionId ? mapper(division) : division)),
    updatedAt: occurredAt,
  };
}

function findDivision(competition: Competition, divisionId: string): CompetitionDivision | undefined {
  return competition.divisions.find((division) => division.id === divisionId);
}

function activeEntryCount(competition: Competition): number {
  return competition.divisions.reduce(
    (total, division) => total + division.entries.filter((entry) => entry.status === "active").length,
    0,
  );
}

function entryLimitFailure<T>(competition: Competition, additional: number, tier: PlanTier): CommandResult<T> | null {
  if (tier !== "free" || activeEntryCount(competition) + additional <= FREE_ENTRY_LIMIT) return null;
  return failure(
    "FREE_ENTRY_LIMIT_REACHED",
    `The free plan supports ${FREE_ENTRY_LIMIT} active entries across all divisions`,
    [issue("free_entry_limit", "entries", "Upgrade this competition without deleting existing entries, then retry")],
    { upgradeRequired: true, limit: FREE_ENTRY_LIMIT },
  );
}

function makeEntry(input: EntryInput, divisionId: string, occurredAt: string): CompetitionEntryRecord {
  return {
    id: input.id,
    divisionId,
    name: input.name.trim(),
    type: input.type,
    status: "active",
    seed: input.seed ?? null,
    metadata: {
      club: input.metadata?.club?.trim() || null,
      association: input.metadata?.association?.trim() || null,
      countryCode: input.metadata?.countryCode ?? null,
    },
    availability: [...(input.availability ?? [])].sort((left, right) => left.start.localeCompare(right.start)),
    replacementEntryId: null,
    replacesEntryId: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function ensureMutable<T>(competition: Competition): CommandResult<T> | null {
  return competition.status === "archived"
    ? failure("CONFLICT", "Archived competitions must be restored before editing")
    : null;
}

export function createCompetition(input: CompetitionInput, context: CommandContext): CommandResult<Competition> {
  const issues = [...validateContext(context), ...validateCompetitionFields(input)];
  if (issues.length) return failure("VALIDATION_ERROR", "Competition is invalid", issues);
  const value: Competition = {
    ...input,
    name: input.name.trim(),
    status: "draft",
    firstMatchStartedAt: null,
    archivedFromStatus: null,
    divisions: [],
    createdAt: context.occurredAt,
    updatedAt: context.occurredAt,
  };
  return success(
    value,
    "competition:create",
    audit(context, value.id, "competition", value.id, "competition.created", { sport: value.sport }),
  );
}

export function updateCompetition(
  competition: Competition,
  patch: CompetitionPatch,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  if (["published", "live", "completed"].includes(competition.status)) {
    return failure("CONFLICT", "Published competition configuration must change through a new revision");
  }
  const contextIssues = validateContext(context);
  if (contextIssues.length) return failure("VALIDATION_ERROR", "Command context is invalid", contextIssues);
  if (patch.sport !== undefined && patch.sport !== competition.sport && competition.firstMatchStartedAt !== null) {
    return failure("SPORT_LOCKED", "Sport cannot change after the first match starts", [
      issue("sport_locked", "sport", "Sport is locked by started match history"),
    ]);
  }
  const candidate: Competition = { ...competition, ...patch, updatedAt: context.occurredAt };
  const issues = validateCompetitionFields(candidate);
  if (issues.length) return failure("VALIDATION_ERROR", "Competition is invalid", issues);
  const changedFields = Object.keys(patch).sort().join(",");
  return success(
    candidate,
    "competition:update",
    audit(context, candidate.id, "competition", candidate.id, "competition.updated", { changedFields }),
  );
}

export function deleteCompetition(competition: Competition, context: CommandContext): CommandResult<null> {
  const issues = validateContext(context);
  if (issues.length) return failure("VALIDATION_ERROR", "Command context is invalid", issues);
  if (competition.status !== "draft" || competition.firstMatchStartedAt !== null) {
    return failure("CONFLICT", "Only an unstarted draft competition can be deleted");
  }
  return success(
    null,
    "competition:delete",
    audit(context, competition.id, "competition", competition.id, "competition.deleted"),
  );
}

export function transitionCompetition(
  competition: Competition,
  target: CompetitionStatus,
  context: CommandContext,
): CommandResult<Competition> {
  const issues = validateContext(context);
  if (issues.length) return failure("VALIDATION_ERROR", "Command context is invalid", issues);
  if (competition.status === "archived" || !STATUS_TRANSITIONS[competition.status].includes(target)) {
    return failure("INVALID_STATE_TRANSITION", `Cannot transition competition from ${competition.status} to ${target}`);
  }
  if (target === "ready" && competition.divisions.length === 0) {
    return failure("CONFLICT", "A competition needs at least one division before it can be ready");
  }
  const value: Competition = {
    ...competition,
    status: target,
    archivedFromStatus: target === "archived" ? competition.status : null,
    updatedAt: context.occurredAt,
  };
  return success(
    value,
    target === "archived" ? "competition:archive" : "competition:transition",
    audit(context, value.id, "competition", value.id, `competition.${target}`, {
      from: competition.status,
      to: target,
    }),
  );
}

export function markFirstMatchStarted(
  competition: Competition,
  startedAt: string,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const issues = [...validateContext(context)];
  if (!validInstant(startedAt))
    issues.push(issue("invalid_instant", "startedAt", "Match start must be a canonical ISO instant"));
  if (issues.length) return failure("VALIDATION_ERROR", "Match start is invalid", issues);
  if (competition.firstMatchStartedAt !== null) {
    return success(competition, "competition:update", []);
  }
  const value = { ...competition, firstMatchStartedAt: startedAt, updatedAt: context.occurredAt };
  return success(
    value,
    "competition:update",
    audit(context, value.id, "competition", value.id, "competition.first_match_started", {
      sportLocked: true,
      startedAt,
    }),
  );
}

export function addDivision(
  competition: Competition,
  input: { id: string; name: string; code?: string | null },
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const issues = [...validateContext(context)];
  if (!input.id.trim()) issues.push(issue("required", "division.id", "Division ID is required"));
  if (!input.name.trim()) issues.push(issue("required", "division.name", "Division name is required"));
  if (competition.divisions.some((division) => division.id === input.id)) {
    issues.push(issue("duplicate_id", "division.id", "Division ID already exists"));
  }
  if (
    competition.divisions.some(
      (division) => division.name.toLocaleLowerCase() === input.name.trim().toLocaleLowerCase(),
    )
  ) {
    issues.push(issue("duplicate_name", "division.name", "Division name already exists"));
  }
  if (issues.length) return failure("VALIDATION_ERROR", "Division is invalid", issues);
  const division: CompetitionDivision = {
    id: input.id,
    name: input.name.trim(),
    code: input.code?.trim() || null,
    entries: [],
    createdAt: context.occurredAt,
    updatedAt: context.occurredAt,
  };
  const value = { ...competition, divisions: [...competition.divisions, division], updatedAt: context.occurredAt };
  return success(
    value,
    "division:manage",
    audit(context, competition.id, "division", division.id, "division.created", { name: division.name }),
  );
}

export function updateDivision(
  competition: Competition,
  divisionId: string,
  patch: { name?: string; code?: string | null },
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  if (!division) return failure("NOT_FOUND", "Division was not found");
  const name = patch.name?.trim() ?? division.name;
  const issues = [...validateContext(context)];
  if (!name) issues.push(issue("required", "division.name", "Division name is required"));
  if (
    competition.divisions.some(
      (candidate) => candidate.id !== divisionId && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    issues.push(issue("duplicate_name", "division.name", "Division name already exists"));
  }
  if (issues.length) return failure("VALIDATION_ERROR", "Division is invalid", issues);
  const value = mapDivision(
    competition,
    divisionId,
    (current) => ({
      ...current,
      ...patch,
      name,
      code: patch.code === undefined ? current.code : patch.code?.trim() || null,
      updatedAt: context.occurredAt,
    }),
    context.occurredAt,
  );
  return success(value, "division:manage", audit(context, competition.id, "division", divisionId, "division.updated"));
}

export function deleteDivision(
  competition: Competition,
  divisionId: string,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  if (!division) return failure("NOT_FOUND", "Division was not found");
  if (division.entries.length > 0) return failure("CONFLICT", "A division with entry history cannot be deleted");
  const issues = validateContext(context);
  if (issues.length) return failure("VALIDATION_ERROR", "Command context is invalid", issues);
  const value = {
    ...competition,
    divisions: competition.divisions.filter((candidate) => candidate.id !== divisionId),
    updatedAt: context.occurredAt,
  };
  return success(value, "division:manage", audit(context, competition.id, "division", divisionId, "division.deleted"));
}

export function addEntry(
  competition: Competition,
  divisionId: string,
  input: EntryInput,
  tier: PlanTier,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  if (!division) return failure("NOT_FOUND", "Division was not found");
  const issues = [...validateContext(context), ...validateEntryInput(input, competition)];
  if (competition.divisions.some((candidate) => candidate.entries.some((entry) => entry.id === input.id))) {
    issues.push(issue("duplicate_id", "entry.id", "Entry ID already exists in this competition"));
  }
  if (
    division.entries.some(
      (entry) => entry.status === "active" && entry.name.toLocaleLowerCase() === input.name.trim().toLocaleLowerCase(),
    )
  ) {
    issues.push(issue("duplicate_name", "entry.name", "Active entry name already exists in this division"));
  }
  if (input.seed != null && division.entries.some((entry) => entry.status === "active" && entry.seed === input.seed)) {
    issues.push(issue("duplicate_seed", "entry.seed", "Seed already exists in this division"));
  }
  if (issues.length) return failure("VALIDATION_ERROR", "Entry is invalid", issues);
  const limit = entryLimitFailure<Competition>(competition, 1, tier);
  if (limit) return limit;
  const entry = makeEntry(input, divisionId, context.occurredAt);
  const value = mapDivision(
    competition,
    divisionId,
    (current) => ({ ...current, entries: [...current.entries, entry], updatedAt: context.occurredAt }),
    context.occurredAt,
  );
  return success(
    value,
    "entry:manage",
    audit(context, competition.id, "entry", entry.id, "entry.created", { divisionId, entryType: entry.type }),
  );
}

export function updateEntry(
  competition: Competition,
  divisionId: string,
  entryId: string,
  patch: Partial<Pick<EntryInput, "name" | "type" | "seed" | "metadata" | "availability">>,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  const entry = division?.entries.find((candidate) => candidate.id === entryId);
  if (!division || !entry) return failure("NOT_FOUND", "Entry was not found");
  if (entry.status !== "active") return failure("CONFLICT", "Withdrawn or replaced entry history cannot be edited");
  const input: EntryInput = {
    id: entry.id,
    name: patch.name ?? entry.name,
    type: patch.type ?? entry.type,
    seed: patch.seed === undefined ? entry.seed : patch.seed,
    metadata: patch.metadata === undefined ? entry.metadata : { ...entry.metadata, ...patch.metadata },
    availability: patch.availability ?? entry.availability,
  };
  const issues = [...validateContext(context), ...validateEntryInput(input, competition)];
  if (
    division.entries.some(
      (candidate) =>
        candidate.id !== entryId &&
        candidate.status === "active" &&
        candidate.name.toLocaleLowerCase() === input.name.trim().toLocaleLowerCase(),
    )
  ) {
    issues.push(issue("duplicate_name", "entry.name", "Active entry name already exists in this division"));
  }
  if (
    input.seed != null &&
    division.entries.some(
      (candidate) => candidate.id !== entryId && candidate.status === "active" && candidate.seed === input.seed,
    )
  ) {
    issues.push(issue("duplicate_seed", "entry.seed", "Seed already exists in this division"));
  }
  if (issues.length) return failure("VALIDATION_ERROR", "Entry is invalid", issues);
  const updated = {
    ...makeEntry(input, divisionId, entry.createdAt),
    status: entry.status,
    replacementEntryId: entry.replacementEntryId,
    replacesEntryId: entry.replacesEntryId,
    updatedAt: context.occurredAt,
  };
  const value = mapDivision(
    competition,
    divisionId,
    (current) => ({
      ...current,
      entries: current.entries.map((candidate) => (candidate.id === entryId ? updated : candidate)),
      updatedAt: context.occurredAt,
    }),
    context.occurredAt,
  );
  return success(value, "entry:manage", audit(context, competition.id, "entry", entryId, "entry.updated"));
}

export function deleteEntry(
  competition: Competition,
  divisionId: string,
  entryId: string,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  const entry = division?.entries.find((candidate) => candidate.id === entryId);
  if (!division || !entry) return failure("NOT_FOUND", "Entry was not found");
  if (entry.status !== "active" || entry.replacementEntryId !== null || entry.replacesEntryId !== null) {
    return failure("CONFLICT", "Entry history involved in withdrawal or replacement cannot be deleted");
  }
  const issues = validateContext(context);
  if (issues.length) return failure("VALIDATION_ERROR", "Command context is invalid", issues);
  const value = mapDivision(
    competition,
    divisionId,
    (current) => ({
      ...current,
      entries: current.entries.filter((candidate) => candidate.id !== entryId),
      updatedAt: context.occurredAt,
    }),
    context.occurredAt,
  );
  return success(value, "entry:manage", audit(context, competition.id, "entry", entryId, "entry.deleted"));
}

export function withdrawEntry(
  competition: Competition,
  divisionId: string,
  entryId: string,
  reason: string,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  const entry = division?.entries.find((candidate) => candidate.id === entryId);
  if (!division || !entry) return failure("NOT_FOUND", "Entry was not found");
  if (entry.status !== "active") return failure("CONFLICT", "Only an active entry can be withdrawn");
  const issues = [...validateContext(context)];
  if (!reason.trim()) issues.push(issue("required", "reason", "Withdrawal reason is required"));
  if (issues.length) return failure("VALIDATION_ERROR", "Withdrawal is invalid", issues);
  const value = mapDivision(
    competition,
    divisionId,
    (current) => ({
      ...current,
      entries: current.entries.map((candidate) =>
        candidate.id === entryId ? { ...candidate, status: "withdrawn", updatedAt: context.occurredAt } : candidate,
      ),
      updatedAt: context.occurredAt,
    }),
    context.occurredAt,
  );
  return success(
    value,
    "entry:manage",
    audit(context, competition.id, "entry", entryId, "entry.withdrawn", { reason: reason.trim() }),
  );
}

export function replaceEntry(
  competition: Competition,
  divisionId: string,
  entryId: string,
  replacement: EntryInput,
  tier: PlanTier,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  const entry = division?.entries.find((candidate) => candidate.id === entryId);
  if (!division || !entry) return failure("NOT_FOUND", "Entry was not found");
  if (entry.status !== "active" && entry.status !== "withdrawn") {
    return failure("CONFLICT", "Only an active or withdrawn entry can be replaced");
  }
  const replacementInput = { ...replacement, seed: replacement.seed === undefined ? entry.seed : replacement.seed };
  const issues = [...validateContext(context), ...validateEntryInput(replacementInput, competition, "replacement")];
  if (competition.divisions.some((candidate) => candidate.entries.some((item) => item.id === replacement.id))) {
    issues.push(issue("duplicate_id", "replacement.id", "Replacement entry ID already exists"));
  }
  if (
    division.entries.some(
      (candidate) =>
        candidate.id !== entryId &&
        candidate.status === "active" &&
        candidate.name.toLocaleLowerCase() === replacementInput.name.trim().toLocaleLowerCase(),
    )
  ) {
    issues.push(issue("duplicate_name", "replacement.name", "Active entry name already exists in this division"));
  }
  if (
    replacementInput.seed != null &&
    division.entries.some(
      (candidate) =>
        candidate.id !== entryId && candidate.status === "active" && candidate.seed === replacementInput.seed,
    )
  ) {
    issues.push(issue("duplicate_seed", "replacement.seed", "Seed already exists in this division"));
  }
  if (issues.length) return failure("VALIDATION_ERROR", "Replacement is invalid", issues);
  const limit = entryLimitFailure<Competition>(competition, entry.status === "active" ? 0 : 1, tier);
  if (limit) return limit;
  const newEntry = { ...makeEntry(replacementInput, divisionId, context.occurredAt), replacesEntryId: entryId };
  const value = mapDivision(
    competition,
    divisionId,
    (current) => ({
      ...current,
      entries: [
        ...current.entries.map((candidate) =>
          candidate.id === entryId
            ? {
                ...candidate,
                status: "replaced" as const,
                replacementEntryId: newEntry.id,
                updatedAt: context.occurredAt,
              }
            : candidate,
        ),
        newEntry,
      ],
      updatedAt: context.occurredAt,
    }),
    context.occurredAt,
  );
  return success(value, "entry:manage", [
    audit(context, competition.id, "entry", entryId, "entry.replaced", { replacementEntryId: newEntry.id }),
    audit(context, competition.id, "entry", newEntry.id, "entry.created_as_replacement", { replacesEntryId: entryId }),
  ]);
}

export type ImportEntryDraft = Omit<EntryInput, "id">;
export type ImportIdFactory = (row: number, draft: Readonly<ImportEntryDraft>) => string;

function importEntries(
  competition: Competition,
  divisionId: string,
  drafts: readonly { row: number; draft: ImportEntryDraft }[],
  idFactory: ImportIdFactory,
  tier: PlanTier,
  context: CommandContext,
): CommandResult<Competition> {
  const blocked = ensureMutable<Competition>(competition);
  if (blocked) return blocked;
  const division = findDivision(competition, divisionId);
  if (!division) return failure("NOT_FOUND", "Division was not found");
  const issues: ValidationIssue[] = [...validateContext(context)];
  for (const { row, draft } of drafts) {
    issues.push(...validateEntryInput({ ...draft, id: "pending-import-id" }, competition, `rows.${row}`, row));
  }
  const names = [
    ...division.entries.filter((entry) => entry.status === "active").map((entry) => entry.name),
    ...drafts.map(({ draft }) => draft.name),
  ].map((name) => name.trim().toLocaleLowerCase());
  if (new Set(names).size !== names.length)
    issues.push(issue("duplicate_name", "rows", "Import creates duplicate active entry names"));
  const seeds = [
    ...division.entries.filter((entry) => entry.status === "active" && entry.seed !== null).map((entry) => entry.seed),
    ...drafts.filter(({ draft }) => draft.seed != null).map(({ draft }) => draft.seed as number),
  ];
  if (new Set(seeds).size !== seeds.length)
    issues.push(issue("duplicate_seed", "rows", "Import creates duplicate seeds"));
  if (issues.length)
    return failure("IMPORT_VALIDATION_FAILED", "No entries were imported because the batch is invalid", issues);
  const limit = entryLimitFailure<Competition>(competition, drafts.length, tier);
  if (limit) return limit;
  const inputs: { row: number; input: EntryInput }[] = [];
  for (const { row, draft } of drafts) {
    try {
      inputs.push({ row, input: { ...draft, id: idFactory(row, cloneAndFreeze(draft)) } });
    } catch {
      return failure("IMPORT_VALIDATION_FAILED", "No entries were imported because ID generation failed", [
        issue(
          "id_factory_error",
          `rows.${row}.id`,
          "ID generation failed; aggregate state is unchanged, but external generator state may have advanced",
          row,
        ),
      ]);
    }
  }
  const idIssues: ValidationIssue[] = [];
  for (const { row, input } of inputs) {
    if (typeof input.id !== "string" || !input.id.trim()) {
      idIssues.push(issue("required", `rows.${row}.id`, "Entry ID must be a non-empty string", row));
    }
  }
  const allIds = [
    ...competition.divisions.flatMap((item) => item.entries.map((entry) => entry.id)),
    ...inputs.map(({ input }) => input.id),
  ];
  if (new Set(allIds).size !== allIds.length) {
    idIssues.push(issue("duplicate_id", "rows", "Import creates duplicate entry IDs"));
  }
  if (idIssues.length) {
    return failure("IMPORT_VALIDATION_FAILED", "No entries were imported because generated IDs are invalid", idIssues);
  }
  const entries = inputs.map(({ input }) => makeEntry(input, divisionId, context.occurredAt));
  const value = mapDivision(
    competition,
    divisionId,
    (current) => ({ ...current, entries: [...current.entries, ...entries], updatedAt: context.occurredAt }),
    context.occurredAt,
  );
  return success(
    value,
    "entry:import",
    audit(
      context,
      competition.id,
      "entry_import",
      `${competition.id}:${divisionId}:${context.occurredAt}`,
      "entries.imported",
      {
        divisionId,
        count: entries.length,
      },
    ),
  );
}

export function importPasteList(
  competition: Competition,
  divisionId: string,
  text: string,
  defaults: Pick<ImportEntryDraft, "type">,
  idFactory: ImportIdFactory,
  tier: PlanTier,
  context: CommandContext,
): CommandResult<Competition> {
  const rows = text
    .split(/\r?\n/)
    .map((value, index) => ({ row: index + 1, value: value.trim() }))
    .filter(({ value }) => value.length > 0)
    .map(({ row, value }) => ({ row, draft: { name: value, type: defaults.type } }));
  if (rows.length === 0) {
    return failure("IMPORT_VALIDATION_FAILED", "Paste list has no entries", [
      issue("empty_import", "text", "Provide at least one non-empty line"),
    ]);
  }
  return importEntries(competition, divisionId, rows, idFactory, tier, context);
}

export type CsvColumn = "name" | "type" | "seed" | "club" | "association" | "countryCode";
export type CsvColumnMapping = Partial<Record<CsvColumn, string>> & { name: string };

function parseCsv(text: string): CommandResult<readonly string[][]> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "field_start" | "unquoted" | "quoted" | "after_quote" = "field_start";
  const finishField = () => {
    row.push(field);
    field = "";
    state = "field_start";
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };
  const invalidCsv = (message: string): CommandResult<readonly string[][]> =>
    failure("IMPORT_VALIDATION_FAILED", "CSV is not valid RFC 4180 data", [issue("invalid_csv", "csv", message)]);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (state === "quoted") {
      if (character === '"') state = "after_quote";
      else field += character;
      continue;
    }
    if (state === "after_quote") {
      if (character === '"') {
        field += '"';
        state = "quoted";
      } else if (character === ",") finishField();
      else if (character === "\n") finishRow();
      else if (character === "\r" && text[index + 1] === "\n") {
        finishRow();
        index += 1;
      } else return invalidCsv("Only a delimiter or line ending may follow a closing quote");
      continue;
    }
    if (state === "field_start" && character === '"') {
      state = "quoted";
    } else if (character === '"') {
      return invalidCsv("A quote may only begin at the start of a field");
    } else if (character === ",") finishField();
    else if (character === "\n") finishRow();
    else if (character === "\r" && text[index + 1] === "\n") {
      finishRow();
      index += 1;
    } else if (character === "\r") {
      return invalidCsv("A carriage return outside a quoted field must be followed by a line feed");
    } else {
      field += character;
      state = "unquoted";
    }
  }
  if (state === "quoted")
    return failure("IMPORT_VALIDATION_FAILED", "CSV contains an unterminated quoted field", [
      issue("invalid_csv", "csv", "Quoted field is not closed"),
    ]);
  finishField();
  if (row.some((value) => value.length > 0) || rows.length === 0) rows.push(row);
  return success(rows, "entry:import", []);
}

export function importCsv(
  competition: Competition,
  divisionId: string,
  csv: string,
  mapping: CsvColumnMapping,
  defaults: Pick<ImportEntryDraft, "type">,
  idFactory: ImportIdFactory,
  tier: PlanTier,
  context: CommandContext,
): CommandResult<Competition> {
  const parsed = parseCsv(csv);
  if (!parsed.ok) return parsed;
  const [headerRow, ...dataRows] = parsed.value;
  if (!headerRow) return failure("IMPORT_VALIDATION_FAILED", "CSV is empty");
  const headers = headerRow.map((header) => header.trim());
  const mappedHeaders = Object.entries(mapping).filter((entry): entry is [CsvColumn, string] => entry[1] !== undefined);
  const missing = mappedHeaders.filter(([, header]) => !headers.includes(header));
  if (missing.length) {
    return failure(
      "IMPORT_VALIDATION_FAILED",
      "CSV mapping references missing columns",
      missing.map(([column, header]) =>
        issue("missing_column", `mapping.${column}`, `Column '${header}' was not found`),
      ),
    );
  }
  const indexes = Object.fromEntries(
    mappedHeaders.map(([column, header]) => [column, headers.indexOf(header)]),
  ) as Partial<Record<CsvColumn, number>>;
  const rows: { row: number; draft: ImportEntryDraft }[] = [];
  const conversionIssues: ValidationIssue[] = [];
  dataRows.forEach((values, index) => {
    const rowNumber = index + 2;
    if (values.every((value) => !value.trim())) return;
    const value = (column: CsvColumn): string | undefined => {
      const columnIndex = indexes[column];
      return columnIndex === undefined ? undefined : values[columnIndex]?.trim();
    };
    const typeValue = value("type") || defaults.type;
    const seedValue = value("seed");
    if (!(["team", "individual", "placeholder"] as readonly string[]).includes(typeValue)) {
      conversionIssues.push(
        issue("invalid_entry_type", `rows.${rowNumber}.type`, `Unknown entry type '${typeValue}'`, rowNumber),
      );
    }
    if (seedValue && !/^\d+$/.test(seedValue)) {
      conversionIssues.push(
        issue("invalid_seed", `rows.${rowNumber}.seed`, "Seed must be a positive integer", rowNumber),
      );
    }
    rows.push({
      row: rowNumber,
      draft: {
        name: value("name") ?? "",
        type: typeValue as EntryType,
        seed: seedValue ? Number(seedValue) : null,
        metadata: {
          club: value("club") || null,
          association: value("association") || null,
          countryCode: value("countryCode") || null,
        },
      },
    });
  });
  if (conversionIssues.length) {
    return failure("IMPORT_VALIDATION_FAILED", "No entries were imported because the CSV is invalid", conversionIssues);
  }
  if (rows.length === 0) return failure("IMPORT_VALIDATION_FAILED", "CSV has no data rows");
  return importEntries(competition, divisionId, rows, idFactory, tier, context);
}

export type CompetitionDuplicateIds = {
  competitionId: string;
  divisionIds: Readonly<Record<string, string>>;
  entryIds: Readonly<Record<string, string>>;
};

export function duplicateCompetition(
  competition: Competition,
  ids: CompetitionDuplicateIds,
  input: { name: string; slug: string; startDate: string; endDate: string },
  context: CommandContext,
): CommandResult<Competition> {
  const candidate: Competition = {
    ...competition,
    id: ids.competitionId,
    name: input.name.trim(),
    slug: input.slug,
    startDate: input.startDate,
    endDate: input.endDate,
    status: "draft",
    firstMatchStartedAt: null,
    archivedFromStatus: null,
    divisions: competition.divisions.map((division) => {
      const divisionId = ids.divisionIds[division.id] ?? "";
      return {
        ...division,
        id: divisionId,
        entries: division.entries
          .filter((entry) => entry.status === "active")
          .map((entry) => ({
            ...entry,
            id: ids.entryIds[entry.id] ?? "",
            divisionId,
            status: "active",
            availability: [],
            replacementEntryId: null,
            replacesEntryId: null,
            createdAt: context.occurredAt,
            updatedAt: context.occurredAt,
          })),
        createdAt: context.occurredAt,
        updatedAt: context.occurredAt,
      };
    }),
    createdAt: context.occurredAt,
    updatedAt: context.occurredAt,
  };
  const issues = [...validateContext(context), ...validateCompetitionFields(candidate)];
  if (candidate.id === competition.id)
    issues.push(issue("duplicate_id", "ids.competitionId", "Duplicate requires a new competition ID"));
  const sourceDivisionIds = competition.divisions.map((division) => division.id);
  for (const id of sourceDivisionIds)
    if (!ids.divisionIds[id]) issues.push(issue("missing_id", `ids.divisionIds.${id}`, "New division ID is required"));
  const sourceEntryIds = competition.divisions.flatMap((division) =>
    division.entries.filter((entry) => entry.status === "active").map((entry) => entry.id),
  );
  for (const id of sourceEntryIds)
    if (!ids.entryIds[id]) issues.push(issue("missing_id", `ids.entryIds.${id}`, "New entry ID is required"));
  const generatedIds = [
    candidate.id,
    ...candidate.divisions.map((division) => division.id),
    ...candidate.divisions.flatMap((division) => division.entries.map((entry) => entry.id)),
  ];
  if (new Set(generatedIds).size !== generatedIds.length)
    issues.push(issue("duplicate_id", "ids", "All duplicate IDs must be unique"));
  for (const division of candidate.divisions) {
    for (const entry of division.entries) issues.push(...validateEntryInput(entry, candidate, `entries.${entry.id}`));
  }
  if (issues.length) return failure("VALIDATION_ERROR", "Competition duplicate is invalid", issues);
  return success(
    candidate,
    "competition:duplicate",
    audit(context, candidate.id, "competition", candidate.id, "competition.duplicated", {
      sourceCompetitionId: competition.id,
    }),
  );
}

export function archiveCompetition(competition: Competition, context: CommandContext): CommandResult<Competition> {
  return transitionCompetition(competition, "archived", context);
}

export function restoreCompetition(competition: Competition, context: CommandContext): CommandResult<Competition> {
  const issues = validateContext(context);
  if (issues.length) return failure("VALIDATION_ERROR", "Command context is invalid", issues);
  if (competition.status !== "archived" || competition.archivedFromStatus === null) {
    return failure("INVALID_STATE_TRANSITION", "Only an archived competition with a prior status can be restored");
  }
  const restoredStatus = competition.archivedFromStatus;
  const value: Competition = {
    ...competition,
    status: restoredStatus,
    archivedFromStatus: null,
    updatedAt: context.occurredAt,
  };
  return success(
    value,
    "competition:restore",
    audit(context, value.id, "competition", value.id, "competition.restored", { restoredStatus }),
  );
}

export function countActiveEntries(competition: Competition): number {
  return activeEntryCount(competition);
}

export const COMPETITION_FREE_ENTRY_LIMIT = FREE_ENTRY_LIMIT;
