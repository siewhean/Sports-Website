import { describe, expect, it } from "vitest";
import { areCanonicalIntervalsEqual, canonicaliseIntervals, toIsoIntervals } from "../src/canonical-intervals.js";

describe("canonicaliseIntervals", () => {
  it("merges overlapping and adjacent intervals according to SCH-006 rules", () => {
    // 09:00–10:00, 09:30–10:30, 10:30–11:00 -> 09:00–11:00
    const start9 = "2026-09-01T09:00:00.000Z";
    const mid930 = "2026-09-01T09:30:00.000Z";
    const end10 = "2026-09-01T10:00:00.000Z";
    const end1030 = "2026-09-01T10:30:00.000Z";
    const end11 = "2026-09-01T11:00:00.000Z";

    const result = canonicaliseIntervals([
      { startsAt: start9, endsAt: end10 },
      { startsAt: mid930, endsAt: end1030 },
      { startsAt: end1030, endsAt: end11 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      startEpochMs: Date.parse(start9),
      endEpochMs: Date.parse(end11),
    });
  });

  it("handles out of order inputs and preserves disjoint intervals", () => {
    const w1 = { startsAt: "2026-09-01T14:00:00Z", endsAt: "2026-09-01T16:00:00Z" };
    const w2 = { startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T11:00:00Z" };

    const result = canonicaliseIntervals([w1, w2]);
    expect(result).toHaveLength(2);
    expect(result[0]!.startEpochMs).toBe(Date.parse("2026-09-01T09:00:00Z"));
    expect(result[1]!.startEpochMs).toBe(Date.parse("2026-09-01T14:00:00Z"));
  });

  it("rejects non-positive duration intervals", () => {
    expect(() => canonicaliseIntervals([{ startsAt: "2026-09-01T10:00:00Z", endsAt: "2026-09-01T10:00:00Z" }])).toThrow(
      /positive duration/i,
    );

    expect(() => canonicaliseIntervals([{ startsAt: "2026-09-01T11:00:00Z", endsAt: "2026-09-01T10:00:00Z" }])).toThrow(
      /positive duration/i,
    );
  });

  it("accurately detects semantic equality between differently fragmented windows", () => {
    const single = [{ startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T11:00:00Z" }];
    const splitAdjacent = [
      { startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T10:00:00Z" },
      { startsAt: "2026-09-01T10:00:00Z", endsAt: "2026-09-01T11:00:00Z" },
    ];
    const splitOverlapping = [
      { startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T10:30:00Z" },
      { startsAt: "2026-09-01T10:00:00Z", endsAt: "2026-09-01T11:00:00Z" },
    ];
    const different = [{ startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T11:30:00Z" }];

    expect(areCanonicalIntervalsEqual(single, splitAdjacent)).toBe(true);
    expect(areCanonicalIntervalsEqual(single, splitOverlapping)).toBe(true);
    expect(areCanonicalIntervalsEqual(single, different)).toBe(false);
  });

  it("converts to ISO strings correctly", () => {
    const intervals = canonicaliseIntervals([{ startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T10:00:00Z" }]);
    const iso = toIsoIntervals(intervals);
    expect(iso).toEqual([
      {
        starts_at: "2026-09-01T09:00:00.000Z",
        ends_at: "2026-09-01T10:00:00.000Z",
      },
    ]);
  });
});
