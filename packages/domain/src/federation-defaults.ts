import type { SettingValue, SportId, SportPack, SportPackSettings } from "./sport-packs.js";
import {
  BADMINTON_3X15_SPORT_PACK_VERSION,
  FEDERATION_SPORT_PACK_VERSION,
  FEDERATION_SPORT_PACKS,
} from "./sport-packs.js";

/**
 * Redesign Phase 4: the single, machine-readable table of federation rules behind the `1.0.0` packs. Every
 * rule cites where it comes from. `verified` says how sure we are:
 * - `primary`: read in the federation's own document;
 * - `secondary`: taken from a secondary source and still to be checked against the federation document;
 * - `unverified`: not checked yet.
 * Checkpoint F-1 blocks new competitions from these packs while any rule is not `primary`.
 */
export type RuleVerification = "primary" | "secondary" | "unverified";

export type RuleSource = Readonly<{
  doc: string;
  edition: string;
  clause?: string;
  url: string;
  verified: RuleVerification;
}>;

export type RuleGroup = "scoring" | "time" | "discipline" | "standings" | "forfeits" | "players";

export type FederationRule = Readonly<{
  /** The pack setting this rule sets. */
  setting: string;
  group: RuleGroup;
  value: SettingValue;
  source: RuleSource;
  /** Shown to officials and logged; MATCHDAY does not enforce it (for example the shot clock). */
  recordOnly?: boolean;
}>;

const icf = (clause: string): RuleSource => ({
  doc: "ICF Canoe Polo Competition Rules",
  edition: "2025",
  clause,
  url: "https://federations.canoeicf.com/sites/default/files/2025_icf_competition_rules_canoe_polo_-_final.pdf",
  verified: "primary",
});

const fivb = (clause: string): RuleSource => ({
  doc: "FIVB Official Volleyball Rules",
  edition: "2025-2028",
  clause,
  url: "https://www.fivb.com/wp-content/uploads/2025/01/FIVB-Volleyball_Rules2025_2028-EN-v05.pdf",
  verified: "primary",
});

const fiba = (clause: string): RuleSource => ({
  doc: "FIBA Official Basketball Rules",
  edition: "2026 v1.1 (effective 1 Oct 2026)",
  clause,
  url: "https://assets.fiba.basketball/image/upload/documents-corporate-fiba-official-rules-2026-v1-1.pdf",
  verified: "primary",
});

// The ITTF Laws were only read in Table Tennis England's verbatim copy of the 2026 Statutes, so they stay
// secondary until the ITTF's own text is checked.
const ittf = (clause: string): RuleSource => ({
  doc: "ITTF Statutes, Laws of Table Tennis",
  edition: "2026 (54th edition)",
  clause,
  url: "https://documents.ittf.sport/sites/default/files/public/2026-02/2026_Statutes_v1_consolidated_clean.pdf",
  verified: "secondary",
});

// 3×21 was read in BWF Laws V2.1 (2023), not the current V5.0; 3×15 only in BWF's April 2026 announcements,
// not the Laws V6.0 text. Both stay secondary until the current Laws are checked.
const bwf = (edition: string, clause: string, url: string): RuleSource => ({
  doc: "BWF Laws of Badminton",
  edition,
  clause,
  url,
  verified: "secondary",
});

const BWF_LAWS_3X21_URL =
  "https://extranet.bwf.sport/docs/document-system/81/1466/1470/Section%204.1%20-%20Laws%20of%20Badminton%20-%2026%20April%202025%20V5.0%20(2)%20.pdf";
const BWF_3X15_URL = "https://bwfbadminton.com/news-single/2026/04/26/key-changes-under-the-3x15-scoring-system";

const rule = (
  setting: string,
  group: RuleGroup,
  value: SettingValue,
  source: RuleSource,
  recordOnly = false,
): FederationRule => Object.freeze({ setting, group, value, source, ...(recordOnly ? { recordOnly } : {}) });

const badmintonGames = (target: number, cap: number, edition: string, url: string): readonly FederationRule[] => [
  rule("bestOf", "scoring", 3, bwf(edition, "Law 7.1", url)),
  rule("regularTargetPoints", "scoring", target, bwf(edition, "Law 7.2", url)),
  rule("winBy", "scoring", 2, bwf(edition, "Law 7.4", url)),
  rule("pointCap", "scoring", cap, bwf(edition, "Law 7.5", url)),
];

const table: Readonly<Record<string, readonly FederationRule[]>> = {
  [`canoe_polo@${FEDERATION_SPORT_PACK_VERSION}`]: [
    rule("periods", "time", 2, icf("Periods of play")),
    rule("periodDurationMinutes", "time", 10, icf("Periods of play")),
    rule("intervalMinutes", "time", 3, icf("Half-time interval")),
    rule("overtimeBreakMinutes", "time", 3, icf("Extra time")),
    rule("overtimeDurationMinutes", "time", 5, icf("Extra time")),
    rule("goldenGoal", "time", true, icf("Extra time")),
    rule("shotClockSeconds", "time", 60, icf("Shot clock"), true),
    rule("timeoutsPerTeam", "time", 0, icf("Time-outs")),
    rule("playersOnField", "players", 5, icf("Teams")),
    rule("rosterMax", "players", 8, icf("Teams")),
    rule("winPoints", "standings", 3, icf("League points")),
    rule("drawPoints", "standings", 1, icf("League points")),
    rule("lossPoints", "standings", 0, icf("League points")),
    rule("forfeitWinnerScore", "forfeits", 7, icf("Forfeit")),
    rule("forfeitLoserScore", "forfeits", 0, icf("Forfeit")),
  ],
  [`volleyball@${FEDERATION_SPORT_PACK_VERSION}`]: [
    rule("bestOf", "scoring", 5, fivb("Rule 6.3 To win the match")),
    rule("regularTargetPoints", "scoring", 25, fivb("Rule 6.2 To win a set")),
    rule("decidingTargetPoints", "scoring", 15, fivb("Rule 6.3.2 Deciding set")),
    rule("winBy", "scoring", 2, fivb("Rule 6.2 To win a set")),
    rule("pointCap", "scoring", null, fivb("Rule 6.2 To win a set")),
    rule("timeoutsPerSet", "time", 2, fivb("Rule 15.1 Number of regular game interruptions")),
    rule("timeoutSeconds", "time", 30, fivb("Rule 15.4.1 Time-outs")),
    rule("substitutionsPerSet", "players", 6, fivb("Rule 15.6 Substitutions"), true),
    rule("setIntervalMinutes", "time", 3, fivb("Rule 18.1 Intervals")),
    rule("forfeitWinnerScore", "forfeits", 25, fivb("Rule 6.4 Default")),
    rule("forfeitLoserScore", "forfeits", 0, fivb("Rule 6.4 Default")),
  ],
  [`basketball@${FEDERATION_SPORT_PACK_VERSION}`]: [
    rule("periods", "time", 4, fiba("Art. 8.1 Playing time")),
    rule("periodDurationMinutes", "time", 10, fiba("Art. 8.1 Playing time")),
    rule("overtimeDurationMinutes", "time", 5, fiba("Art. 8.7 Overtime")),
    rule("successiveOvertime", "time", true, fiba("Art. 8.7 Overtime")),
    rule("forfeitWinnerScore", "forfeits", 20, fiba("Art. 20.2.1 Forfeit")),
    rule("forfeitLoserScore", "forfeits", 0, fiba("Art. 20.2.1 Forfeit")),
    // Default (Art. 21) is not a forfeit: the score stands if the other team leads, otherwise 2-0, and the
    // defaulting team still gets 1 classification point.
    rule("defaultWinnerScore", "forfeits", 2, fiba("Art. 21.1, 21.2.1 Default")),
    rule("defaultLoserScore", "forfeits", 0, fiba("Art. 21.1, 21.2.1 Default")),
    rule("defaultLossPoints", "standings", 1, fiba("Art. 21.1, 21.2.1 Default")),
  ],
  [`table_tennis@${FEDERATION_SPORT_PACK_VERSION}`]: [
    rule("bestOf", "scoring", 5, ittf("Law 2.12.1 A match")),
    rule("regularTargetPoints", "scoring", 11, ittf("Law 2.11.1 A game")),
    rule("winBy", "scoring", 2, ittf("Law 2.11.1 A game")),
    rule("pointCap", "scoring", null, ittf("Law 2.11.1 A game")),
  ],
  [`badminton@${FEDERATION_SPORT_PACK_VERSION}`]: badmintonGames(
    21,
    30,
    "3×21 scoring (read in V2.1, 2023)",
    BWF_LAWS_3X21_URL,
  ),
  [`badminton@${BADMINTON_3X15_SPORT_PACK_VERSION}`]: badmintonGames(
    15,
    21,
    "3×15 scoring, from 4 Jan 2027 (BWF announcement)",
    BWF_3X15_URL,
  ),
};

export const FEDERATION_DEFAULTS: Readonly<Record<string, readonly FederationRule[]>> = Object.freeze(
  Object.fromEntries(Object.entries(table).map(([key, rules]) => [key, Object.freeze([...rules])])),
);

/** The cited federation rules for one pack, or an empty list for a draft pack that has none. */
export function federationRulesFor(sportId: SportId, packVersion: string): readonly FederationRule[] {
  return FEDERATION_DEFAULTS[`${sportId}@${packVersion}`] ?? [];
}

/** Rules that checkpoint F-1 still has to verify against the federation's own document. */
export function rulesNeedingVerification(): readonly Readonly<{ pack: string; rule: FederationRule }>[] {
  return Object.entries(FEDERATION_DEFAULTS).flatMap(([pack, rules]) =>
    rules
      .filter((candidate) => candidate.source.verified !== "primary")
      .map((candidate) => ({ pack, rule: candidate })),
  );
}

export type RuleStatus = "federation_default" | "changed" | "matchday_default";

export type RuleRow = Readonly<{
  setting: string;
  label: string;
  group: RuleGroup | "other";
  value: SettingValue;
  /** The federation value, when the rule comes from a federation; otherwise MATCHDAY's own default. */
  defaultValue: SettingValue;
  status: RuleStatus;
  /** True when the organiser changed this rule; Reset puts `defaultValue` back. */
  changed: boolean;
  source?: RuleSource;
  recordOnly: boolean;
}>;

function sameValue(left: SettingValue | undefined, right: SettingValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * One row per setting for the Rules page: its value now, the default it started from, whether the organiser
 * changed it and, for federation rules, the cited source. `snapshot` is the competition's frozen pack
 * defaults and `effective` the settings in force (snapshot plus overrides).
 */
export function describeRules(
  pack: SportPack,
  snapshot: SportPackSettings,
  effective: SportPackSettings,
): readonly RuleRow[] {
  const federation = new Map(federationRulesFor(pack.sportId, pack.version).map((entry) => [entry.setting, entry]));
  return Object.entries(pack.settingsSchema).map(([setting, definition]) => {
    const cited = federation.get(setting);
    const defaultValue = snapshot[setting] ?? null;
    const value = effective[setting] ?? defaultValue;
    const changed = !sameValue(value, defaultValue);
    return Object.freeze({
      setting,
      label: definition.label,
      group: cited?.group ?? "other",
      value,
      defaultValue,
      status: changed ? "changed" : cited ? "federation_default" : "matchday_default",
      changed,
      ...(cited ? { source: cited.source } : {}),
      recordOnly: cited?.recordOnly ?? false,
    });
  });
}

const criterionWords: Readonly<Record<string, string>> = {
  points: "most points",
  wins: "most wins",
  match_wins: "most matches won",
  goal_difference: "best goal difference",
  goals_for: "most goals scored",
  game_difference: "best game difference",
  point_difference: "best point difference",
  points_for: "most points scored",
  set_ratio: "best set ratio",
  point_ratio: "best point ratio",
  head_to_head: "result between the tied teams",
  head_to_head_two_way: "result between the two when exactly two are level",
  game_ratio: "best game ratio",
  discipline: "fewest cards",
  seed: "higher seed",
};

/**
 * Plain-language tie-break rules for a standings order, for organisers and (Phase 11) the public page:
 * "Teams are ranked by most points, then best goal difference, …".
 */
export function describeTieBreaks(pack: SportPack, effective: SportPackSettings): string {
  const order = effective.standingsOrder;
  const steps = (Array.isArray(order) ? order : pack.standings.defaultOrder).map(
    (criterionId) => criterionWords[criterionId] ?? criterionId.replaceAll("_", " "),
  );
  const entries = pack.terminology.entryPlural;
  const ranked = `${entries.charAt(0).toUpperCase()}${entries.slice(1)} are ranked by ${steps.join(", then ")}.`;
  return `${ranked} If they are still level, the organiser decides and the decision is logged.`;
}

/** Every federation pack has a cited table entry; used by the federation test and checkpoint F-1. */
export function federationPackKeys(): readonly string[] {
  return FEDERATION_SPORT_PACKS.map((pack) => `${pack.sportId}@${pack.version}`);
}
