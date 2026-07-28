import type { PublicCompetitionProjection, PublicDivisionProjection } from "@matchday/contracts";

export const publicSportNames = {
  canoe_polo: "Canoe Polo",
  badminton: "Badminton",
  table_tennis: "Table Tennis",
  volleyball: "Volleyball",
  basketball: "Basketball",
} as const;

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

export function publicSportName(code: PublicCompetitionProjection["competition"]["sport_code"]): string {
  return publicSportNames[code];
}
