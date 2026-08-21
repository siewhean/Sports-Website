import { describe, expect, it } from "vitest";

import { runGateCC5Lifecycle, stopGateCC5LifecycleWorker } from "../../scripts/run-gate-c-c5-lifecycle.js";

const sourceSha = "a".repeat(40);
const changedSourceSha = "b".repeat(40);
const approvedEnvironment = {
  GATE_C_C5_WORKLOAD_PROFILE_JSON: JSON.stringify({
    profileId: "approved-c5-pilot",
    durationSeconds: 1,
    scorekeeperCount: 1,
    publicReaderCount: 1,
    organiserWorkerCount: 1,
    approval: {
      owner: "platform-ops",
      approvedAtUtc: "2026-08-04T00:00:00.000Z",
      reference: "OPS-42",
    },
  }),
};

type LifecycleCalls = {
  redisCreated: number;
  producerClosed: number;
  workerStopped: number;
  cleanup: number;
};

function createDependencies(
  calls: LifecycleCalls,
  overrides: Readonly<{
    sourceShas?: readonly string[];
    requireCleanSourceTree?: () => void;
    stopWorker?: () => Promise<void>;
  }> = {},
) {
  let sourceIndex = 0;
  const sourceShas = overrides.sourceShas ?? [sourceSha, sourceSha];
  return {
    sourceSha: () => sourceShas[Math.min(sourceIndex++, sourceShas.length - 1)] ?? sourceSha,
    requireCleanSourceTree: overrides.requireCleanSourceTree ?? (() => undefined),
    createRunId: () => "123e4567-e89b-12d3-a456-426614174000",
    createRedis: () => {
      calls.redisCreated += 1;
      return {
        zscore: async () => "1",
        quit: async () => undefined,
      };
    },
    createProducer: () => ({
      enqueue: async () => ({ id: "probe-job" }),
      close: async () => {
        calls.producerClosed += 1;
      },
    }),
    startWorker: () => ({
      child: {
        pid: 1,
        exitCode: 0,
        once: () => undefined,
      },
      tail: [],
    }),
    stopWorker: async () => {
      calls.workerStopped += 1;
      await (overrides.stopWorker?.() ?? Promise.resolve());
    },
    prepareOwnership: async () => undefined,
    ownedKeys: async () => ["owned-worker-key"],
    cleanupOwnership: async () => {
      calls.cleanup += 1;
      return { initialOwnedKeyCount: 1, finalOwnedKeyCount: 0, unrelatedGuardPreserved: true };
    },
    waitUntil: async (predicate: () => Promise<boolean>, label: string) => {
      if (!(await predicate())) throw new Error(`test predicate did not pass for ${label}`);
    },
    evidencePath: async () => "/tmp/gate-c-c5-lifecycle-receipt.json",
    writeEvidence: async () => undefined,
  };
}

describe("C5 lifecycle failure fences", () => {
  it("rejects an already-abnormal worker exit before attempting a shutdown signal", async () => {
    await expect(
      stopGateCC5LifecycleWorker({
        child: {
          pid: 1,
          exitCode: 23,
          once: () => undefined,
        },
        tail: [],
      }),
    ).rejects.toThrow("Gate C C5 worker exited with code 23");
  });

  it("refuses a dirty source tree before opening Redis or starting a worker", async () => {
    const calls: LifecycleCalls = { redisCreated: 0, producerClosed: 0, workerStopped: 0, cleanup: 0 };
    const dependencies = createDependencies(calls, {
      requireCleanSourceTree: () => {
        throw new Error("test source tree is dirty");
      },
    });

    await expect(runGateCC5Lifecycle(approvedEnvironment, dependencies)).rejects.toThrow("test source tree is dirty");
    expect(calls).toEqual({ redisCreated: 0, producerClosed: 0, workerStopped: 0, cleanup: 0 });
  });

  it("rejects evidence when the source changes during the run and cleans only after both actors stop", async () => {
    const calls: LifecycleCalls = { redisCreated: 0, producerClosed: 0, workerStopped: 0, cleanup: 0 };
    const dependencies = createDependencies(calls, { sourceShas: [sourceSha, changedSourceSha] });

    await expect(runGateCC5Lifecycle(approvedEnvironment, dependencies)).rejects.toThrow(
      "Gate C C5 lifecycle run failed; worker output was not retained",
    );
    expect(calls).toEqual({ redisCreated: 1, producerClosed: 1, workerStopped: 1, cleanup: 1 });
  });

  it("retains the isolated namespace when a worker exit prevents safe cleanup", async () => {
    const calls: LifecycleCalls = { redisCreated: 0, producerClosed: 0, workerStopped: 0, cleanup: 0 };
    const dependencies = createDependencies(calls, {
      stopWorker: async () => {
        throw new Error("worker exited with code 23");
      },
    });

    await expect(runGateCC5Lifecycle(approvedEnvironment, dependencies)).rejects.toThrow(
      /lifecycle cleanup could not complete for isolated namespace [a-f0-9]{64}/u,
    );
    expect(calls.producerClosed).toBe(1);
    expect(calls.workerStopped).toBe(2);
    expect(calls.cleanup).toBe(0);
  });
});
