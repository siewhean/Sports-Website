import { describe, expect, it } from "vitest";
import { c5ReceiptHash, validateGateCC5Receipt } from "../../scripts/gate-c-c5-evidence.js";

const source = "a".repeat(40);
const receipt = {
  artifact_kind: "gate-c-c5-workload-receipt" as const,
  source_sha: source,
  profile_id: "pilot-score-writes",
  approval_reference: "OPS-42",
  operation: "score_event_acknowledgement",
  sample_count: 10,
  timeout_count: 0,
  p50_ms: 10,
  p95_ms: 20,
  p99_ms: 30,
  unexpected_error_count: 0,
  correctness_passed: true,
  postgresql_identifier_sha256: "b".repeat(64),
  redis_namespace_sha256: "c".repeat(64),
};
describe("C5 evidence receipt", () => {
  it("accepts only exact-SHA isolated all-pass receipts", () => {
    expect(validateGateCC5Receipt(receipt, source)).toEqual(receipt);
    expect(c5ReceiptHash(receipt)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("fails closed for timeout, correctness, and source failures", () => {
    expect(() => validateGateCC5Receipt({ ...receipt, timeout_count: 1 }, source)).toThrow("fail-closed");
    expect(() => validateGateCC5Receipt({ ...receipt, source_sha: "b".repeat(40) }, source)).toThrow(
      "exact source SHA",
    );
  });
});
