import type { ScheduledMatch } from "./schedule.js";
import type { BracketResolution, CanoePoloResult, StandingsRow } from "./results.js";

type PublicationBase = {
  competitionId: string;
  divisionId: string;
  publicationVersion: number;
  publishedAt: string;
};

export type ResultPublicationProjection = PublicationBase & {
  kind: "results";
  results: readonly CanoePoloResult[];
  standings: readonly StandingsRow[];
  bracket: BracketResolution;
  lastUpdatedAt: string;
};

export type SchedulePublicationProjection = PublicationBase & {
  kind: "schedule";
  scheduleRevisionId: string;
  matches: readonly ScheduledMatch[];
};

function validatePublication(input: PublicationBase): void {
  if (!input.competitionId || !input.divisionId) throw new Error("Publication requires competition and division IDs");
  if (!Number.isInteger(input.publicationVersion) || input.publicationVersion < 1) {
    throw new Error("Publication version must be a positive integer");
  }
  if (!Number.isFinite(Date.parse(input.publishedAt))) throw new Error("Publication requires a valid timestamp");
}

export function buildResultPublicationProjection(
  input: Omit<ResultPublicationProjection, "kind">,
): ResultPublicationProjection {
  validatePublication(input);
  if (!Number.isFinite(Date.parse(input.lastUpdatedAt)))
    throw new Error("Result publication requires a valid update timestamp");
  return { ...input, kind: "results" };
}

export function buildSchedulePublicationProjection(
  input: Omit<SchedulePublicationProjection, "kind">,
): SchedulePublicationProjection {
  validatePublication(input);
  if (!input.scheduleRevisionId) throw new Error("Schedule publication requires a revision ID");
  return { ...input, kind: "schedule" };
}
