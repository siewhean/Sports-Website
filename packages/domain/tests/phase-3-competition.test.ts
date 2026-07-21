import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPETITION_FREE_ENTRY_LIMIT,
  addDivision,
  addEntry,
  archiveCompetition,
  countActiveEntries,
  createCompetition,
  deleteCompetition,
  deleteDivision,
  deleteEntry,
  duplicateCompetition,
  importCsv,
  importPasteList,
  markFirstMatchStarted,
  replaceEntry,
  restoreCompetition,
  transitionCompetition,
  updateCompetition,
  updateDivision,
  updateEntry,
  withdrawEntry,
  type CommandContext,
  type CommandResult,
  type Competition,
  type CompetitionInput,
  type CompetitionLocation,
  type CompetitionStatus,
  type EntryMetadata,
  type EntryInput,
  type AvailabilityWindow,
} from "../src/competition.js";

const T0 = "2027-01-02T03:04:05.000Z";
const T1 = "2027-01-02T04:04:05.000Z";
const context: CommandContext = { actorId: "organiser-1", occurredAt: T0 };

function ok<T>(result: CommandResult<T>): T {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function baseCompetition(): Competition {
  return ok(
    createCompetition(
      {
        id: "competition-1",
        organisationId: "organisation-1",
        name: "National Open",
        slug: "national-open",
        sport: "canoe_polo",
        location: {
          venue: "Marina Bay",
          address: "1 Bay Road",
          locality: "Singapore",
          countryCode: "SG",
        },
        startDate: "2027-07-10",
        endDate: "2027-07-11",
        timeZone: "Asia/Singapore",
        locale: "en-SG",
      },
      context,
    ),
  );
}

function withDivision(): Competition {
  return ok(addDivision(baseCompetition(), { id: "division-open", name: "Open", code: "O" }, context));
}

function input(index: number, overrides: Partial<EntryInput> = {}): EntryInput {
  return { id: `entry-${index}`, name: `Entry ${index}`, type: "team", seed: index, ...overrides };
}

function oracle() {
  return JSON.parse(
    readFileSync(new URL("../../../validation/phase-3/competition-lifecycle.oracle.json", import.meta.url), "utf8"),
  ) as {
    state_transitions: Record<CompetitionStatus, CompetitionStatus[]>;
    csv: {
      source: string;
      expected: { name: string; type: string; seed: number; club: string | null; countryCode: string }[];
    };
    free_entry_limit: number;
  };
}

describe("CMP-001–005 competition lifecycle and immutable command outcomes", () => {
  it("creates and updates valid competition fields with permission and audit intents", () => {
    const created = createCompetition(
      {
        id: "c-1",
        organisationId: "o-1",
        name: "  Open  ",
        slug: "open",
        sport: "badminton",
        location: { venue: "Hall", address: "Road", locality: null, countryCode: "SG" },
        startDate: "2027-01-01",
        endDate: "2027-01-02",
        timeZone: "Asia/Singapore",
        locale: "en-SG",
      },
      context,
    );
    expect(created).toMatchObject({
      ok: true,
      requiredPermission: "competition:create",
      audit: [{ action: "competition.created", actorId: "organiser-1" }],
    });
    const original = ok(created);
    const updated = updateCompetition(
      original,
      { name: "Regional Open", location: { ...original.location, venue: "Hall 2" } },
      { ...context, occurredAt: T1 },
    );
    expect(ok(updated)).toMatchObject({ name: "Regional Open", location: { venue: "Hall 2" }, updatedAt: T1 });
    expect(original.name).toBe("Open");
    expect(updated).toMatchObject({
      ok: true,
      requiredPermission: "competition:update",
      audit: [{ action: "competition.updated" }],
    });
  });

  it("deep-clones and freezes every caller-owned nested reference", () => {
    const location: CompetitionLocation = {
      venue: "Input venue",
      address: "Input road",
      locality: "Singapore",
      countryCode: "SG",
    };
    const createInput: CompetitionInput = {
      id: "isolated",
      organisationId: "organisation-1",
      name: "Isolated Open",
      slug: "isolated-open",
      sport: "canoe_polo",
      location,
      startDate: "2027-07-10",
      endDate: "2027-07-11",
      timeZone: "Asia/Singapore",
      locale: "en-SG",
    };
    const created = ok(createCompetition(createInput, context));
    location.venue = "Caller mutation";
    expect(created.location.venue).toBe("Input venue");

    const divided = ok(addDivision(created, { id: "d", name: "Division" }, context));
    const metadata: Partial<EntryMetadata> = { club: "Original club", countryCode: "SG" };
    const availability: AvailabilityWindow[] = [{ start: "2027-07-10T01:00:00.000Z", end: "2027-07-10T02:00:00.000Z" }];
    const added = ok(addEntry(divided, "d", input(1, { metadata, availability }), "free", context));
    metadata.club = "Caller club mutation";
    availability[0]!.start = "2027-07-10T03:00:00.000Z";
    expect(added.divisions[0]?.entries[0]).toMatchObject({
      metadata: { club: "Original club" },
      availability: [{ start: "2027-07-10T01:00:00.000Z" }],
    });
    expect(Object.isFrozen(added)).toBe(true);
    expect(Object.isFrozen(added.location)).toBe(true);
    expect(Object.isFrozen(added.divisions[0]?.entries[0]?.metadata)).toBe(true);
    expect(Object.isFrozen(added.divisions[0]?.entries[0]?.availability[0])).toBe(true);
    expect(() => {
      (added.location as { venue: string }).venue = "Result mutation";
    }).toThrow(TypeError);

    const patchLocation: CompetitionLocation = { ...added.location, venue: "Patched venue" };
    const updated = ok(updateCompetition(added, { location: patchLocation }, { ...context, occurredAt: T1 }));
    patchLocation.venue = "Mutated patch";
    expect(updated.location.venue).toBe("Patched venue");
  });

  it.each([
    ["2027-02-29", "2027-03-01", "UTC", "invalid_date"],
    ["2028-02-29", "2028-02-28", "UTC", "invalid_date_range"],
    ["2028-02-28", "2028-02-29", "Mars/Olympus", "invalid_time_zone"],
  ])("rejects invalid dates or time zone: %s to %s in %s", (startDate, endDate, timeZone, code) => {
    const current = baseCompetition();
    const result = updateCompetition(current, { startDate, endDate, timeZone }, context);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    if (!result.ok) expect(result.error.issues.map((candidate) => candidate.code)).toContain(code);
    expect(current).toEqual(baseCompetition());
  });

  it.each(["GMT", "Etc/GMT+8", "US/Eastern"])("accepts Intl-recognized canonical or alias time zone %s", (timeZone) => {
    expect(() => new Intl.DateTimeFormat("en", { timeZone }).format(0)).not.toThrow();
    expect(updateCompetition(baseCompetition(), { timeZone }, context).ok).toBe(true);
  });

  it("matches the independent state-transition oracle and never mutates rejected input", () => {
    const allowed = oracle().state_transitions;
    const statuses = Object.keys(allowed) as CompetitionStatus[];
    for (const from of statuses) {
      for (const to of statuses) {
        let current = withDivision();
        current = { ...current, status: from, archivedFromStatus: from === "archived" ? "draft" : null };
        const snapshot = structuredClone(current);
        const result = transitionCompetition(current, to, context);
        expect(result.ok, `${from} -> ${to}`).toBe(allowed[from].includes(to));
        expect(current).toEqual(snapshot);
      }
    }
  });

  it("supports Ready returning to Draft and rejects Ready without a division", () => {
    expect(transitionCompetition(baseCompetition(), "ready", context)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    const ready = ok(transitionCompetition(withDivision(), "ready", context));
    expect(ok(transitionCompetition(ready, "draft", { ...context, occurredAt: T1 })).status).toBe("draft");
  });

  it("enforces one supported sport and locks it permanently once match history starts", () => {
    const original = baseCompetition();
    const changedBeforeStart = ok(updateCompetition(original, { sport: "volleyball" }, context));
    expect(changedBeforeStart.sport).toBe("volleyball");
    const locked = ok(markFirstMatchStarted(changedBeforeStart, "2027-07-10T01:00:00.000Z", context));
    const result = updateCompetition(locked, { sport: "basketball" }, { ...context, occurredAt: T1 });
    expect(result).toMatchObject({ ok: false, error: { code: "SPORT_LOCKED" } });
    expect(locked.sport).toBe("volleyball");
  });

  it("requires a revision instead of overwriting published configuration", () => {
    const published = { ...withDivision(), status: "published" as const };
    expect(
      updateCompetition(published, { location: { ...published.location, venue: "Other venue" } }, context),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: expect.stringContaining("revision") },
    });
  });

  it("only deletes unstarted drafts and emits a delete intent rather than mutating state", () => {
    const draft = baseCompetition();
    expect(deleteCompetition(draft, context)).toMatchObject({
      ok: true,
      value: null,
      requiredPermission: "competition:delete",
      audit: [{ action: "competition.deleted" }],
    });
    expect(deleteCompetition({ ...draft, status: "published" }, context)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
  });
});

describe("CMP-006–009 division and common entry CRUD", () => {
  it("creates, updates, and deletes empty divisions without touching the source aggregate", () => {
    const original = baseCompetition();
    const added = ok(addDivision(original, { id: "d-1", name: "Women", code: "W" }, context));
    const updated = ok(updateDivision(added, "d-1", { name: "Women's Open" }, { ...context, occurredAt: T1 }));
    expect(updated.divisions[0]).toMatchObject({ name: "Women's Open", code: "W" });
    expect(ok(deleteDivision(updated, "d-1", context)).divisions).toEqual([]);
    expect(original.divisions).toEqual([]);
  });

  it("supports team, individual, and placeholder entries through one model with seed metadata", () => {
    let competition = withDivision();
    const types = ["team", "individual", "placeholder"] as const;
    types.forEach((type, index) => {
      competition = ok(
        addEntry(
          competition,
          "division-open",
          input(index + 1, { type, metadata: { club: index === 0 ? "Marina" : null, countryCode: "SG" } }),
          "free",
          { ...context, occurredAt: new Date(Date.parse(T0) + index * 1000).toISOString() },
        ),
      );
    });
    expect(competition.divisions[0]?.entries.map((entry) => [entry.type, entry.seed])).toEqual([
      ["team", 1],
      ["individual", 2],
      ["placeholder", 3],
    ]);
    expect(competition.divisions[0]?.entries[0]?.metadata.club).toBe("Marina");
  });

  it("updates and deletes active entries while preserving seed uniqueness", () => {
    const added = ok(addEntry(withDivision(), "division-open", input(1), "free", context));
    const updated = ok(
      updateEntry(added, "division-open", "entry-1", { name: "Renamed", seed: 4 }, { ...context, occurredAt: T1 }),
    );
    expect(updated.divisions[0]?.entries[0]).toMatchObject({ name: "Renamed", seed: 4 });
    expect(ok(deleteEntry(updated, "division-open", "entry-1", context)).divisions[0]?.entries).toEqual([]);
    expect(deleteDivision(added, "division-open", context)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});

describe("CMP-010–012 atomic paste and mapped CSV imports", () => {
  const ids = (row: number) => `import-${row}`;

  it("imports trimmed non-empty paste lines as one audited batch", () => {
    const result = importPasteList(
      withDivision(),
      "division-open",
      "Alpha\n\n Beta \r\nGamma",
      { type: "team" },
      ids,
      "free",
      context,
    );
    expect(result).toMatchObject({
      ok: true,
      requiredPermission: "entry:import",
      audit: [{ action: "entries.imported", details: { count: 3 } }],
    });
    expect(ok(result).divisions[0]?.entries.map((entry) => entry.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("matches the independent mapped CSV oracle including quoted commas", () => {
    const fixture = oracle().csv;
    const imported = ok(
      importCsv(
        withDivision(),
        "division-open",
        fixture.source,
        { name: "Display name", type: "Kind", seed: "Seed", club: "Club", countryCode: "Country" },
        { type: "team" },
        ids,
        "free",
        context,
      ),
    );
    expect(
      imported.divisions[0]?.entries.map((entry) => ({
        name: entry.name,
        type: entry.type,
        seed: entry.seed,
        club: entry.metadata.club,
        countryCode: entry.metadata.countryCode,
      })),
    ).toEqual(fixture.expected);
  });

  it.each([
    ["Name,Seed\nValid,1\nInvalid,nope", { name: "Name", seed: "Seed" }],
    ["Name,Seed\nDuplicate,1\nDuplicate,2", { name: "Name", seed: "Seed" }],
    ['Name\n"Unclosed', { name: "Name" }],
    ['Name\n"Alpha"junk', { name: "Name" }],
    ['Na"me\nAlpha', { name: "Name" }],
    ["Name\rAlpha", { name: "Name" }],
  ])("rolls back the entire CSV batch on any invalid row", (csv, mapping) => {
    const original = withDivision();
    const snapshot = structuredClone(original);
    const result = importCsv(original, "division-open", csv, mapping, { type: "team" }, ids, "free", context);
    expect(result).toMatchObject({ ok: false, error: { code: "IMPORT_VALIDATION_FAILED" } });
    expect(original).toEqual(snapshot);
    expect(original.divisions[0]?.entries).toEqual([]);
  });

  it("rejects mappings to absent headers before generating IDs", () => {
    let calls = 0;
    const result = importCsv(
      withDivision(),
      "division-open",
      "Name\nAlpha",
      { name: "Missing" },
      { type: "team" },
      () => `id-${++calls}`,
      "free",
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "IMPORT_VALIDATION_FAILED", issues: [{ code: "missing_column" }] },
    });
    expect(calls).toBe(0);
  });

  it("validates the full batch and context before invoking the ID factory", () => {
    let calls = 0;
    const factory = (row: number) => {
      calls += 1;
      return `id-${row}`;
    };
    expect(
      importPasteList(
        withDivision(),
        "division-open",
        "Duplicate\nDuplicate",
        { type: "team" },
        factory,
        "free",
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: "IMPORT_VALIDATION_FAILED" } });
    expect(calls).toBe(0);
    expect(
      importPasteList(withDivision(), "division-open", "Valid", { type: "team" }, factory, "free", {
        actorId: "",
        occurredAt: T0,
      }),
    ).toMatchObject({ ok: false, error: { code: "IMPORT_VALIDATION_FAILED" } });
    expect(calls).toBe(0);
  });

  it("converts an ID-factory exception into an atomic structured error", () => {
    const original = withDivision();
    const snapshot = structuredClone(original);
    let calls = 0;
    const result = importPasteList(
      original,
      "division-open",
      "Alpha\nBeta",
      { type: "team" },
      () => {
        calls += 1;
        if (calls === 2) throw new Error("generator unavailable");
        return "generated-1";
      },
      "free",
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "IMPORT_VALIDATION_FAILED",
        issues: [
          {
            code: "id_factory_error",
            row: 2,
            message: expect.stringContaining("external generator state may have advanced"),
          },
        ],
      },
    });
    expect(calls).toBe(2);
    expect(original).toEqual(snapshot);
    expect(original.divisions[0]?.entries).toEqual([]);
  });
});

describe("CMP-013–016 seeds, availability, replacement, and free-plan boundaries", () => {
  it("validates timezone-aware availability boundaries and overlap", () => {
    const valid = input(1, {
      availability: [
        { start: "2027-07-09T16:00:00.000Z", end: "2027-07-09T18:00:00.000Z" },
        { start: "2027-07-10T23:00:00.000Z", end: "2027-07-11T02:00:00.000Z" },
      ],
    });
    expect(addEntry(withDivision(), "division-open", valid, "free", context).ok).toBe(true);
    const outside = addEntry(
      withDivision(),
      "division-open",
      input(2, { availability: [{ start: "2027-07-09T15:59:59.000Z", end: "2027-07-09T17:00:00.000Z" }] }),
      "free",
      context,
    );
    expect(outside).toMatchObject({ ok: false, error: { issues: [{ code: "outside_competition_dates" }] } });
    const overlap = addEntry(
      withDivision(),
      "division-open",
      input(3, {
        availability: [
          { start: "2027-07-10T01:00:00.000Z", end: "2027-07-10T03:00:00.000Z" },
          { start: "2027-07-10T02:00:00.000Z", end: "2027-07-10T04:00:00.000Z" },
        ],
      }),
      "free",
      context,
    );
    expect(overlap.ok).toBe(false);
    if (!overlap.ok)
      expect(overlap.error.issues.map((candidate) => candidate.code)).toContain("overlapping_availability");
  });

  it("preserves withdrawal history and links an atomic replacement without increasing active count", () => {
    const added = ok(addEntry(withDivision(), "division-open", input(1), "free", context));
    const withdrawn = ok(
      withdrawEntry(added, "division-open", "entry-1", "Travel disruption", { ...context, occurredAt: T1 }),
    );
    expect(withdrawn.divisions[0]?.entries[0]?.status).toBe("withdrawn");
    const replaced = ok(
      replaceEntry(withdrawn, "division-open", "entry-1", { id: "entry-2", name: "Entry 2", type: "team" }, "free", {
        ...context,
        occurredAt: "2027-01-02T05:04:05.000Z",
      }),
    );
    expect(countActiveEntries(replaced)).toBe(1);
    expect(replaced.divisions[0]?.entries).toMatchObject([
      { id: "entry-1", status: "replaced", replacementEntryId: "entry-2" },
      { id: "entry-2", status: "active", replacesEntryId: "entry-1", seed: 1 },
    ]);
    const updatedReplacement = ok(
      updateEntry(replaced, "division-open", "entry-2", { name: "Updated replacement" }, context),
    );
    expect(updatedReplacement.divisions[0]?.entries[1]).toMatchObject({
      name: "Updated replacement",
      replacesEntryId: "entry-1",
    });
    expect(deleteEntry(updatedReplacement, "division-open", "entry-2", context)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(replaceEntry(replaced, "division-open", "entry-1", input(3), "free", context)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
  });

  it("enforces the 16-entry limit across arbitrary division distributions without destructive mutation", () => {
    expect(COMPETITION_FREE_ENTRY_LIMIT).toBe(oracle().free_entry_limit);
    for (let firstDivisionCount = 0; firstDivisionCount <= COMPETITION_FREE_ENTRY_LIMIT; firstDivisionCount += 1) {
      let competition = withDivision();
      competition = ok(addDivision(competition, { id: "division-2", name: "Second" }, context));
      for (let index = 1; index <= COMPETITION_FREE_ENTRY_LIMIT; index += 1) {
        const divisionId = index <= firstDivisionCount ? "division-open" : "division-2";
        competition = ok(addEntry(competition, divisionId, input(index), "free", context));
      }
      const snapshot = structuredClone(competition);
      const rejected = addEntry(competition, "division-2", input(17), "free", context);
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "FREE_ENTRY_LIMIT_REACHED", upgradeRequired: true, limit: 16 },
      });
      expect(competition).toEqual(snapshot);
      const upgraded = ok(addEntry(competition, "division-2", input(17), "organiser_pro", context));
      expect(countActiveEntries(upgraded)).toBe(17);
      expect(countActiveEntries(competition)).toBe(16);
    }
  });

  it("applies the free limit atomically to bulk imports", () => {
    let competition = withDivision();
    for (let index = 1; index <= 15; index += 1)
      competition = ok(addEntry(competition, "division-open", input(index), "free", context));
    let factoryCalls = 0;
    const result = importPasteList(
      competition,
      "division-open",
      "Sixteen\nSeventeen",
      { type: "team" },
      (row) => {
        factoryCalls += 1;
        return `bulk-${row}`;
      },
      "free",
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FREE_ENTRY_LIMIT_REACHED" } });
    expect(factoryCalls).toBe(0);
    expect(countActiveEntries(competition)).toBe(15);
  });

  it("does not let replacement of a withdrawn historical entry bypass the free limit", () => {
    let competition = withDivision();
    competition = ok(addEntry(competition, "division-open", input(1), "free", context));
    competition = ok(withdrawEntry(competition, "division-open", "entry-1", "Unavailable", context));
    for (let index = 2; index <= 17; index += 1) {
      competition = ok(addEntry(competition, "division-open", input(index), "free", context));
    }
    const snapshot = structuredClone(competition);
    expect(
      replaceEntry(
        competition,
        "division-open",
        "entry-1",
        { id: "replacement", name: "Replacement", type: "team" },
        "free",
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: "FREE_ENTRY_LIMIT_REACHED" } });
    expect(competition).toEqual(snapshot);
  });

  it("validates replacement name and seed against other active entries", () => {
    let competition = withDivision();
    competition = ok(addEntry(competition, "division-open", input(1), "free", context));
    competition = ok(addEntry(competition, "division-open", input(2), "free", context));
    const result = replaceEntry(
      competition,
      "division-open",
      "entry-1",
      { id: "replacement", name: "Entry 2", type: "team", seed: 2 },
      "free",
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    if (!result.ok)
      expect(result.error.issues.map((candidate) => candidate.code).sort()).toEqual([
        "duplicate_name",
        "duplicate_seed",
      ]);
  });
});

describe("CMP-017–018 duplicate, archive, and restore", () => {
  it("duplicates active configuration with caller-supplied IDs and resets lifecycle/history", () => {
    let source = withDivision();
    source = ok(addEntry(source, "division-open", input(1), "free", context));
    source = ok(addEntry(source, "division-open", input(2), "free", context));
    source = ok(withdrawEntry(source, "division-open", "entry-2", "Unavailable", context));
    source = { ...source, status: "completed", firstMatchStartedAt: "2027-07-10T01:00:00.000Z" };
    const duplicated = ok(
      duplicateCompetition(
        source,
        {
          competitionId: "competition-2",
          divisionIds: { "division-open": "division-new" },
          entryIds: { "entry-1": "entry-new" },
        },
        { name: "2028 National Open", slug: "2028-national-open", startDate: "2028-07-10", endDate: "2028-07-11" },
        { ...context, occurredAt: T1 },
      ),
    );
    expect(duplicated).toMatchObject({
      id: "competition-2",
      status: "draft",
      firstMatchStartedAt: null,
      archivedFromStatus: null,
    });
    expect(duplicated.divisions[0]).toMatchObject({
      id: "division-new",
      entries: [{ id: "entry-new", status: "active", divisionId: "division-new" }],
    });
    expect(source.divisions[0]?.entries).toHaveLength(2);
  });

  it.each(["draft", "ready", "published", "live", "completed"] as const)(
    "archives and restores the exact prior %s status",
    (status) => {
      const source = { ...withDivision(), status };
      const archived = ok(archiveCompetition(source, context));
      expect(archived).toMatchObject({ status: "archived", archivedFromStatus: status });
      expect(archiveCompetition(archived, context)).toMatchObject({
        ok: false,
        error: { code: "INVALID_STATE_TRANSITION" },
      });
      const restored = restoreCompetition(archived, { ...context, occurredAt: T1 });
      expect(restored).toMatchObject({
        ok: true,
        value: { status, archivedFromStatus: null },
        requiredPermission: "competition:restore",
        audit: [{ action: "competition.restored", details: { restoredStatus: status } }],
      });
    },
  );

  it("blocks all nested mutation while archived", () => {
    const archived = ok(archiveCompetition(withDivision(), context));
    expect(addDivision(archived, { id: "new", name: "New" }, context)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(addEntry(archived, "division-open", input(1), "free", context)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(
      withdrawEntry(
        { ...archived, divisions: withDivision().divisions },
        "division-open",
        "missing",
        "reason",
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});
