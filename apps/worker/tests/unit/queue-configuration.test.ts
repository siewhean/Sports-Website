import { describe, expect, it } from "vitest";

import { resolveWorkerQueuePrefix } from "../../src/queue-configuration.js";

describe("worker queue configuration", () => {
  it("uses BullMQ's default namespace when no isolated prefix is configured", () => {
    expect(resolveWorkerQueuePrefix({})).toBeUndefined();
    expect(resolveWorkerQueuePrefix({ MATCHDAY_WORKER_QUEUE_PREFIX: "  " })).toBeUndefined();
  });

  it("accepts a bounded C5-owned queue prefix", () => {
    expect(resolveWorkerQueuePrefix({ MATCHDAY_WORKER_QUEUE_PREFIX: "matchday-c5-abc123" })).toBe("matchday-c5-abc123");
  });

  it.each(["c5", "Matchday-c5", "matchday:c5", "matchday_c5", "matchday-c5-"])(
    "rejects an unsafe queue prefix: %s",
    (prefix) => {
      expect(() => resolveWorkerQueuePrefix({ MATCHDAY_WORKER_QUEUE_PREFIX: prefix })).toThrow(
        "MATCHDAY_WORKER_QUEUE_PREFIX",
      );
    },
  );
});
