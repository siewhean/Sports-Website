import { describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

import { runGateCC5HmacRotationDrill } from "../../scripts/run-gate-c-c5-hmac-rotation.js";

describe("Gate C C5 HMAC rotation drill", () => {
  it("cannot be invoked by the normal certification path without its own opt-in", async () => {
    await expect(runGateCC5HmacRotationDrill({ sourceSha: "a".repeat(40), environment: {} })).rejects.toThrow(
      "Refusing HMAC rotation drill without GATE_C_C5_HMAC_DRILL_OPT_IN=1",
    );
  });
});
