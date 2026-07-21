import { describe, expect, it } from "vitest";
import { SPORT_PACKS } from "@matchday/domain";
import {
  nextDraftDefinition,
  parseSportPackActivationReceipt,
  parseSportPackAdminIndex,
  parseSportPackAdminRead,
  parseSportPackDraftReceipt,
} from "./phase3-sport-pack-admin";

const accountId = "80e92ffb-77fc-4688-8a72-02a7be7bd601";
const createdAt = "2026-07-20T00:00:00.000Z";
const hash = "a".repeat(64);

describe("Phase 3 sport-pack administration boundary", () => {
  it("strictly reads an immutable draft definition and revision", () => {
    const definition = SPORT_PACKS.canoe_polo;
    const parsed = parseSportPackAdminRead({
      sport_code: definition.sportId,
      version: definition.version,
      schema_version: definition.schemaVersion,
      definition,
      definition_hash: hash,
      status: "draft",
      revision: 1,
      created_by: accountId,
      created_at: createdAt,
      activated_by: null,
      activated_at: null,
      superseded_at: null,
      superseded_by: null,
      superseded_by_version: null,
      read_only: true,
    });
    expect(parsed?.definition).toEqual(definition);
    expect(parseSportPackAdminRead({ ...parsed, surprise: true })).toBeNull();
  });

  it("discovers the current active version from the strict version index", () => {
    const index = parseSportPackAdminIndex({
      sport_code: "canoe_polo",
      active_version: "1.0.0",
      versions: [
        {
          version: "1.0.0",
          schema_version: 1,
          definition_hash: hash,
          status: "active",
          revision: 2,
          created_at: createdAt,
          activated_at: createdAt,
          superseded_at: null,
        },
      ],
    });
    expect(index?.activeVersion).toBe("1.0.0");
    expect(parseSportPackAdminIndex({ ...index, active_version: "missing" })).toBeNull();
  });

  it("creates a distinct validated draft version without mutating the source", () => {
    const source = SPORT_PACKS.badminton;
    const next = nextDraftDefinition(source, "1.0.0");
    expect(next?.version).toBe("1.0.0");
    expect(source.version).not.toBe("1.0.0");
  });

  it("requires exact draft and revision-aware activation receipts", () => {
    expect(
      parseSportPackDraftReceipt({
        sport_code: "canoe_polo",
        version: "1.0.0",
        schema_version: 1,
        definition_hash: hash,
        status: "draft",
        revision: 1,
        created_by: accountId,
        created_at: createdAt,
        idempotent_replay: false,
      })?.revision,
    ).toBe(1);
    const activation = {
      sport_code: "canoe_polo",
      version: "1.0.0",
      schema_version: 1,
      definition_hash: hash,
      status: "active",
      revision: 2,
      activated_by: accountId,
      activated_at: createdAt,
      previous_active_version: "0.9.0",
      idempotent_replay: false,
    };
    expect(parseSportPackActivationReceipt(activation)?.revision).toBe(2);
    expect(parseSportPackActivationReceipt({ ...activation, revision: 1 })).toBeNull();
    expect(parseSportPackActivationReceipt({ ...activation, extra: true })).toBeNull();
  });
});
