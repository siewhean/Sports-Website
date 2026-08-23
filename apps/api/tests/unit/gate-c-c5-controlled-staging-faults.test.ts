import { describe, expect, it } from "vitest";

import { createGateCC5ControlledStagingFaultHooks } from "../../scripts/gate-c-c5-controlled-staging-faults.js";

describe("Gate C C5 controlled staging fault hooks", () => {
  it("fails closed when any real fault command is absent", async () => {
    const hooks = createGateCC5ControlledStagingFaultHooks({
      retainedRoot: "/tmp/gate-c-c5-retained",
      environment: {},
    });
    await expect(hooks.redis_interruption()).rejects.toThrow(
      "Gate C C5 redis_interruption requires INJECT, RECOVER and CLEANUP controlled-staging commands",
    );
  });
});
