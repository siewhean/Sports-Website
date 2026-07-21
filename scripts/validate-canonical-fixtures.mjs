import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixtureUrl = new URL("../validation/canonical-competitions.json", import.meta.url);
const pack = JSON.parse(await readFile(fixtureUrl, "utf8"));
const requiredSizes = [8, 12, 16, 24, 48];
const requiredModes = ["balanced", "compact", "participation"];

function assertPositiveInteger(value, context) {
  assert(Number.isInteger(value) && value > 0, `${context} must be a positive integer`);
}

function minutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  assert(match, `Invalid time: ${value}`);
  const [, hours, mins] = match.map(Number);
  assert(hours <= 23 && mins <= 59, `Invalid time: ${value}`);
  return hours * 60 + mins;
}

function parseDate(value, context) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${context}: expected YYYY-MM-DD`);
  const instant = new Date(`${value}T00:00:00Z`);
  assert(
    Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value,
    `${context}: invalid date`,
  );
  return instant.valueOf();
}

function assertTimeZone(value, context) {
  assert(typeof value === "string" && value.trim() === value && value.length > 0, `${context}: expected timezone`);
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: value }), `${context}: invalid IANA timezone`);
}

function calculateSlots(capacity, slotMinutes) {
  assertPositiveInteger(slotMinutes, "Slot duration");
  assertPositiveInteger(capacity.area_count, "Capacity area count");
  assertPositiveInteger(capacity.days, "Capacity day count");
  const opening = minutes(capacity.open);
  const closing = minutes(capacity.close);
  assert(closing > opening, "Capacity close must be after open");

  let cursor = opening;
  let slotsPerAreaDay = 0;
  const unavailable = [...capacity.unavailable].sort((left, right) => minutes(left.start) - minutes(right.start));
  for (const period of unavailable) {
    const start = minutes(period.start);
    const end = minutes(period.end);
    assert(end > start, "Unavailable period must have positive duration");
    assert(start >= cursor, "Unavailable periods must not overlap");
    assert(start >= opening, "Unavailable period starts before opening");
    assert(end <= closing, "Unavailable period ends after closing");
    slotsPerAreaDay += Math.floor((start - cursor) / slotMinutes);
    cursor = end;
  }
  slotsPerAreaDay += Math.floor((closing - cursor) / slotMinutes);
  return slotsPerAreaDay * capacity.area_count * capacity.days;
}

function roundRobinMatches(groups) {
  if (!groups) return 0;
  assertPositiveInteger(groups.count, "Round-robin group count");
  assertPositiveInteger(groups.size, "Round-robin group size");
  assert(groups.size >= 2, "Round-robin group size must contain at least two entries");
  return groups.count * ((groups.size * (groups.size - 1)) / 2);
}

function knockoutMatches(knockout) {
  if (!knockout) return 0;
  assertPositiveInteger(knockout.entrants, "Knockout entrant count");
  assert(knockout.entrants >= 2, "Knockout must contain at least two entrants");
  const bracketSize = 2 ** Math.ceil(Math.log2(knockout.entrants));
  assert.equal(knockout.byes ?? 0, bracketSize - knockout.entrants, "Knockout bye oracle mismatch");
  return knockout.entrants - 1 + Number(knockout.third_place);
}

function inclusiveDayCount(dates) {
  const start = parseDate(dates.start, "Competition start date");
  const end = parseDate(dates.end, "Competition end date");
  assert(end >= start, "Competition end date precedes start date");
  return (end - start) / 86_400_000 + 1;
}

assert.equal(pack.schema_version, "1.1.0");
assert.equal(pack.sport, "canoe_polo");
assert.equal(pack.assumptions.slot_minutes, 30);
assert(Array.isArray(pack.extended_scenarios), "Extended scenarios must be an array");
assert(pack.extended_scenarios.length > 0, "At least one extended scenario is required");
assert(
  pack.extended_scenarios.some((fixture) => fixture.fixture_id === "canoe-polo-multi-division-12-availability"),
  "Required multi-division availability scenario is missing",
);
assert.deepEqual(
  pack.competitions.map((fixture) => fixture.entry_count),
  requiredSizes,
);

const ids = new Set();
let roundRobinOnlyFormats = 0;
for (const fixture of pack.competitions) {
  assert(!ids.has(fixture.fixture_id), `Duplicate fixture ID: ${fixture.fixture_id}`);
  ids.add(fixture.fixture_id);
  assertPositiveInteger(fixture.entry_count, `${fixture.fixture_id}: entry count`);
  assertPositiveInteger(fixture.division_count, `${fixture.fixture_id}: division count`);
  assert.equal(fixture.division_count, 1, `${fixture.fixture_id}: canonical baseline is single-division`);
  assert.equal(fixture.divisions.length, fixture.division_count, `${fixture.fixture_id}: division count mismatch`);
  assert.equal(
    new Set(fixture.divisions.map((division) => division.id)).size,
    fixture.division_count,
    `${fixture.fixture_id}: duplicate division ID`,
  );
  for (const division of fixture.divisions) {
    assertPositiveInteger(division.entry_count, `${fixture.fixture_id}/${division.id}: division entry count`);
  }
  assert.equal(
    fixture.divisions.reduce((total, division) => total + division.entry_count, 0),
    fixture.entry_count,
    `${fixture.fixture_id}: division entry totals do not match competition`,
  );
  assertTimeZone(fixture.timezone, `${fixture.fixture_id}: timezone`);
  assert.equal(
    inclusiveDayCount(fixture.dates),
    fixture.capacity.days,
    `${fixture.fixture_id}: date range and capacity-day count differ`,
  );
  assert.match(fixture.entry_prefix, /^cp\d{2}-team-$/);

  const generatedEntries = Array.from({ length: fixture.entry_count }, (_, index) => ({
    id: `${fixture.entry_prefix}${String(index + 1).padStart(2, "0")}`,
    seed: index + 1,
    division_id: fixture.divisions[0].id,
  }));
  assert.equal(new Set(generatedEntries.map((entry) => entry.id)).size, fixture.entry_count);
  assert.equal(generatedEntries.at(-1).seed, fixture.entry_count);
  assert(generatedEntries.every((entry) => fixture.divisions.some((division) => division.id === entry.division_id)));

  const slots = calculateSlots(fixture.capacity, pack.assumptions.slot_minutes);
  assert.equal(slots, fixture.capacity.expected_slots, `${fixture.fixture_id}: capacity oracle mismatch`);
  assert.deepEqual(
    fixture.formats.map((format) => format.mode).sort(),
    requiredModes,
    `${fixture.fixture_id}: missing format mode`,
  );

  for (const format of fixture.formats) {
    if (format.groups) {
      assert.equal(
        format.groups.count * format.groups.size,
        fixture.entry_count,
        `${fixture.fixture_id}/${format.mode}: groups must place every entry exactly once`,
      );
      assert.equal(
        format.guaranteed_matches,
        format.groups.size - 1,
        `${fixture.fixture_id}/${format.mode}: group round robin determines guaranteed matches`,
      );
      assert.equal(
        format.qualification.source,
        "group_rank",
        `${fixture.fixture_id}/${format.mode}: wrong qualification source`,
      );
      assert(
        Number.isInteger(format.qualification.per_group),
        `${fixture.fixture_id}/${format.mode}: per-group qualifier count must be an integer`,
      );
      assert(
        format.qualification.per_group >= 0,
        `${fixture.fixture_id}/${format.mode}: negative per-group qualifier count`,
      );
      assert(
        format.qualification.per_group <= format.groups.size,
        `${fixture.fixture_id}/${format.mode}: too many qualifiers per group`,
      );
      assert(
        format.qualification.best_remaining <= format.groups.count,
        `${fixture.fixture_id}/${format.mode}: too many best-remaining qualifiers`,
      );
      if (format.qualification.best_remaining > 0) {
        assert.equal(
          format.qualification.best_remaining_rank,
          format.qualification.per_group + 1,
          `${fixture.fixture_id}/${format.mode}: best-remaining rank must follow automatic qualifiers`,
        );
      }
      assert.equal(
        format.groups.count * format.qualification.per_group + format.qualification.best_remaining,
        format.qualifiers,
        `${fixture.fixture_id}/${format.mode}: qualification rule does not produce declared qualifier count`,
      );
    } else {
      assert.equal(format.guaranteed_matches, 1, `${fixture.fixture_id}/compact: minimum is one match`);
      assert.equal(
        format.qualification.source,
        "seeded_entries",
        `${fixture.fixture_id}/compact: wrong qualification source`,
      );
      assert.equal(
        format.qualification.count,
        fixture.entry_count,
        `${fixture.fixture_id}/compact: seeded entry count mismatch`,
      );
    }

    assert(format.qualifiers <= fixture.entry_count, `${fixture.fixture_id}/${format.mode}: too many qualifiers`);
    if (format.knockout) {
      assert.equal(
        format.qualifiers,
        format.knockout.entrants,
        `${fixture.fixture_id}/${format.mode}: qualifier and knockout sizes differ`,
      );
    } else {
      assert.equal(format.qualifiers, 0, `${fixture.fixture_id}/${format.mode}: qualifiers require a knockout`);
    }
    const calculatedMatches = roundRobinMatches(format.groups) + knockoutMatches(format.knockout);
    if (format.groups && !format.knockout) roundRobinOnlyFormats += 1;
    assert.equal(
      calculatedMatches,
      format.expected_matches,
      `${fixture.fixture_id}/${format.mode}: match oracle mismatch`,
    );
    assert.equal(
      slots - format.expected_matches,
      format.expected_remaining_slots,
      `${fixture.fixture_id}/${format.mode}: remaining-slot oracle mismatch`,
    );
    assert(format.expected_remaining_slots >= 0, `${fixture.fixture_id}/${format.mode}: format exceeds capacity`);
  }
}

assert(roundRobinOnlyFormats >= 1, "At least one canonical format must be round-robin-only");

for (const fixture of pack.extended_scenarios) {
  assert(!ids.has(fixture.fixture_id), `Duplicate fixture ID: ${fixture.fixture_id}`);
  ids.add(fixture.fixture_id);
  assertPositiveInteger(fixture.entry_count, `${fixture.fixture_id}: entry count`);
  assertPositiveInteger(fixture.division_count, `${fixture.fixture_id}: division count`);
  assert(fixture.division_count > 1, `${fixture.fixture_id}: extended scenario must be multi-division`);
  assert.equal(fixture.divisions.length, fixture.division_count, `${fixture.fixture_id}: division count mismatch`);
  assert.equal(
    new Set(fixture.divisions.map((division) => division.id)).size,
    fixture.division_count,
    `${fixture.fixture_id}: duplicate division ID`,
  );
  for (const division of fixture.divisions) {
    assertPositiveInteger(division.entry_count, `${fixture.fixture_id}/${division.id}: division entry count`);
    assert.equal(typeof division.entry_prefix, "string", `${fixture.fixture_id}/${division.id}: entry prefix missing`);
    assert(division.entry_prefix.length > 0, `${fixture.fixture_id}/${division.id}: entry prefix is empty`);
  }
  assertTimeZone(fixture.timezone, `${fixture.fixture_id}: timezone`);
  assert.equal(
    fixture.divisions.reduce((total, division) => total + division.entry_count, 0),
    fixture.entry_count,
    `${fixture.fixture_id}: division entry totals do not match competition`,
  );
  assert.equal(
    inclusiveDayCount(fixture.dates),
    fixture.capacity.days,
    `${fixture.fixture_id}: date range and capacity-day count differ`,
  );

  const generatedEntries = fixture.divisions.flatMap((division) =>
    Array.from({ length: division.entry_count }, (_, index) => ({
      id: `${division.entry_prefix}${String(index + 1).padStart(2, "0")}`,
      division_id: division.id,
    })),
  );
  const entryIds = new Set(generatedEntries.map((entry) => entry.id));
  assert.equal(entryIds.size, fixture.entry_count, `${fixture.fixture_id}: generated entry IDs are not unique`);
  assert(
    fixture.entry_availability_constraints.length > 0,
    `${fixture.fixture_id}: entry availability constraints are required`,
  );
  assert.equal(
    new Set(fixture.entry_availability_constraints.map((constraint) => constraint.entry_id)).size,
    fixture.entry_availability_constraints.length,
    `${fixture.fixture_id}: duplicate entry availability constraint`,
  );
  for (const constraint of fixture.entry_availability_constraints) {
    assert(entryIds.has(constraint.entry_id), `${fixture.fixture_id}: availability references an unknown entry`);
    assert(constraint.unavailable.length > 0, `${fixture.fixture_id}: empty entry availability constraint`);
    for (const period of constraint.unavailable) {
      const date = parseDate(period.date, `${fixture.fixture_id}/${constraint.entry_id}: availability date`);
      const startDate = parseDate(fixture.dates.start, `${fixture.fixture_id}: start date`);
      const endDate = parseDate(fixture.dates.end, `${fixture.fixture_id}: end date`);
      assert(date >= startDate && date <= endDate, `${fixture.fixture_id}: availability date is out of range`);
      assert(minutes(period.end) > minutes(period.start), `${fixture.fixture_id}: availability range is empty`);
      assert(
        minutes(period.start) >= minutes(fixture.capacity.open),
        `${fixture.fixture_id}: availability starts early`,
      );
      assert(minutes(period.end) <= minutes(fixture.capacity.close), `${fixture.fixture_id}: availability ends late`);
    }
  }

  assert.equal(
    fixture.division_formats.length,
    fixture.division_count,
    `${fixture.fixture_id}: every division requires one format oracle`,
  );
  const formatDivisionIds = new Set();
  let calculatedMatches = 0;
  for (const format of fixture.division_formats) {
    assert(!formatDivisionIds.has(format.division_id), `${fixture.fixture_id}: duplicate division format`);
    formatDivisionIds.add(format.division_id);
    const division = fixture.divisions.find((candidate) => candidate.id === format.division_id);
    assert(division, `${fixture.fixture_id}: format references an unknown division`);
    assert.equal(format.mode, "round_robin_only", `${fixture.fixture_id}/${format.division_id}: unexpected mode`);
    assert.equal(
      format.groups.count * format.groups.size,
      division.entry_count,
      `${fixture.fixture_id}/${format.division_id}: groups do not place every entry`,
    );
    assert.equal(format.knockout, null, `${fixture.fixture_id}/${format.division_id}: knockout must be absent`);
    assert.equal(
      format.guaranteed_matches,
      format.groups.size - 1,
      `${fixture.fixture_id}/${format.division_id}: guaranteed-match oracle mismatch`,
    );
    const divisionMatches = roundRobinMatches(format.groups) + knockoutMatches(format.knockout);
    assert.equal(
      divisionMatches,
      format.expected_matches,
      `${fixture.fixture_id}/${format.division_id}: match oracle mismatch`,
    );
    calculatedMatches += divisionMatches;
  }
  assert.equal(calculatedMatches, fixture.expected_matches, `${fixture.fixture_id}: aggregate match oracle mismatch`);

  const slots = calculateSlots(fixture.capacity, pack.assumptions.slot_minutes);
  assert.equal(slots, fixture.capacity.expected_slots, `${fixture.fixture_id}: capacity oracle mismatch`);
  assert.equal(
    slots - calculatedMatches,
    fixture.expected_remaining_slots,
    `${fixture.fixture_id}: remaining-slot oracle mismatch`,
  );
  assert(fixture.expected_remaining_slots >= 0, `${fixture.fixture_id}: format exceeds capacity`);
}

console.log(
  `Validated ${pack.competitions.length} canonical competitions, ${pack.extended_scenarios.length} extended scenario, and ${pack.competitions.length * 3 + pack.extended_scenarios.reduce((total, fixture) => total + fixture.division_formats.length, 0)} format oracles.`,
);
