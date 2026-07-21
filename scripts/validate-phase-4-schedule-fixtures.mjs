import { readFile } from "node:fs/promises";

const fixtureUrl = new URL("../validation/phase-4/schedules/golden-oracles.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const expectedSizes = [8, 12, 16, 24, 48];

if (fixture.schema_version !== 1 || !Array.isArray(fixture.sizes)) {
  throw new Error("Phase 4 schedule fixture must use schema_version 1 and a sizes array");
}
if (JSON.stringify(fixture.sizes.map((item) => item.entry_count)) !== JSON.stringify(expectedSizes)) {
  throw new Error("Phase 4 schedule fixture must contain ordered 8/12/16/24/48 oracles");
}
for (const item of fixture.sizes) {
  if (!Number.isSafeInteger(item.expected_match_count) || item.expected_match_count < 1) {
    throw new Error(`Fixture ${item.entry_count} has an invalid expected_match_count`);
  }
  if (!Number.isSafeInteger(item.expected_span_minutes) || item.expected_span_minutes < 1) {
    throw new Error(`Fixture ${item.entry_count} has an invalid expected_span_minutes`);
  }
  if (
    !Array.isArray(item.expected_match_order) ||
    item.expected_match_order.length !== item.expected_match_count ||
    new Set(item.expected_match_order).size !== item.expected_match_order.length ||
    item.expected_match_order.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new Error(`Fixture ${item.entry_count} must contain one unique match ID per expected match`);
  }
}

const shared = fixture.multi_division;
if (
  !shared ||
  shared.expected_match_count !== 16 ||
  shared.expected_area_count !== 2 ||
  !Number.isSafeInteger(shared.expected_simultaneous_pairs) ||
  shared.expected_simultaneous_pairs < 1 ||
  !Array.isArray(shared.expected_assignment_order) ||
  shared.expected_assignment_order.length !== shared.expected_match_count ||
  shared.expected_assignment_order.some(
    (assignment) =>
      !Array.isArray(assignment) ||
      assignment.length !== 3 ||
      assignment.some((value) => typeof value !== "string" || value.length === 0),
  )
) {
  throw new Error("Phase 4 shared-area fixture must contain the frozen two-division assignment oracle");
}

console.log(`Validated ${fixture.sizes.length} size oracles and one shared-area multi-division oracle.`);
