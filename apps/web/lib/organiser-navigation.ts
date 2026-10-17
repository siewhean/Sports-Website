import { playingAreaNoun, type SportId } from "@matchday/domain";
import { messages } from "@matchday/ui";
import type { OrganiserSection } from "@/lib/phase2";

/**
 * Redesign Phase 2 (owner decision D8): organiser competition pages are split into two areas.
 * Setup holds everything you prepare before match day; Live holds match-day tools. Every old organiser
 * section keeps its URL and is reachable from exactly one tab (Activity appears in both areas).
 */
export type OrganiserMode = "setup" | "live";

export type OrganiserTab =
  | "overview"
  | "details"
  | "teams"
  | "venue"
  | "rules"
  | "format"
  | "schedule"
  | "officials"
  | "publish"
  | "setup-activity"
  | "courts"
  | "results"
  | "corrections"
  | "access"
  | "live-activity";

export type OrganiserTabLink = Readonly<{ id: OrganiserTab; mode: OrganiserMode; label: string; href: string }>;

type TabDefinition = Readonly<{ id: OrganiserTab; mode: OrganiserMode; path: string }>;

const copy = messages.organiserShell;

const tabDefinitions: readonly TabDefinition[] = [
  { id: "overview", mode: "setup", path: "" },
  { id: "details", mode: "setup", path: "/setup" },
  { id: "teams", mode: "setup", path: "/entries" },
  { id: "venue", mode: "setup", path: "/capacity" },
  { id: "rules", mode: "setup", path: "/settings" },
  { id: "format", mode: "setup", path: "/format" },
  { id: "schedule", mode: "setup", path: "/schedule" },
  { id: "officials", mode: "setup", path: "/officials" },
  { id: "publish", mode: "setup", path: "/publish" },
  { id: "setup-activity", mode: "setup", path: "/audit" },
  { id: "courts", mode: "live", path: "/live" },
  { id: "results", mode: "live", path: "/results" },
  { id: "corrections", mode: "live", path: "/repairs" },
  { id: "access", mode: "live", path: "/access" },
  { id: "live-activity", mode: "live", path: "/audit?mode=live" },
];

/** The tab that hosts each old organiser section. */
export const sectionTabs: Readonly<Record<OrganiserSection, OrganiserTab>> = {
  "control-room": "overview",
  setup: "details",
  settings: "rules",
  entries: "teams",
  capacity: "venue",
  format: "format",
  officials: "officials",
  schedule: "schedule",
  results: "results",
  publish: "publish",
  access: "access",
  audit: "setup-activity",
};

export function organiserBasePath(competitionId: string): string {
  return `/organiser/competitions/${encodeURIComponent(competitionId)}`;
}

function isSportId(value: string | undefined): value is SportId {
  return (
    value === "canoe_polo" ||
    value === "badminton" ||
    value === "table_tennis" ||
    value === "volleyball" ||
    value === "basketball"
  );
}

/** "Pitches", "Courts" or "Tables" for the competition's sport; "Courts" when the sport is unknown. */
export function playingAreasLabel(sportCode: string | undefined): string {
  return copy.areas[isSportId(sportCode) ? playingAreaNoun(sportCode) : "court"];
}

function tabLabel(id: OrganiserTab, sportCode: string | undefined): string {
  switch (id) {
    case "setup-activity":
    case "live-activity":
      return copy.tabs.activity;
    case "courts":
      return playingAreasLabel(sportCode);
    default:
      return copy.tabs[id];
  }
}

export function organiserTabs(
  competition: Readonly<{ id: string; sportCode?: string | undefined }>,
  mode: OrganiserMode,
): OrganiserTabLink[] {
  const base = organiserBasePath(competition.id);
  return tabDefinitions
    .filter((tab) => tab.mode === mode)
    .map((tab) => ({
      id: tab.id,
      mode: tab.mode,
      label: tabLabel(tab.id, competition.sportCode),
      href: base + tab.path,
    }));
}

export function modeOfTab(tab: OrganiserTab): OrganiserMode {
  return tabDefinitions.find((definition) => definition.id === tab)?.mode ?? "setup";
}

/** Where the Setup / Live switch goes: the first tab of each area. */
export function modeHref(competitionId: string, mode: OrganiserMode): string {
  return organiserBasePath(competitionId) + (mode === "live" ? "/live" : "");
}

/** Activity is shared; `?mode=live` keeps the Live header when it is opened from Live. */
export function activityTab(mode: string | undefined): OrganiserTab {
  return mode === "live" ? "live-activity" : "setup-activity";
}
