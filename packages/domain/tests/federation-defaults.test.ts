import { describe, expect, it } from "vitest";
import {
  FEDERATION_DEFAULTS,
  describeRules,
  describeTieBreaks,
  federationPackKeys,
  federationRulesFor,
  rulesNeedingVerification,
} from "../src/federation-defaults.js";
import {
  BADMINTON_3X15_SPORT_PACK,
  BADMINTON_FEDERATION_SPORT_PACK,
  CANOE_POLO_FEDERATION_SPORT_PACK,
  CANOE_POLO_SPORT_PACK,
  DRAFT_SPORT_PACK_VERSION,
  FEDERATION_SPORT_PACKS,
  SPORT_PACKS,
  VOLLEYBALL_FEDERATION_SPORT_PACK,
  createCompetitionSportSettings,
  createSportPackRegistry,
  customiseCompetitionSportSettings,
  federationSportPackFor,
  resetCompetitionSportSettings,
} from "../src/sport-packs.js";

describe("federation defaults (redesign Phase 4)", () => {
  it("has a cited table for every federation pack, and nothing else", () => {
    expect(Object.keys(FEDERATION_DEFAULTS).sort()).toEqual([...federationPackKeys()].sort());
  });

  it("pack 1.0.0 values equal the cited table for every rule", () => {
    for (const pack of FEDERATION_SPORT_PACKS) {
      const rules = federationRulesFor(pack.sportId, pack.version);
      expect(rules.length, `${pack.sportId}@${pack.version}`).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(pack.settingsSchema[rule.setting], `${pack.sportId} ${rule.setting} in schema`).toBeDefined();
        expect(pack.recommendedSettings[rule.setting], `${pack.sportId}@${pack.version} ${rule.setting}`).toEqual(
          rule.value,
        );
      }
    }
  });

  it("every rule cites a document with an https URL", () => {
    for (const rules of Object.values(FEDERATION_DEFAULTS))
      for (const rule of rules) {
        expect(rule.source.doc.length).toBeGreaterThan(0);
        expect(rule.source.url).toMatch(/^https:\/\//u);
      }
  });

  it("lists every rule that checkpoint F-1 still has to verify", () => {
    const pending = rulesNeedingVerification();
    expect(pending.every(({ rule }) => rule.source.verified !== "primary")).toBe(true);
    const sports = new Set(pending.map(({ pack }) => pack.split("@")[0]));
    expect([...sports].sort()).toEqual(["badminton", "basketball", "table_tennis"]);
    // Canoe polo and volleyball are read from the federations' own documents.
    expect(pending.some(({ pack }) => pack.startsWith("canoe_polo") || pack.startsWith("volleyball"))).toBe(false);
  });

  it("applies the federation corrections the plan calls for", () => {
    expect(CANOE_POLO_FEDERATION_SPORT_PACK.forfeit).toMatchObject({ winnerScore: 7, loserScore: 0 });
    expect(CANOE_POLO_FEDERATION_SPORT_PACK.recommendedSettings.timeoutsEnabled).toBe(false);
    expect(VOLLEYBALL_FEDERATION_SPORT_PACK.recommendedSettings.bestOf).toBe(5);
    expect(VOLLEYBALL_FEDERATION_SPORT_PACK.matchStructure.targetPoints).toEqual([25, 25, 25, 25, 15]);
    expect(VOLLEYBALL_FEDERATION_SPORT_PACK.forfeit.awardedSegments).toBe(3);
    expect(BADMINTON_3X15_SPORT_PACK.matchStructure).toMatchObject({ targetPoints: [15, 15, 15], pointCap: 21 });
  });

  it("leaves the draft packs untouched for existing competitions", () => {
    for (const pack of Object.values(SPORT_PACKS)) expect(pack.version).toBe(DRAFT_SPORT_PACK_VERSION);
    expect(CANOE_POLO_SPORT_PACK.forfeit.winnerScore).toBe(3);
    const registry = createSportPackRegistry([...Object.values(SPORT_PACKS), ...FEDERATION_SPORT_PACKS]);
    expect(registry.versions("badminton")).toEqual([DRAFT_SPORT_PACK_VERSION, "1.0.0", "1.1.0"]);
    expect(registry.resolve("canoe_polo", DRAFT_SPORT_PACK_VERSION)).toEqual(CANOE_POLO_SPORT_PACK);
  });
});

describe("federation pack by start date (D34)", () => {
  it("gives badminton 3×21 up to 3 Jan 2027 and 3×15 from 4 Jan 2027", () => {
    expect(federationSportPackFor("badminton", "2027-01-03")).toBe(BADMINTON_FEDERATION_SPORT_PACK);
    expect(federationSportPackFor("badminton", "2027-01-04")).toBe(BADMINTON_3X15_SPORT_PACK);
  });

  it("gives other sports pack 1.0.0 whatever the date", () => {
    expect(federationSportPackFor("volleyball", "2030-06-01")).toBe(VOLLEYBALL_FEDERATION_SPORT_PACK);
    expect(federationSportPackFor("canoe_polo", "2026-01-01").version).toBe("1.0.0");
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(() => federationSportPackFor("badminton", "4 Jan 2027")).toThrow();
  });
});

describe("Rules page rows", () => {
  const pack = CANOE_POLO_FEDERATION_SPORT_PACK;

  it("marks untouched federation rules as federation defaults with their source", () => {
    const settings = createCompetitionSportSettings(pack, "cmp_1");
    const rows = describeRules(pack, settings.recommendedSnapshot, settings.effective);
    const forfeit = rows.find((row) => row.setting === "forfeitWinnerScore");
    expect(forfeit).toMatchObject({ value: 7, defaultValue: 7, status: "federation_default", changed: false });
    expect(forfeit?.source?.verified).toBe("primary");
    expect(rows.find((row) => row.setting === "slotMinutes")).toMatchObject({ status: "matchday_default" });
    expect(rows.find((row) => row.setting === "shotClockSeconds")?.recordOnly).toBe(true);
  });

  it("marks an organiser change and clears it on reset", () => {
    const created = createCompetitionSportSettings(pack, "cmp_1");
    const changed = customiseCompetitionSportSettings(pack, created, { periodDurationMinutes: 7 });
    const changedRow = describeRules(pack, changed.recommendedSnapshot, changed.effective).find(
      (row) => row.setting === "periodDurationMinutes",
    );
    expect(changedRow).toMatchObject({ value: 7, defaultValue: 10, status: "changed", changed: true });
    const reset = resetCompetitionSportSettings(changed);
    const resetRow = describeRules(pack, reset.recommendedSnapshot, reset.effective).find(
      (row) => row.setting === "periodDurationMinutes",
    );
    expect(resetRow).toMatchObject({ value: 10, status: "federation_default", changed: false });
  });
});

describe("tie-break rules in plain words", () => {
  it("writes one sentence per sport from the standings order", () => {
    for (const pack of FEDERATION_SPORT_PACKS) {
      const text = describeTieBreaks(pack, pack.recommendedSettings);
      expect(text).toMatch(/ are ranked by /u);
      expect(text).not.toMatch(/_/u);
    }
    expect(
      describeTieBreaks(CANOE_POLO_FEDERATION_SPORT_PACK, CANOE_POLO_FEDERATION_SPORT_PACK.recommendedSettings),
    ).toBe(
      "Teams are ranked by most points, then best goal difference, then most goals scored, then result between the tied teams, then fewest cards. If they are still level, the organiser decides and the decision is logged.",
    );
  });
});
