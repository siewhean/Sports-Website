import { describe, expect, it } from "vitest";
import {
  isDivisionCreateBody,
  isEntryCreateBody,
  isEntryPlanBody,
  isEntryRenameBody,
  isPlaceholderEntry,
  normalisePlannedCount,
  parseCreatedDivision,
  parseCreatedEntry,
  parsePlannedEntries,
  phase3EntriesCopy,
  tidyPlannedCountInput,
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
      code: null,
      shortCode: null,
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
    ).toEqual({ id: "entry-1", name: "Marina", seed: 1, status: "active", entryType: "team", revision: 1 });
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

describe("planned (placeholder) teams", () => {
  const idempotencyKey = "00000000-0000-4000-8000-000000000002";
  const placeholder = (index: number, overrides: Record<string, unknown> = {}) => ({
    id: `entry-${index}`,
    division_id: "division-1",
    name: `Open ${index}`,
    entry_type: "placeholder",
    status: "active",
    seed: null,
    revision: 1,
    ...overrides,
  });

  it("normalises the optional planned-team count", () => {
    expect(normalisePlannedCount("")).toEqual({ ok: true, value: null });
    expect(normalisePlannedCount("   ")).toEqual({ ok: true, value: null });
    expect(normalisePlannedCount(null)).toEqual({ ok: true, value: null });
    expect(normalisePlannedCount(" 8 ")).toEqual({ ok: true, value: 8 });
    expect(normalisePlannedCount("007")).toEqual({ ok: true, value: 7 });
    expect(normalisePlannedCount("48")).toEqual({ ok: true, value: 48 });
    expect(normalisePlannedCount(12)).toEqual({ ok: true, value: 12 });
    for (const bad of ["0", "000", "49", "-1", "2.5", "1e1", "eight", "8 teams", "٣"]) {
      expect(normalisePlannedCount(bad)).toEqual({ ok: false, error: phase3EntriesCopy.plannedTeamsInvalid });
    }
  });

  it("rejects planned counts above the places left in the division", () => {
    expect(normalisePlannedCount("16", 16)).toEqual({ ok: true, value: 16 });
    const tooMany = normalisePlannedCount("17", 16);
    expect(tooMany.ok).toBe(false);
    expect(!tooMany.ok && tooMany.error).toContain("16 places left");
    expect(normalisePlannedCount("", 0)).toEqual({ ok: true, value: null });
  });

  it("tidies the planned-count field on blur", () => {
    expect(tidyPlannedCountInput(" 008 ")).toBe("8");
    expect(tidyPlannedCountInput("abc")).toBe("");
    expect(tidyPlannedCountInput("0")).toBe("");
    expect(tidyPlannedCountInput("")).toBe("");
  });

  it("accepts planned_entry_count on the division command only within range and limit", () => {
    const base = { name: "Open", entry_limit: 8, idempotency_key: idempotencyKey };
    expect(isDivisionCreateBody({ ...base, planned_entry_count: 8 })).toBe(true);
    expect(isDivisionCreateBody({ ...base, code: "OPEN", planned_entry_count: 1 })).toBe(true);
    expect(isDivisionCreateBody({ ...base, planned_entry_count: 9 })).toBe(false);
    expect(isDivisionCreateBody({ ...base, planned_entry_count: 0 })).toBe(false);
    expect(isDivisionCreateBody({ ...base, planned_entry_count: "4" })).toBe(false);
    expect(isDivisionCreateBody({ ...base, entry_limit: 48, planned_entry_count: 49 })).toBe(false);
  });

  it("validates plan and rename commands", () => {
    expect(isEntryPlanBody({ count: 4, idempotency_key: idempotencyKey })).toBe(true);
    expect(isEntryPlanBody({ count: 0, idempotency_key: idempotencyKey })).toBe(false);
    expect(isEntryPlanBody({ count: 49, idempotency_key: idempotencyKey })).toBe(false);
    expect(isEntryPlanBody({ count: 4 })).toBe(false);
    expect(isEntryPlanBody({ count: 4, idempotency_key: idempotencyKey, extra: true })).toBe(false);

    expect(
      isEntryRenameBody({ revision: 1, name: "Harbour", entry_type: "team", idempotency_key: idempotencyKey }),
    ).toBe(true);
    expect(isEntryRenameBody({ revision: 2, name: "Harbour", idempotency_key: idempotencyKey })).toBe(true);
    expect(isEntryRenameBody({ revision: 0, name: "Harbour", idempotency_key: idempotencyKey })).toBe(false);
    expect(isEntryRenameBody({ revision: 1, name: "  ", idempotency_key: idempotencyKey })).toBe(false);
    expect(
      isEntryRenameBody({ revision: 1, name: "Harbour", entry_type: "club", idempotency_key: idempotencyKey }),
    ).toBe(false);
    expect(isEntryRenameBody({ revision: 1, name: "Harbour", seed: 1, idempotency_key: idempotencyKey })).toBe(false);
  });

  it("parses placeholder entries created with a division", () => {
    const division = parseCreatedDivision(
      {
        id: "division-1",
        competition_id: "competition-1",
        name: "Open",
        code: null,
        team_limit: 8,
        revision: 1,
        entries: [placeholder(1), placeholder(2)],
      },
      "competition-1",
      8,
      2,
    );
    expect(division?.entries).toEqual([
      { id: "entry-1", name: "Open 1", seed: null, status: "active", entryType: "placeholder", revision: 1 },
      { id: "entry-2", name: "Open 2", seed: null, status: "active", entryType: "placeholder", revision: 1 },
    ]);
    expect(division?.entries.every(isPlaceholderEntry)).toBe(true);
    // Count mismatch, foreign division, or malformed entries are rejected.
    const payload = { id: "division-1", competition_id: "competition-1", name: "Open", team_limit: 8 };
    expect(parseCreatedDivision({ ...payload, entries: [placeholder(1)] }, "competition-1", 8, 2)).toBeNull();
    expect(
      parseCreatedDivision({ ...payload, entries: [placeholder(1, { division_id: "other" })] }, "competition-1"),
    ).toBeNull();
    expect(parseCreatedDivision({ ...payload, entries: "none" }, "competition-1")).toBeNull();
    expect(parseCreatedDivision({ ...payload, entries: [] }, "competition-1")?.entries).toEqual([]);
  });

  it("parses planned entries for one division", () => {
    expect(parsePlannedEntries({ division_id: "division-1", entries: [placeholder(3)] }, "division-1")).toHaveLength(1);
    expect(parsePlannedEntries({ division_id: "division-2", entries: [placeholder(3)] }, "division-1")).toBeNull();
    expect(parsePlannedEntries({ division_id: "division-1", entries: [] }, "division-1")).toBeNull();
    expect(
      parsePlannedEntries(
        { division_id: "division-1", entries: [placeholder(3, { entry_type: "club" })] },
        "division-1",
      ),
    ).toBeNull();
  });

  it("counts placeholders toward the free-plan usage and treats legacy entries as teams", () => {
    expect(isPlaceholderEntry({})).toBe(false);
    expect(isPlaceholderEntry({ entryType: "team" })).toBe(false);
    expect(
      totalActiveEntries([
        {
          id: "division-1",
          name: "Open",
          entryLimit: 8,
          entries: [
            { id: "a", name: "Open 1", seed: null, status: "active", entryType: "placeholder", revision: 1 },
            { id: "b", name: "Harbour", seed: 1, status: "confirmed" },
          ],
        },
      ]),
    ).toBe(2);
  });

  it("uses sentence-case copy for planned teams", () => {
    expect(phase3EntriesCopy.plannedTeams).toBe("Planned teams (optional)");
    expect(phase3EntriesCopy.unnamedBadge).toBe("Unnamed");
    expect(phase3EntriesCopy.intro).toContain("name them later");
    expect(phase3EntriesCopy.plannedTeamsInvalid).toMatch(/^Enter\b/);
  });
});
