import { afterEach, describe, expect, it } from "vitest";
import {
  CANOE_POLO_FEDERATION_SPORT_PACK,
  SPORT_PACKS,
  TABLE_TENNIS_FEDERATION_SPORT_PACK,
  createCompetitionSportSettings,
} from "@matchday/domain";
import { isRedesignRulesEnabled } from "./feature-flags.server";
import {
  RULES_GROUP_ORDER,
  buildRulesGroups,
  parseRulesHistory,
  resetRule,
  ruleDefaultLabel,
  rulesCopy,
  rulesHistoryLines,
  rulesTieBreakText,
} from "./phase3-rules";

const polo = CANOE_POLO_FEDERATION_SPORT_PACK;
const snapshot = createCompetitionSportSettings(polo, "cmp_1").recommendedSnapshot;

function row(groups: ReturnType<typeof buildRulesGroups>, setting: string) {
  return groups.flatMap((group) => group.rows).find((candidate) => candidate.setting === setting);
}

describe("Rules page rows (redesign Phase 4)", () => {
  it("groups rules in the plan's order and leaves empty groups out", () => {
    const groups = buildRulesGroups(polo, snapshot, snapshot);
    const ids = groups.map((group) => group.id);
    expect(ids).toEqual(RULES_GROUP_ORDER.filter((id) => ids.includes(id)));
    expect(ids.slice(0, 4)).toEqual(["time", "discipline", "standings", "forfeits"]);
    expect(groups.find((group) => group.id === "standings")?.title).toBe("Standings & tie-breaks");
    // Every pack setting appears exactly once.
    expect(
      groups
        .flatMap((group) => group.rows)
        .map((candidate) => candidate.setting)
        .sort(),
    ).toEqual(Object.keys(polo.settingsSchema).sort());
  });

  it("shows the federation default and its source for a cited rule", () => {
    const forfeit = row(buildRulesGroups(polo, snapshot, snapshot), "forfeitWinnerScore");
    expect(forfeit).toMatchObject({ groupId: "forfeits", changed: false, valueText: "7" });
    expect(ruleDefaultLabel(forfeit!)).toBe("Federation default: 7");
    expect(forfeit?.sourceText).toBe("ICF Canoe Polo Competition Rules, 2025, Forfeit.");
    expect(row(buildRulesGroups(polo, snapshot, snapshot), "shotClockSeconds")?.sourceText).toContain(
      rulesCopy.recordOnly,
    );
  });

  it("marks MATCHDAY's own settings without inventing a federation source", () => {
    const slot = row(buildRulesGroups(polo, snapshot, snapshot), "slotMinutes");
    expect(slot).toMatchObject({ groupId: "other", sourceText: null });
    expect(ruleDefaultLabel(slot!)).toBe("MATCHDAY default: 30");
  });

  it("says when a federation rule is still to be verified", () => {
    const pack = TABLE_TENNIS_FEDERATION_SPORT_PACK;
    const tableTennis = createCompetitionSportSettings(pack, "cmp_2").recommendedSnapshot;
    expect(row(buildRulesGroups(pack, tableTennis, tableTennis), "bestOf")?.sourceText).toContain(
      rulesCopy.notYetVerified,
    );
  });

  it("marks a changed rule and Reset puts back only that rule", () => {
    const edited = { ...snapshot, periodDurationMinutes: 7, intervalMinutes: 5 };
    const changed = row(buildRulesGroups(polo, snapshot, edited), "periodDurationMinutes");
    expect(changed).toMatchObject({ changed: true, status: "changed", valueText: "7", defaultText: "10" });
    const reset = resetRule(edited, snapshot, "periodDurationMinutes");
    expect(reset).toMatchObject({ periodDurationMinutes: 10, intervalMinutes: 5 });
    expect(row(buildRulesGroups(polo, snapshot, reset), "periodDurationMinutes")?.changed).toBe(false);
  });

  it("works for a draft-pack competition too, with MATCHDAY defaults only", () => {
    const draft = SPORT_PACKS.badminton;
    const groups = buildRulesGroups(draft, draft.recommendedSettings, draft.recommendedSettings);
    expect(groups.flatMap((group) => group.rows).every((candidate) => candidate.source === undefined)).toBe(true);
    expect(row(groups, "bestOf")?.groupId).toBe("scoring");
  });

  it("writes the tie-break rules in plain words from the current values", () => {
    expect(rulesTieBreakText(polo, snapshot)).toMatch(/^Teams are ranked by most points, then best goal difference/u);
    expect(rulesTieBreakText(polo, { ...snapshot, standingsOrder: ["points", "head_to_head"] })).toBe(
      "Teams are ranked by most points, then result between the tied teams. If they are still level, the organiser decides and the decision is logged.",
    );
  });
});

describe("Rules changes history", () => {
  const item = {
    id: "e1",
    action: "sport_settings.updated",
    occurred_at: "2026-10-17T09:30:00.000Z",
    actor_name: "Owner",
    division_id: null,
    revision: 2,
    changes: [{ setting: "periodDurationMinutes", before: 10, after: 7 }],
  };

  it("reads the API list and writes one plain line per change", () => {
    const history = parseRulesHistory({ items: [item] });
    expect(history.state).toBe("ready");
    expect(rulesHistoryLines(history.items[0]!, polo)).toEqual(["Period length (minutes): 10 → 7"]);
    expect(rulesCopy.historyWhen(item.occurred_at)).toBe("17 Oct 2026, 09:30 UTC");
  });

  it("refuses a malformed list as a whole", () => {
    expect(parseRulesHistory({ items: [{ ...item, revision: "2" }] })).toEqual({ state: "unavailable", items: [] });
    expect(parseRulesHistory(null).state).toBe("unavailable");
  });
});

describe("redesign_p4_rules flag", () => {
  const key = "MATCHDAY_FEATURE_REDESIGN_P4_RULES";
  const initial = process.env[key];
  afterEach(() => {
    if (initial === undefined) delete process.env[key];
    else process.env[key] = initial;
  });

  it("is off by default and follows a typed environment override", async () => {
    delete process.env[key];
    await expect(isRedesignRulesEnabled()).resolves.toBe(false);
    process.env[key] = "true";
    await expect(isRedesignRulesEnabled()).resolves.toBe(true);
    process.env[key] = "yes";
    await expect(isRedesignRulesEnabled()).resolves.toBe(false);
  });
});
