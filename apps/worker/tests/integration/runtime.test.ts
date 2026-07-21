import { randomUUID } from "node:crypto";

import { getObservabilityContext } from "@matchday/observability";
import { describe, expect, it, vi } from "vitest";

import { WorkerRuntime, type WorkerMetrics } from "../../src/index.js";

describe("WorkerRuntime with Redis", () => {
  it("deduplicates public projection purges using the prior published version", async () => {
    const handled = vi.fn(async () => ({ purgedAt: "2026-07-17T00:00:00.000Z" }));
    const runtime = new WorkerRuntime({
      queueName: `matchday-edge-purge-test-${randomUUID()}`,
      redisUrl: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14",
      concurrency: 1,
      handleEdgePurge: handled,
    });
    const payload = {
      competitionId: "10000000-0000-4000-a000-000000000001",
      projection: "results" as const,
      publicationState: "published" as const,
      previousPublishedVersion: 4,
      publishedVersion: 5,
      correlationId: "publish-request-5",
    };

    await runtime.start();
    const first = await runtime.enqueueEdgePurge(payload);
    const duplicate = await runtime.enqueueEdgePurge({ ...payload, publishedVersion: 6 });
    await waitUntil(() => handled.mock.calls.length === 1);

    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(handled).toHaveBeenCalledOnce();
    expect(handled).toHaveBeenCalledWith(payload, expect.objectContaining({ jobId: first.id }));
    await runtime.stop();
  });

  it("deduplicates a probe and carries correlation context through shutdown", async () => {
    const correlationId = "correlation-deterministic-probe";
    const healthStates: string[] = [];
    const handled = vi.fn();
    const metrics = metricsSpy();
    const runtime = new WorkerRuntime({
      queueName: `matchday-worker-test-${randomUUID()}`,
      redisUrl: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14",
      concurrency: 1,
      metrics,
      hooks: {
        onHealthChange: ({ status }) => healthStates.push(status),
      },
      handleProbe: async (payload, context) => {
        handled({
          payload,
          context: getObservabilityContext(),
          jobId: context.jobId,
        });
        return {
          correlationId: payload.correlationId,
          handledAt: "2026-07-17T00:00:00.000Z",
        };
      },
    });

    await runtime.start();
    const first = await runtime.enqueueProbe(
      { correlationId, requestedAt: "2026-07-17T00:00:00.000Z" },
      "deterministic-probe",
    );
    const duplicate = await runtime.enqueueProbe(
      { correlationId, requestedAt: "2026-07-17T00:00:01.000Z" },
      "deterministic-probe",
    );
    await waitUntil(() => handled.mock.calls.length === 1);

    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          correlationId,
          jobId: first.id,
        },
      }),
    );
    expect(metrics.jobStarted).toHaveBeenCalledTimes(1);
    expect(metrics.jobCompleted).toHaveBeenCalledTimes(1);

    await runtime.stop();
    expect(runtime.getHealth().status).toBe("stopped");
    expect(healthStates).toEqual(["starting", "ready", "stopping", "stopped"]);
  });

  it("returns a bounded shutdown failure for a hung handler", async () => {
    let release: (() => void) | undefined;
    let started = false;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new WorkerRuntime({
      queueName: `matchday-worker-timeout-test-${randomUUID()}`,
      redisUrl: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14",
      shutdownTimeoutMs: 25,
      handleProbe: async (payload) => {
        started = true;
        await blocker;
        return {
          correlationId: payload.correlationId,
          handledAt: "2026-07-17T00:00:00.000Z",
        };
      },
    });
    await runtime.start();
    await runtime.enqueueProbe(
      {
        correlationId: "correlation-timeout",
        requestedAt: "2026-07-17T00:00:00.000Z",
      },
      "hung-handler",
    );
    await waitUntil(() => started);

    await expect(runtime.stop()).rejects.toThrow("shutdown timed out");
    expect(runtime.getHealth()).toMatchObject({
      status: "degraded",
      reason: "Worker shutdown timed out",
    });
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("emits one payload-free terminal hook and metric after retry exhaustion", async () => {
    const metrics = metricsSpy();
    const terminal = vi.fn();
    const secret = "edge-provider-token-must-not-leak";
    const runtime = new WorkerRuntime({
      queueName: `matchday-worker-terminal-test-${randomUUID()}`,
      redisUrl: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14",
      concurrency: 1,
      metrics,
      queueDefaults: {
        defaultAttempts: 2,
        defaultBackoff: { type: "fixed", delay: 10 },
      },
      hooks: { onJobDeadLettered: terminal },
      handleEdgePurge: async () => {
        throw new Error(secret);
      },
    });

    await runtime.start();
    await runtime.enqueueEdgePurge({
      competitionId: "10000000-0000-4000-a000-000000000001",
      projection: "results",
      publicationState: "published",
      previousPublishedVersion: 8,
      publishedVersion: 9,
      correlationId: "terminal-purge-9",
    });
    await waitUntil(() => terminal.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "job.dead-lettered",
        jobName: "edge.public-projection.purge",
        attemptsMade: 2,
      }),
    );
    expect(JSON.stringify(terminal.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(terminal.mock.calls)).not.toContain('"payload"');
    expect(metrics.jobDeadLettered).toHaveBeenCalledOnce();
    expect(metrics.jobDeadLettered).toHaveBeenCalledWith("edge.public-projection.purge");
    expect(runtime.getHealth()).toMatchObject({
      status: "degraded",
      reason: "Terminal job failure: edge.public-projection.purge",
    });
    await runtime.stop();
  });
});

function metricsSpy(): WorkerMetrics {
  return {
    jobStarted: vi.fn(),
    jobCompleted: vi.fn(),
    jobFailed: vi.fn(),
    jobDeadLettered: vi.fn(),
    activeJobs: vi.fn(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for worker job");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
