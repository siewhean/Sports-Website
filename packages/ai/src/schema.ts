import { phase4AiMissingFields, type Phase4AiMissingField, type Phase4CompetitionBrief } from "@matchday/contracts";
import { z } from "zod";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const countryCodePattern = /^[A-Z]{2}$/;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const isoDate = z
  .string()
  .regex(datePattern)
  .refine((value) => {
    const [yearText, monthText, dayText] = value.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= (days[month - 1] ?? 0);
  }, "Invalid calendar date");

export const competitionBriefSchema = z
  .object({
    schema_version: z.literal("1.0"),
    name: boundedText(160).nullable(),
    sport: z.enum(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]).nullable(),
    entry_count: z.number().int().min(2).max(48).nullable(),
    division_count: z.number().int().min(1).max(16).nullable(),
    divisions: z
      .array(z.object({ name: boundedText(80), entry_count: z.number().int().min(2).max(48) }).strict())
      .min(1)
      .max(16)
      .nullable(),
    location: z
      .object({
        venue: boundedText(160).nullable(),
        address: boundedText(240).nullable(),
        locality: boundedText(120).nullable(),
        country_code: z.string().regex(countryCodePattern).nullable(),
      })
      .strict()
      .nullable(),
    dates: z
      .object({
        start: isoDate.nullable(),
        end: isoDate.nullable(),
      })
      .strict(),
    playing_areas: z.number().int().min(1).max(64).nullable(),
    daily_availability: z
      .array(
        z
          .object({
            date: isoDate,
            start_time: z.string().regex(timePattern),
            end_time: z.string().regex(timePattern),
          })
          .strict(),
      )
      .min(1)
      .max(256)
      .nullable(),
    time_slot_minutes: z.number().int().min(5).max(240).nullable(),
    minimum_matches_per_entry: z.number().int().min(1).max(47).nullable(),
    knockout_required: z.boolean().nullable(),
    rank_all_entries: z.boolean().nullable(),
    placement_required: z.boolean().nullable(),
    cross_group_qualification_allowed: z.boolean().nullable(),
    organiser_priority: z.enum(["speed", "simplicity", "participation"]).nullable(),
    missing_fields: z.array(z.enum(phase4AiMissingFields)).max(phase4AiMissingFields.length),
  })
  .strict();

export type BriefValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type BriefValidationResult =
  | { ok: true; brief: Phase4CompetitionBrief; warnings: BriefValidationIssue[] }
  | { ok: false; issues: BriefValidationIssue[] };

function missingFields(brief: Omit<Phase4CompetitionBrief, "missing_fields">): Phase4AiMissingField[] {
  const missing: Phase4AiMissingField[] = [];
  if (brief.sport === null) missing.push("sport");
  if (brief.entry_count === null) missing.push("entry_count");
  if (brief.division_count === null) missing.push("division_count");
  if (brief.division_count !== null && brief.division_count > 1 && brief.divisions === null) missing.push("divisions");
  if (brief.location === null || (brief.location.venue === null && brief.location.address === null)) {
    missing.push("location");
  }
  if (brief.dates.start === null) missing.push("dates.start");
  if (brief.dates.end === null) missing.push("dates.end");
  if (brief.playing_areas === null) missing.push("playing_areas");
  if (brief.daily_availability === null) missing.push("daily_availability");
  if (brief.time_slot_minutes === null) missing.push("time_slot_minutes");
  if (brief.minimum_matches_per_entry === null) missing.push("minimum_matches_per_entry");
  if (brief.knockout_required === null) missing.push("knockout_required");
  if (brief.rank_all_entries === null) missing.push("rank_all_entries");
  if (brief.placement_required === null) missing.push("placement_required");
  if (brief.cross_group_qualification_allowed === null) missing.push("cross_group_qualification_allowed");
  if (brief.organiser_priority === null) missing.push("organiser_priority");
  return missing;
}

function businessIssues(brief: Phase4CompetitionBrief): BriefValidationIssue[] {
  const issues: BriefValidationIssue[] = [];
  if (brief.dates.start !== null && brief.dates.end !== null && brief.dates.end < brief.dates.start) {
    issues.push({ code: "date_order", path: "dates.end", message: "End date cannot precede start date" });
  }
  if (brief.divisions !== null && brief.division_count !== null && brief.divisions.length !== brief.division_count) {
    issues.push({ code: "division_count", path: "divisions", message: "Division rows must match division_count" });
  }
  if (brief.divisions !== null && brief.entry_count !== null) {
    const assigned = brief.divisions.reduce((sum, division) => sum + division.entry_count, 0);
    if (assigned !== brief.entry_count) {
      issues.push({ code: "entry_total", path: "divisions", message: "Division entries must total entry_count" });
    }
    const names = brief.divisions.map((division) => division.name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) {
      issues.push({ code: "duplicate_division", path: "divisions", message: "Division names must be unique" });
    }
  }
  const smallestDivision = brief.divisions?.reduce(
    (smallest, division) => Math.min(smallest, division.entry_count),
    Number.POSITIVE_INFINITY,
  );
  if (
    brief.minimum_matches_per_entry !== null &&
    (smallestDivision ?? brief.entry_count) !== null &&
    brief.minimum_matches_per_entry >= (smallestDivision ?? brief.entry_count ?? Number.POSITIVE_INFINITY)
  ) {
    issues.push({
      code: "minimum_matches",
      path: "minimum_matches_per_entry",
      message: "Minimum matches must be lower than the smallest division entry count",
    });
  }
  if (brief.daily_availability !== null) {
    const byDate = new Map<string, Array<{ start: string; end: string }>>();
    for (const [index, window] of brief.daily_availability.entries()) {
      if (window.start_time >= window.end_time) {
        issues.push({
          code: "availability_order",
          path: `daily_availability.${index}.end_time`,
          message: "Availability end time must be later than start time",
        });
      }
      if (
        (brief.dates.start !== null && window.date < brief.dates.start) ||
        (brief.dates.end !== null && window.date > brief.dates.end)
      ) {
        issues.push({
          code: "availability_date",
          path: `daily_availability.${index}.date`,
          message: "Availability must fall within the competition dates",
        });
      }
      const windows = byDate.get(window.date) ?? [];
      if (windows.some((other) => window.start_time < other.end && window.end_time > other.start)) {
        issues.push({
          code: "availability_overlap",
          path: `daily_availability.${index}`,
          message: "Availability windows cannot overlap on the same date",
        });
      }
      windows.push({ start: window.start_time, end: window.end_time });
      byDate.set(window.date, windows);
    }
  }
  return issues;
}

export function validateCompetitionBrief(value: unknown): BriefValidationResult {
  const parsed = competitionBriefSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const suppliedMissing = parsed.data.missing_fields;
  const withoutMissing = { ...parsed.data };
  delete (withoutMissing as Partial<Phase4CompetitionBrief>).missing_fields;
  const derivedMissing = missingFields(withoutMissing);
  const brief: Phase4CompetitionBrief = { ...parsed.data, missing_fields: derivedMissing };
  const issues = businessIssues(brief);
  if (issues.length > 0) return { ok: false, issues };

  const expected = [...derivedMissing].sort();
  const supplied = [...new Set(suppliedMissing)].sort();
  const warnings: BriefValidationIssue[] =
    JSON.stringify(expected) === JSON.stringify(supplied)
      ? []
      : [
          {
            code: "missing_fields_corrected",
            path: "missing_fields",
            message: "Missing fields were recalculated from the structured values",
          },
        ];
  return { ok: true, brief, warnings };
}
