import { initializeMetrics, startTelemetryRuntime, type MetricsRuntime } from "@matchday/observability";

import type { WorkerMetrics } from "./runtime.js";

/** Start providers before creating any instruments; never depend on global SDK state. */
export async function startWorkerTelemetry(
  options: Parameters<typeof startTelemetryRuntime>[0],
  dependencies?: Parameters<typeof startTelemetryRuntime>[1],
) {
  const telemetry = await startTelemetryRuntime(options, dependencies);
  const metrics = createWorkerMetrics(
    initializeMetrics({
      serviceName: options.serviceName,
      ...(options.serviceVersion === undefined ? {} : { serviceVersion: options.serviceVersion }),
      provider: telemetry.meterProvider,
    }),
  );
  return { telemetry, metrics };
}

export function createWorkerMetrics(runtimeMetrics: MetricsRuntime): WorkerMetrics {
  const started = runtimeMetrics.counter("worker.jobs.started");
  const completed = runtimeMetrics.counter("worker.jobs.completed");
  const failed = runtimeMetrics.counter("worker.jobs.failed");
  const deadLettered = runtimeMetrics.counter("worker.jobs.dead_lettered");
  const duration = runtimeMetrics.histogram("worker.job.duration", { unit: "ms" });
  const active = runtimeMetrics.upDownCounter("worker.jobs.active");
  return {
    jobStarted: (name) => started.add(1, { job: name }),
    jobCompleted: (name, durationMs) => {
      completed.add(1, { job: name });
      duration.record(durationMs, { job: name, outcome: "completed" });
    },
    jobFailed: (name, durationMs) => {
      failed.add(1, { job: name });
      duration.record(durationMs, { job: name, outcome: "failed" });
    },
    jobDeadLettered: (name) => deadLettered.add(1, { job: name }),
    activeJobs: (delta) => active.add(delta),
  };
}

/** Share the entire shutdown promise, including concurrent signal callers. */
export function createWorkerShutdown(options: {
  drain(): Promise<void>;
  closeBackground(): Promise<void>;
  telemetry: { flush(): Promise<void>; shutdown(): Promise<void> };
}): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= (async () => {
      const applicationErrors: unknown[] = [];
      try {
        await options.drain();
      } catch (error) {
        applicationErrors.push(error);
      }
      try {
        await options.closeBackground();
      } catch (error) {
        applicationErrors.push(error);
      }
      try {
        await options.telemetry.flush();
      } catch {
        // An exporter outage must not turn a drained worker into a failed worker.
      }
      try {
        await options.telemetry.shutdown();
      } catch {
        // Application handles have already closed; telemetry is best effort.
      }
      if (applicationErrors.length > 0) {
        throw new AggregateError(applicationErrors, "Worker application shutdown failed");
      }
    })();
    return shutdown;
  };
}
