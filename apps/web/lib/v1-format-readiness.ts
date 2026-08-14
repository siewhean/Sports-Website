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

export function v1FormatReadiness(setup: Phase4SetupDocument | null | undefined): V1FormatReadiness {
  const entries = setup?.values.entries;
  const divisionsMissingEntries = entries?.divisions.filter((division) => division.entry_ids.length < 2).length ?? 0;
  const entriesReady = Boolean(
    entries && entries.divisions.length > 0 && entries.total_entry_count >= 2 && divisionsMissingEntries === 0,
  );

  const capacity = setup?.values.capacity;
  const capacityReady = Boolean(capacity && capacity.area_ids.length > 0 && capacity.effective.availableMatchSlots > 0);

  const prerequisites: readonly V1FormatPrerequisite[] = [
    {
      id: "entries",
      label: "Entries",
      detail: entriesReady
        ? `${entries!.total_entry_count} entries are ready across ${entries!.divisions.length} division${entries!.divisions.length === 1 ? "" : "s"}.`
        : divisionsMissingEntries > 0
          ? `Add at least two teams or placeholders to every division. ${divisionsMissingEntries} division${divisionsMissingEntries === 1 ? " still needs" : "s still need"} entries.`
          : "Add at least two teams or placeholders to a division before choosing a format.",
      ready: entriesReady,
    },
    {
      id: "capacity",
      label: "Capacity",
      detail: capacityReady
        ? `${capacity!.effective.availableMatchSlots} match slot${capacity!.effective.availableMatchSlots === 1 ? " is" : "s are"} available.`
        : "Add at least one playing area and an available time window before choosing a format.",
      ready: capacityReady,
    },
  ];

  return { ready: prerequisites.every((item) => item.ready), prerequisites };
}
