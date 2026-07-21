import { describe, expect, it } from "vitest";
import {
  assistedSetupStepIds,
  decideAssistedSetupAutosave,
  deriveAssistedSetupProgress,
  transitionAssistedSetup,
  validateAssistedSetupStep,
  type AssistedSetupStepValues,
} from "../src/index.js";

function completeValues(): AssistedSetupStepValues {
  return {
    basics: {
      name: "National Championships",
      sportCode: "canoe_polo",
      venue: "Sports Hub",
      address: "1 Stadium Drive",
      locality: "Singapore",
      countryCode: "SG",
      startsOn: "2026-08-14",
      endsOn: "2026-08-16",
      timeZone: "Asia/Singapore",
      locale: "en-SG",
      entryCount: 8,
      divisionCount: 1,
      entryCountStatus: "confirmed",
    },
    capacity: {
      kind: "phase3_capacity_revision",
      competitionId: "competition-1",
      revision: 4,
      timeZone: "Asia/Singapore",
      areaIds: ["area-1", "area-2"],
      sourceHash: "capacity-hash",
      availableMatchSlots: 40,
    },
    settings: [
      {
        scope: "competition",
        competitionId: "competition-1",
        divisionId: null,
        revision: 2,
        mode: "recommended",
        packSchemaVersion: 1,
        packVersion: "2026.1",
        definitionHash: "pack-hash",
      },
    ],
    entries: {
      competitionId: "competition-1",
      totalEntryCount: 8,
      divisions: [
        {
          divisionId: "division-1",
          divisionRevision: 2,
          entryIds: Array.from({ length: 8 }, (_, index) => `entry-${index + 1}`),
          confirmedCount: 8,
          placeholderCount: 0,
        },
      ],
      imports: [{ importId: "import-1", status: "applied", acceptedRowCount: 8, rejectedRowCount: 0 }],
    },
    format_preferences: {
      minimumMatchesPerEntry: 3,
      rankAllEntries: true,
      knockoutRequired: true,
      placementRequired: true,
      crossGroupAllowed: false,
      priority: "participation",
    },
    format_recommendations: {
      recommendations: [
        {
          id: "balanced",
          formatRevisionId: "format-revision-1",
          definitionHash: "format-a",
          name: "Balanced",
          structure: "Pools then knockout",
          advantage: "Balances participation and duration",
          matchCount: 24,
          minimumMatchesPerEntry: 3,
          capacityStatus: "fits",
          schedulingStatus: "feasible",
          warningCodes: [],
        },
        {
          id: "compact",
          formatRevisionId: "format-revision-2",
          definitionHash: "format-b",
          name: "Compact",
          structure: "Short pools then knockout",
          advantage: "Finishes earlier",
          matchCount: 18,
          minimumMatchesPerEntry: 2,
          capacityStatus: "tight",
          schedulingStatus: "feasible",
          warningCodes: [],
        },
      ],
      requiresChanges: null,
      selectedRecommendationId: "balanced",
      acknowledgedCapacityShortfall: false,
      recommendationSetHash: "recommendations-hash",
    },
    schedule_review: {
      scheduleJobId: "job-1",
      sourceRevision: 4,
      selectedRecommendationId: "balanced",
      formatRevisionId: "format-revision-1",
      formatDefinitionHash: "format-a",
      capacityRevision: 4,
      settingsReferences: [{ scope: "competition", divisionId: null, revision: 2, definitionHash: "pack-hash" }],
      selectedResultRevision: 3,
      selectedResultHash: "schedule-hash",
      objective: "balanced",
      scheduleRevisionId: "schedule-revision-1",
      feasibility: "valid",
    },
    review_publish: {
      selectedFormatRevisionId: "format-revision-1",
      selectedScheduleResultHash: "schedule-hash",
      capacityRevision: 4,
      settingsReferences: [{ scope: "competition", divisionId: null, revision: 2, definitionHash: "pack-hash" }],
      acknowledgedWarningCodes: [],
      publicationStatus: "published",
      publishedScheduleRevisionId: "schedule-revision-1",
    },
  };
}

describe("Phase 4 Assisted Setup validation", () => {
  it("derives all eight steps and deterministic prerequisites", () => {
    const values = { ...completeValues(), review_publish: null };
    const progress = deriveAssistedSetupProgress(values);
    expect(progress.currentStep).toBe("review_publish");
    expect(progress.completedSteps).toEqual(assistedSetupStepIds.slice(0, 7));
    expect(progress.steps[7]?.prerequisiteStepIds).toEqual(assistedSetupStepIds.slice(0, 7));
    expect(progress.steps[7]?.status).toBe("error");
  });

  it("marks all eight steps complete when final review is valid", () => {
    const progress = deriveAssistedSetupProgress(completeValues());
    expect(progress.completedSteps).toEqual(assistedSetupStepIds);
    expect(progress.steps.every((step) => step.status === "completed")).toBe(true);
  });

  it("keeps final review incomplete until explicit publication succeeds", () => {
    const source = completeValues();
    const values = {
      ...source,
      review_publish: {
        ...source.review_publish!,
        publicationStatus: "not_requested" as const,
        publishedScheduleRevisionId: null,
      },
    };
    expect(validateAssistedSetupStep("review_publish", values)).toContainEqual(
      expect.objectContaining({ code: "publication_required" }),
    );
    expect(deriveAssistedSetupProgress(values).completedSteps).toEqual(assistedSetupStepIds.slice(0, 7));
  });

  it("blocks forward navigation until every prior step is valid", () => {
    const values = { ...completeValues(), capacity: null };
    const result = transitionAssistedSetup(values, "basics", { kind: "go_to_step", stepId: "settings" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("prerequisite");
      expect(result.issues).toContainEqual(expect.objectContaining({ path: "capacity" }));
    }
  });

  it("resumes at the first invalid step regardless of stored UI position", () => {
    const values = { ...completeValues(), entries: null };
    const result = transitionAssistedSetup(values, "review_publish", { kind: "resume" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.currentStep).toBe("entries");
  });

  it("rejects lossy or mismatched capacity references", () => {
    const source = completeValues();
    const values = {
      ...source,
      capacity: {
        ...source.capacity!,
        revision: 0,
        sourceHash: "",
        timeZone: "UTC",
        areaIds: ["area-1", "area-1"],
      },
    };
    expect(validateAssistedSetupStep("capacity", values).map((item) => item.code)).toEqual([
      "invalid_reference",
      "invalid_areas",
      "timezone_mismatch",
    ]);
  });

  it("keeps import state aggregate-only and validates entry identity exactly", () => {
    const source = completeValues();
    const values = {
      ...source,
      entries: {
        ...source.entries!,
        totalEntryCount: 8,
        divisions: [{ ...source.entries!.divisions[0]!, entryIds: Array(8).fill("same-entry") }],
      },
    };
    expect(validateAssistedSetupStep("entries", values)).toContainEqual(
      expect.objectContaining({ code: "duplicate_entry" }),
    );
    expect(JSON.stringify(values.entries)).not.toContain("email");
    expect(JSON.stringify(values.entries)).not.toContain("raw");
  });

  it("rejects unexpected import payload fields at the runtime boundary", () => {
    const source = completeValues();
    const unsafeImport = {
      ...source.entries!.imports[0]!,
      rawRows: [{ email: "private@example.test" }],
    };
    const values = {
      ...source,
      entries: { ...source.entries!, imports: [unsafeImport] },
    };
    expect(validateAssistedSetupStep("entries", values)).toContainEqual(
      expect.objectContaining({ code: "invalid_import_reference" }),
    );
  });

  it("rejects invalid calendar dates, IANA time zones and incomplete locations", () => {
    const source = completeValues();
    const values = {
      ...source,
      basics: { ...source.basics!, address: "", startsOn: "2026-99-99", timeZone: "Mars/Olympus" },
    };
    expect(validateAssistedSetupStep("basics", values).map((item) => item.code)).toEqual([
      "required",
      "invalid_dates",
      "invalid_time_zone",
    ]);
  });

  it("revalidates sport, entry status and every preference union at runtime", () => {
    const source = completeValues();
    const values = {
      ...source,
      basics: { ...source.basics!, sportCode: "unsupported_sport", entryCountStatus: "unknown" },
      format_preferences: {
        minimumMatchesPerEntry: 3,
        rankAllEntries: "yes",
        knockoutRequired: 1,
        placementRequired: null,
        crossGroupAllowed: [],
        priority: "invalid",
      },
    } as unknown as AssistedSetupStepValues;
    expect(validateAssistedSetupStep("basics", values).map((item) => item.code)).toEqual([
      "invalid_sport",
      "invalid_entry_count_status",
    ]);
    expect(validateAssistedSetupStep("format_preferences", values).map((item) => item.code)).toEqual([
      "invalid_boolean",
      "invalid_boolean",
      "invalid_boolean",
      "invalid_boolean",
      "invalid_priority",
    ]);
  });

  it("rejects division settings that do not belong to persisted entries", () => {
    const source = completeValues();
    const values = {
      ...source,
      settings: [
        ...source.settings!,
        {
          ...source.settings![0]!,
          scope: "division" as const,
          divisionId: "unknown-division",
        },
      ],
    };
    expect(validateAssistedSetupStep("settings", values)).toContainEqual(
      expect.objectContaining({ code: "unknown_division" }),
    );
  });

  it("revalidates settings, recommendation and schedule enums at runtime", () => {
    const source = completeValues();
    const values = {
      ...source,
      settings: [{ ...source.settings![0]!, mode: "invalid" }],
      format_recommendations: {
        ...source.format_recommendations!,
        recommendations: [
          {
            ...source.format_recommendations!.recommendations[0]!,
            capacityStatus: "garbage",
            schedulingStatus: "garbage",
          },
        ],
      },
      schedule_review: { ...source.schedule_review!, objective: "invalid" },
    } as unknown as AssistedSetupStepValues;
    expect(validateAssistedSetupStep("settings", values)).toContainEqual(
      expect.objectContaining({ code: "invalid_mode" }),
    );
    expect(validateAssistedSetupStep("format_recommendations", values)).toContainEqual(
      expect.objectContaining({ code: "invalid_reference" }),
    );
    expect(validateAssistedSetupStep("schedule_review", values)).toContainEqual(
      expect.objectContaining({ code: "invalid_objective" }),
    );
  });

  it("derives truthful capacity categories from the Phase 3 slot total", () => {
    const source = completeValues();
    const selected = source.format_recommendations!.recommendations[0]!;
    const values = {
      ...source,
      capacity: { ...source.capacity!, availableMatchSlots: 1 },
      format_recommendations: {
        ...source.format_recommendations!,
        recommendations: [{ ...selected, matchCount: 999, capacityStatus: "fits" as const }],
        requiresChanges: {
          ...selected,
          id: "over",
          formatRevisionId: "format-over",
          definitionHash: "hash-over",
          capacityStatus: "requires_changes" as const,
          matchCount: 1,
        },
      },
    };
    expect(validateAssistedSetupStep("format_recommendations", values).map((item) => item.code)).toEqual(
      expect.arrayContaining(["capacity_mismatch"]),
    );
    expect(
      validateAssistedSetupStep("format_recommendations", values).filter((item) => item.code === "capacity_mismatch"),
    ).toHaveLength(2);
  });

  it("rejects duplicate division IDs and impossible aggregate counts", () => {
    const source = completeValues();
    const division = source.entries!.divisions[0]!;
    const values = {
      ...source,
      basics: { ...source.basics!, divisionCount: 2 },
      entries: {
        ...source.entries!,
        divisions: [
          { ...division, confirmedCount: 999, placeholderCount: 999 },
          { ...division, entryIds: [], confirmedCount: 0, placeholderCount: 0 },
        ],
      },
    };
    expect(validateAssistedSetupStep("entries", values).map((item) => item.code)).toEqual(
      expect.arrayContaining(["invalid_division", "invalid_reference"]),
    );
  });

  it("caps normal recommendations and requires feasible acknowledged selection", () => {
    const source = completeValues();
    const options = Array.from({ length: 4 }, (_, index) => ({
      id: `option-${index}`,
      formatRevisionId: `format-revision-${index}`,
      definitionHash: `hash-${index}`,
      name: `Option ${index}`,
      structure: "Pools then knockout",
      advantage: "Brief advantage",
      matchCount: 16 + index,
      minimumMatchesPerEntry: 2,
      capacityStatus: "fits" as const,
      schedulingStatus: "feasible" as const,
      warningCodes: [],
    }));
    const values = {
      ...source,
      format_recommendations: {
        recommendations: options,
        requiresChanges: {
          id: "over",
          formatRevisionId: "format-revision-over",
          definitionHash: "over-hash",
          name: "Full ranking",
          structure: "Pools and placement",
          advantage: "Ranks every entry",
          matchCount: 48,
          minimumMatchesPerEntry: 4,
          capacityStatus: "requires_changes" as const,
          schedulingStatus: "feasible" as const,
          warningCodes: ["requires_more_slots"],
        },
        selectedRecommendationId: "over",
        acknowledgedCapacityShortfall: false,
        recommendationSetHash: "set-hash",
      },
    };
    expect(validateAssistedSetupStep("format_recommendations", values).map((item) => item.code)).toEqual([
      "invalid_count",
      "capacity_acknowledgement",
    ]);
  });

  it("enforces recommendation identity and over-capacity categories", () => {
    const source = completeValues();
    const first = source.format_recommendations!.recommendations[0]!;
    const values = {
      ...source,
      format_recommendations: {
        ...source.format_recommendations!,
        recommendations: [
          first,
          { ...first, definitionHash: "different-hash", capacityStatus: "requires_changes" as const },
        ],
        requiresChanges: { ...first, id: "over", definitionHash: "over-hash", capacityStatus: "fits" as const },
      },
    };
    expect(validateAssistedSetupStep("format_recommendations", values).map((item) => item.code)).toEqual(
      expect.arrayContaining(["not_meaningfully_different", "invalid_category"]),
    );
  });

  it("detects stale schedule and capacity selections before publication", () => {
    const source = completeValues();
    const values = {
      ...source,
      review_publish: {
        ...source.review_publish!,
        capacityRevision: 3,
        selectedScheduleResultHash: "older-schedule",
      },
    };
    expect(validateAssistedSetupStep("review_publish", values).map((item) => item.code)).toEqual([
      "stale_capacity",
      "stale_schedule",
    ]);
  });

  it("binds schedule and publication to selected format and pinned settings", () => {
    const source = completeValues();
    const values = {
      ...source,
      schedule_review: {
        ...source.schedule_review!,
        selectedRecommendationId: "compact",
        formatRevisionId: "stale-format",
        settingsReferences: [
          { scope: "competition" as const, divisionId: null, revision: 999, definitionHash: "stale-pack" },
        ],
      },
      review_publish: {
        ...source.review_publish!,
        selectedFormatRevisionId: "arbitrary-format",
        settingsReferences: [
          { scope: "competition" as const, divisionId: null, revision: 999, definitionHash: "stale-pack" },
        ],
      },
    };
    expect(validateAssistedSetupStep("schedule_review", values).map((item) => item.code)).toEqual(
      expect.arrayContaining(["stale_format", "stale_settings"]),
    );
    expect(validateAssistedSetupStep("review_publish", values).map((item) => item.code)).toEqual(
      expect.arrayContaining(["stale_format", "stale_settings"]),
    );
  });

  it("orders idempotency, permission, expiry and optimistic-conflict guards deterministically", () => {
    const base = {
      currentRevision: 4,
      expectedRevision: 4,
      status: "active" as const,
      readOnly: false,
      expiresAtEpochMs: 200,
      nowEpochMs: 100,
      requestFingerprint: "request-a",
      storedIdempotencyFingerprint: null,
    };
    expect(decideAssistedSetupAutosave(base)).toBe("save");
    expect(decideAssistedSetupAutosave({ ...base, expectedRevision: 3 })).toBe("conflict");
    expect(decideAssistedSetupAutosave({ ...base, nowEpochMs: 200 })).toBe("expired");
    expect(decideAssistedSetupAutosave({ ...base, readOnly: true })).toBe("read_only");
    expect(
      decideAssistedSetupAutosave({
        ...base,
        expectedRevision: 1,
        readOnly: true,
        nowEpochMs: 300,
        storedIdempotencyFingerprint: "request-a",
      }),
    ).toBe("idempotent_replay");
    expect(decideAssistedSetupAutosave({ ...base, storedIdempotencyFingerprint: "request-b" })).toBe(
      "idempotency_mismatch",
    );
  });
});
