import { createHash } from "node:crypto";
import { expect } from "vitest";
import { ErrorCode, type ApiErrorCode } from "@matchday/contracts";

export function computeSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isValidSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function isValidGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function assertValidErrorCode(code: string): asserts code is ApiErrorCode {
  expect(Object.values(ErrorCode)).toContain(code);
}

export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}
