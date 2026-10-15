import { describe, expect, it } from "vitest";
import { buildPlannedEntryDrafts, plannedEntryCountIssue } from "../../src/phase-3-planned-entries.js";

describe("planned entry drafts", () => {
  it("names placeholders after the division and seeds them from 1", () => {
    expect(buildPlannedEntryDrafts({ divisionName: " Women ", count: 3, entryLimit: 8, existing: [] })).toEqual([
      { name: "Women 1", seed: 1 },
      { name: "Women 2", seed: 2 },
      { name: "Women 3", seed: 3 },
    ]);
  });

  it("skips names and seeds already used by active entries but reuses withdrawn ones", () => {
    const drafts = buildPlannedEntryDrafts({
      divisionName: "Open",
      count: 2,
      entryLimit: 8,
      existing: [
        { name: "open 1", seed: 1, status: "active" },
        { name: "Open 2", seed: 3, status: "withdrawn" },
        { name: "Kayak Club", seed: 2, status: "confirmed" },
      ],
    });
    expect(drafts).toEqual([
      { name: "Open 2", seed: 3 },
      { name: "Open 3", seed: 4 },
    ]);
  });

  it("leaves the seed empty once the division limit is exhausted", () => {
    const drafts = buildPlannedEntryDrafts({
      divisionName: "Open",
      count: 2,
      entryLimit: 2,
      existing: [{ name: "Named", seed: 2, status: "active" }],
    });
    expect(drafts).toEqual([
      { name: "Open 1", seed: 1 },
      { name: "Open 2", seed: null },
    ]);
  });

  it("keeps the ordinal visible for very long division names", () => {
    const [draft] = buildPlannedEntryDrafts({ divisionName: "x".repeat(130), count: 1, entryLimit: 8, existing: [] });
    expect(draft?.name.length).toBe(120);
    expect(draft?.name.endsWith(" 1")).toBe(true);
  });
});

describe("planned entry count validation", () => {
  it("accepts whole numbers within the division limit", () => {
    expect(plannedEntryCountIssue(4, 8, 4)).toBeNull();
  });

  it.each([0, -1, 1.5, 49, "4", null, undefined])("rejects %p", (count) => {
    expect(plannedEntryCountIssue(count, 48, 0)).toMatch(/whole number from 1 to 48/);
  });

  it("rejects counts that would exceed the division entry limit", () => {
    expect(plannedEntryCountIssue(5, 8, 4)).toMatch(/division entry limit of 8/);
  });
});
