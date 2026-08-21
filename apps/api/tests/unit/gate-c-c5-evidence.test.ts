import { createHash } from "node:crypto";
import type { C5ControlledFailure, C5WorkloadOperation } from "@matchday/observability";
import { describe, expect, it } from "vitest";
import { c5ReceiptHash, validateGateCC5Receipt } from "../../scripts/gate-c-c5-evidence.js";

const sourceSha = "a".repeat(40);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const plan = {
  profile: {
    profileId: "pilot-score-writes",
    durationSeconds: 1,
    scorekeeperCount: 1,
    publicReaderCount: 1,
    organiserWorkerCount: 1,
    approval: {
      owner: "platform-ops",
      approvedAtUtc: "2026-08-04T00:00:00.000Z",
      reference: "OPS-42",
    },
  },
  minimumSamplesPerOperation: 10,
} as const;

const operation = (name: C5WorkloadOperation, p95Ms: number) => ({
  operation: name,
  workerCount: 1,
  timeoutCount: 0,
  summary: {
    sampleCount: 10,
    successfulCount: 10,
    expectedFailureCount: 0,
    unexpectedFailureCount: 0,
    errorRate: 0,
    p50Ms: 10,
    p95Ms,
    p99Ms: p95Ms,
    maxMs: p95Ms,
  },
  correctness: { passed: true },
});

const receipt = {
  artifact_kind: "gate-c-c5-integrated-workload-receipt" as const,
  source_sha: sourceSha,
  profile_id: plan.profile.profileId,
  approval_reference_sha256: hash(plan.profile.approval.reference),
  workload_plan_sha256: hash(stableJson(plan)),
  minimum_samples_per_operation: 10,
  duration_ms: 5_000,
  operations: {
    score_event_acknowledgement: operation("score_event_acknowledgement", 500),
    public_result_convergence: operation("public_result_convergence", 2_000),
    public_current_conditional_read: operation("public_current_conditional_read", 500),
    lease_takeover: operation("lease_takeover", 2_000),
    repair_publication: operation("repair_publication", 2_000),
  },
  controlled_failures: (
    [
      "postgres_interruption",
      "redis_interruption",
      "api_interruption",
      "web_interruption",
      "worker_interruption",
      "latency",
      "connection_pressure",
      "outbox_delay",
      "disk_pressure",
      "pdf_failure",
      "backup_restore",
      "projection_regeneration",
    ] as const satisfies readonly C5ControlledFailure[]
  ).map((fault) => ({
    fault,
    injector: "command" as const,
    injection_evidence_sha256: "d".repeat(64),
    recovery_evidence_sha256: "e".repeat(64),
    cleanup_evidence_sha256: "f".repeat(64),
    recovery_observed: true as const,
    cleanup_observed: true as const,
    recovery_oracle: `recovered_${fault}`,
  })),
  postgresql_identifier_sha256: "1".repeat(64),
  redis_namespace_sha256: "2".repeat(64),
};

describe("C5 evidence receipt", () => {
  it("delegates to the one exact-SHA integrated receipt authority", () => {
    expect(validateGateCC5Receipt(receipt, { sourceSha, plan })).toEqual(receipt);
    expect(c5ReceiptHash(receipt)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an obsolete partial receipt rather than creating a second authority", () => {
    expect(() =>
      validateGateCC5Receipt(
        {
          artifact_kind: "gate-c-c5-workload-receipt",
          source_sha: sourceSha,
          operation: "score_event_acknowledgement",
        },
        { sourceSha, plan },
      ),
    ).toThrow("unsupported fields");
  });
});
