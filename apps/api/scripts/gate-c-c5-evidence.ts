import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/u;

export type GateCC5Receipt = Readonly<{
  artifact_kind: "gate-c-c5-workload-receipt";
  source_sha: string;
  profile_id: string;
  approval_reference: string;
  operation: string;
  sample_count: number;
  timeout_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  unexpected_error_count: number;
  correctness_passed: boolean;
  postgresql_identifier_sha256: string;
  redis_namespace_sha256: string;
}>;

function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256`);
}

export function validateGateCC5Receipt(value: unknown, sourceSha: string): GateCC5Receipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("C5 workload receipt must be an object");
  const receipt = value as Partial<GateCC5Receipt>;
  if (receipt.artifact_kind !== "gate-c-c5-workload-receipt" || receipt.source_sha !== sourceSha) {
    throw new Error("C5 workload receipt is not bound to the exact source SHA");
  }
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(receipt.profile_id ?? "") || !receipt.approval_reference?.trim()) {
    throw new Error("C5 workload receipt has no approved profile");
  }
  if (
    !receipt.operation?.trim() ||
    receipt.sample_count === undefined ||
    receipt.sample_count < 1 ||
    receipt.timeout_count === undefined ||
    receipt.timeout_count < 0
  ) {
    throw new Error("C5 workload receipt has invalid workload counts");
  }
  for (const value of [receipt.p50_ms, receipt.p95_ms, receipt.p99_ms]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("C5 workload receipt has invalid latency");
    }
  }
  if (receipt.unexpected_error_count !== 0 || receipt.timeout_count !== 0 || receipt.correctness_passed !== true) {
    throw new Error("C5 workload receipt does not satisfy the fail-closed correctness gate");
  }
  hash(receipt.postgresql_identifier_sha256, "C5 PostgreSQL isolation");
  hash(receipt.redis_namespace_sha256, "C5 Redis isolation");
  return receipt as GateCC5Receipt;
}

export function c5ReceiptHash(receipt: GateCC5Receipt): string {
  return createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
}
