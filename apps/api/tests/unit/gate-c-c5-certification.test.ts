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
});
