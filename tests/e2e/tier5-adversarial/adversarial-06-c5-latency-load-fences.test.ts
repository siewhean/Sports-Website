import { describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  summarizeWorkload,
  assertWorkloadBudget,
  assertC5WorkloadProfile,
  assertC5OperationBudget,
  validateC5IntegratedWorkloadReceipt,
  executeC5IntegratedWorkload,
  C5_WORKLOAD_OPERATIONS,
  C5_CONTROLLED_FAILURES,
  C5_FAULT_INJECTORS,
  type C5WorkloadOperation,
  type C5ControlledFailure,
  type C5WorkloadProfile,
  type C5ApprovedWorkloadPlan,
  type C5IntegratedWorkloadExecution,
  type C5ControlledFailureReceipt,
  type WorkloadSample,
} from "@matchday/observability";
import { TEST_CANDIDATE_SHA } from "../helpers/fixtures";

function sha256(val: string): string {
  return createHash("sha256").update(val, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("C5 integrated workload plan has an unsupported value");
  return encoded;
}

describe("Tier 5 Adversarial - Subsystem 6: C5 Latency & Load Fences Hardening", () => {
  describe("1. Workload Latency Budgets & Percentile Fences", () => {
    it("ADV-C5-01: nearest-rank latency summarizer correctly orders p50 <= p95 <= p99 <= max under large volume", () => {
      const sampleCount = 5_000;
      const samples: WorkloadSample[] = [];

      for (let i = 1; i <= sampleCount; i++) {
        // Generate skewed latency distribution (mostly 10-50ms with occasional tail latency up to 400ms)
        const durationMs = i % 100 === 0 ? 300 + (i % 100) : 10 + (i % 40);
        samples.push({
          durationMs,
          outcome: "success",
        });
      }

      const summary = summarizeWorkload(samples);
      expect(summary.sampleCount).toBe(5_000);
      expect(summary.successfulCount).toBe(5_000);
      expect(summary.expectedFailureCount).toBe(0);
      expect(summary.unexpectedFailureCount).toBe(0);
      expect(summary.errorRate).toBe(0);

      // Strict percentile ordering
      expect(summary.p50Ms).toBeLessThanOrEqual(summary.p95Ms);
      expect(summary.p95Ms).toBeLessThanOrEqual(summary.p99Ms);
      expect(summary.p99Ms).toBeLessThanOrEqual(summary.maxMs);
      expect(summary.p95Ms).toBeLessThan(100);
    });

    it("ADV-C5-02: rejects invalid sample durations (negative, non-finite)", () => {
      expect(() => summarizeWorkload([{ durationMs: -5, outcome: "success" }])).toThrow(
        "Workload sample duration must be a finite non-negative number",
      );
      expect(() => summarizeWorkload([{ durationMs: NaN, outcome: "success" }])).toThrow(
        "Workload sample duration must be a finite non-negative number",
      );
      expect(() => summarizeWorkload([{ durationMs: Infinity, outcome: "success" }])).toThrow(
        "Workload sample duration must be a finite non-negative number",
      );
      expect(() => summarizeWorkload([])).toThrow("Workload summary requires at least one sample");
    });

    it("ADV-C5-03: assertWorkloadBudget strictly blocks p95 latency budget violations", () => {
      const failingAckSummary = {
        sampleCount: 1000,
        successfulCount: 1000,
        expectedFailureCount: 0,
        unexpectedFailureCount: 0,
        errorRate: 0,
        p50Ms: 200,
        p95Ms: 505, // Exceeds 500ms budget!
        p99Ms: 600,
        maxMs: 700,
      };

      expect(() => assertC5OperationBudget("score_event_acknowledgement", failingAckSummary, { passed: true })).toThrow(
        "Workload p95 505ms exceeds 500ms budget",
      );

      const failingConvergenceSummary = {
        sampleCount: 1000,
        successfulCount: 1000,
        expectedFailureCount: 0,
        unexpectedFailureCount: 0,
        errorRate: 0,
        p50Ms: 1500,
        p95Ms: 2050, // Exceeds 2000ms budget!
        p99Ms: 2200,
        maxMs: 2500,
      };

      expect(() =>
        assertC5OperationBudget("public_result_convergence", failingConvergenceSummary, { passed: true }),
      ).toThrow("Workload p95 2050ms exceeds 2000ms budget");
    });

    it("ADV-C5-04: assertWorkloadBudget strictly blocks any unexpected failure rate (> 0)", () => {
      const summaryWithOneFailure = {
        sampleCount: 1000,
        successfulCount: 999,
        expectedFailureCount: 0,
        unexpectedFailureCount: 1, // 1 error in 1000 samples (0.1%)
        errorRate: 0.001,
        p50Ms: 50,
        p95Ms: 100,
        p99Ms: 150,
        maxMs: 200,
      };

      expect(() =>
        assertC5OperationBudget("score_event_acknowledgement", summaryWithOneFailure, { passed: true }),
      ).toThrow("Workload unexpected error rate 0.001 exceeds 0 budget");
    });

    it("ADV-C5-05: assertC5OperationBudget propagates correctness oracle failures", () => {
      const passingLatencySummary = {
        sampleCount: 1000,
        successfulCount: 1000,
        expectedFailureCount: 0,
        unexpectedFailureCount: 0,
        errorRate: 0,
        p50Ms: 50,
        p95Ms: 100,
        p99Ms: 150,
        maxMs: 200,
      };

      expect(() =>
        assertC5OperationBudget("lease_takeover", passingLatencySummary, {
          passed: false,
          failureCode: "LEASE_TAKEOVER_FENCE_FAILED",
        }),
      ).toThrow("C5 lease_takeover correctness oracle failed: LEASE_TAKEOVER_FENCE_FAILED");
    });
  });

  describe("2. Workload Profile & Approval Validation Fences", () => {
    const validProfile: C5WorkloadProfile = {
      profileId: "c5-pilot-standard",
      durationSeconds: 60,
      scorekeeperCount: 10,
      publicReaderCount: 50,
      organiserWorkerCount: 5,
      approval: {
        owner: "platform-certifier",
        approvedAtUtc: "2026-08-20T00:00:00.000Z",
        reference: "C5-CERT-REF-2026-08-20-001",
      },
    };

    it("ADV-C5-06: validates valid C5 workload profile", () => {
      expect(() => assertC5WorkloadProfile(validProfile)).not.toThrow();
    });

    it("ADV-C5-07: rejects invalid profile IDs (uppercase, special characters, too short)", () => {
      expect(() => assertC5WorkloadProfile({ ...validProfile, profileId: "INVALID_PROFILE" })).toThrow(
        "C5 profileId is invalid",
      );
      expect(() => assertC5WorkloadProfile({ ...validProfile, profileId: "c5" })).toThrow("C5 profileId is invalid");
      expect(() => assertC5WorkloadProfile({ ...validProfile, profileId: "c5$profile" })).toThrow(
        "C5 profileId is invalid",
      );
    });

    it("ADV-C5-08: rejects out-of-range worker counts or duration", () => {
      expect(() => assertC5WorkloadProfile({ ...validProfile, durationSeconds: 0 })).toThrow(
        "C5 durationSeconds must be an integer from 1 to 86400",
      );
      expect(() => assertC5WorkloadProfile({ ...validProfile, scorekeeperCount: 0 })).toThrow(
        "C5 scorekeeperCount must be an integer from 1 to 10000",
      );
      expect(() => assertC5WorkloadProfile({ ...validProfile, publicReaderCount: 15_000 })).toThrow(
        "C5 publicReaderCount must be an integer from 1 to 10000",
      );
    });

    it("ADV-C5-09: rejects non-canonical ISO UTC approval timestamps", () => {
      expect(() =>
        assertC5WorkloadProfile({
          ...validProfile,
          approval: { ...validProfile.approval, approvedAtUtc: "2026-08-20 00:00:00" }, // Missing T and Z
        }),
      ).toThrow("C5 approval timestamp must be an ISO UTC timestamp");

      expect(() =>
        assertC5WorkloadProfile({
          ...validProfile,
          approval: { ...validProfile.approval, approvedAtUtc: "invalid-date" },
        }),
      ).toThrow("C5 approval timestamp must be an ISO UTC timestamp");
    });
  });

  describe("3. C5 Integrated Workload Receipt Validation & Tamper Fencing", () => {
    const validPlan: C5ApprovedWorkloadPlan = {
      profile: {
        profileId: "c5-pilot-standard",
        durationSeconds: 1,
        scorekeeperCount: 5,
        publicReaderCount: 10,
        organiserWorkerCount: 2,
        approval: {
          owner: "platform-certifier",
          approvedAtUtc: "2026-08-20T00:00:00.000Z",
          reference: "C5-CERT-REF-2026-08-20-001",
        },
      },
      minimumSamplesPerOperation: 50,
    };

    function createValidWorkloadReceipt(operation: C5WorkloadOperation, workerCount: number, p95Ms: number = 50) {
      return {
        operation,
        workerCount,
        timeoutCount: 0,
        summary: {
          sampleCount: 50,
          successfulCount: 50,
          expectedFailureCount: 0,
          unexpectedFailureCount: 0,
          errorRate: 0,
          p50Ms: 20,
          p95Ms,
          p99Ms: p95Ms + 10,
          maxMs: p95Ms + 20,
        },
        correctness: { passed: true },
      };
    }

    function createValidControlledFailureReceipts(): C5ControlledFailureReceipt[] {
      return C5_CONTROLLED_FAILURES.map((fault) => ({
        fault,
        injector: "command",
        injection_evidence_sha256: sha256(`injection-${fault}`),
        recovery_evidence_sha256: sha256(`recovery-${fault}`),
        cleanup_evidence_sha256: sha256(`cleanup-${fault}`),
        recovery_observed: true,
        cleanup_observed: true,
        recovery_oracle: `recovery_oracle_${fault}`,
      }));
    }

    it("ADV-C5-10: rejects receipt when source SHA does not match candidate SHA", () => {
      const receipt = {
        artifact_kind: "gate-c-c5-integrated-workload-receipt",
        source_sha: "0000000000000000000000000000000000000000", // Mismatched SHA
        profile_id: validPlan.profile.profileId,
        approval_reference_sha256: sha256(validPlan.profile.approval.reference),
        workload_plan_sha256: sha256(stableJson(validPlan)),
        minimum_samples_per_operation: validPlan.minimumSamplesPerOperation,
        duration_ms: 6_000,
        operations: {
          score_event_acknowledgement: createValidWorkloadReceipt("score_event_acknowledgement", 5),
          public_result_convergence: createValidWorkloadReceipt("public_result_convergence", 10),
          public_current_conditional_read: createValidWorkloadReceipt("public_current_conditional_read", 10),
          lease_takeover: createValidWorkloadReceipt("lease_takeover", 5),
          repair_publication: createValidWorkloadReceipt("repair_publication", 2),
        },
        controlled_failures: createValidControlledFailureReceipts(),
        postgresql_identifier_sha256: sha256("postgres-c5-test"),
        redis_namespace_sha256: sha256("redis-c5-test"),
      };

      expect(() =>
        validateC5IntegratedWorkloadReceipt(receipt, {
          sourceSha: TEST_CANDIDATE_SHA,
          plan: validPlan,
        }),
      ).toThrow("C5 integrated workload receipt is not bound to the exact source SHA");
    });

    it("ADV-C5-11: rejects receipt missing any of the 12 controlled failure hook proofs", () => {
      const incompleteFailures = createValidControlledFailureReceipts().slice(0, 11); // Missing 1 fault proof!

      const receipt = {
        artifact_kind: "gate-c-c5-integrated-workload-receipt",
        source_sha: TEST_CANDIDATE_SHA,
        profile_id: validPlan.profile.profileId,
        approval_reference_sha256: sha256(validPlan.profile.approval.reference),
        workload_plan_sha256: sha256(stableJson(validPlan)),
        minimum_samples_per_operation: validPlan.minimumSamplesPerOperation,
        duration_ms: 6_000,
        operations: {
          score_event_acknowledgement: createValidWorkloadReceipt("score_event_acknowledgement", 5),
          public_result_convergence: createValidWorkloadReceipt("public_result_convergence", 10),
          public_current_conditional_read: createValidWorkloadReceipt("public_current_conditional_read", 10),
          lease_takeover: createValidWorkloadReceipt("lease_takeover", 5),
          repair_publication: createValidWorkloadReceipt("repair_publication", 2),
        },
        controlled_failures: incompleteFailures,
        postgresql_identifier_sha256: sha256("postgres-c5-test"),
        redis_namespace_sha256: sha256("redis-c5-test"),
      };

      expect(() =>
        validateC5IntegratedWorkloadReceipt(receipt, {
          sourceSha: TEST_CANDIDATE_SHA,
          plan: validPlan,
        }),
      ).toThrow("C5 integrated workload receipt is missing controlled-failure evidence");
    });

    it("ADV-C5-12: rejects receipt with unsafe or malformed recovery oracle", () => {
      const badFailures = createValidControlledFailureReceipts();
      // Unsafe oracle containing illegal characters
      (badFailures[0] as any).recovery_oracle = "INVALID!ORACLE#NAME";

      const receipt = {
        artifact_kind: "gate-c-c5-integrated-workload-receipt",
        source_sha: TEST_CANDIDATE_SHA,
        profile_id: validPlan.profile.profileId,
        approval_reference_sha256: sha256(validPlan.profile.approval.reference),
        workload_plan_sha256: sha256(stableJson(validPlan)),
        minimum_samples_per_operation: validPlan.minimumSamplesPerOperation,
        duration_ms: 6_000,
        operations: {
          score_event_acknowledgement: createValidWorkloadReceipt("score_event_acknowledgement", 5),
          public_result_convergence: createValidWorkloadReceipt("public_result_convergence", 10),
          public_current_conditional_read: createValidWorkloadReceipt("public_current_conditional_read", 10),
          lease_takeover: createValidWorkloadReceipt("lease_takeover", 5),
          repair_publication: createValidWorkloadReceipt("repair_publication", 2),
        },
        controlled_failures: badFailures,
        postgresql_identifier_sha256: sha256("postgres-c5-test"),
        redis_namespace_sha256: sha256("redis-c5-test"),
      };

      expect(() =>
        validateC5IntegratedWorkloadReceipt(receipt, {
          sourceSha: TEST_CANDIDATE_SHA,
          plan: validPlan,
        }),
      ).toThrow("has an unsafe recovery oracle");
    });
  });

  describe("4. End-to-End High-Concurrency Workload Execution", () => {
    it("ADV-C5-13: executes sustained workload across 5 operations and 12 failure hooks", async () => {
      const plan: C5ApprovedWorkloadPlan = {
        profile: {
          profileId: "c5-adversarial-burst",
          durationSeconds: 1,
          scorekeeperCount: 2,
          publicReaderCount: 4,
          organiserWorkerCount: 2,
          approval: {
            owner: "adversarial-tester",
            approvedAtUtc: "2026-08-20T00:00:00.000Z",
            reference: "C5-ADV-HARNESS-2026-08-20-001",
          },
        },
        minimumSamplesPerOperation: 10,
      };

      // Mock executors generating realistic successful latency samples
      const mockExecutors: Record<C5WorkloadOperation, any> = {
        score_event_acknowledgement: async () => ({
          outcome: "success" as const,
          correctness: { passed: true },
        }),
        public_result_convergence: async () => ({
          outcome: "success" as const,
          correctness: { passed: true },
        }),
        public_current_conditional_read: async () => ({
          outcome: "success" as const,
          correctness: { passed: true },
        }),
        lease_takeover: async () => ({
          outcome: "success" as const,
          correctness: { passed: true },
        }),
        repair_publication: async () => ({
          outcome: "success" as const,
          correctness: { passed: true },
        }),
      };

      // Mock controlled failure hooks for all 12 fault types
      const mockHooks: Record<C5ControlledFailure, any> = Object.fromEntries(
        C5_CONTROLLED_FAILURES.map((fault) => [
          fault,
          async (): Promise<C5ControlledFailureReceipt> => ({
            fault,
            injector: "command",
            injection_evidence_sha256: sha256(`drill-inject-${fault}`),
            recovery_evidence_sha256: sha256(`drill-recover-${fault}`),
            cleanup_evidence_sha256: sha256(`drill-cleanup-${fault}`),
            recovery_observed: true,
            cleanup_observed: true,
            recovery_oracle: `oracle_verified_${fault}`,
          }),
        ]),
      ) as Record<C5ControlledFailure, any>;

      // Fake clock advancing by 2ms per sample so sample latency <= 10ms,
      // plus advancing by 1500ms per operation so total duration >= 5000ms
      let simulatedTime = 10000;
      let lastOp = "";
      const clock = () => {
        simulatedTime += 2;
        return simulatedTime;
      };

      // Wrap mock executors to advance operation time cleanly
      const wrappedExecutors: Record<C5WorkloadOperation, any> = Object.fromEntries(
        C5_WORKLOAD_OPERATIONS.map((op) => [
          op,
          async (inv: any) => {
            simulatedTime += 2; // small sample latency
            return mockExecutors[op](inv);
          },
        ]),
      ) as Record<C5WorkloadOperation, any>;

      // Wrap hooks to advance clock between operations
      const wrappedHooks: Record<C5ControlledFailure, any> = Object.fromEntries(
        C5_CONTROLLED_FAILURES.map((fault) => [
          fault,
          async () => {
            simulatedTime += 500; // fault drill duration
            return mockHooks[fault]();
          },
        ]),
      ) as Record<C5ControlledFailure, any>;

      const execution: C5IntegratedWorkloadExecution = {
        sourceSha: TEST_CANDIDATE_SHA,
        plan,
        maximumSamples: 10,
        operationTimeoutMs: 5000,
        executors: wrappedExecutors,
        controlledFailureHooks: wrappedHooks,
        postgresqlIdentifier: "postgres-test-instance-01",
        redisNamespace: "redis-test-namespace-01",
      };

      const receipt = await executeC5IntegratedWorkload(execution, clock);

      expect(receipt.artifact_kind).toBe("gate-c-c5-integrated-workload-receipt");
      expect(receipt.source_sha).toBe(TEST_CANDIDATE_SHA);
      expect(receipt.controlled_failures).toHaveLength(12);

      for (const op of C5_WORKLOAD_OPERATIONS) {
        expect(receipt.operations[op].summary.sampleCount).toBe(10);
        expect(receipt.operations[op].summary.errorRate).toBe(0);
        expect(receipt.operations[op].correctness.passed).toBe(true);
      }
    });
  });
});
