import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime } from "../../src/index.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitUntil timed out after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Outbox and Public Projection Worker Crash Safety", () => {
  const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14";

  it("safely retries and completes public projection purge after worker crash simulation", async () => {
    let executionAttempts = 0;
    const handled = vi.fn(async () => {
      executionAttempts += 1;
      if (executionAttempts === 1) {
        // Simulate worker crash / uncaught exception before job ack
        throw new Error("Simulated worker process crash");
      }
      return { purgedAt: new Date().toISOString() };
    });

    const queueName = `matchday-crash-safety-${randomUUID()}`;
    const runtime = new WorkerRuntime({
      queueName,
      redisUrl,
      concurrency: 1,
      queueDefaults: {
        defaultAttempts: 3,
        defaultBackoff: { type: "fixed", delay: 50 },
      },
      handleEdgePurge: handled,
    });

    const payload = {
      competitionId: randomUUID(),
      projection: "results" as const,
      publicationState: "published" as const,
      previousPublishedVersion: 1,
      publishedVersion: 2,
      correlationId: `corr-${randomUUID()}`,
    };

    await runtime.start();
    await runtime.enqueueEdgePurge(payload);

    await waitUntil(() => handled.mock.calls.length === 2);

    expect(handled).toHaveBeenCalledTimes(2);
    expect(executionAttempts).toBe(2);

    await runtime.stop();
  });

  it("preserves idempotent single purge execution on duplicate enqueues", async () => {
    const handled = vi.fn(async () => ({ purgedAt: new Date().toISOString() }));
    const queueName = `matchday-idempotency-${randomUUID()}`;
    const runtime = new WorkerRuntime({
      queueName,
      redisUrl,
      concurrency: 1,
      handleEdgePurge: handled,
    });

    const payload = {
      competitionId: randomUUID(),
      projection: "results" as const,
      publicationState: "published" as const,
      previousPublishedVersion: 2,
      publishedVersion: 3,
      correlationId: `corr-${randomUUID()}`,
    };

    await runtime.start();

    // Enqueue duplicate requests with same payload (computes same deterministic idempotency key)
    await Promise.all([
      runtime.enqueueEdgePurge(payload),
      runtime.enqueueEdgePurge(payload),
      runtime.enqueueEdgePurge(payload),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Only one execution should have occurred
    expect(handled).toHaveBeenCalledOnce();

    await runtime.stop();
  });
});
