import { describe, expect, it } from "vitest";

import { assertGateCC4CollectorEnvironment, createGateCC4CollectorReceipt } from "../../scripts/run-gate-c-c4-e2e.js";

const sourceSha = "a".repeat(40);

describe("Gate C C4 evidence collector", () => {
  it("emits unsealed collector evidence rather than current certification", () => {
    const receipt = createGateCC4CollectorReceipt({
      sourceSha,
      runId: "run-1",
      startedAt: "2026-08-23T00:00:00.000Z",
      completedAt: "2026-08-23T00:00:01.000Z",
      nodeVersion: "v24.18.0",
      pnpmVersion: "10.33.0",
      unitOutput: "unit pass",
      e2eOutput: "e2e pass",
    });

    expect(receipt.record_status).toBe("UNSEALED_COLLECTOR");
    expect(receipt.status).toBe("PASS");
    expect(receipt.source_sha).toBe(sourceSha);
    expect(receipt.outputs.unit_test_summary_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed for toolchain drift and tracked source changes", () => {
    expect(() =>
      assertGateCC4CollectorEnvironment({
        nodeVersion: "v24.15.0",
        pnpmVersion: "10.33.0",
        dirtyTrackedFiles: "",
      }),
    ).toThrow("requires Node v24.18.0");
    expect(() =>
      assertGateCC4CollectorEnvironment({
        nodeVersion: "v24.18.0",
        pnpmVersion: "10.33.0",
        dirtyTrackedFiles: " M apps/api/src/main.ts",
      }),
    ).toThrow("dirty source tree");
  });
});
