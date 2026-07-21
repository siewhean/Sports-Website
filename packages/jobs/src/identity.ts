import { createHash } from "node:crypto";

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export function assertIdempotencyKey(key: string): void {
  if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(`idempotencyKey must contain between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
}

export function createDeterministicJobId(jobName: string, idempotencyKey: string): string {
  assertIdempotencyKey(idempotencyKey);
  const digest = createHash("sha256").update(jobName).update("\0").update(idempotencyKey).digest("hex");

  // BullMQ custom IDs cannot contain a colon. The name is hashed as well so the
  // identifier remains safe when registries use namespaced job names.
  return `job-${digest}`;
}
