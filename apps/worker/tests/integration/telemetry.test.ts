import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { WorkerRuntime } from "../../src/runtime.js";
import { createWorkerShutdown, startWorkerTelemetry } from "../../src/telemetry.js";

describe("worker telemetry exporter outage", () => {
  it("completes durable jobs without retries or lost completion when exports fail", async () => {
    const exportedNames: string[] = [];
    const exporterShutdown = vi.fn(async () => undefined);
    const { telemetry, metrics } = await startWorkerTelemetry(
      {
        enabled: true,
        environment: "test",
        serviceName: "matchday-worker",
        endpoint: "http://collector.test:4318",
        metricExportIntervalMs: 60_000,
      },
      {
        metricExporter: {
          export(resourceMetrics, callback) {
            exportedNames.push(
              ...resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)),
            );
            callback({ code: 1, error: new Error("Synthetic exporter unavailable") });
          },
          forceFlush: async () => undefined,
          shutdown: exporterShutdown,
        },
      },
    );
    const handled = vi.fn(async (payload: { correlationId: string }) => ({
      correlationId: payload.correlationId,
      handledAt: "2026-10-05T00:00:00.000Z",
    }));
    const runtime = new WorkerRuntime({
      queueName: `matchday-g3-telemetry-${randomUUID()}`,
      redisUrl: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14",
      concurrency: 1,
      metrics,
      handleProbe: handled,
    });
    const closeBackground = vi.fn(async () => undefined);
    const stop = createWorkerShutdown({ drain: () => runtime.stop(), closeBackground, telemetry });
    try {
      await runtime.start();
      const payload = { correlationId: "safe-probe", requestedAt: "2026-10-05T00:00:00.000Z" };
      const first = await runtime.enqueueProbe(payload, "telemetry-outage");
      const deadline = Date.now() + 5_000;
      while (handled.mock.calls.length === 0) {
        if (Date.now() > deadline) throw new Error("Worker probe did not complete");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await telemetry.flush();
      const duplicate = await runtime.enqueueProbe(payload, "telemetry-outage");
      expect(duplicate).toEqual({ ...first, duplicate: true });
      expect(handled).toHaveBeenCalledOnce();
      expect(runtime.getHealth().status).toBe("ready");
      expect(exportedNames).toEqual(
        expect.arrayContaining([
          "worker.jobs.started",
          "worker.jobs.completed",
          "worker.job.duration",
          "worker.jobs.active",
        ]),
      );
      await Promise.all([stop(), stop()]);
      expect(runtime.getHealth().status).toBe("stopped");
      expect(closeBackground).toHaveBeenCalledOnce();
      expect(exporterShutdown).toHaveBeenCalledOnce();
    } finally {
      await stop();
    }
  });
});
