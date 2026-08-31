import { loadConfig } from "@matchday/config";
import { createLogger, initializeMetrics, type MetricsRuntime } from "@matchday/observability";

import { createWorkerEdgeCachePurgePort } from "./edge-cache.js";
import { createProductionEmailOutboxWorker } from "./email-outbox-worker.js";
import { resolveWorkerQueuePrefix } from "./queue-configuration.js";
import { WorkerRuntime, type WorkerMetrics } from "./runtime.js";
import { workerServiceName } from "./service.js";

const config = loadConfig();
const logger = createLogger({
  environment: config.environment,
  level: config.logLevel,
  service: workerServiceName,
});
const metricsRuntime = initializeMetrics({ serviceName: workerServiceName });
const edgeCache = createWorkerEdgeCachePurgePort(config);
const queuePrefix = resolveWorkerQueuePrefix(process.env);
const runtime = new WorkerRuntime({
  queueName: "matchday-foundation",
  redisUrl: config.redisUrl,
  ...(queuePrefix === undefined ? {} : { queuePrefix }),
  metrics: createWorkerMetrics(metricsRuntime),
  hooks: {
    onHealthChange: (health) => logger.info({ health }, "worker health changed"),
    onJobDeadLettered: (event) => logger.error({ event }, "worker job dead-lettered"),
  },
  ...(edgeCache ? { handleEdgePurge: (payload) => edgeCache.purge(payload) } : {}),
  handleProbe: async (payload, context) => {
    logger.info({ jobId: context.jobId, requestedAt: payload.requestedAt }, "foundation probe handled");
    return {
      correlationId: payload.correlationId,
      handledAt: new Date().toISOString(),
    };
  },
});

const emailWorkerHandle = createProductionEmailOutboxWorker({
  databaseUrl: config.databaseUrl,
  smtp: config.smtp,
  onProcessed: (result) => {
    if (result.claimed > 0) {
      logger.info({ result }, "processed email outbox batch");
    }
  },
  onError: (error) => {
    logger.error({ error }, "email outbox processing error");
  },
});

await runtime.start();
await emailWorkerHandle.worker.start();

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutdown requested");
  let forceExit = false;
  try {
    await runtime.stop();
    await emailWorkerHandle.close();
    logger.info("worker stopped");
  } catch (error: unknown) {
    logger.error({ error }, "worker shutdown failed");
    process.exitCode = 1;
    forceExit = true;
  } finally {
    logger.flush();
    // OpenTelemetry or a logger transport may retain event-loop handles after
    // the queue has shut down. A worker that has completed its bounded
    // shutdown must terminate, otherwise an orchestrator cannot distinguish a
    // drained worker from one still accepting jobs.
    process.exit(forceExit ? 1 : 0);
  }
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

function createWorkerMetrics(runtimeMetrics: MetricsRuntime): WorkerMetrics {
  const started = runtimeMetrics.counter("worker.jobs.started");
  const completed = runtimeMetrics.counter("worker.jobs.completed");
  const failed = runtimeMetrics.counter("worker.jobs.failed");
  const deadLettered = runtimeMetrics.counter("worker.jobs.dead_lettered");
  const duration = runtimeMetrics.histogram("worker.job.duration", {
    unit: "ms",
  });
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
