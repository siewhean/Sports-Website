import { randomUUID } from "node:crypto";

import { loadConfig } from "@matchday/config";
import { createLogger, initializeMetrics, type MetricsRuntime } from "@matchday/observability";

import { DomainScheduleOptimizer } from "./domain-optimizer.js";
import { SchedulerHealthServer } from "./health-server.js";
import { PostgresScheduleJobStore } from "./postgres-store.js";
import { schedulerQueueName } from "./queue.js";
import { SchedulerRuntime } from "./runtime.js";
import type { SchedulerMetrics } from "./ports.js";

const config = loadConfig();
const logger = createLogger({ environment: config.environment, level: config.logLevel, service: "matchday-scheduler" });
const metricsRuntime = initializeMetrics({ serviceName: "matchday-scheduler" });
const store = new PostgresScheduleJobStore(config.databaseUrl);
const runtime = new SchedulerRuntime({
  queueName: schedulerQueueName(config.environment),
  redisUrl: config.redisUrl,
  workerId: process.env.SCHEDULER_WORKER_ID ?? `${process.pid}-${randomUUID()}`,
  store,
  optimizer: new DomainScheduleOptimizer({
    maxIterationsPerRun: integerEnvironment("SCHEDULER_MAX_ITERATIONS", 64, 1, 256),
  }),
  concurrency: integerEnvironment("SCHEDULER_CONCURRENCY", 1, 1, 32),
  processor: {
    leaseMs: integerEnvironment("SCHEDULER_LEASE_MS", 30_000, 5_000, 300_000),
    cancellationPollMs: integerEnvironment("SCHEDULER_CANCELLATION_POLL_MS", 250, 10, 1_000),
    maxYieldIntervalMs: integerEnvironment("SCHEDULER_MAX_YIELD_MS", 1_000, 10, 1_000),
  },
  shutdownTimeoutMs: integerEnvironment("SCHEDULER_SHUTDOWN_TIMEOUT_MS", 30_000, 1_000, 300_000),
  metrics: createSchedulerMetrics(metricsRuntime),
  onHealthChange: (health) => logger.info({ health }, "scheduler health changed"),
  onDeadLettered: (event) => logger.error({ event }, "schedule job dead-lettered"),
});
const health = new SchedulerHealthServer({
  runtime,
  host: process.env.SCHEDULER_HEALTH_HOST ?? "127.0.0.1",
  port: integerEnvironment("SCHEDULER_HEALTH_PORT", 4010, 1, 65_535),
});

await runtime.start();
await health.start();
logger.info({ address: health.getAddress() }, "scheduler started");

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) {
    logger.error({ signal }, "scheduler forced shutdown requested");
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal }, "scheduler shutdown requested");
  try {
    await runtime.stop();
    await health.stop();
    logger.info("scheduler stopped");
  } catch (error: unknown) {
    logger.error({ error }, "scheduler shutdown failed");
    process.exitCode = 1;
  } finally {
    logger.flush();
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function createSchedulerMetrics(runtimeMetrics: MetricsRuntime): SchedulerMetrics {
  const started = runtimeMetrics.counter("scheduler.jobs.started");
  const explored = runtimeMetrics.counter("scheduler.candidates.explored");
  const checkpointed = runtimeMetrics.counter("scheduler.best.checkpointed");
  const finished = runtimeMetrics.counter("scheduler.jobs.finished");
  const failed = runtimeMetrics.counter("scheduler.jobs.failed");
  const deadLettered = runtimeMetrics.counter("scheduler.jobs.dead_lettered");
  const active = runtimeMetrics.upDownCounter("scheduler.jobs.active");
  const duration = runtimeMetrics.histogram("scheduler.job.duration", { unit: "ms" });
  const cancellation = runtimeMetrics.histogram("scheduler.cancellation.observation_latency", { unit: "ms" });
  return {
    jobStarted: (objective) => started.add(1, { objective }),
    candidateExplored: (objective) => explored.add(1, { objective }),
    bestCheckpointed: (objective) => checkpointed.add(1, { objective }),
    jobFinished: (state, durationMs) => {
      finished.add(1, { state });
      duration.record(durationMs, { state });
    },
    jobFailed: (failureClass, durationMs) => {
      failed.add(1, { failure_class: failureClass });
      duration.record(durationMs, { state: "failed" });
    },
    jobDeadLettered: () => deadLettered.add(1),
    cancellationObserved: (latencyMs) => cancellation.record(latencyMs),
    activeJobs: (delta) => active.add(delta),
  };
}
