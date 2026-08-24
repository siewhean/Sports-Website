import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createGateCC5ControlledStagingFaultHooks } from "../../scripts/gate-c-c5-controlled-staging-faults.js";

describe("Gate C C5 controlled staging fault hooks", () => {
  it("fails closed when any real fault command is absent", async () => {
    const hooks = createGateCC5ControlledStagingFaultHooks({
      retainedRoot: "/tmp/gate-c-c5-retained",
      environment: {},
    });
    await expect(hooks.redis_interruption()).rejects.toThrow(
      "Gate C C5 redis_interruption requires PRECONDITION, INJECT, DEGRADATION, RECOVER, INVARIANT and CLEANUP controlled-staging commands",
    );
  });

  it("always invokes and retains cleanup when an earlier destructive phase fails", async () => {
    const retainedRoot = await mkdtemp(path.join(os.tmpdir(), "gate-c-c5-fault-"));
    const prefix = "GATE_C_C5_REDIS_INTERRUPTION_";
    const environment = {
      [`${prefix}PRECONDITION_COMMAND`]: "/usr/bin/printf precondition",
      [`${prefix}INJECT_COMMAND`]: "/usr/bin/false",
      [`${prefix}DEGRADATION_COMMAND`]: "/usr/bin/printf degradation",
      [`${prefix}RECOVER_COMMAND`]: "/usr/bin/printf recovery",
      [`${prefix}INVARIANT_COMMAND`]: "/usr/bin/printf invariant",
      [`${prefix}CLEANUP_COMMAND`]: "/usr/bin/printf cleanup",
    };
    try {
      const hooks = createGateCC5ControlledStagingFaultHooks({ retainedRoot, environment });
      await expect(hooks.redis_interruption()).rejects.toThrow();
      await expect(readFile(path.join(retainedRoot, "redis_interruption", "cleanup.log"), "utf8")).resolves.toContain(
        "cleanup",
      );
    } finally {
      await rm(retainedRoot, { recursive: true, force: true });
    }
  });
});
