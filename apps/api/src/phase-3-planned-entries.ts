// Planned ("unnamed") entries let organisers continue setup before team names
// exist. They are ordinary division_entries rows with entry_type='placeholder';
// nothing else in the schema distinguishes them, so every count, cap, format
// recommendation and schedule treats them exactly like named teams.

import { placeholderLabel } from "@matchday/domain";

export const PLANNED_ENTRY_COUNT_MAX = 48;

export type PlannedEntryDraft = Readonly<{ name: string; seed: number | null }>;

function normaliseName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * Builds the placeholder drafts for one planning request per D16.
 *
 * Names derive from placeholderLabel ("Team 1", "M-1"), continuing numbering
 * past any placeholder that already uses the pattern, skipping names that are already taken
 * by an active entry (case-insensitive) so the DB's active-name uniqueness index
 * cannot reject the batch. Seeds fill the lowest free slots within the division
 * limit, or stay null when none remain, matching how organisers seed by hand.
 */
export function buildPlannedEntryDrafts(input: {
  divisionName: string;
  divisionShortCode?: string | null;
  multiDivision?: boolean;
  count: number;
  entryLimit: number;
  existing: ReadonlyArray<{ name: string; seed: number | null; status: string }>;
}): readonly PlannedEntryDraft[] {
  const active = input.existing.filter((entry) => entry.status === "active" || entry.status === "confirmed");
  const takenNames = new Set(active.map((entry) => normaliseName(entry.name)));
  const takenSeeds = new Set(active.flatMap((entry) => (entry.seed === null ? [] : [entry.seed])));
  const drafts: PlannedEntryDraft[] = [];
  let ordinal = 0;
  let seed = 1;
  while (drafts.length < input.count) {
    ordinal += 1;
    while (seed <= input.entryLimit && takenSeeds.has(seed)) seed += 1;
    const assignedSeed = seed <= input.entryLimit ? seed : null;
    if (assignedSeed !== null) takenSeeds.add(assignedSeed);

    const baseLabel = placeholderLabel({
      entry: { entry_type: "placeholder", seed: assignedSeed },
      divisionShortCode: input.divisionShortCode,
      multiDivision: input.multiDivision,
      fallbackIndex: ordinal,
    });

    let candidate = baseLabel;
    let disambiguator = 2;
    while (takenNames.has(normaliseName(candidate))) {
      candidate = `${baseLabel} (${disambiguator++})`;
    }
    takenNames.add(normaliseName(candidate));
    drafts.push({ name: candidate, seed: assignedSeed });
  }
  return drafts;
}

/** Validates a planned-entry count from the API boundary; returns an error message or null. */
export function plannedEntryCountIssue(count: unknown, entryLimit: number, activeCount: number): string | null {
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > PLANNED_ENTRY_COUNT_MAX)
    return `Planned team count must be a whole number from 1 to ${PLANNED_ENTRY_COUNT_MAX}`;
  if (activeCount + (count as number) > entryLimit)
    return `Planned teams would exceed the division entry limit of ${entryLimit}`;
  return null;
}
