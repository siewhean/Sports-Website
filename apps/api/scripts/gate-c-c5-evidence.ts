import { createHash } from "node:crypto";
import {
  validateC5IntegratedWorkloadReceipt,
  type C5ApprovedWorkloadPlan,
  type C5IntegratedWorkloadReceipt,
} from "@matchday/observability";

/**
 * C5 has one workload-evidence authority. Keep this API-script boundary so
 * callers retain their existing import path, but delegate all validation to
 * the strict integrated receipt contract in @matchday/observability.
 */
export type GateCC5Receipt = C5IntegratedWorkloadReceipt;

export function validateGateCC5Receipt(
  value: unknown,
  expected: Readonly<{ sourceSha: string; plan: C5ApprovedWorkloadPlan }>,
): GateCC5Receipt {
  return validateC5IntegratedWorkloadReceipt(value, expected);
}

export function c5ReceiptHash(receipt: GateCC5Receipt): string {
  return createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
}
