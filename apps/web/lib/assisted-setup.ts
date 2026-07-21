import {
  createDefaultFormatTemplates,
  defaultFormatEntryCounts,
  type DefaultFormatEntryCount,
  type FormatTemplateStrategy,
} from "@matchday/domain";

export const ASSISTED_SETUP_DRAFT_KEY = "matchday.assisted-setup.draft.v1";
export const ASSISTED_SETUP_DRAFT_VERSION = 1;
export const ASSISTED_SETUP_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type RecommendationId = "fast" | "balanced" | "depth";

export type AssistedSetupDraft = {
  readonly version: typeof ASSISTED_SETUP_DRAFT_VERSION;
  readonly savedAt: number;
  readonly activeStep: number;
  readonly competitionName: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly venue: string;
  readonly teams: number;
  readonly divisions: number;
  readonly areas: number;
  readonly slotMinutes: number;
  readonly days: ReadonlyArray<{ readonly label: string; readonly opening: string; readonly closing: string }>;
  readonly areaAvailability: readonly ("full" | "limited" | "unavailable")[];
  readonly unavailableMinutes: number;
  readonly settingsMode: "recommended" | "customised";
  readonly recommendation: RecommendationId;
  readonly schedule: "fastest" | "balanced" | "rest";
};

const strategyByRecommendation: Record<RecommendationId, FormatTemplateStrategy> = {
  fast: "compact_knockout",
  balanced: "championship_focus",
  depth: "full_placement",
};

const canonicalEstimateCache = new Map<DefaultFormatEntryCount, ReadonlyMap<FormatTemplateStrategy, number>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isRecommendation(value: unknown): value is RecommendationId {
  return value === "fast" || value === "balanced" || value === "depth";
}

export function estimateMatches(teams: number, divisions: number, recommendation: RecommendationId): number {
  if (
    !Number.isInteger(teams) ||
    !Number.isInteger(divisions) ||
    teams < 2 ||
    teams > 512 ||
    divisions < 1 ||
    divisions > Math.floor(teams / 2)
  ) {
    return 0;
  }

  const baseSize = Math.floor(teams / divisions);
  const remainder = teams % divisions;
  return Array.from({ length: divisions }, (_, divisionIndex) => baseSize + (divisionIndex < remainder ? 1 : 0)).reduce(
    (total, entryCount) => total + estimateDivisionMatches(entryCount, recommendation),
    0,
  );
}

function estimateDivisionMatches(entryCount: number, recommendation: RecommendationId): number {
  if (entryCount < 2) return 0;
  if (defaultFormatEntryCounts.includes(entryCount as DefaultFormatEntryCount)) {
    const canonicalEntryCount = entryCount as DefaultFormatEntryCount;
    let estimates = canonicalEstimateCache.get(canonicalEntryCount);
    if (!estimates) {
      estimates = new Map(
        createDefaultFormatTemplates(canonicalEntryCount).map((template) => [
          template.strategy,
          template.metrics.matchCount,
        ]),
      );
      canonicalEstimateCache.set(canonicalEntryCount, estimates);
    }
    const estimate = estimates.get(strategyByRecommendation[recommendation]);
    if (estimate !== undefined) return estimate;
  }

  // Transparent prototype fallback for non-canonical division sizes. Pools are
  // split as evenly as possible with at most four entries per pool. The three
  // paths then add a short knockout, a half-field championship path, or a full
  // classification path respectively.
  const poolCount = Math.ceil(entryCount / 4);
  const poolBaseSize = Math.floor(entryCount / poolCount);
  const largerPools = entryCount % poolCount;
  const poolMatches = Array.from(
    { length: poolCount },
    (_, poolIndex) => poolBaseSize + (poolIndex < largerPools ? 1 : 0),
  ).reduce((total, poolSize) => total + (poolSize * (poolSize - 1)) / 2, 0);

  if (recommendation === "fast") return entryCount;
  if (recommendation === "balanced") return poolMatches + Math.ceil(entryCount / 2);
  return poolMatches + Math.max(1, entryCount - 2);
}

export function parseAssistedSetupDraft(raw: string | null, now = Date.now()): AssistedSetupDraft | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== ASSISTED_SETUP_DRAFT_VERSION) return null;
  if (!isIntegerInRange(value.savedAt, 1, now) || now - value.savedAt > ASSISTED_SETUP_DRAFT_MAX_AGE_MS) return null;
  if (!isIntegerInRange(value.activeStep, 0, 7)) return null;
  if (typeof value.competitionName !== "string" || value.competitionName.length > 120) return null;
  if (!isDate(value.startDate) || !isDate(value.endDate)) return null;
  if (typeof value.venue !== "string" || value.venue.length > 160) return null;
  if (!isIntegerInRange(value.teams, 2, 512) || !isIntegerInRange(value.divisions, 1, Math.floor(value.teams / 2)))
    return null;
  if (!isIntegerInRange(value.areas, 1, 64)) return null;
  const slotMinutes = value.slotMinutes;
  if (typeof slotMinutes !== "number" || ![20, 30, 40, 45].includes(slotMinutes)) return null;
  if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 14) return null;
  const days = value.days.flatMap((day) => {
    if (
      !isRecord(day) ||
      typeof day.label !== "string" ||
      day.label.length > 40 ||
      !isTime(day.opening) ||
      !isTime(day.closing)
    ) {
      return [];
    }
    return [{ label: day.label, opening: day.opening, closing: day.closing }];
  });
  if (days.length !== value.days.length) return null;
  if (!Array.isArray(value.areaAvailability) || value.areaAvailability.length > 64) return null;
  const areaAvailability = value.areaAvailability.filter(
    (item): item is "full" | "limited" | "unavailable" =>
      item === "full" || item === "limited" || item === "unavailable",
  );
  if (areaAvailability.length !== value.areaAvailability.length) return null;
  if (!isIntegerInRange(value.unavailableMinutes, 0, 10_080)) return null;
  if (value.settingsMode !== "recommended" && value.settingsMode !== "customised") return null;
  if (!isRecommendation(value.recommendation)) return null;
  if (value.schedule !== "fastest" && value.schedule !== "balanced" && value.schedule !== "rest") return null;

  return {
    version: ASSISTED_SETUP_DRAFT_VERSION,
    savedAt: value.savedAt,
    activeStep: value.activeStep,
    competitionName: value.competitionName,
    startDate: value.startDate,
    endDate: value.endDate,
    venue: value.venue,
    teams: value.teams,
    divisions: value.divisions,
    areas: value.areas,
    slotMinutes,
    days,
    areaAvailability,
    unavailableMinutes: value.unavailableMinutes,
    settingsMode: value.settingsMode,
    recommendation: value.recommendation,
    schedule: value.schedule,
  };
}
