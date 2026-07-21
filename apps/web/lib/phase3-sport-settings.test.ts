import { describe, expect, it } from "vitest";
import { SPORT_PACKS } from "@matchday/domain";
import {
  deriveSportSettingsOverride,
  displaySettingValue,
  parseSportSettingsResponse,
  settingsMode,
  validateSettingsDraft,
} from "./phase3-sport-settings";

describe("Phase 3 sport settings view model", () => {
  const pack = SPORT_PACKS.canoe_polo;

  it("keeps an unchanged recommendation in recommended mode", () => {
    expect(deriveSportSettingsOverride(pack.recommendedSettings, pack.recommendedSettings)).toEqual({});
    expect(settingsMode(pack.recommendedSettings, pack.recommendedSettings)).toBe("recommended");
  });

  it("creates only the changed keys in a customised override", () => {
    const values = { ...pack.recommendedSettings, slotMinutes: 35 };
    expect(deriveSportSettingsOverride(values, pack.recommendedSettings)).toEqual({ slotMinutes: 35 });
    expect(settingsMode(values, pack.recommendedSettings)).toBe("customised");
  });

  it("reports field-addressable validation errors", () => {
    const errors = validateSettingsDraft(pack, { ...pack.recommendedSettings, slotMinutes: 0 });
    expect(errors.slotMinutes).toBe("Expected 5–480");
  });

  it("formats ordered enum values for decision support", () => {
    expect(displaySettingValue(["wins", "head_to_head", "goal_difference"])).toBe(
      "Wins → Head To Head → Goal Difference",
    );
  });

  it("strictly parses authenticated competition settings and preserves read-only permission", () => {
    const context = {
      scope: "competition" as const,
      competitionId: "46f0050a-ddd3-4fd5-bf30-c063694ae52a",
      competitionName: "Open",
    };
    const payload = {
      competition_id: context.competitionId,
      division_id: null,
      sport_code: pack.sportId,
      pack_schema_version: pack.schemaVersion,
      pack_version: pack.version,
      recommended_snapshot: pack.recommendedSettings,
      override: {},
      effective: pack.recommendedSettings,
      mode: "recommended",
      revision: 2,
      pack_definition_hash: "a".repeat(64),
      pack_definition: pack,
      permission: "read",
      read_only: true,
      organisation_id: "80e92ffb-77fc-4688-8a72-02a7be7bd601",
    };
    const document = parseSportSettingsResponse(payload, context);
    expect(document?.state).toBe("read-only");
    expect(document?.canEdit).toBe(false);
    expect(document?.capabilities).toEqual({ save: false, saveDefault: false, copyPrevious: false });
  });

  it("rejects unknown fields, permission drift and inconsistent effective settings", () => {
    const context = {
      scope: "competition" as const,
      competitionId: "46f0050a-ddd3-4fd5-bf30-c063694ae52a",
      competitionName: "Open",
    };
    const base = {
      competition_id: context.competitionId,
      division_id: null,
      sport_code: pack.sportId,
      pack_schema_version: pack.schemaVersion,
      pack_version: pack.version,
      recommended_snapshot: pack.recommendedSettings,
      override: {},
      effective: pack.recommendedSettings,
      mode: "recommended",
      revision: 2,
      pack_definition_hash: "a".repeat(64),
      pack_definition: pack,
      permission: "write",
      read_only: false,
      organisation_id: "80e92ffb-77fc-4688-8a72-02a7be7bd601",
    };
    expect(parseSportSettingsResponse({ ...base, surprise: true }, context)).toBeNull();
    expect(parseSportSettingsResponse({ ...base, read_only: true }, context)).toBeNull();
    expect(
      parseSportSettingsResponse({ ...base, effective: { ...pack.recommendedSettings, slotMinutes: 35 } }, context),
    ).toBeNull();
  });

  it("hydrates a newly activated pinned definition that is not bundled", () => {
    const context = {
      scope: "competition" as const,
      competitionId: "46f0050a-ddd3-4fd5-bf30-c063694ae52a",
      competitionName: "Open",
    };
    const activated = { ...pack, version: "9.0.0", displayName: "Canoe Polo 2030" };
    const document = parseSportSettingsResponse(
      {
        competition_id: context.competitionId,
        division_id: null,
        sport_code: activated.sportId,
        pack_schema_version: activated.schemaVersion,
        pack_version: activated.version,
        pack_definition_hash: "b".repeat(64),
        pack_definition: activated,
        recommended_snapshot: activated.recommendedSettings,
        override: {},
        effective: activated.recommendedSettings,
        mode: "recommended",
        revision: 1,
        permission: "write",
        read_only: false,
        organisation_id: "80e92ffb-77fc-4688-8a72-02a7be7bd601",
      },
      context,
    );
    expect(document?.packVersion).toBe("9.0.0");
    expect(document?.sportName).toBe("Canoe Polo 2030");
    expect(document?.packDefinition).toEqual(activated);
  });
});
