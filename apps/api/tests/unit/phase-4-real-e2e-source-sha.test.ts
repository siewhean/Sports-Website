import { describe, expect, it } from "vitest";

import { sourceShaAtHead } from "../../scripts/run-phase-4-real-e2e.js";

describe("Phase 4 real E2E source binding", () => {
  it("derives one full SHA from the current checkout instead of trusting a caller", () => {
    expect(sourceShaAtHead()).toMatch(/^[a-f0-9]{40}$/u);
  });
});
