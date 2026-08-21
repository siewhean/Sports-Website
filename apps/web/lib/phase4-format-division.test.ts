import { describe, expect, it } from "vitest";
import { formatDivisionHref, formatDivisionOptions, selectFormatDivision } from "./phase4-format-division";

const primary = { id: "division-open", name: "Open" };
const women = { id: "division-women", name: "Women" };

describe("Phase 4 format division routing", () => {
  it("keeps the authoritative primary division first and removes duplicate IDs", () => {
    expect(formatDivisionOptions(primary, [women, primary, { id: "", name: "Invalid" }])).toEqual([primary, women]);
  });

  it("defaults only when no division was requested and fails closed otherwise", () => {
    const divisions = [primary, women];
    expect(selectFormatDivision(divisions, undefined)).toEqual(primary);
    expect(selectFormatDivision(divisions, women.id)).toEqual(women);
    expect(selectFormatDivision(divisions, "unknown")).toBeNull();
    expect(selectFormatDivision(divisions, "")).toBeNull();
    expect(selectFormatDivision(divisions, [women.id])).toBeNull();
  });

  it("builds an encoded canonical URL that keeps the selected division explicit", () => {
    expect(formatDivisionHref("competition/id", "women & girls")).toBe(
      "/organiser/competitions/competition%2Fid/format?division=women+%26+girls",
    );
  });
});
