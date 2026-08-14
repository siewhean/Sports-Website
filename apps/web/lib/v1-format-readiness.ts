import type { Phase4SetupDocument } from "@matchday/contracts";

export type V1FormatPrerequisite = Readonly<{
  id: "entries" | "capacity";
  label: string;
  detail: string;
  ready: boolean;
}>;

export type V1FormatReadiness = Readonly<{
  ready: boolean;
  prerequisites: readonly V1FormatPrerequisite[];
}>;

export type V1CanonicalFormatReadinessInput = Readonly<{
  divisions: readonly Readonly<{
    entries?: readonly Readonly<{ status: string }>[];
  }>[];
  capacity: Readonly<{
    areaCount: number;
    availableMatchSlots: number;
  }>;
}>;

function readiness(
  divisionEntryCounts: readonly number[],
  totalEntryCount: number,
  areaCount: number,
  availableMatchSlots: number,
): V1FormatReadiness {
  const divisionsMissingEntries = divisionEntryCounts.filter((entryCount) => entryCount < 2).length;
  const entriesReady = divisionEntryCounts.length > 0 && totalEntryCount >= 2 && divisionsMissingEntries === 0;
  const capacityReady = areaCount > 0 && availableMatchSlots > 0;

  const prerequisites: readonly V1FormatPrerequisite[] = [
    {
      id: "entries",
      label: "Entries",
      detail: entriesReady
        ? `${totalEntryCount} entries are ready across ${divisionEntryCounts.length} division${divisionEntryCounts.length === 1 ? "" : "s"}.`
        : divisionsMissingEntries > 0
          ? `Add at least two teams or placeholders to every division. ${divisionsMissingEntries} division${divisionsMissingEntries === 1 ? " still needs" : "s still need"} entries.`
          : "Add at least two teams or placeholders to a division before choosing a format.",
      ready: entriesReady,
    },
    {
      id: "capacity",
      label: "Capacity",
      detail: capacityReady
        ? `${availableMatchSlots} match slot${availableMatchSlots === 1 ? " is" : "s are"} available.`
        : "Add at least one playing area and an available time window before choosing a format.",
      ready: capacityReady,
    },
  ];

  return { ready: prerequisites.every((item) => item.ready), prerequisites };
}

/**
 * Assisted Setup readiness remains useful for the advanced wizard, but the V1
 * organiser journey must not require an Assisted Setup draft to exist.
 */
export function v1FormatReadiness(setup: Phase4SetupDocument | null | undefined): V1FormatReadiness {
  const entries = setup?.values.entries;
  const divisionEntryCounts = entries?.divisions.map((division) => division.entry_ids.length) ?? [];
  const totalEntryCount = entries?.total_entry_count ?? 0;
  const capacity = setup?.values.capacity;
  return readiness(
    divisionEntryCounts,
    totalEntryCount,
    capacity?.area_ids.length ?? 0,
    capacity?.effective.availableMatchSlots ?? 0,
  );
}

/**
 * The simple V1 Format page reads its prerequisites from the canonical direct
 * competition/capacity surfaces the organiser just edited. This deliberately
 * avoids treating the optional Assisted Setup aggregate as a hidden gate.
 */
export function v1CanonicalFormatReadiness(input: V1CanonicalFormatReadinessInput): V1FormatReadiness {
  const divisionEntryCounts = input.divisions.map(
    (division) =>
      division.entries?.filter((entry) => entry.status === "active" || entry.status === "confirmed").length ?? 0,
  );
  const totalEntryCount = divisionEntryCounts.reduce((total, count) => total + count, 0);
  return readiness(
    divisionEntryCounts,
    totalEntryCount,
    input.capacity.areaCount,
    input.capacity.availableMatchSlots,
  );
}
