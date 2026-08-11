import { describe, expect, it } from "vitest";
import { organiserSections, v1OrganiserSections } from "./phase2";

describe("V1 organiser navigation", () => {
  it("shows only the primary competition journey", () => {
    expect(v1OrganiserSections.map((section) => section.id)).toEqual([
      "control-room",
      "entries",
      "capacity",
      "format",
      "schedule",
      "results",
      "publish",
    ]);
  });

  it("keeps advanced and operational routes supported but out of V1 navigation", () => {
    const routeIds = organiserSections.map((section) => section.id);
    expect(routeIds).toEqual(expect.arrayContaining(["setup", "settings", "access", "audit"]));
    expect(v1OrganiserSections.map((section) => section.id)).not.toEqual(
      expect.arrayContaining(["setup", "settings", "access", "audit"]),
    );
  });
});
