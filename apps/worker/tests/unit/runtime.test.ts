import { describe, expect, it } from "vitest";

import { WorkerRuntime, connectionHealthTransition } from "../../src/index.js";

describe("WorkerRuntime configuration", () => {
  it("rejects non-Redis connection URLs", () => {
    expect(
      () =>
        new WorkerRuntime({
          queueName: "test",
          redisUrl: "https://example.test",
        }),
    ).toThrow("redis:// or rediss://");
  });

  it("rejects enqueue before the worker is ready", async () => {
    const runtime = new WorkerRuntime({
      queueName: "test",
      redisUrl: "redis://127.0.0.1:6379/14",
    });
    await expect(
      runtime.enqueueProbe(
        {
          correlationId: "correlation-1",
          requestedAt: "2026-07-17T00:00:00.000Z",
        },
        "not-ready",
      ),
    ).rejects.toThrow("must be ready");
    await expect(
      runtime.enqueueEdgePurge({
        competitionId: "10000000-0000-4000-a000-000000000001",
        projection: "results",
        publicationState: "published",
        previousPublishedVersion: 1,
        publishedVersion: 2,
        correlationId: "purge-2",
      }),
    ).rejects.toThrow("must be ready");
    await runtime.stop();
  });

  it("does not expose Redis credentials through JSON serialization", () => {
    const runtime = new WorkerRuntime({
      queueName: "credential-regression",
      redisUrl: "rediss://worker:super-secret-password@example.test:6380/4",
    });

    const serialized = JSON.stringify(runtime);
    expect(serialized).not.toContain("super-secret-password");
    expect(serialized).not.toContain("rediss://");
    expect(serialized).not.toContain("worker");
  });

  it("recovers degraded health when BullMQ reconnects", () => {
    expect(connectionHealthTransition("ready", "closed", true)).toBe("degraded");
    expect(connectionHealthTransition("degraded", "ready", true)).toBe("ready");
    expect(connectionHealthTransition("stopping", "closed", true)).toBeUndefined();
  });
});
