import { describe, expect, it } from "vitest";
import {
  isDivisionCreateBody,
  isEntryCreateBody,
  parseCreatedDivision,
  parseCreatedEntry,
  phase3EntriesCopy,
  totalActiveEntries,
  validateDivisionInput,
  validateEntryInput,
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

  it("validates division inputs and requires valid name and limits", () => {
    expect(validateDivisionInput("Open", 16)).toEqual({ ok: true, value: { name: "Open", entryLimit: 16 } });
    expect(validateDivisionInput("  Premier  ", "24")).toEqual({
      ok: true,
      value: { name: "Premier", entryLimit: 24 },
    });
    expect(validateDivisionInput("A", 16)).toEqual({ ok: false, error: phase3EntriesCopy.divisionNameRequired });
    expect(validateDivisionInput("", 16)).toEqual({ ok: false, error: phase3EntriesCopy.divisionNameRequired });
    expect(validateDivisionInput("Open", 1)).toEqual({ ok: false, error: phase3EntriesCopy.divisionLimitInvalid });
    expect(validateDivisionInput("Open", 129)).toEqual({ ok: false, error: phase3EntriesCopy.divisionLimitInvalid });
    expect(validateDivisionInput("Open", "not-a-number")).toEqual({
      ok: false,
      error: phase3EntriesCopy.divisionLimitInvalid,
    });
    expect(validateDivisionInput("Open", 16.5)).toEqual({
      ok: false,
      error: phase3EntriesCopy.divisionLimitInvalid,
    });
  });

  it("validates entry inputs, accepting blank seeds as null and validating non-blank seeds", () => {
    // Blank seed inputs must be accepted with seed: null
    expect(validateEntryInput("Marina Blue", "")).toEqual({
      ok: true,
      value: { name: "Marina Blue", seed: null },
    });
    expect(validateEntryInput("Marina Blue", "   ")).toEqual({
      ok: true,
      value: { name: "Marina Blue", seed: null },
    });
    expect(validateEntryInput("Marina Blue", undefined)).toEqual({
      ok: true,
      value: { name: "Marina Blue", seed: null },
    });
    expect(validateEntryInput("Marina Blue", null)).toEqual({
      ok: true,
      value: { name: "Marina Blue", seed: null },
    });

    // Valid positive seeds 1..48
    expect(validateEntryInput("Marina Blue", 1)).toEqual({
      ok: true,
      value: { name: "Marina Blue", seed: 1 },
    });
    expect(validateEntryInput("Marina Blue", "48")).toEqual({
      ok: true,
      value: { name: "Marina Blue", seed: 48 },
    });

    // Invalid seeds: 0, negative, >48, non-integer, non-numeric
    expect(validateEntryInput("Marina Blue", 0)).toEqual({
      ok: false,
      error: phase3EntriesCopy.entrySeedInvalid,
    });
    expect(validateEntryInput("Marina Blue", "0")).toEqual({
      ok: false,
      error: phase3EntriesCopy.entrySeedInvalid,
    });
    expect(validateEntryInput("Marina Blue", 49)).toEqual({
      ok: false,
      error: phase3EntriesCopy.entrySeedInvalid,
    });
    expect(validateEntryInput("Marina Blue", -5)).toEqual({
      ok: false,
      error: phase3EntriesCopy.entrySeedInvalid,
    });
    expect(validateEntryInput("Marina Blue", 2.5)).toEqual({
      ok: false,
      error: phase3EntriesCopy.entrySeedInvalid,
    });
    expect(validateEntryInput("Marina Blue", "first")).toEqual({
      ok: false,
      error: phase3EntriesCopy.entrySeedInvalid,
    });

    // Short or missing entry name
    expect(validateEntryInput("A", "")).toEqual({
      ok: false,
      error: phase3EntriesCopy.entryNameRequired,
    });
    expect(validateEntryInput("", 1)).toEqual({
      ok: false,
      error: phase3EntriesCopy.entryNameRequired,
    });
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
