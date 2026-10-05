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

/** Startup may reject when a concurrent signal closes its queue connection. */
export async function startWorkerApplication(options: {
  startRuntime(): Promise<void>;
  startBackground(): Promise<void>;
  isStopping(): boolean;
  waitForShutdown(): Promise<void>;
}): Promise<void> {
  try {
    await options.startRuntime();
    if (!options.isStopping()) await options.startBackground();
  } catch (error) {
    if (!options.isStopping()) throw error;
    // A signal already owns shutdown. Do not let top-level startup rejection
    // terminate before that lifecycle has drained and flushed its handles.
    await options.waitForShutdown();
  }
}

export const WORKER_WHOLE_PROCESS_SHUTDOWN_DEADLINE_MS = 60_000;

export type WorkerShutdownSignal = "SIGTERM" | "SIGINT";

/** Share the entire application shutdown promise, including concurrent signal callers. */
export function createWorkerShutdown(options: {
  stopBackgroundIntake?(): void;
  drain(): Promise<void>;
  closeBackground(): Promise<void>;
  telemetry: { flush(): Promise<void>; shutdown(): Promise<void> };
}): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    if (shutdown !== undefined) return shutdown;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    shutdown = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    void (async () => {
      const applicationErrors: unknown[] = [];
      try {
        options.stopBackgroundIntake?.();
      } catch (error) {
        applicationErrors.push(error);
      }
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
    })().then(resolve, reject);
    return shutdown;
  };
}

export function createWorkerSignalShutdown(options: {
  stop(): Promise<void>;
  deadlineMs?: number;
  onRequested(signal: WorkerShutdownSignal): void;
  onStopped(): void;
  onFailed(): void;
  onDeadlineExceeded(signal: WorkerShutdownSignal, deadlineMs: number): void;
  flushLogger(): void;
  exit(code: 0 | 1): void;
}): (signal: WorkerShutdownSignal) => Promise<void> {
  const deadlineMs = options.deadlineMs ?? WORKER_WHOLE_PROCESS_SHUTDOWN_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1_000) {
    throw new Error("Worker whole-process shutdown deadline must be at least 1000ms");
  }

  let shutdown: Promise<void> | undefined;
  return (signal) => {
    if (shutdown !== undefined) return shutdown;
    let resolve!: () => void;
    // Publish ownership before invoking observers or application code, including
    // synchronous reentrant signals. Every signal shares this same operation.
    shutdown = new Promise<void>((accept) => {
      resolve = accept;
    });
    let settled = false;
    let observerFailed = false;
    const observe = (operation: () => void): void => {
      try {
        operation();
      } catch {
        observerFailed = true;
      }
    };
    const terminate = (code: 0 | 1): void => {
      observe(options.flushLogger);
      try {
        options.exit(observerFailed ? 1 : code);
      } finally {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      observe(() => options.onDeadlineExceeded(signal, deadlineMs));
      terminate(1);
    }, deadlineMs);
    observe(() => options.onRequested(signal));

    const complete = (code: 0 | 1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observe(code === 0 ? options.onStopped : options.onFailed);
      terminate(code);
    };
    try {
      void options.stop().then(
        () => complete(0),
        () => complete(1),
      );
    } catch {
      complete(1);
    }
    return shutdown;
  };
}
