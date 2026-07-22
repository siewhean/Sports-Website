import { describe, expect, it } from "vitest";
import type { Phase4SetupDocument } from "@matchday/contracts";
import {
  isAssistedSetupAutosaveRequest,
  parseAssistedSetupAutosaveResponse,
  parseAssistedSetupCreateResponse,
  parseAssistedSetupDocument,
} from "./phase4-assisted-setup";

const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";
const stepIds = [
  "basics",
  "capacity",
  "settings",
  "entries",
  "format_preferences",
  "format_recommendations",
  "schedule_review",
  "review_publish",
] as const;

const document: Phase4SetupDocument = {
  schema_version: 1,
  id: "setup-a",
  organisation_id: "org-a",
  competition_id: competitionId,
  competition_status: "draft",
  revision: 2,
  status: "active",
  current_step: "basics",
  completed_steps: [],
  steps: stepIds.map((id, index) => ({
    id,
    status: index === 0 ? "current" : "not_started",
    prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
    errors: [],
    completed_at: null,
  })),
  values: {
    basics: null,
    capacity: null,
    settings: null,
    entries: null,
    format_preferences: null,
    format_recommendations: null,
    schedule_review: null,
    review_publish: null,
  },
  permission: "write",
  read_only: false,
  autosave: {
    status: "idle",
    last_saved_at: null,
    expires_at: "2026-08-20T00:00:00.000Z",
  },
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z",
  completed_at: null,
};

describe("Phase 4 assisted-setup web contract", () => {
  it("accepts the exact server document and rejects unknown keys", () => {
    expect(parseAssistedSetupDocument(document, competitionId)).toEqual(document);
    expect(parseAssistedSetupDocument({ ...document, local_revision: 2 }, competitionId)).toBeNull();
    expect(
      parseAssistedSetupDocument(
        { ...document, values: { ...document.values, basics: { name: "Incomplete nested value" } } },
        competitionId,
      ),
    ).toBeNull();
    expect(
      parseAssistedSetupDocument(
        {
          ...document,
          steps: document.steps.map((step, index) =>
            index === 0 ? { ...step, prerequisite_step_ids: ["not_a_setup_step"] } : step,
          ),
        },
        competitionId,
      ),
    ).toBeNull();
    expect(
      parseAssistedSetupDocument(
        {
          ...document,
          steps: document.steps.map((step, index) =>
            index === 0 ? { ...step, errors: [{ code: "INVALID", path: 42, message: "Broken" }] } : step,
          ),
        },
        competitionId,
      ),
    ).toBeNull();
  });

  it("accepts only the exact create-draft response wrapper", () => {
    expect(parseAssistedSetupCreateResponse({ document, idempotent_replay: false }, competitionId)).toEqual({
      document,
      idempotent_replay: false,
    });
    expect(parseAssistedSetupCreateResponse(document, competitionId)).toBeNull();
    expect(
      parseAssistedSetupCreateResponse({ document, idempotent_replay: false, browser_seed: true }, competitionId),
    ).toBeNull();
  });

  it("requires server revision and idempotency for every transition", () => {
    expect(
      isAssistedSetupAutosaveRequest({
        expected_revision: 2,
        idempotency_key: "command-a",
        transition: { kind: "go_to_step", step_id: "capacity" },
      }),
    ).toBe(true);
    expect(
      isAssistedSetupAutosaveRequest({
        expected_revision: 2,
        transition: { kind: "go_to_step", step_id: "capacity" },
      }),
    ).toBe(false);
    expect(
      isAssistedSetupAutosaveRequest({
        expected_revision: 2,
        idempotency_key: "command-a",
        transition: { kind: "go_to_step", step_id: "capacity" },
        browser_only: true,
      }),
    ).toBe(false);
    expect(
      isAssistedSetupAutosaveRequest({
        expected_revision: 2,
        idempotency_key: "command-a",
        transition: { kind: "save_step", step: { step_id: "basics", value: null } },
      }),
    ).toBe(false);
    expect(
      isAssistedSetupAutosaveRequest({
        expected_revision: 2,
        idempotency_key: "command-a",
        transition: { kind: "complete", review: {} },
      }),
    ).toBe(false);
  });

  it("surfaces authoritative conflict documents instead of overwriting", () => {
    const parsed = parseAssistedSetupAutosaveResponse(
      { outcome: "conflict", current: { ...document, revision: 3 } },
      competitionId,
    );
    expect(parsed?.outcome).toBe("conflict");
    if (parsed?.outcome === "conflict") expect(parsed.current.revision).toBe(3);
    expect(
      parseAssistedSetupAutosaveResponse(
        { outcome: "conflict", current: { ...document, revision: 3 }, ignored: true },
        competitionId,
      ),
    ).toBeNull();
  });
});
