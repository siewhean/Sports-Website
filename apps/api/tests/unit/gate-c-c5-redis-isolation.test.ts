import { describe, expect, it } from "vitest";

import { createGateCC5RedisOwnership } from "../../scripts/gate-c-c5-redis-isolation.js";

describe("C5 Redis ownership contract", () => {
  it("owns only the exact Bull, dead-letter, cancellation, and rate-limit namespaces", () => {
    const ownership = createGateCC5RedisOwnership(
      "matchday-c5-queue-a",
      "matchday-c5-queue-a",
      "matchday:test:gate-c-c5:run-a:",
    );
    expect(ownership.ownedPatterns).toEqual([
      "matchday-c5-queue-a:matchday-c5-queue-a:*",
      "matchday-c5-queue-a:matchday-c5-queue-a.dead-letter:*",
      "matchday:job-cancellation:matchday-c5-queue-a:matchday-c5-queue-a:*",
      "matchday:test:gate-c-c5:run-a:*",
    ]);
    expect(ownership.unrelatedGuardKey).toBe("matchday-c5-queue-a:matchday-c5-queue-a-foreign:ttl-sentinel");
  });

  it.each([
    ["bull", "matchday-c5-queue-a", "matchday:test:gate-c-c5:run-a:"],
    ["matchday-c5-queue-a", "foundation", "matchday:test:gate-c-c5:run-a:"],
    ["matchday-c5-queue-a", "matchday-c5-queue-a", "matchday:test:scoring-access:run-a:"],
  ])("rejects non-owned C5 namespace input", (prefix, queue, namespace) => {
    expect(() => createGateCC5RedisOwnership(prefix, queue, namespace)).toThrow(/owned/);
  });
});
