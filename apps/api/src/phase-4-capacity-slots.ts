import { buildCalendarCapacitySlotSet, type ScheduleProblem } from "@matchday/domain";

/** Availability or unavailable window row, with the civil source fields capacity was saved from. */
export type CapacityWindowRow = {
  id: string;
  playing_area_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  date: string;
  start_time: string;
  end_time: string;
  cross_midnight: boolean;
};
export type CapacityAreaRow = {
  id: string;
  slot_minutes: number;
  fixed_reserve_slots: number;
};

/**
 * Solver slots from the canonical domain capacity grid (`buildCalendarCapacitySlotSet`), so the
 * solver sees exactly the usable slots the capacity count promises: reserve slots (each area's
 * latest `fixed_reserve_slots` slots) are never offered to normal solving. Slot IDs keep the
 * historical `<availability window id>:<1-based index>` form whenever the slot sits on its
 * source window's grid, so persisted placements and locks still resolve; a slot shifted by an
 * unavailable split gets an exact-instant `<window id>:at:<epoch ms>` ID instead.
 */
export function capacityMatchSlots(
  windows: readonly CapacityWindowRow[],
  unavailable: readonly CapacityWindowRow[],
  durationMinutes: number,
  areas: readonly CapacityAreaRow[],
  timeZone: string,
): ScheduleProblem["slots"][number][] {
  const civilWindow = (window: CapacityWindowRow) => ({
    id: window.id,
    areaId: window.playing_area_id,
    date: window.date,
    startTime: window.start_time,
    endTime: window.end_time,
    crossMidnight: window.cross_midnight,
  });
  const canonical = buildCalendarCapacitySlotSet({
    timeZone,
    slotMinutes: durationMinutes,
    areas: areas.map((area, index) => ({
      id: area.id,
      name: area.id,
      sortOrder: index,
      fixedReserveSlots: area.fixed_reserve_slots,
    })),
    availability: windows.map(civilWindow),
    unavailable: unavailable.map(civilWindow),
  });
  const intervals = new Map(canonical.intervals.map((interval) => [interval.id, interval]));
  const windowById = new Map(
    windows.map((window) => [
      window.id,
      { startsAt: new Date(window.starts_at).getTime(), endsAt: new Date(window.ends_at).getTime() },
    ]),
  );
  const slotMs = durationMinutes * 60_000;
  return canonical.usableSlots.map((slot) => {
    const interval = intervals.get(slot.intervalId)!;
    const sources = [...interval.sourceAvailabilityIds].sort();
    const sourceId =
      sources.find((id) => {
        const window = windowById.get(id)!;
        return window.startsAt <= slot.startEpochMs && window.endsAt >= slot.endEpochMs;
      }) ?? sources[0]!;
    const offset = (slot.startEpochMs - windowById.get(sourceId)!.startsAt) / slotMs;
    return {
      id: Number.isInteger(offset) ? `${sourceId}:${offset + 1}` : `${sourceId}:at:${slot.startEpochMs}`,
      intervalId: sourceId,
      areaId: slot.areaId,
      startEpochMs: slot.startEpochMs,
      endEpochMs: slot.endEpochMs,
    };
  });
}
