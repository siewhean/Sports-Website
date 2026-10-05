import { describe, expect, it, vi } from "vitest";

import {
  createWorkerShutdown,
  createWorkerSignalShutdown,
  startWorkerApplication,
  startWorkerTelemetry,
} from "../../src/telemetry.js";

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
      stopBackgroundIntake: () => {
        events.push("intake");
      },
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
    expect(events).toEqual(["intake", "drain"]);
    release?.();
    await first;
    await stop();
    expect(events).toEqual(["intake", "drain", "background", "flush", "shutdown"]);
  });

  it("shares concurrent signals and exits exactly once after clean shutdown", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const exit = vi.fn();
    const shutdown = createWorkerSignalShutdown({
      stop: () =>
        new Promise<void>((resolve) => {
          events.push("stop");
          release = resolve;
        }),
      deadlineMs: 5_000,
      onRequested: (signal) => events.push(`requested:${signal}`),
      onStopped: () => events.push("stopped"),
      onFailed: () => events.push("failed"),
      onDeadlineExceeded: () => events.push("deadline"),
      flushLogger: () => events.push("logger"),
      exit,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(second).toBe(first);
    expect(events).toEqual(["requested:SIGTERM", "stop"]);
    release?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["requested:SIGTERM", "stop", "stopped", "logger"]);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("enforces a non-zero crash-equivalent whole-process deadline for stalled email work", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const exit = vi.fn();
    const shutdown = createWorkerSignalShutdown({
      stop: async () => new Promise<void>(() => undefined),
      deadlineMs: 2_000,
      onRequested: () => events.push("requested"),
      onStopped: () => events.push("stopped"),
      onFailed: () => events.push("failed"),
      onDeadlineExceeded: () => events.push("deadline"),
      flushLogger: () => events.push("logger"),
      exit,
    });
    const pending = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(events).toEqual(["requested", "deadline", "logger"]);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
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

describe("shutdown observer isolation", () => {
  it.each(["onRequested", "onStopped", "onFailed", "onDeadlineExceeded", "flushLogger"] as const)(
    "still exits non-zero when %s throws",
    async (failing) => {
      vi.useFakeTimers();
      try {
        const exit = vi.fn();
        const observer = (name: string) => () => {
          if (name === failing) throw new Error("observer failure");
        };
        const shutdown = createWorkerSignalShutdown({
          stop:
            failing === "onDeadlineExceeded"
              ? () => new Promise<void>(() => undefined)
              : failing === "onFailed"
                ? () => {
                    throw new Error("synchronous drain failure");
                  }
                : async () => undefined,
          deadlineMs: 1000,
          onRequested: observer("onRequested"),
          onStopped: observer("onStopped"),
          onFailed: observer("onFailed"),
          onDeadlineExceeded: observer("onDeadlineExceeded"),
          flushLogger: observer("flushLogger"),
          exit,
        });
        const pending = shutdown("SIGTERM");
        await vi.advanceTimersByTimeAsync(1000);
        await pending;
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("publishes signal lifecycle ownership before an observer reenters it", async () => {
    const stop = vi.fn(async () => undefined);
    const exit = vi.fn();
    let reentered: Promise<void> | undefined;
    const shutdown = createWorkerSignalShutdown({
      stop,
      onRequested: () => {
        reentered = shutdown("SIGINT");
      },
      onStopped: () => undefined,
      onFailed: () => undefined,
      onDeadlineExceeded: () => undefined,
      flushLogger: () => undefined,
      exit,
    });
    const first = shutdown("SIGTERM");
    expect(reentered).toBe(first);
    await first;
    expect(stop).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});

it("publishes application shutdown ownership before intake observers reenter", async () => {
  const drain = vi.fn(async () => undefined);
  const closeBackground = vi.fn(async () => undefined);
  const flush = vi.fn(async () => undefined);
  const shutdown = vi.fn(async () => undefined);
  let reentered: Promise<void> | undefined;
  const stop = createWorkerShutdown({
    stopBackgroundIntake: () => {
      reentered = stop();
    },
    drain,
    closeBackground,
    telemetry: { flush, shutdown },
  });
  const first = stop();
  expect(reentered).toBe(first);
  await first;
  for (const operation of [drain, closeBackground, flush, shutdown]) {
    expect(operation).toHaveBeenCalledOnce();
  }
});

it("waits for shared shutdown when closing startup rejects, without starting email intake", async () => {
  let rejectStartup!: (error: Error) => void;
  let releaseShutdown!: () => void;
  const startup = new Promise<void>((_resolve, reject) => {
    rejectStartup = reject;
  });
  const shutdown = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  });
  let stopping = false;
  const startBackground = vi.fn(async () => undefined);
  const waitForShutdown = vi.fn(() => shutdown);
  let finished = false;
  const starting = startWorkerApplication({
    startRuntime: () => startup,
    startBackground,
    isStopping: () => stopping,
    waitForShutdown,
  }).then(() => {
    finished = true;
  });
  stopping = true;
  rejectStartup(new Error("Queue closed during startup"));
  await Promise.resolve();
  await Promise.resolve();
  expect(waitForShutdown).toHaveBeenCalledOnce();
  expect(startBackground).not.toHaveBeenCalled();
  expect(finished).toBe(false);
  releaseShutdown();
  await starting;
  expect(finished).toBe(true);
});

it("retains normal startup rejection rather than reporting successful shutdown", async () => {
  const startBackground = vi.fn(async () => undefined);
  const waitForShutdown = vi.fn(async () => undefined);
  await expect(
    startWorkerApplication({
      startRuntime: async () => {
        throw new Error("Startup failed");
      },
      startBackground,
      isStopping: () => false,
      waitForShutdown,
    }),
  ).rejects.toThrow("Startup failed");
  expect(startBackground).not.toHaveBeenCalled();
  expect(waitForShutdown).not.toHaveBeenCalled();
});
