import { describe, expect, it } from "vitest";
import {
  C5_CONTROLLED_FAILURES,
  executeC5IntegratedWorkload,
  validateC5IntegratedWorkloadReceipt,
  type C5ControlledFailure,
} from "./c5-integrated-workload.js";
import { C5_WORKLOAD_OPERATIONS, type C5WorkloadOperation } from "./workload-profile.js";
import type { C5WorkloadExecutor } from "./workload-runner.js";

const sourceSha = "a".repeat(40);
const profile = {
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
} as const;
const plan = { profile, minimumSamplesPerOperation: 10 } as const;

function executors() {
  const result = {} as Record<C5WorkloadOperation, C5WorkloadExecutor>;
  for (const operation of C5_WORKLOAD_OPERATIONS) {
    result[operation] = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    const receipt = await executeC5IntegratedWorkload({
      sourceSha,
      plan,
      maximumSamples: 10,
      operationTimeoutMs: 1_000,
      executors: executors(),
      controlledFailureHooks: hooks(),
      postgresqlIdentifier: "test_c5_aggregate_1",
      redisNamespace: "matchday:test:gate-c-c5:aggregate-1:",
    });

    expect(receipt.source_sha).toBe(sourceSha);
    expect(Object.keys(receipt.operations).sort()).toEqual([...C5_WORKLOAD_OPERATIONS].sort());
    expect(receipt.controlled_failures).toHaveLength(C5_CONTROLLED_FAILURES.length);
    expect(JSON.stringify(receipt)).not.toContain("test_c5_aggregate_1");
    expect(validateC5IntegratedWorkloadReceipt(receipt, { sourceSha, plan })).toEqual(receipt);
  }, 15_000);

  it("fails closed when a controlled failure is omitted or an operation has an unexpected error", async () => {
    const receipt = await executeC5IntegratedWorkload({
      sourceSha,
      plan,
      maximumSamples: 10,
      operationTimeoutMs: 1_000,
      executors: executors(),
      controlledFailureHooks: hooks(),
      postgresqlIdentifier: "test_c5_aggregate_2",
      redisNamespace: "matchday:test:gate-c-c5:aggregate-2:",
    });
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
    await expect(
      executeC5IntegratedWorkload({
        sourceSha,
        plan,
        maximumSamples: 1,
        operationTimeoutMs: 1_000,
        executors: executors(),
        controlledFailureHooks: hooks(),
        postgresqlIdentifier: "test_c5_aggregate_3",
        redisNamespace: "matchday:test:gate-c-c5:aggregate-3:",
      }),
    ).rejects.toThrow("below the approved minimum");
  }, 15_000);

  it("requires every configured worker to contribute a sample and retains only stable fault-oracle codes", async () => {
    const highWorkerPlan = {
      profile: { ...profile, scorekeeperCount: 11 },
      minimumSamplesPerOperation: 10,
    } as const;
    await expect(
      executeC5IntegratedWorkload({
        sourceSha,
        plan: highWorkerPlan,
        maximumSamples: 11,
        operationTimeoutMs: 1_000,
        executors: executors(),
        controlledFailureHooks: hooks(),
        postgresqlIdentifier: "test_c5_aggregate_4",
        redisNamespace: "matchday:test:gate-c-c5:aggregate-4:",
      }),
    ).rejects.toThrow("every configured worker");

    const receipt = await executeC5IntegratedWorkload({
      sourceSha,
      plan,
      maximumSamples: 10,
      operationTimeoutMs: 1_000,
      executors: executors(),
      controlledFailureHooks: hooks(),
      postgresqlIdentifier: "test_c5_aggregate_5",
      redisNamespace: "matchday:test:gate-c-c5:aggregate-5:",
    });
    expect(() =>
      validateC5IntegratedWorkloadReceipt(
        {
          ...receipt,
          controlled_failures: receipt.controlled_failures.map((fault) =>
            fault.fault === "api_interruption" ? { ...fault, recovery_oracle: "user@example.com" } : fault,
          ),
        },
        { sourceSha, plan },
      ),
    ).toThrow("unsafe recovery oracle");
  }, 20_000);
});
