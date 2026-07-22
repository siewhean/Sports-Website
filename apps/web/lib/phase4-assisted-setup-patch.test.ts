import { describe, expect, it, vi } from "vitest";
import type { Phase4PatchableSetupStep } from "@matchday/contracts";
import { isAssistedSetupPatchRequest, setupPatchBody } from "./phase4-assisted-setup-patch";

const step: Phase4PatchableSetupStep = {
  step_id: "format_preferences",
  value: {
    minimum_matches: { per_entry: 3 },
    ranking: { rank_all_entries: true },
    knockout: { required: false },
    placement: { required: false },
    qualification: { cross_group_allowed: true },
    priority: { value: "participation" },
  },
};

describe("Phase 4 Assisted Setup patch web contract", () => {
  it("creates a revision-fenced non-navigating patch", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    expect(setupPatchBody(6, step)).toEqual({
      expected_revision: 6,
      idempotency_key: "00000000-0000-4000-8000-000000000001",
      step,
    });
    vi.unstubAllGlobals();
  });

  it("rejects unknown keys, missing revisions, and non-editable steps", () => {
    expect(isAssistedSetupPatchRequest({ expected_revision: 6, idempotency_key: "patch-key", step })).toBe(true);
    expect(
      isAssistedSetupPatchRequest({ expected_revision: 6, idempotency_key: "patch-key", step, browser_only: true }),
    ).toBe(false);
    expect(isAssistedSetupPatchRequest({ idempotency_key: "patch-key", step })).toBe(false);
    expect(
      isAssistedSetupPatchRequest({
        expected_revision: 6,
        idempotency_key: "patch-key",
        step: { step_id: "capacity", value: {} },
      }),
    ).toBe(false);
    expect(
      isAssistedSetupPatchRequest({
        expected_revision: 6,
        idempotency_key: "patch-key",
        step: { step_id: "basics", value: {} },
      }),
    ).toBe(false);
  });
});
