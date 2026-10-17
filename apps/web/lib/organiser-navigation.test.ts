import { describe, expect, it } from "vitest";
import { organiserSections } from "./phase2";
import {
  activityTab,
  modeHref,
  modeOfTab,
  organiserTabs,
  playingAreasLabel,
  sectionTabs,
  type OrganiserTab,
} from "./organiser-navigation";

const competition = { id: "national-cup", sportCode: "canoe_polo" };
const base = "/organiser/competitions/national-cup";
const allTabs = [...organiserTabs(competition, "setup"), ...organiserTabs(competition, "live")];

describe("redesign Phase 2 organiser navigation", () => {
  it("keeps every old organiser section reachable at its old URL", () => {
    for (const section of organiserSections) {
      const tab = allTabs.find((item) => item.id === sectionTabs[section.id]);
      expect(tab, section.id).toBeDefined();
      const expected = section.id === "control-room" ? base : `${base}/${section.id}`;
      expect(tab?.href, section.id).toBe(expected);
    }
  });

  it("splits Setup and Live, with Activity in both", () => {
    expect(organiserTabs(competition, "setup").map((tab) => tab.label)).toEqual([
      "Overview",
      "Details",
      "Teams",
      "Venue and dates",
      "Rules",
      "Format",
      "Schedule",
      "Officials",
      "Publish",
      "Activity",
    ]);
    expect(organiserTabs(competition, "live").map((tab) => tab.label)).toEqual([
      "Pitches",
      "Results and standings",
      "Walkovers and corrections",
      "Scoring access",
      "Activity",
    ]);
    expect(new Set(allTabs.map((tab) => tab.href)).size).toBe(allTabs.length);
  });

  it("puts every tab in the area it is listed under", () => {
    for (const tab of allTabs) expect(modeOfTab(tab.id as OrganiserTab)).toBe(tab.mode);
  });

  it("sends the switch to the first tab of each area", () => {
    expect(modeHref("national-cup", "setup")).toBe(base);
    expect(modeHref("national-cup", "live")).toBe(`${base}/live`);
    expect(organiserTabs(competition, "live")[0]?.href).toBe(`${base}/live`);
  });

  it("keeps the Live header on Activity opened from Live", () => {
    expect(activityTab("live")).toBe("live-activity");
    expect(activityTab(undefined)).toBe("setup-activity");
    expect(activityTab("anything")).toBe("setup-activity");
  });

  it("names playing areas the way each sport does", () => {
    expect(playingAreasLabel("canoe_polo")).toBe("Pitches");
    expect(playingAreasLabel("badminton")).toBe("Courts");
    expect(playingAreasLabel("table_tennis")).toBe("Tables");
    expect(playingAreasLabel("volleyball")).toBe("Courts");
    expect(playingAreasLabel("basketball")).toBe("Courts");
    expect(playingAreasLabel(undefined)).toBe("Courts");
  });

  it("encodes competition ids in links", () => {
    expect(organiserTabs({ id: "a/b" }, "setup")[0]?.href).toBe("/organiser/competitions/a%2Fb");
  });
});
