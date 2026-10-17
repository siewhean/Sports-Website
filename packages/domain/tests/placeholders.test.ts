import { describe, expect, it } from "vitest";
import { canRegistrationReplacePlaceholder, generateDivisionShortCode, placeholderLabel } from "../src/placeholders.js";

describe("placeholders domain engine", () => {
  describe("generateDivisionShortCode", () => {
    it("suggests expected standard codes for division names", () => {
      expect(generateDivisionShortCode("Men's Open")).toBe("M");
      expect(generateDivisionShortCode("Women's Open")).toBe("W");
      expect(generateDivisionShortCode("Mixed Open")).toBe("X");
      expect(generateDivisionShortCode("Open")).toBe("O");
      expect(generateDivisionShortCode("Boys U14")).toBe("B");
      expect(generateDivisionShortCode("Girls U14")).toBe("G");
      expect(generateDivisionShortCode("Under 18")).toBe("U18");
      expect(generateDivisionShortCode("Under 21")).toBe("U21");
      expect(generateDivisionShortCode("U-16")).toBe("U16");
      expect(generateDivisionShortCode("Division 1")).toBe("D");
    });

    it("resolves collisions by appending digits within 4 characters", () => {
      expect(generateDivisionShortCode("Men's Open", ["M"])).toBe("M2");
      expect(generateDivisionShortCode("Men's Open", ["M", "M2"])).toBe("M3");
      expect(generateDivisionShortCode("Under 18", ["U18"])).toBe("U182");
      expect(generateDivisionShortCode("Under 18", ["U18", "U182"])).toBe("U183");
      // If code is 4 characters, prefix is truncated to fit suffix
      expect(generateDivisionShortCode("U180", ["U180"])).toBe("U182");
    });
  });

  describe("placeholderLabel (D16 derived labels)", () => {
    it("derives labels before a format is created", () => {
      const placeholder = { id: "p1", entry_type: "placeholder", seed: 1 };

      // Single division
      expect(placeholderLabel({ entry: placeholder })).toBe("Team 1");
      expect(placeholderLabel({ entry: placeholder, isPublic: true })).toBe("Team 1 (TBC)");

      // Multi-division with division code
      expect(
        placeholderLabel({
          entry: placeholder,
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("M-1");

      expect(
        placeholderLabel({
          entry: placeholder,
          divisionShortCode: "M",
          multiDivision: true,
          isPublic: true,
        }),
      ).toBe("Team M-1 (TBC)");
    });

    it("derives labels after format from group membership and updates on move", () => {
      const placeholder = { id: "p1", entry_type: "placeholder", seed: 1 };

      // Group A position 1
      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
        }),
      ).toBe("A1");

      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
          isPublic: true,
        }),
      ).toBe("Team A1 (TBC)");

      // Multi-division after format
      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("M-A1");

      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "A", position: 1 },
          divisionShortCode: "M",
          multiDivision: true,
          isPublic: true,
        }),
      ).toBe("Team M-A1 (TBC)");

      // Moving to Group B position 2 automatically reflects in label
      expect(
        placeholderLabel({
          entry: placeholder,
          groupMembership: { groupLabel: "B", position: 2 },
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("M-B2");
    });

    it("returns real team name when entry is not a placeholder", () => {
      const realTeam = {
        id: "t1",
        name: "Vikings RFC",
        entry_type: "team",
        seed: 1,
      };

      // Real name replaces label everywhere, even if groupMembership is provided
      expect(
        placeholderLabel({
          entry: realTeam,
          groupMembership: { groupLabel: "A", position: 1 },
          divisionShortCode: "M",
          multiDivision: true,
          isPublic: true,
        }),
      ).toBe("Vikings RFC");

      expect(
        placeholderLabel({
          entry: realTeam,
          divisionShortCode: "M",
          multiDivision: true,
        }),
      ).toBe("Vikings RFC");
    });
  });

  describe("canRegistrationReplacePlaceholder", () => {
    it("allows replacement only for approved registrations, never pending", () => {
      expect(canRegistrationReplacePlaceholder("pending")).toBe(false);
      expect(canRegistrationReplacePlaceholder("unverified")).toBe(false);
      expect(canRegistrationReplacePlaceholder("rejected")).toBe(false);
      expect(canRegistrationReplacePlaceholder("approved")).toBe(true);
    });
  });
});
