import { describe, expect, it } from "vitest";
import {
  isDivisionCreateBody,
  isEntryCreateBody,
  parseCreatedDivision,
  parseCreatedEntry,
  phase3EntriesCopy,
  totalActiveEntries,
} from "./phase3-entries";

describe("division and entry commands", () => {
  const idempotencyKey = "00000000-0000-4000-8000-000000000001";

  it("accepts only the canonical division command", () => {
    expect(isDivisionCreateBody({ name: "Open", code: "OPEN", entry_limit: 8, idempotency_key: idempotencyKey })).toBe(
      true,
    );
    expect(isDivisionCreateBody({ name: "Open", entry_limit: 7 })).toBe(false);
    expect(isDivisionCreateBody({ name: "Open", entry_limit: 8, bypass: true })).toBe(false);
  });

  it("accepts only the canonical entry command", () => {
    expect(isEntryCreateBody({ name: "Marina", entry_type: "team", seed: 8, idempotency_key: idempotencyKey })).toBe(
      true,
    );
    expect(isEntryCreateBody({ name: "Marina", seed: 49 })).toBe(false);
    expect(isEntryCreateBody({ name: "Marina", seed: 1, metadata: {} })).toBe(false);
  });

  it("parses authoritative API records", () => {
    expect(
      parseCreatedDivision(
        { id: "division-1", competition_id: "competition-1", name: "Open", team_limit: 8, revision: 1 },
        "competition-1",
      ),
    ).toEqual({
      id: "division-1",
      name: "Open",
      entryLimit: 8,
      entries: [],
    });
    expect(
      parseCreatedDivision(
        { id: "division-1", competition_id: "competition-1", name: "Open", team_limit: 24 },
        "competition-1",
        16,
      ),
    ).toBeNull();
    expect(
      parseCreatedEntry(
        { id: "entry-1", division_id: "division-1", name: "Marina", seed: 1, status: "active", revision: 1 },
        "division-1",
      ),
    ).toEqual({ id: "entry-1", name: "Marina", seed: 1, status: "active" });
    expect(
      parseCreatedEntry(
        { id: "entry-1", division_id: "other", name: "Marina", seed: 1, status: "active" },
        "division-1",
      ),
    ).toBeNull();
    expect(parseCreatedEntry({ id: "entry-1", name: "Marina", seed: 0, status: "active" })).toBeNull();
    expect(
      parseCreatedEntry(
        { id: "entry-1", division_id: "division-1", name: "Marina", seed: 1, status: "withdrawn" },
        "division-1",
      ),
    ).toBeNull();
  });

  it("counts the free-plan limit across divisions and excludes inactive records", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      id: `entry-${index}`,
      name: `Entry ${index}`,
      seed: index + 1,
      status: "active",
    }));
    expect(
      totalActiveEntries([
        { id: "open", name: "Open", entryLimit: 8, entries },
        {
          id: "women",
          name: "Women",
          entryLimit: 8,
          entries: [...entries, { id: "old", name: "Old", seed: null, status: "withdrawn" }],
        },
      ]),
    ).toBe(16);
  });

  it("provides field-and-fix validation guidance for divisions and entries", () => {
    expect(phase3EntriesCopy.divisionNameRequired).toMatch(/^(Enter|Select)\b/);
    expect(phase3EntriesCopy.divisionNameRequired).toContain("division name");
    expect(phase3EntriesCopy.divisionLimitInvalid).toMatch(/^(Enter|Select)\b/);
    expect(phase3EntriesCopy.divisionLimitInvalid).toContain("limit");
    expect(phase3EntriesCopy.entryNameRequired).toMatch(/^(Enter|Select)\b/);
    expect(phase3EntriesCopy.entryNameRequired).toContain("name");
    expect(phase3EntriesCopy.entrySeedInvalid).toMatch(/^(Enter|Select)\b/);
    expect(phase3EntriesCopy.entrySeedInvalid).toContain("seed");
    expect(phase3EntriesCopy.freeLimitReached).toContain("16");
  });
});
