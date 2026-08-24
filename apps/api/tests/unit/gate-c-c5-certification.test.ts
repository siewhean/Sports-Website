import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync,
}));

import { runGateCC5Certification } from "../../scripts/run-gate-c-c5-certification.js";

describe("Gate C C5 certification runner", () => {
  it("fails closed before it reads source state without controlled staging opt-in", async () => {
    await expect(runGateCC5Certification({})).rejects.toThrow(
      "Refusing C5 certification without GATE_C_C5_STAGING_OPT_IN=1",
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("constructs the external controlled runtime before the benchmark and has no certification local fallback", () => {
    const source = readFileSync(new URL("../../scripts/run-gate-c-c5-certification.ts", import.meta.url), "utf8");
    const runtime = source.indexOf("createGateCC5ControlledStagingRuntime");
    const benchmark = source.indexOf("runC5BenchmarkAndEvidence");
    expect(runtime).toBeGreaterThanOrEqual(0);
    expect(benchmark).toBeGreaterThan(runtime);
    expect(source).not.toContain("buildApp(");
    expect(source).not.toContain("migrateDatabase(");
  });
});
