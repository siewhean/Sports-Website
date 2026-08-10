import { describe, expect, it } from "vitest";
import {
  C5_CONTROLLED_FAILURES,
  C5_APPROVED_PILOT_PROFILE,
  C5_MAXIMUM_SAMPLES_PER_OPERATION,
  createC5ApprovedPilotWorkloadPlan,
  executeC5IntegratedWorkload,
  validateC5IntegratedWorkloadReceipt,
  type C5ControlledFailure,
  type C5WorkloadResource,
} from "./c5-integrated-workload.js";
import { C5_WORKLOAD_OPERATIONS, type C5WorkloadOperation } from "./workload-profile.js";
import type { C5WorkloadExecutor } from "./workload-runner.js";

const sourceSha = "a".repeat(40);
const profile = C5_APPROVED_PILOT_PROFILE;
const plan = createC5ApprovedPilotWorkloadPlan(profile);

function virtualTiming() {
  let now = 0;
  return {
    now: () => now,
    waitUntil: async (timestampMs: number) => {
      now = Math.max(now, timestampMs);
    },
    timeoutSignal: (timeoutMs: number) => AbortSignal.timeout(timeoutMs),
  };
}

function executors() {
  const result = {} as Record<C5WorkloadOperation, C5WorkloadExecutor>;
  for (const operation of C5_WORKLOAD_OPERATIONS) {
    result[operation] = async () => {
      return { outcome: "success", correctness: { passed: true } };
    };
  }
  return result;
}

function hooks() {
  return Object.fromEntries(
    C5_CONTROLLED_FAILURES.map((fault) => [
      fault,
      async () => ({
        fault,
        injector: "command" as const,
        injection_evidence_sha256: "b".repeat(64),
        recovery_evidence_sha256: "c".repeat(64),
        cleanup_evidence_sha256: "d".repeat(64),
        recovery_observed: true as const,
        cleanup_observed: true as const,
        recovery_oracle: `observed_${fault}`,
      }),
    ]),
  ) as Record<
    C5ControlledFailure,
    () => Promise<{
      fault: C5ControlledFailure;
      injector: "command";
      injection_evidence_sha256: string;
      recovery_evidence_sha256: string;
      cleanup_evidence_sha256: string;
      recovery_observed: true;
      cleanup_observed: true;
      recovery_oracle: string;
    }>
  >;
}

describe("C5 integrated workload receipt", () => {
  it("requires every C1-C4 operation and controlled-failure oracle in a sanitised exact-SHA receipt", async () => {
    const lifecycle: string[] = [];
    const operationExecutors = executors();
    const receipt = await executeC5IntegratedWorkload(
      {
        sourceSha,
        plan,
        operationTimeoutMs: 1_000,
        operationResources: Object.fromEntries(
          C5_WORKLOAD_OPERATIONS.map((operation) => [
            operation,
            async () => {
              lifecycle.push(`open:${operation}`);
              return {
                executor: operationExecutors[operation],
                close: async () => {
                  lifecycle.push(`close:${operation}`);
                },
              };
            },
          ]),
        ) as Record<C5WorkloadOperation, () => Promise<C5WorkloadResource>>,
        controlledFailureHooks: hooks(),
        postgresqlIdentifier: "test_c5_aggregate_1",
        redisNamespace: "matchday:test:gate-c-c5:aggregate-1:",
      },
      virtualTiming(),
    );

    expect(receipt.source_sha).toBe(sourceSha);
    expect(Object.keys(receipt.operations).sort()).toEqual([...C5_WORKLOAD_OPERATIONS].sort());
    expect(receipt.controlled_failures).toHaveLength(C5_CONTROLLED_FAILURES.length);
    expect(lifecycle).toEqual(
      C5_WORKLOAD_OPERATIONS.flatMap((operation) => [`open:${operation}`, `close:${operation}`]),
    );
    expect(JSON.stringify(receipt)).not.toContain("test_c5_aggregate_1");
    expect(validateC5IntegratedWorkloadReceipt(receipt, { sourceSha, plan })).toEqual(receipt);
    expect(receipt.operations.public_result_convergence.summary.sampleCount).toBe(300);
    expect(receipt.operations.public_current_conditional_read.summary.sampleCount).toBe(
      C5_MAXIMUM_SAMPLES_PER_OPERATION.public_current_conditional_read,
    );
    for (const operation of C5_WORKLOAD_OPERATIONS) {
      expect(receipt.operations[operation].elapsedMs).toBeGreaterThanOrEqual(3_600_000);
      expect(receipt.operations[operation].sourceSha).toBe(sourceSha);
    }
  }, 30_000);

  it("fails closed when a controlled failure is omitted or an operation has an unexpected error", async () => {
    const receipt = await executeC5IntegratedWorkload(
      {
        sourceSha,
        plan,
        operationTimeoutMs: 1_000,
        executors: executors(),
        controlledFailureHooks: hooks(),
        postgresqlIdentifier: "test_c5_aggregate_2",
        redisNamespace: "matchday:test:gate-c-c5:aggregate-2:",
      },
      virtualTiming(),
    );
    expect(() =>
      validateC5IntegratedWorkloadReceipt(
        { ...receipt, controlled_failures: receipt.controlled_failures.slice(1) },
        { sourceSha, plan },
      ),
    ).toThrow("controlled-failure evidence");
    expect(() =>
      validateC5IntegratedWorkloadReceipt(
        {
          ...receipt,
          operations: {
            ...receipt.operations,
            lease_takeover: {
              ...receipt.operations.lease_takeover,
              correctness: { passed: false, failureCode: "stale_writer_accepted" },
            },
          },
        },
        { sourceSha, plan },
      ),
    ).toThrow("lease_takeover");
    expect(() =>
      validateC5IntegratedWorkloadReceipt(
        { ...receipt, database_url: "postgres://secret@host/db" },
        { sourceSha, plan },
      ),
    ).toThrow("unsupported fields");
    expect(() =>
      validateC5IntegratedWorkloadReceipt(
        {
          ...receipt,
          operations: {
            ...receipt.operations,
            public_current_conditional_read: {
              ...receipt.operations.public_current_conditional_read,
              summary: {
                ...receipt.operations.public_current_conditional_read.summary,
                successfulCount: 999,
                p95Ms: 9_999,
              },
            },
          },
        },
        { sourceSha, plan },
      ),
    ).toThrow("public_current_conditional_read");
  }, 30_000);

  it("requires every configured worker to contribute a sample and retains only stable fault-oracle codes", async () => {
    expect(() => createC5ApprovedPilotWorkloadPlan({ ...profile, scorekeeperCount: 11 })).toThrow(
      "approved pilot profile",
    );
    expect(() => createC5ApprovedPilotWorkloadPlan({ ...profile, unapproved: "x" } as typeof profile)).toThrow(
      "unsupported profile fields",
    );
    expect(() =>
      validateC5IntegratedWorkloadReceipt(
        {
          artifact_kind: "gate-c-c5-integrated-workload-receipt",
        },
        {
          sourceSha,
          plan: { ...plan, maximumSamplesPerWorkerPerSecond: 2 },
        },
      ),
    ).toThrow("at most one sample");
  });
});
