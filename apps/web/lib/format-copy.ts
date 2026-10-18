import { opaqueId } from "@matchday/ui";

export type FormatWarningExplanation = {
  readonly reason: string;
  readonly fix: string;
};

export const KNOWN_FORMAT_WARNING_CODES = [
  "insufficient_capacity",
  "CAPACITY_SHORTFALL",
  "SCHEDULE_CAPACITY",
  "requires_more_slots",
  "SCHEDULE_DAILY_LIMIT",
  "SCHEDULE_REST",
  "SCHEDULE_DEPENDENCIES",
  "SCHEDULE_INFEASIBLE",
  "SCHEDULE_UNVERIFIED",
] as const;

export type KnownFormatWarningCode = (typeof KNOWN_FORMAT_WARNING_CODES)[number];

const warningCopy: Record<KnownFormatWarningCode, FormatWarningExplanation> = {
  insufficient_capacity: {
    reason: opaqueId("This format needs more match slots than your venue provides."),
    fix: opaqueId("Add courts, extend venue hours, or choose a format with fewer matches."),
  },
  CAPACITY_SHORTFALL: {
    reason: opaqueId("This format needs more match slots than your venue provides."),
    fix: opaqueId("Add courts, extend venue hours, or choose a format with fewer matches."),
  },
  SCHEDULE_CAPACITY: {
    reason: opaqueId("This format needs more match slots than the venue provides."),
    fix: opaqueId("Add courts, add playing days, or increase daily opening hours."),
  },
  requires_more_slots: {
    reason: opaqueId("This format needs more match slots than the current capacity provides."),
    fix: opaqueId("Add courts or extend hours to provide enough slots."),
  },
  SCHEDULE_DAILY_LIMIT: {
    reason: opaqueId("Teams would play more matches in a day than your daily limit allows."),
    fix: opaqueId("Allow more matches per day in rules, or spread matches across more days."),
  },
  SCHEDULE_REST: {
    reason: opaqueId("The required rest between matches does not fit in the available playing time."),
    fix: opaqueId("Reduce required rest time in rules, or add courts."),
  },
  SCHEDULE_DEPENDENCIES: {
    reason: opaqueId("Later knockout rounds cannot fit after the rounds they depend on."),
    fix: opaqueId("Add courts to run earlier rounds sooner, or extend playing days."),
  },
  SCHEDULE_INFEASIBLE: {
    reason: opaqueId("This format cannot be scheduled with the current entries, rules, and venue capacity."),
    fix: opaqueId("Adjust venue hours, court count, or team limits."),
  },
  SCHEDULE_UNVERIFIED: {
    reason: opaqueId("A quick schedule check found no valid schedule candidate yet."),
    fix: opaqueId("Generating a schedule in the workspace may still succeed, or you can adjust constraints."),
  },
};

const defaultWarningCopy: FormatWarningExplanation = {
  reason: opaqueId("This format requires changes to your setup before it can be scheduled."),
  fix: opaqueId("Review entries, venue availability, or format rules."),
};

/**
 * Returns a plain-language explanation and concrete suggested fix for any format warning code.
 */
export function formatWarningCopy(warningCode: string): FormatWarningExplanation {
  if (warningCode in warningCopy) {
    return warningCopy[warningCode as KnownFormatWarningCode];
  }
  return defaultWarningCopy;
}

/**
 * Formats a single combined warning sentence for compact display.
 */
export function formatWarningSentence(warningCode: string): string {
  const item = formatWarningCopy(warningCode);
  return `${item.reason} ${item.fix}`;
}

/**
 * Derives a ribbon badge label for a format recommendation card (e.g., "Best balance", "Shortest day", "Most games").
 * If the card does not fit, it never receives "Best balance".
 */
export function formatRecommendationRibbon(
  strategy: string,
  ordinal: number,
  fits: boolean = true,
): { label: string; isBest: boolean } {
  if (!fits) {
    if (strategy === "compact_knockout") return { label: opaqueId("Shortest day"), isBest: false };
    if (strategy === "round_robin") return { label: opaqueId("Most games"), isBest: false };
    if (strategy === "double_elimination") return { label: opaqueId("Double chance"), isBest: false };
    return { label: opaqueId("Alternative"), isBest: false };
  }

  if (strategy === "compact_knockout") {
    return { label: opaqueId("Shortest day"), isBest: false };
  }
  if (strategy === "round_robin") {
    return { label: opaqueId("Most games"), isBest: false };
  }
  if (strategy === "double_elimination") {
    return { label: opaqueId("Double chance"), isBest: false };
  }
  if (strategy === "full_placement") {
    if (ordinal === 1) return { label: opaqueId("Best balance"), isBest: true };
    return { label: opaqueId("Alternative"), isBest: false };
  }
  if (strategy === "championship_focus") {
    if (ordinal === 1) return { label: opaqueId("Best balance"), isBest: true };
    return { label: opaqueId("Shortest day"), isBest: false };
  }
  if (ordinal === 1) {
    return { label: opaqueId("Best balance"), isBest: true };
  }
  return { label: opaqueId("Alternative"), isBest: false };
}

/**
 * Human-readable descriptive title for format strategies.
 * Matches domain graph generation which builds groups of 4 (packages/domain/src/format.ts:1196).
 */
export function formatDescriptiveTitle(strategy: string, entryCount?: number, structure?: string): string {
  if (structure && structure.includes("groups of")) {
    return structure;
  }
  if (strategy === "round_robin") {
    return opaqueId("One league, everyone plays everyone");
  }
  if (strategy === "compact_knockout") {
    return opaqueId("Single elimination bracket");
  }
  if (strategy === "double_elimination") {
    return opaqueId("Double elimination with upper and lower brackets");
  }

  if (entryCount && entryCount % 4 === 0) {
    const groups = entryCount / 4;
    if (strategy === "full_placement") {
      if (groups === 2) return opaqueId("2 groups of 4, then semi-finals and full placings");
      if (groups === 3) return opaqueId("3 groups of 4, then knockouts and full placings");
      if (groups === 4) return opaqueId("4 groups of 4, then quarter-finals and full placings");
      if (groups === 6) return opaqueId("6 groups of 4, then knockouts and full placings");
      return opaqueId(`${groups} groups of 4, then knockouts and full placings`);
    }
    if (strategy === "championship_focus") {
      if (groups === 2) return opaqueId("2 groups of 4, then semi-finals");
      if (groups === 3) return opaqueId("3 groups of 4, then knockouts");
      if (groups === 4) return opaqueId("4 groups of 4, then quarter-finals");
      if (groups === 6) return opaqueId("6 groups of 4, then knockouts");
      return opaqueId(`${groups} groups of 4, then championship knockouts`);
    }
  }

  if (strategy === "full_placement") {
    return opaqueId("Group stages, then knockouts and full placings");
  }
  if (strategy === "championship_focus") {
    return opaqueId("Group stages, then championship knockouts");
  }
  return strategy.replaceAll("_", " ");
}

export const formatCopy = {
  fitsTitle: opaqueId("Fits the venue time"),
  notCheckedTitle: opaqueId("Not checked"),
  doesNotFitTitle: opaqueId("Doesn’t fit"),
  scheduleNotCheckedNotice: opaqueId("Schedule feasibility has not been checked yet."),
  matches: opaqueId("Matches"),
  fewestGames: opaqueId("Fewest games for a team"),
  slotsUsed: opaqueId("Slots used"),
  slotsUsedAllDivisions: opaqueId("Slots used (all divisions)"),
  slotsUsedBothDivisions: opaqueId("Slots used (both divisions)"),
  everyTeamRanked: opaqueId("Every team ranked"),
  yes: opaqueId("Yes"),
  no: opaqueId("No"),
  useThisFormat: opaqueId("Use this format"),
  currentFormat: opaqueId("Current format"),
  customise: opaqueId("Customise"),
  somethingElseTitle: opaqueId("Something else in mind?"),
  somethingElseBody: opaqueId(
    "Start from a blank page: add groups, knockouts, double elimination or placement matches yourself.",
  ),
  designYourOwn: opaqueId("Design your own"),
  leaveSpareSlots: (spare: number) => opaqueId(`Leaves ${spare} slot${spare === 1 ? "" : "s"} spare for delays.`),
} as const;

export type FormatFamily =
  "full_placement" | "championship_focus" | "compact_knockout" | "double_elimination" | "round_robin";

/**
 * Detects the format family from candidate strategy, name, or structure string.
 */
export function detectFormatFamily(input: {
  readonly strategy?: string | null;
  readonly name?: string | null;
  readonly structure?: string | null;
}): FormatFamily {
  const text = `${input.strategy ?? ""} ${input.name ?? ""} ${input.structure ?? ""}`.toLowerCase();
  if (text.includes("double_elimination") || text.includes("double elimination")) return "double_elimination";
  if (text.includes("round_robin") || text.includes("round robin") || text.includes("one league")) return "round_robin";
  if (text.includes("full_placement") || text.includes("full placement") || text.includes("full placings"))
    return "full_placement";
  if (text.includes("compact_knockout") || text.includes("compact knockout") || text.includes("single elimination"))
    return "compact_knockout";
  if (text.includes("championship_focus") || text.includes("championship focus")) return "championship_focus";
  return "full_placement";
}

export function formatFitStatus(candidate: {
  readonly capacity_status: string;
  readonly scheduling_status: string;
  readonly match_count: number;
  readonly available_match_slots: number;
  readonly warning_codes?: readonly string[];
  readonly advantage?: string;
}): {
  readonly fits: boolean;
  readonly isUnverified: boolean;
  readonly badgeLabel: string;
  readonly reason: string;
  readonly fix: string;
} {
  const fits =
    candidate.capacity_status !== "requires_changes" &&
    candidate.match_count <= candidate.available_match_slots &&
    candidate.scheduling_status !== "infeasible";

  if (fits) {
    const isUnverified =
      candidate.scheduling_status === "not_checked" ||
      Boolean(candidate.warning_codes?.includes("SCHEDULE_UNVERIFIED"));
    const spare = candidate.available_match_slots - candidate.match_count;
    const spareReason = spare > 0 ? formatCopy.leaveSpareSlots(spare) : opaqueId("Uses all available match slots.");
    const explanation = candidate.advantage ? `${spareReason} ${candidate.advantage}` : spareReason;
    return {
      fits: true,
      isUnverified,
      badgeLabel: isUnverified ? formatCopy.notCheckedTitle : formatCopy.fitsTitle,
      reason: isUnverified ? `${explanation} ${formatCopy.scheduleNotCheckedNotice}` : explanation,
      fix: "",
    };
  }

  const firstWarning = candidate.warning_codes?.[0] ?? "insufficient_capacity";
  const copy = formatWarningCopy(firstWarning);
  return {
    fits: false,
    isUnverified: false,
    badgeLabel: formatCopy.doesNotFitTitle,
    reason: copy.reason,
    fix: copy.fix,
  };
}
