import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createGateCC5LifecycleReceipt } from "../../scripts/run-gate-c-c5-lifecycle.js";

const source = readFileSync(new URL("../../scripts/run-gate-c-c5-lifecycle.ts", import.meta.url), "utf8");

describe("C5 real lifecycle receipt", () => {
  it("retains only hashes and proves orderly cleanup", () => {
    const receipt = createGateCC5LifecycleReceipt({
      sourceSha: "a".repeat(40),
      profileId: "approved-c5-pilot",
      approvalReference: "OPS-42",
      probeJobId: "job-sensitive-id",
      redisNamespace: "matchday:test:gate-c-c5:run-a:",
      cleanup: { initialOwnedKeyCount: 5, finalOwnedKeyCount: 0, unrelatedGuardPreserved: true },
    });
    expect(receipt).toMatchObject({
      source_sha: "a".repeat(40),
      producer_stopped_before_cleanup: true,
      worker_stopped_before_cleanup: true,
      owned_key_counts: { before_cleanup: 5, after_cleanup: 0 },
      unrelated_guard_preserved: true,
    });
    expect(JSON.stringify(receipt)).not.toContain("job-sensitive-id");
    expect(JSON.stringify(receipt)).not.toContain("matchday:test:gate-c-c5:run-a:");
    expect(JSON.stringify(receipt)).not.toContain("OPS-42");
    expect(receipt.approval_reference_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a cleanup receipt that does not preserve the unrelated guard", () => {
    expect(() =>
      createGateCC5LifecycleReceipt({
        sourceSha: "a".repeat(40),
        profileId: "approved-c5-pilot",
        approvalReference: "OPS-42",
        probeJobId: "job-id",
        redisNamespace: "matchday:test:gate-c-c5:run-a:",
        cleanup: { initialOwnedKeyCount: 1, finalOwnedKeyCount: 0, unrelatedGuardPreserved: false },
      }),
    ).toThrow("safe queue cleanup");
  });

  it("spawns the worker directly so graceful shutdown has an observable exit code", () => {
    expect(source).toContain('spawn(process.execPath, [tsxCli, "apps/worker/src/main.ts"]');
    expect(source).not.toContain('spawn("pnpm", ["--filter", "@matchday/worker"');
  });
});
