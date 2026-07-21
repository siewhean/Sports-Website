import { describe, expect, it } from "vitest";
import {
  capacityMutationBody,
  isCapacityMutationBody,
  parseCapacityResponse,
  validateCapacityDraft,
} from "./phase3-capacity";

const competitionId = "46f0050a-ddd3-4fd5-bf30-c063694ae52a";
const areaId = "8e66bd53-a9cb-4cde-840a-cc94988ca461";
const availableId = "75706328-3058-44f0-a06a-8eb08980dd81";
const unavailableId = "b640f3a6-3a6f-4376-87a3-f3ac31d071a4";

function payload(status: "comfortable" | "tight" | "does_not_fit" = "tight") {
  const remaining = status === "comfortable" ? 2 : status === "tight" ? 0 : -2;
  return {
    competition_id: competitionId,
    revision: 7,
    timezone: "Asia/Singapore",
    permission: "write",
    read_only: false,
    areas: [
      {
        id: areaId,
        name: "Pool A",
        sort_order: 0,
        slot_minutes: 30,
        fixed_reserve_slots: 2,
        availability: [
          {
            id: availableId,
            date: "2026-08-30",
            start_time: "09:00",
            end_time: "19:00",
            cross_midnight: false,
            starts_at: "2026-08-30T01:00:00.000Z",
            ends_at: "2026-08-30T11:00:00.000Z",
          },
        ],
        unavailable: [
          {
            id: unavailableId,
            date: "2026-08-30",
            start_time: "13:00",
            end_time: "14:00",
            cross_midnight: false,
            starts_at: "2026-08-30T05:00:00.000Z",
            ends_at: "2026-08-30T06:00:00.000Z",
          },
        ],
      },
    ],
    effective: {
      timeZone: "Asia/Singapore",
      slotMinutes: 30,
      rawTotalSlots: 18,
      fixedReserveSlots: 2,
      availableMatchSlots: 16,
      requiredMatchSlots: 16 - remaining,
      remainingMatchSlots: remaining,
      status,
      areas: [{ areaId, areaName: "Pool A", sortOrder: 0, usableMinutes: 540, rawSlots: 18, intervalCount: 2 }],
      intervals: [
        {
          id: "effective-a",
          areaId,
          areaName: "Pool A",
          startEpochMs: 1788051600000,
          endEpochMs: 1788087600000,
          startIso: "2026-08-30T01:00:00.000Z",
          endIso: "2026-08-30T11:00:00.000Z",
          usableMinutes: 540,
          slots: 18,
          unusedMinutes: 0,
          sourceAvailabilityIds: [availableId],
        },
      ],
    },
  };
}

describe("Phase 3 capacity web boundary", () => {
  it.each(["comfortable", "tight", "does_not_fit"] as const)(
    "renders returned %s capacity truth without recalculation",
    (status) => {
      const parsed = parseCapacityResponse(payload(status), competitionId);
      expect(parsed?.effective.status).toBe(status);
      expect(parsed?.effective.requiredMatchSlots).toBe(payload(status).effective.requiredMatchSlots);
      expect(parsed?.effective.remainingMatchSlots).toBe(payload(status).effective.remainingMatchSlots);
    },
  );

  it("strictly preserves raw source IDs, windows, revision and permission", () => {
    const parsed = parseCapacityResponse(payload(), competitionId)!;
    expect(parsed.revision).toBe(7);
    expect(parsed.areas[0]?.unavailable[0]?.id).toBe(unavailableId);
    expect(parseCapacityResponse({ ...payload(), surprise: true }, competitionId)).toBeNull();
  });

  it("round-trips GET source data to the exact revision-aware PUT body", () => {
    const parsed = parseCapacityResponse(payload(), competitionId)!;
    expect(validateCapacityDraft(parsed.areas)).toEqual({});
    const body = capacityMutationBody(parsed.revision, parsed.timezone, parsed.areas);
    expect(isCapacityMutationBody(body)).toBe(true);
    expect(body).toEqual({
      revision: 7,
      timezone: "Asia/Singapore",
      areas: [
        {
          id: areaId,
          name: "Pool A",
          sort_order: 0,
          slot_minutes: 30,
          fixed_reserve_slots: 2,
          availability: [{ id: availableId, date: "2026-08-30", start_time: "09:00", end_time: "19:00" }],
          unavailable: [{ id: unavailableId, date: "2026-08-30", start_time: "13:00", end_time: "14:00" }],
        },
      ],
    });
    expect(isCapacityMutationBody({ ...body, revision: 0 })).toBe(false);
    expect(isCapacityMutationBody({ ...body, areas: [{ ...body.areas[0], surprise: true }] })).toBe(false);
  });

  it("rejects stale permission drift and duplicate stable IDs", () => {
    expect(parseCapacityResponse({ ...payload(), read_only: true }, competitionId)).toBeNull();
    const duplicated = payload();
    duplicated.areas[0]!.unavailable[0]!.id = availableId;
    expect(parseCapacityResponse(duplicated, competitionId)).toBeNull();
  });
});
