import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANOE_POLO_SPORT_PACK,
  DRAFT_SPORT_PACK_VERSION,
  SPORT_PACKS,
  applyCopyFromPreviousCompetitionCommand,
  applySaveAsUserDefaultCommand,
  assertValidSportPack,
  createCompetitionSportSettings,
  createCopyFromPreviousCompetitionCommand,
  createDivisionSportSettings,
  createSaveAsUserDefaultCommand,
  createSportPackRegistry,
  customiseCompetitionSportSettings,
  customiseDivisionSportSettings,
  resetCompetitionSportSettings,
  resetDivisionSportSettings,
  resolveSportPack,
  validateSportPack,
  validateSportSettings,
  type SportId,
  type SportPack,
} from "../src/sport-packs.js";

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../../validation/phase-3/sport-packs/${name}`, import.meta.url), "utf8"),
  ) as T;
}

function mutableClone<T>(value: T): T {
  return structuredClone(value);
}

describe("SPT-001–004 and SPT-009–014: versioned sport-pack schema", () => {
  it("validates all five immutable provisional product packs", () => {
    expect(Object.keys(SPORT_PACKS)).toEqual(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]);
    for (const pack of Object.values(SPORT_PACKS)) {
      expect(validateSportPack(pack)).toEqual([]);
      expect(pack.version).toBe(DRAFT_SPORT_PACK_VERSION);
      expect(pack.status).toBe("provisional_product_baseline");
      expect(pack.authority).toBe("product_recommendation_not_federation_profile");
      expect(Object.isFrozen(pack)).toBe(true);
      expect(Object.isFrozen(pack.recommendedSettings)).toBe(true);
      expect(pack.recommendedSettings.slotMinutes).toBe(pack.recommendedSlotMinutes);
      expect(pack.entryTypes.length).toBeGreaterThan(0);
      expect(pack.eventTypes.length).toBeGreaterThan(0);
      expect(pack.scorecard.length).toBeGreaterThan(0);
      expect(pack.validationRules.length).toBeGreaterThan(0);
      expect(pack.standings.availableCriteria.length).toBeGreaterThanOrEqual(pack.standings.defaultOrder.length);
    }
  });

  it("matches the independently stored sport-contract fixture", () => {
    const expected = fixture<{
      status: string;
      authority: string;
      packs: Array<{
        sportId: SportId;
        displayName: string;
        entryTypes: string[];
        hierarchy: string[];
        requiredEvents: string[];
        standingsOrder: string[];
        forfeit: [number, number, number];
        slotMinutes: number;
      }>;
    }>("expected-contracts.json");

    expect(
      Object.values(SPORT_PACKS).map((pack) => ({
        sportId: pack.sportId,
        displayName: pack.displayName,
        entryTypes: pack.entryTypes,
        hierarchy: pack.scoreStructure.hierarchy,
        requiredEvents: pack.eventTypes.map(({ id }) => id),
        standingsOrder: pack.standings.defaultOrder,
        forfeit: [pack.forfeit.winnerScore, pack.forfeit.loserScore, pack.forfeit.awardedSegments],
        slotMinutes: pack.recommendedSlotMinutes,
      })),
    ).toEqual(expected.packs);
    expect(new Set(Object.values(SPORT_PACKS).map(({ status }) => status))).toEqual(new Set([expected.status]));
    expect(new Set(Object.values(SPORT_PACKS).map(({ authority }) => authority))).toEqual(
      new Set([expected.authority]),
    );
  });

  it("covers the documented match and score structures", () => {
    expect(SPORT_PACKS.canoe_polo.matchStructure).toMatchObject({ kind: "timed_periods", regulationSegments: 2 });
    expect(SPORT_PACKS.canoe_polo.scoreStructure).toMatchObject({ primaryUnit: "goal", drawAllowed: true });
    expect(SPORT_PACKS.badminton.matchStructure).toMatchObject({
      regulationSegments: 3,
      targetPoints: [21, 21, 21],
      winBy: 2,
      pointCap: 30,
    });
    expect(SPORT_PACKS.table_tennis.matchStructure).toMatchObject({
      regulationSegments: 5,
      targetPoints: [11, 11, 11, 11, 11],
      winBy: 2,
      pointCap: null,
    });
    expect(SPORT_PACKS.volleyball.matchStructure).toMatchObject({
      regulationSegments: 3,
      targetPoints: [25, 25, 15],
      winBy: 2,
      pointCap: null,
    });
    expect(SPORT_PACKS.basketball.matchStructure).toMatchObject({
      regulationSegments: 4,
      segmentDurationMinutes: 10,
      overtimeDurationMinutes: 5,
      successiveOvertime: true,
    });
    expect(SPORT_PACKS.basketball.scoreStructure.allowedIncrements).toEqual([1, 2, 3]);
    expect(
      SPORT_PACKS.volleyball.standings.availableCriteria.find(({ id }) => id === "set_ratio")?.zeroDenominator,
    ).toBe("infinity_when_numerator_positive");
  });

  it("strictly rejects unknown, malformed, duplicate, and internally inconsistent pack properties", () => {
    const unknownTop = { ...mutableClone(CANOE_POLO_SPORT_PACK), federationApproved: true };
    expect(validateSportPack(unknownTop)).toContainEqual(
      expect.objectContaining({ path: "pack.federationApproved", code: "unknown_key" }),
    );

    const unknownTerminology = mutableClone(CANOE_POLO_SPORT_PACK) as SportPack & {
      terminology: SportPack["terminology"] & { rink: string };
    };
    unknownTerminology.terminology.rink = "rink";
    expect(validateSportPack(unknownTerminology)).toContainEqual(
      expect.objectContaining({ path: "pack.terminology.rink", code: "unknown_key" }),
    );

    const malformedVersion = { ...mutableClone(CANOE_POLO_SPORT_PACK), version: "draft" };
    expect(validateSportPack(malformedVersion)).toContainEqual(expect.objectContaining({ code: "semver" }));

    const duplicateEvent = mutableClone(CANOE_POLO_SPORT_PACK);
    (duplicateEvent.eventTypes as Array<(typeof duplicateEvent.eventTypes)[number]>).push(
      duplicateEvent.eventTypes[0]!,
    );
    expect(validateSportPack(duplicateEvent)).toContainEqual(expect.objectContaining({ code: "event_ids" }));

    const invalidOrder = mutableClone(CANOE_POLO_SPORT_PACK);
    (invalidOrder.standings.defaultOrder as string[]).push("not_a_criterion");
    expect(validateSportPack(invalidOrder)).toContainEqual(expect.objectContaining({ code: "criteria_order" }));

    const missingRecommended = mutableClone(CANOE_POLO_SPORT_PACK);
    delete (missingRecommended.recommendedSettings as Record<string, unknown>).slotMinutes;
    expect(validateSportPack(missingRecommended)).toContainEqual(
      expect.objectContaining({ path: "settings.slotMinutes", code: "required" }),
    );
  });

  it("validates every nested schema object, field type, enum, and unknown property", () => {
    const cases: Array<{
      mutate(pack: SportPack): void;
      path: string;
      code: string;
    }> = [
      {
        mutate: (pack) => ((pack.terminology as unknown as Record<string, unknown>).playingArea = 3),
        path: "pack.terminology.playingArea",
        code: "type",
      },
      {
        mutate: (pack) => ((pack.matchStructure as unknown as Record<string, unknown>).targetPoints = [21, "21", 21]),
        path: "pack.matchStructure.targetPoints",
        code: "type",
      },
      {
        mutate: (pack) => ((pack.matchStructure as unknown as Record<string, unknown>).targetPoints = [21]),
        path: "pack.matchStructure.targetPoints",
        code: "segment_count",
      },
      {
        mutate: (pack) => ((pack.scoreStructure as unknown as Record<string, unknown>).aggregate = "average"),
        path: "pack.scoreStructure.aggregate",
        code: "enum",
      },
      {
        mutate: (pack) => ((pack.eventTypes[0] as unknown as Record<string, unknown>).requiresSide = "yes"),
        path: "pack.eventTypes[0].requiresSide",
        code: "type",
      },
      {
        mutate: (pack) => ((pack.eventTypes[0] as unknown as Record<string, unknown>).colour = "blue"),
        path: "pack.eventTypes[0].colour",
        code: "unknown_key",
      },
      {
        mutate: (pack) => ((pack.standings as unknown as Record<string, unknown>).unresolvedTie = "coin_toss"),
        path: "pack.standings.unresolvedTie",
        code: "enum",
      },
      {
        mutate: (pack) =>
          ((pack.standings.availableCriteria[0] as unknown as Record<string, unknown>).direction = "ascending"),
        path: "pack.standings.availableCriteria[0].direction",
        code: "enum",
      },
      {
        mutate: (pack) => ((pack.forfeit as unknown as Record<string, unknown>).preserveCompletedPlay = 1),
        path: "pack.forfeit.preserveCompletedPlay",
        code: "type",
      },
      {
        mutate: (pack) => ((pack.scorecard[0] as unknown as Record<string, unknown>).required = "true"),
        path: "pack.scorecard[0].required",
        code: "type",
      },
      {
        mutate: (pack) => ((pack.validationRules[0] as unknown as Record<string, unknown>).severity = "warning"),
        path: "pack.validationRules[0].severity",
        code: "enum",
      },
      {
        mutate: (pack) => ((pack.validationRules[0] as unknown as Record<string, unknown>).undocumented = true),
        path: "pack.validationRules[0].undocumented",
        code: "unknown_key",
      },
      {
        mutate: (pack) => ((pack.settingsSchema.slotMinutes as unknown as Record<string, unknown>).step = 5),
        path: "pack.settingsSchema.slotMinutes.step",
        code: "unknown_key",
      },
      {
        mutate: (pack) => ((pack.settingsSchema.slotMinutes as unknown as Record<string, unknown>).minimum = "5"),
        path: "pack.settingsSchema.slotMinutes",
        code: "range",
      },
      {
        mutate: (pack) => ((pack.recommendedSettings as unknown as Record<string, unknown>).federationMode = true),
        path: "settings.federationMode",
        code: "unknown_key",
      },
    ];

    for (const sample of cases) {
      const candidate = mutableClone(SPORT_PACKS.badminton);
      sample.mutate(candidate);
      expect(validateSportPack(candidate), `${sample.path}:${sample.code}`).toContainEqual(
        expect.objectContaining({ path: sample.path, code: sample.code }),
      );
    }
  });

  it("rejects boxed strings and objects at every enum boundary without coercion", () => {
    const boxed = (value: string): unknown => new String(value);
    const cases: Array<{ pack: SportPack; path: string; code: string }> = [];

    const sportId = mutableClone(SPORT_PACKS.badminton);
    (sportId as unknown as Record<string, unknown>).sportId = boxed("badminton");
    cases.push({ pack: sportId, path: "pack.sportId", code: "sport_id" });

    const status = mutableClone(SPORT_PACKS.badminton);
    (status as unknown as Record<string, unknown>).status = boxed("provisional_product_baseline");
    cases.push({ pack: status, path: "pack.status", code: "status" });

    const authority = mutableClone(SPORT_PACKS.badminton);
    (authority as unknown as Record<string, unknown>).authority = boxed(
      "product_recommendation_not_federation_profile",
    );
    cases.push({ pack: authority, path: "pack.authority", code: "authority" });

    const entryType = mutableClone(SPORT_PACKS.badminton);
    (entryType.entryTypes as unknown as unknown[])[0] = boxed("singles");
    cases.push({ pack: entryType, path: "pack.entryTypes", code: "entry_types" });

    const matchKind = mutableClone(SPORT_PACKS.badminton);
    (matchKind.matchStructure as unknown as Record<string, unknown>).kind = boxed("best_of_segments");
    cases.push({ pack: matchKind, path: "pack.matchStructure.kind", code: "enum" });

    const aggregate = mutableClone(SPORT_PACKS.badminton);
    (aggregate.scoreStructure as unknown as Record<string, unknown>).aggregate = boxed("segments_won");
    cases.push({ pack: aggregate, path: "pack.scoreStructure.aggregate", code: "enum" });

    const attribution = mutableClone(SPORT_PACKS.badminton);
    (attribution.eventTypes[0] as unknown as Record<string, unknown>).participantAttribution = boxed("optional");
    cases.push({ pack: attribution, path: "pack.eventTypes[0].participantAttribution", code: "enum" });

    const unresolvedTie = mutableClone(SPORT_PACKS.badminton);
    (unresolvedTie.standings as unknown as Record<string, unknown>).unresolvedTie = boxed("audited_manual_resolution");
    cases.push({ pack: unresolvedTie, path: "pack.standings.unresolvedTie", code: "enum" });

    const direction = mutableClone(SPORT_PACKS.badminton);
    (direction.standings.availableCriteria[0] as unknown as Record<string, unknown>).direction = boxed("higher");
    cases.push({ pack: direction, path: "pack.standings.availableCriteria[0].direction", code: "enum" });

    const zeroDenominator = mutableClone(SPORT_PACKS.volleyball);
    (
      zeroDenominator.standings.availableCriteria.find(({ id }) => id === "set_ratio") as unknown as Record<
        string,
        unknown
      >
    ).zeroDenominator = boxed("infinity_when_numerator_positive");
    cases.push({
      pack: zeroDenominator,
      path: "pack.standings.availableCriteria[1].zeroDenominator",
      code: "enum",
    });

    const definitionType = mutableClone(SPORT_PACKS.badminton);
    (definitionType.settingsSchema.bestOf as unknown as Record<string, unknown>).type = boxed("integer");
    cases.push({ pack: definitionType, path: "pack.settingsSchema.bestOf.type", code: "enum" });

    const severity = mutableClone(SPORT_PACKS.badminton);
    (severity.validationRules[0] as unknown as Record<string, unknown>).severity = boxed("error");
    cases.push({ pack: severity, path: "pack.validationRules[0].severity", code: "enum" });

    const constraintKind = mutableClone(SPORT_PACKS.badminton);
    const oddConstraint = constraintKind.validationRules.find(({ id }) => id === "best_of_is_odd")?.settingsConstraint;
    (oddConstraint as unknown as Record<string, unknown>).kind = boxed("odd_integer");
    cases.push({
      pack: constraintKind,
      path: "pack.validationRules[2].settingsConstraint.kind",
      code: "enum",
    });

    for (const sample of cases) {
      expect(validateSportPack(sample.pack), `${sample.path}:${sample.code}`).toContainEqual(
        expect.objectContaining({ path: sample.path, code: sample.code }),
      );
    }

    expect(
      validateSportSettings(SPORT_PACKS.badminton, { standingsOrder: [boxed("match_wins")] }, { partial: true }),
    ).toContainEqual(expect.objectContaining({ path: "settings.standingsOrder", code: "type" }));

    const enumSettingPack = mutableClone(SPORT_PACKS.badminton);
    (enumSettingPack.settingsSchema as unknown as Record<string, unknown>).surface = {
      type: "enum",
      label: "Surface",
      values: ["indoor", "outdoor"],
    };
    (enumSettingPack.recommendedSettings as unknown as Record<string, unknown>).surface = boxed("indoor");
    expect(validateSportPack(enumSettingPack)).toContainEqual(
      expect.objectContaining({ path: "settings.surface", code: "enum" }),
    );
  });

  it("executes property-style invalid-setting fixtures against the declared schema", () => {
    const cases =
      fixture<Array<{ sportId: SportId; settings: Record<string, unknown>; code?: string; valid?: boolean }>>(
        "invalid-settings.json",
      );
    for (const sample of cases) {
      const issues = validateSportSettings(SPORT_PACKS[sample.sportId], sample.settings, { partial: true });
      if (sample.valid) expect(issues, sample.sportId).toEqual([]);
      else
        expect(
          issues.map(({ code }) => code),
          sample.sportId,
        ).toContain(sample.code);
    }
  });

  it("accepts every recommended property alone and rejects type mutations", () => {
    for (const pack of Object.values(SPORT_PACKS)) {
      for (const [key, value] of Object.entries(pack.recommendedSettings)) {
        expect(validateSportSettings(pack, { [key]: value }, { partial: true }), `${pack.sportId}.${key}`).toEqual([]);
        const wrong =
          typeof value === "boolean"
            ? "true"
            : Array.isArray(value)
              ? value.join(",")
              : typeof value === "number"
                ? String(value)
                : value === null
                  ? false
                  : 1;
        expect(
          validateSportSettings(pack, { [key]: wrong }, { partial: true }).length,
          `${pack.sportId}.${key}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("enforces rule-driven sport-specific cross-field invariants on effective settings", () => {
    expect(() => createCompetitionSportSettings(SPORT_PACKS.badminton, "bad-even", { bestOf: 4 })).toThrow(
      /Invalid sport settings/,
    );
    expect(() => createCompetitionSportSettings(SPORT_PACKS.table_tennis, "bad-cap", { pointCap: 8 })).toThrow(
      /Invalid sport settings/,
    );
    expect(() =>
      createCompetitionSportSettings(SPORT_PACKS.volleyball, "bad-target", {
        regularTargetPoints: 15,
        decidingTargetPoints: 25,
      }),
    ).toThrow(/Invalid sport settings/);
    expect(() =>
      createCompetitionSportSettings(SPORT_PACKS.canoe_polo, "bad-forfeit", {
        forfeitWinnerScore: 0,
        forfeitLoserScore: 3,
      }),
    ).toThrow(/Invalid sport settings/);
    expect(() =>
      createCompetitionSportSettings(SPORT_PACKS.basketball, "bad-overtime", { successiveOvertime: false }),
    ).toThrow(/Invalid sport settings/);

    const evenRule = SPORT_PACKS.badminton.validationRules.find(({ id }) => id === "best_of_is_odd");
    expect(evenRule?.settingsConstraint).toEqual({ kind: "odd_integer", field: "bestOf" });
  });
});

describe("SPT-003, SPT-004, and SPT-006: override state", () => {
  it("starts Recommended, becomes Customised, and resets to the captured competition recommendation", () => {
    const initial = createCompetitionSportSettings(SPORT_PACKS.canoe_polo, "competition-1");
    expect(initial.mode).toBe("recommended");
    expect(initial.effective.slotMinutes).toBe(30);
    const customised = customiseCompetitionSportSettings(SPORT_PACKS.canoe_polo, initial, {
      slotMinutes: 35,
      allowUnknownScorer: true,
    });
    expect(customised.mode).toBe("customised");
    expect(customised.effective).toMatchObject({ slotMinutes: 35, allowUnknownScorer: true, periods: 2 });
    expect(initial.effective.slotMinutes).toBe(30);

    const reset = resetCompetitionSportSettings(customised);
    expect(reset.mode).toBe("recommended");
    expect(reset.override).toEqual({});
    expect(reset.effective).toEqual(initial.recommendedSnapshot);
  });

  it("layers and resets a division override against the effective competition settings", () => {
    const competition = customiseCompetitionSportSettings(
      SPORT_PACKS.volleyball,
      createCompetitionSportSettings(SPORT_PACKS.volleyball, "competition-2"),
      { slotMinutes: 50 },
    );
    const initial = createDivisionSportSettings(SPORT_PACKS.volleyball, competition, "division-a");
    expect(initial).toMatchObject({ mode: "recommended", effective: { slotMinutes: 50, regularTargetPoints: 25 } });

    const customised = customiseDivisionSportSettings(SPORT_PACKS.volleyball, competition, initial, {
      regularTargetPoints: 21,
      decidingTargetPoints: 11,
    });
    expect(customised.mode).toBe("customised");
    expect(customised.effective).toMatchObject({ slotMinutes: 50, regularTargetPoints: 21, decidingTargetPoints: 11 });

    const reset = resetDivisionSportSettings(competition, customised);
    expect(reset.mode).toBe("recommended");
    expect(reset.effective).toEqual(competition.effective);
  });

  it("rejects invalid and cross-pack overrides", () => {
    const canoe = createCompetitionSportSettings(SPORT_PACKS.canoe_polo, "competition-3");
    expect(() => customiseCompetitionSportSettings(SPORT_PACKS.canoe_polo, canoe, { slotMinutes: 0 })).toThrow(
      /Invalid sport settings/,
    );
    expect(() => customiseCompetitionSportSettings(SPORT_PACKS.basketball, canoe, { slotMinutes: 40 })).toThrow(
      /does not match/,
    );
    expect(() => createDivisionSportSettings(SPORT_PACKS.canoe_polo, canoe, "", {})).toThrow(/divisionId/);
  });

  it("rejects forged cross-sport, version, and schema-compatible-looking division state", () => {
    const canoe = createCompetitionSportSettings(SPORT_PACKS.canoe_polo, "shared-id");
    const division = createDivisionSportSettings(SPORT_PACKS.canoe_polo, canoe, "division-x");
    const wrongSport = { ...division, sportId: "basketball" as const };
    const wrongVersion = { ...division, packVersion: "0.2.0-draft.1" };
    const wrongSchema = { ...division, packSchemaVersion: 2 as unknown as 1 };
    expect(() =>
      customiseDivisionSportSettings(SPORT_PACKS.canoe_polo, canoe, wrongSport, { slotMinutes: 31 }),
    ).toThrow(/does not match/);
    expect(() => resetDivisionSportSettings(canoe, wrongVersion)).toThrow(/does not match/);
    expect(() => resetDivisionSportSettings(canoe, wrongSchema)).toThrow(/does not match/);

    const forgedCompetition = { ...canoe, packSchemaVersion: 2 as unknown as 1 };
    expect(() => createDivisionSportSettings(SPORT_PACKS.canoe_polo, forgedCompetition, "division-y")).toThrow(
      /invalid|does not match/i,
    );
    expect(() =>
      customiseCompetitionSportSettings(SPORT_PACKS.canoe_polo, forgedCompetition, { slotMinutes: 31 }),
    ).toThrow(/invalid|does not match/i);
  });
});

describe("SPT-002, SPT-007, and SPT-008: version-safe commands", () => {
  it("creates immutable save-as-user-default data with source provenance", () => {
    const competition = customiseCompetitionSportSettings(
      SPORT_PACKS.badminton,
      createCompetitionSportSettings(SPORT_PACKS.badminton, "badminton-2026"),
      { slotMinutes: 25, serverIndicatorEnabled: true },
    );
    const command = createSaveAsUserDefaultCommand("command-1", "user-1", competition);
    const saved = applySaveAsUserDefaultCommand(command);
    expect(command.type).toBe("sport_settings.save_as_user_default");
    expect(saved).toEqual({
      userId: "user-1",
      sportId: "badminton",
      sourcePackSchemaVersion: 1,
      sourcePackVersion: DRAFT_SPORT_PACK_VERSION,
      settings: competition.effective,
    });
    expect(Object.isFrozen(saved.settings)).toBe(true);
  });

  it("copies compatible previous settings while preserving the target competition pack version", () => {
    const history = fixture<{
      sportId: SportId;
      legacyVersion: string;
      currentVersion: string;
      legacySlotMinutes: number;
      currentSlotMinutes: number;
    }>("version-history.json");
    const legacyPack = mutableClone(CANOE_POLO_SPORT_PACK);
    (legacyPack as { version: string }).version = history.legacyVersion;
    (legacyPack as { recommendedSlotMinutes: number }).recommendedSlotMinutes = history.legacySlotMinutes;
    (legacyPack.recommendedSettings as Record<string, unknown>).slotMinutes = history.legacySlotMinutes;
    assertValidSportPack(legacyPack);

    const source = customiseCompetitionSportSettings(
      legacyPack,
      createCompetitionSportSettings(legacyPack, "canoe-2025"),
      { slotMinutes: 27 },
    );
    const target = createCompetitionSportSettings(CANOE_POLO_SPORT_PACK, "canoe-2026");
    const command = createCopyFromPreviousCompetitionCommand("command-2", source, target);
    const copied = applyCopyFromPreviousCompetitionCommand(CANOE_POLO_SPORT_PACK, target, command);

    expect(command).toMatchObject({
      sourcePackVersion: history.legacyVersion,
      targetPackVersion: history.currentVersion,
    });
    expect(copied.packVersion).toBe(history.currentVersion);
    expect(copied.recommendedSnapshot.slotMinutes).toBe(history.currentSlotMinutes);
    expect(copied.effective.slotMinutes).toBe(27);
    expect(copied.mode).toBe("customised");
  });

  it("rejects cross-sport copies and a stale target-version command", () => {
    const canoe = createCompetitionSportSettings(SPORT_PACKS.canoe_polo, "canoe");
    const basketball = createCompetitionSportSettings(SPORT_PACKS.basketball, "basketball");
    expect(() => createCopyFromPreviousCompetitionCommand("command-3", canoe, basketball)).toThrow(/different sports/);

    const command = createCopyFromPreviousCompetitionCommand("command-4", canoe, canoe);
    const changedTarget = { ...canoe, packVersion: "0.2.0-draft.1" };
    expect(() => applyCopyFromPreviousCompetitionCommand(SPORT_PACKS.canoe_polo, changedTarget, command)).toThrow(
      /does not match|version changed/,
    );

    const incompatibleSource = { ...canoe, packSchemaVersion: 2 as unknown as 1 };
    expect(() => createCopyFromPreviousCompetitionCommand("command-5", incompatibleSource, canoe)).toThrow(
      /invalid|incompatible/i,
    );
  });

  it("keeps prior versions resolvable and rejects mutation under an existing version", () => {
    const legacy = mutableClone(CANOE_POLO_SPORT_PACK);
    (legacy as { version: string }).version = "0.0.1-draft.1";
    (legacy as { recommendedSlotMinutes: number }).recommendedSlotMinutes = 25;
    (legacy.recommendedSettings as Record<string, unknown>).slotMinutes = 25;
    const registry = createSportPackRegistry([legacy, CANOE_POLO_SPORT_PACK]);
    expect(resolveSportPack(registry, "canoe_polo", "0.0.1-draft.1").recommendedSlotMinutes).toBe(25);
    expect(resolveSportPack(registry, "canoe_polo", DRAFT_SPORT_PACK_VERSION).recommendedSlotMinutes).toBe(30);

    const alteredSameVersion = mutableClone(CANOE_POLO_SPORT_PACK);
    (alteredSameVersion as { recommendedSlotMinutes: number }).recommendedSlotMinutes = 35;
    (alteredSameVersion.recommendedSettings as Record<string, unknown>).slotMinutes = 35;
    expect(() => createSportPackRegistry([CANOE_POLO_SPORT_PACK, alteredSameVersion])).toThrow(/immutable/);
  });

  it("exposes a frozen registry facade with no runtime Map mutation surface", () => {
    const registry = createSportPackRegistry([CANOE_POLO_SPORT_PACK]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect((registry as unknown as { set?: unknown }).set).toBeUndefined();
    expect((registry as unknown as { get?: unknown }).get).toBeUndefined();
    expect(registry.has("canoe_polo", DRAFT_SPORT_PACK_VERSION)).toBe(true);
    expect(registry.versions("canoe_polo")).toEqual([DRAFT_SPORT_PACK_VERSION]);
    expect(Object.isFrozen(registry.versions("canoe_polo"))).toBe(true);
    expect(() => (registry.versions("canoe_polo") as string[]).push("9.9.9")).toThrow();
    expect(() => (registry.sportIds() as SportId[]).push("basketball")).toThrow();
    expect(Object.isFrozen(resolveSportPack(registry, "canoe_polo", DRAFT_SPORT_PACK_VERSION))).toBe(true);
    const boxedSport = new String("canoe_polo") as unknown as SportId;
    const boxedVersion = new String(DRAFT_SPORT_PACK_VERSION) as unknown as string;
    expect(registry.has(boxedSport, DRAFT_SPORT_PACK_VERSION)).toBe(false);
    expect(registry.has("canoe_polo", boxedVersion)).toBe(false);
    expect(() => resolveSportPack(registry, boxedSport, DRAFT_SPORT_PACK_VERSION)).toThrow(/Unknown sport pack/);
    expect(() => resolveSportPack(registry, "canoe_polo", boxedVersion)).toThrow(/Unknown sport pack/);
  });

  it("snapshots version and defaults so later source-object mutation cannot rewrite a competition", () => {
    const mutable = mutableClone(CANOE_POLO_SPORT_PACK);
    const competition = createCompetitionSportSettings(mutable, "snapshot-test");
    (mutable as { version: string }).version = "9.9.9";
    (mutable.recommendedSettings as Record<string, unknown>).slotMinutes = 99;
    expect(competition.packVersion).toBe(DRAFT_SPORT_PACK_VERSION);
    expect(competition.recommendedSnapshot.slotMinutes).toBe(30);
    expect(competition.effective.slotMinutes).toBe(30);
    expect(Object.isFrozen(competition)).toBe(true);
  });
});
