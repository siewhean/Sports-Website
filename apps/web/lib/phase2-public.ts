import type {
  PublicCompetitionProjection,
  PublicDivisionProjection,
  PublicProjectionFreshness,
} from "@matchday/contracts";

export type GateCC4PublicCompetitionProjection = PublicCompetitionProjection &
  Readonly<{ freshness: PublicProjectionFreshness }>;

export const publicSportNames = {
  canoe_polo: "Canoe Polo",
  badminton: "Badminton",
  table_tennis: "Table Tennis",
  volleyball: "Volleyball",
  basketball: "Basketball",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPublicDivisionProjection(value: unknown): value is PublicDivisionProjection {
  if (!value || typeof value !== "object") return false;
  const division = value as Partial<PublicDivisionProjection>;
  return Boolean(
    division.division &&
    typeof division.division.id === "string" &&
    typeof division.division.name === "string" &&
    Array.isArray(division.schedule) &&
    Array.isArray(division.results) &&
    (division.standings === null || (typeof division.standings === "object" && !Array.isArray(division.standings))) &&
    (division.bracket === null || (typeof division.bracket === "object" && !Array.isArray(division.bracket))),
  );
}

export function isPublicCompetitionProjection(value: unknown): value is PublicCompetitionProjection {
  if (!value || typeof value !== "object") return false;
  const projection = value as Partial<PublicCompetitionProjection>;
  return Boolean(
    projection.competition &&
    typeof projection.competition.id === "string" &&
    typeof projection.competition.name === "string" &&
    typeof projection.competition.slug === "string" &&
    typeof projection.competition.sport_code === "string" &&
    projection.competition.sport_code in publicSportNames &&
    Array.isArray(projection.divisions) &&
    projection.divisions.length > 0 &&
    projection.divisions.every(isPublicDivisionProjection) &&
    projection.division &&
    typeof projection.division.id === "string" &&
    Array.isArray(projection.schedule) &&
    Array.isArray(projection.results) &&
    projection.publication &&
    typeof projection.last_updated_at === "string",
  );
}

export function isGateCC4PublicCompetitionProjection(value: unknown): value is GateCC4PublicCompetitionProjection {
  if (!isPublicCompetitionProjection(value) || !isRecord((value as Record<string, unknown>).freshness)) return false;
  const freshness = (value as unknown as { freshness: Record<string, unknown> }).freshness;
  const generatedAt = typeof freshness.generated_at === "string" ? Date.parse(freshness.generated_at) : Number.NaN;
  const sourceUpdatedAt =
    typeof freshness.source_updated_at === "string" ? Date.parse(freshness.source_updated_at) : Number.NaN;
  return Boolean(
    typeof freshness.division_id === "string" &&
    freshness.division_id === value.division.id &&
    Number.isSafeInteger(freshness.schedule_version) &&
    freshness.schedule_version === value.publication.schedule_version &&
    Number.isSafeInteger(freshness.result_version) &&
    freshness.result_version === value.publication.result_version &&
    Number.isSafeInteger(freshness.projection_version) &&
    (freshness.projection_version as number) >= 1 &&
    Number.isFinite(generatedAt) &&
    Number.isFinite(sourceUpdatedAt) &&
    generatedAt >= sourceUpdatedAt &&
    typeof freshness.etag === "string" &&
    /^[A-Za-z0-9._:-]{1,250}$/u.test(freshness.etag),
  );
}

export function publicSportName(code: PublicCompetitionProjection["competition"]["sport_code"]): string {
  return publicSportNames[code];
}
