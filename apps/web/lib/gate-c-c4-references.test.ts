import { describe, expect, it } from "vitest";
import { parseGateCC4References } from "./gate-c-c4-references";

const ids = {
  entry: "11111111-1111-4111-8111-111111111111",
  division: "22222222-2222-4222-8222-222222222222",
  area: "33333333-3333-4333-8333-333333333333",
  match: "44444444-4444-4444-8444-444444444444",
} as const;

function references() {
  return {
    entries: [{ id: ids.entry, division_id: ids.division, name: "Marina Blue" }],
    playing_areas: [{ id: ids.area, name: "Court 1" }],
    matches: [{ id: ids.match, label: "M12", home: "Marina Blue", away: "Harbour Gold" }],
  };
}

describe("parseGateCC4References", () => {
  it("retains a validated authoritative score-sheet match list", () => {
    expect(parseGateCC4References(references())).toMatchObject({
      matches: [{ id: ids.match, label: "M12", home: "Marina Blue", away: "Harbour Gold" }],
    });
  });

  it("rejects malformed or duplicate score-sheet references", () => {
    const malformed = references();
    malformed.matches[0] = { ...malformed.matches[0]!, home: "" };
    expect(parseGateCC4References(malformed)).toBeNull();

    const duplicate = references();
    duplicate.matches.push({ ...duplicate.matches[0]! });
    expect(parseGateCC4References(duplicate)).toBeNull();
  });
});
