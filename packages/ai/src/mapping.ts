import type {
  Phase4AiMappingResult,
  Phase4AiMissingField,
  Phase4CompetitionBrief,
  Phase4FormatRecommendationInput,
  Phase4SetupInput,
} from "@matchday/contracts";
import { validateCompetitionBrief, type BriefValidationIssue } from "./schema.js";

export class InvalidCompetitionBriefError extends Error {
  constructor(readonly issues: readonly BriefValidationIssue[]) {
    super("Competition brief failed schema or business validation");
    this.name = "InvalidCompetitionBriefError";
  }
}

function validatedCompetitionBrief(value: unknown): Phase4CompetitionBrief {
  const result = validateCompetitionBrief(value);
  if (!result.ok) throw new InvalidCompetitionBriefError(result.issues);
  return result.brief;
}

function requiredMissing(brief: Phase4CompetitionBrief): Phase4AiMissingField[] {
  return brief.missing_fields;
}

export function mapBriefToSetupInput(value: unknown): Phase4AiMappingResult<Phase4SetupInput> {
  const brief = validatedCompetitionBrief(value);
  const missing = requiredMissing(brief);
  if (missing.length > 0) return { ok: false, missing_fields: [...missing] };

  const {
    sport,
    entry_count: entryCount,
    division_count: divisionCount,
    location,
    playing_areas: playingAreas,
    daily_availability: dailyAvailability,
    time_slot_minutes: timeSlotMinutes,
    minimum_matches_per_entry: minimumMatchesPerEntry,
    knockout_required: knockoutRequired,
    rank_all_entries: rankAllEntries,
    placement_required: placementRequired,
    cross_group_qualification_allowed: crossGroupQualificationAllowed,
    organiser_priority: organiserPriority,
  } = brief;
  const { start, end } = brief.dates;
  if (
    sport === null ||
    entryCount === null ||
    divisionCount === null ||
    location === null ||
    start === null ||
    end === null ||
    playingAreas === null ||
    dailyAvailability === null ||
    timeSlotMinutes === null ||
    minimumMatchesPerEntry === null ||
    knockoutRequired === null ||
    rankAllEntries === null ||
    placementRequired === null ||
    crossGroupQualificationAllowed === null ||
    organiserPriority === null
  ) {
    throw new Error("Validated competition brief contains an inconsistent missing_fields projection");
  }
  const divisions =
    brief.divisions?.map((division) => ({ name: division.name, entryCount: division.entry_count })) ??
    (divisionCount === 1 ? [{ name: "Open", entryCount }] : []);
  if (divisions.length !== divisionCount) {
    return { ok: false, missing_fields: ["divisions"] };
  }

  return {
    ok: true,
    value: {
      name: brief.name,
      sport,
      entryCount,
      divisionCount,
      divisions,
      location,
      dates: { start, end },
      playingAreas,
      dailyAvailability: dailyAvailability.map((window) => ({
        date: window.date,
        startTime: window.start_time,
        endTime: window.end_time,
      })),
      timeSlotMinutes,
      minimumMatchesPerEntry,
      knockoutRequired,
      rankAllEntries,
      placementRequired,
      crossGroupQualificationAllowed,
      organiserPriority,
    },
  };
}

export function mapBriefToFormatRecommendationInput(
  value: unknown,
  capacity: { availableMatchSlots: number },
): Phase4AiMappingResult<Phase4FormatRecommendationInput> {
  const brief = validatedCompetitionBrief(value);
  const setup = mapBriefToSetupInput(brief);
  if (!setup.ok) return setup;
  if (!Number.isInteger(capacity.availableMatchSlots) || capacity.availableMatchSlots < 0) {
    throw new Error("availableMatchSlots must be a non-negative integer calculated by the capacity engine");
  }
  return {
    ok: true,
    value: {
      sport: setup.value.sport,
      entryCount: setup.value.entryCount,
      divisionCount: setup.value.divisionCount,
      availableMatchSlots: capacity.availableMatchSlots,
      minimumMatchesPerEntry: setup.value.minimumMatchesPerEntry,
      rankAllEntries: setup.value.rankAllEntries,
      knockoutRequired: setup.value.knockoutRequired,
      placementRequired: setup.value.placementRequired,
      crossGroupQualificationAllowed: setup.value.crossGroupQualificationAllowed,
      organiserPriority: setup.value.organiserPriority,
    },
  };
}
