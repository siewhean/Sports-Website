import {
  describeRules,
  describeTieBreaks,
  type RuleGroup,
  type RuleRow,
  type RuleSource,
  type SettingValue,
  type SportPack,
  type SportPackSettings,
} from "@matchday/domain";
import { displaySettingValue } from "@/lib/phase3-sport-settings";

/**
 * Redesign Phase 4 Rules page (Setup → Rules, flag `redesign_p4_rules`). Every rule of the competition's pack is
 * shown in a group with its value, the default it started from, whether the organiser changed it and, for
 * federation rules, where the rule comes from.
 */
export type RulesGroupId = Exclude<RuleGroup, "players"> | "players" | "other";

export const RULES_GROUP_ORDER: readonly RulesGroupId[] = [
  "scoring",
  "time",
  "discipline",
  "standings",
  "forfeits",
  "players",
  "other",
];

/**
 * Where a setting goes when the federation table does not cite it (draft packs, or MATCHDAY's own settings such as
 * the match slot). Cited rules use the group from the federation table.
 */
const FALLBACK_GROUPS: Readonly<Record<string, RulesGroupId>> = {
  bestOf: "scoring",
  regularTargetPoints: "scoring",
  decidingTargetPoints: "scoring",
  winBy: "scoring",
  pointCap: "scoring",
  periods: "time",
  periodDurationMinutes: "time",
  overtimeDurationMinutes: "time",
  successiveOvertime: "time",
  intervalMinutes: "time",
  setIntervalMinutes: "time",
  overtimeBreakMinutes: "time",
  goldenGoal: "time",
  shotClockSeconds: "time",
  timeoutsEnabled: "time",
  timeoutsPerTeam: "time",
  timeoutsPerSet: "time",
  timeoutSeconds: "time",
  cardsEnabled: "discipline",
  incidentsEnabled: "discipline",
  winPoints: "standings",
  drawPoints: "standings",
  lossPoints: "standings",
  forfeitLossPoints: "standings",
  defaultLossPoints: "standings",
  standingsOrder: "standings",
  forfeitWinnerScore: "forfeits",
  forfeitLoserScore: "forfeits",
  defaultWinnerScore: "forfeits",
  defaultLoserScore: "forfeits",
  playersOnField: "players",
  rosterMax: "players",
  substitutionsPerSet: "players",
};

export type RulesRowView = RuleRow &
  Readonly<{
    groupId: RulesGroupId;
    valueText: string;
    defaultText: string;
    sourceText: string | null;
  }>;

export type RulesGroupView = Readonly<{ id: RulesGroupId; title: string; rows: readonly RulesRowView[] }>;

const historyTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export const rulesCopy = {
  eyebrow: "Rules",
  intro: "Each rule starts from the sport's rules. Change any of them for this competition; Reset puts it back.",
  groups: {
    scoring: "Scoring",
    time: "Time",
    discipline: "Discipline",
    standings: "Standings & tie-breaks",
    forfeits: "Forfeits",
    players: "Players",
    other: "Match day",
  } satisfies Record<RulesGroupId, string>,
  federationDefault: "Federation default",
  matchdayDefault: "MATCHDAY default",
  changed: "Changed",
  changedFromFederation: "Changed from federation default",
  reset: "Reset",
  resetRule: (label: string) => `Reset ${label} to its default`,
  aboutRule: (label: string) => `Where the ${label.toLowerCase()} rule comes from`,
  noSource: "This is MATCHDAY's own starting value, not a federation rule.",
  recordOnly: "Shown to officials and logged; MATCHDAY does not run it.",
  notYetVerified: "Still to be checked against the federation's own rule book.",
  tieBreaksTitle: "How ties are broken",
  save: "Save rules",
  saving: "Saving…",
  saved: "Rules saved.",
  unsaved: "You have changes that are not saved yet.",
  noChanges: "No unsaved changes.",
  readOnly: "Only the competition's owners and organisers can change its rules.",
  versionLabel: "Rules version",
  packLabel: "Rule set",
  historyTitle: "Rules changes",
  historyEmpty: "No rules have been changed yet.",
  historyUnavailable: "The list of rules changes could not be loaded.",
  historyCopied: "Copied from a previous competition",
  historyNoDetail: "Saved without a list of changes.",
  historyBy: (name: string | null) => (name ? `by ${name}` : "by an organiser"),
  historyChange: (label: string, before: string, after: string) => `${label}: ${before} → ${after}`,
  historyVersion: (version: number) => `Version ${version}`,
  historyWhen: (iso: string) => `${historyTime.format(new Date(iso))} UTC`,
  divisionScope: "For one division",
} as const;

export function ruleSourceText(source: RuleSource | undefined, recordOnly: boolean): string | null {
  if (!source) return null;
  const citation = [source.doc, source.edition, source.clause].filter(Boolean).join(", ");
  const notes: string[] = [];
  if (source.verified !== "primary") notes.push(rulesCopy.notYetVerified);
  if (recordOnly) notes.push(rulesCopy.recordOnly);
  return [`${citation}.`, ...notes].join(" ");
}

function groupOf(row: RuleRow): RulesGroupId {
  if (row.group !== "other") return row.group;
  return FALLBACK_GROUPS[row.setting] ?? "other";
}

/** The Rules page's groups, in the plan's order, with every row ready to show. Empty groups are left out. */
export function buildRulesGroups(
  pack: SportPack,
  snapshot: SportPackSettings,
  values: SportPackSettings,
): readonly RulesGroupView[] {
  const rows: RulesRowView[] = describeRules(pack, snapshot, values).map((row) => ({
    ...row,
    groupId: groupOf(row),
    valueText: displaySettingValue(row.value),
    defaultText: displaySettingValue(row.defaultValue),
    sourceText: ruleSourceText(row.source, row.recordOnly),
  }));
  return RULES_GROUP_ORDER.map((id) => ({
    id,
    title: rulesCopy.groups[id],
    rows: rows.filter((row) => row.groupId === id),
  })).filter((group) => group.rows.length > 0);
}

/** "Federation default: 10" for a cited rule, "MATCHDAY default: 30" for MATCHDAY's own starting value. */
export function ruleDefaultLabel(row: Pick<RuleRow, "source"> & { defaultText: string }): string {
  return `${row.source ? rulesCopy.federationDefault : rulesCopy.matchdayDefault}: ${row.defaultText}`;
}

export function rulesTieBreakText(pack: SportPack, values: SportPackSettings): string {
  return describeTieBreaks(pack, values);
}

/** Puts one rule back to its default; the rest of the draft is kept. */
export function resetRule(values: SportPackSettings, snapshot: SportPackSettings, setting: string): SportPackSettings {
  const next: Record<string, SettingValue> = { ...values };
  const fallback = snapshot[setting];
  if (fallback === undefined) delete next[setting];
  else next[setting] = fallback;
  return next;
}

export type RulesHistoryChange = Readonly<{ setting: string; before: unknown; after: unknown }>;

export type RulesHistoryItem = Readonly<{
  id: string;
  action: "sport_settings.updated" | "sport_settings.copied";
  occurredAt: string;
  actorName: string | null;
  divisionId: string | null;
  revision: number | null;
  changes: readonly RulesHistoryChange[];
}>;

export type RulesHistory = Readonly<{ state: "ready" | "unavailable"; items: readonly RulesHistoryItem[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Parses the API's history response; anything unexpected makes the whole list unavailable, never half-shown. */
export function parseRulesHistory(payload: unknown): RulesHistory {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return { state: "unavailable", items: [] };
  const items: RulesHistoryItem[] = [];
  for (const item of payload.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      (item.action !== "sport_settings.updated" && item.action !== "sport_settings.copied") ||
      typeof item.occurred_at !== "string" ||
      Number.isNaN(Date.parse(item.occurred_at)) ||
      (item.actor_name !== null && typeof item.actor_name !== "string") ||
      (item.division_id !== null && typeof item.division_id !== "string") ||
      (item.revision !== null && !Number.isInteger(item.revision)) ||
      !Array.isArray(item.changes) ||
      !item.changes.every((change) => isRecord(change) && typeof change.setting === "string")
    )
      return { state: "unavailable", items: [] };
    items.push({
      id: item.id,
      action: item.action,
      occurredAt: item.occurred_at,
      actorName: item.actor_name as string | null,
      divisionId: item.division_id as string | null,
      revision: item.revision as number | null,
      changes: (item.changes as Record<string, unknown>[]).map((change) => ({
        setting: change.setting as string,
        before: change.before ?? null,
        after: change.after ?? null,
      })),
    });
  }
  return { state: "ready", items };
}

function historyValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  )
    return displaySettingValue(value as SettingValue);
  return JSON.stringify(value);
}

/** One plain line per changed rule: "Period length (minutes): 10 → 7". */
export function rulesHistoryLines(item: RulesHistoryItem, pack: SportPack): readonly string[] {
  return item.changes.map((change) =>
    rulesCopy.historyChange(
      pack.settingsSchema[change.setting]?.label ?? change.setting,
      historyValue(change.before),
      historyValue(change.after),
    ),
  );
}
