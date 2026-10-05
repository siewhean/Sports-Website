import { describe, expect, it, vi } from "vitest";

import { createWorkerShutdown, startWorkerTelemetry } from "../../src/telemetry.js";

const options = {
  enabled: true,
  endpoint: "http://collector.test:4318",
  metricExportIntervalMs: 60_000,
  environment: "test" as const,
  serviceName: "matchday-worker",
};

describe("worker telemetry", () => {
  it("exports counters and histograms through its explicitly configured provider", async () => {
    const exports: string[] = [];
    const { telemetry, metrics } = await startWorkerTelemetry(options, {
      metricExporter: {
        export(resourceMetrics, callback) {
          exports.push(JSON.stringify(resourceMetrics));
          callback({ code: 0 });
        },
        forceFlush: async () => undefined,
        shutdown: async () => undefined,
      },
    });
    try {
      metrics.jobStarted("foundation.probe");
      metrics.activeJobs(1);
      metrics.jobCompleted("foundation.probe", 42);
      metrics.activeJobs(-1);
      metrics.jobFailed("foundation.probe", 12);
      metrics.jobDeadLettered("foundation.probe");
      await telemetry.flush();
      const data = JSON.parse(exports[0]!);
      const instruments = data.scopeMetrics.flatMap((scope: { metrics: unknown[] }) => scope.metrics);
      const byName = new Map<string, { dataPoints: { value: unknown; attributes: unknown }[] }>(
        instruments.map((metric: { descriptor: { name: string }; dataPoints: unknown[] }) => [
          metric.descriptor.name,
          metric,
        ]),
      );
      for (const name of ["started", "completed", "failed", "dead_lettered"]) {
        expect(byName.get(`worker.jobs.${name}`)?.dataPoints).toEqual([
          expect.objectContaining({ value: 1, attributes: { job: "foundation.probe" } }),
        ]);
      }
      expect(byName.get("worker.jobs.active")?.dataPoints).toEqual([
        expect.objectContaining({ value: 0, attributes: {} }),
      ]);
      expect(byName.get("worker.job.duration")?.dataPoints).toEqual([
        expect.objectContaining({
          attributes: { job: "foundation.probe", outcome: "completed" },
          value: expect.objectContaining({ count: 1, sum: 42 }),
        }),
        expect.objectContaining({
          attributes: { job: "foundation.probe", outcome: "failed" },
          value: expect.objectContaining({ count: 1, sum: 12 }),
        }),
      ]);
    } finally {
      await telemetry.shutdown();
    }
  });

  it("keeps disabled telemetry a no-op", async () => {
    const exporter = vi.fn();
    const { telemetry, metrics } = await startWorkerTelemetry(
      { ...options, enabled: false },
      {
        metricExporter: {
          export: exporter,
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        },
      },
    );
    metrics.jobStarted("foundation.probe");
    metrics.jobCompleted("foundation.probe", 42);
    await telemetry.flush();
    await Promise.all([telemetry.shutdown(), telemetry.shutdown()]);
    expect(exporter).not.toHaveBeenCalled();
  });

  it("drains jobs, closes background handles, flushes, and shuts down exactly once", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const stop = createWorkerShutdown({
      drain: async () => {
        events.push("drain");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      closeBackground: async () => {
        events.push("background");
      },
      telemetry: {
        flush: async () => {
          events.push("flush");
        },
        shutdown: async () => {
          events.push("shutdown");
        },
      },
    });
    const first = stop();
    expect(stop()).toBe(first);
    expect(events).toEqual(["drain"]);
    release?.();
    await first;
    await stop();
    expect(events).toEqual(["drain", "background", "flush", "shutdown"]);
  });

  it("bounds stalled telemetry after application handles drain and close", async () => {
    const events: string[] = [];
    const hanging = (): Promise<void> => new Promise(() => undefined);
    const { telemetry, metrics } = await startWorkerTelemetry(options, {
      shutdownTimeoutMs: 20,
      metricExporter: {
        export() {
          events.push("export");
          // Deliberately never acknowledge an export.
        },
        forceFlush: hanging,
        shutdown() {
          events.push("exporter-shutdown");
          return hanging();
        },
      },
    });
    metrics.jobStarted("foundation.probe");
    metrics.jobCompleted("foundation.probe", 42);
    const stop = createWorkerShutdown({
      drain: async () => {
        events.push("drain");
      },
      closeBackground: async () => {
        events.push("background");
      },
      telemetry: {
        flush: async () => {
          events.push("flush");
          await telemetry.flush();
        },
        shutdown: async () => {
          events.push("shutdown");
          await telemetry.shutdown();
        },
      },
    });
    // A generous outer deadline proves completion without timing-sensitive assertions.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([stop(), stop()]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Telemetry prevented worker shutdown")), 1_000);
        }),
      ]);
      expect(events.slice(0, 4)).toEqual(["drain", "background", "flush", "export"]);
      expect(events.filter((event) => event === "shutdown")).toHaveLength(1);
      await stop();
      expect(events.filter((event) => event === "drain")).toHaveLength(1);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await telemetry.shutdown();
    }
  });

  it("contains telemetry failures and still shuts down, while retaining application failures", async () => {
    const shutdown = vi.fn().mockRejectedValue(new Error("exporter unavailable"));
    const closeBackground = vi.fn().mockResolvedValue(undefined);
    const telemetry = { flush: vi.fn().mockRejectedValue(new Error("flush failed")), shutdown };
    await expect(
      createWorkerShutdown({ drain: async () => undefined, closeBackground, telemetry })(),
    ).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledOnce();
    const failed = createWorkerShutdown({
      drain: async () => {
        throw new Error("drain failed");
      },
      closeBackground,
      telemetry,
    });
    await expect(failed()).rejects.toThrow("Worker application shutdown failed");
    expect(closeBackground).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(2);
  });
});
