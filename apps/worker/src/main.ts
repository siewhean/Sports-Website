import { loadConfig } from "@matchday/config";
import { createErrorReporter, createLogger, initSentryNode } from "@matchday/observability";

import { createWorkerEdgeCachePurgePort } from "./edge-cache.js";
import { createProductionEmailOutboxWorker } from "./email-outbox-worker.js";
import { resolveWorkerQueuePrefix } from "./queue-configuration.js";
import { WorkerRuntime } from "./runtime.js";
import {
  createWorkerShutdown,
  createWorkerSignalShutdown,
  startWorkerApplication,
  startWorkerTelemetry,
  WORKER_WHOLE_PROCESS_SHUTDOWN_DEADLINE_MS,
} from "./telemetry.js";
import { workerServiceName } from "./service.js";

const config = loadConfig();
const logger = createLogger({
  environment: config.environment,
  level: config.logLevel,
  service: workerServiceName,
});
// Inert unless SENTRY_DSN is set; also installs uncaughtException/unhandledRejection capture.
const errorReporter = createErrorReporter(initSentryNode({ service: workerServiceName }));
const { telemetry, metrics } = await startWorkerTelemetry({
  ...config.telemetry,
  environment: config.environment,
  serviceName: workerServiceName,
  serviceVersion: "0.1.0",
});
const edgeCache = createWorkerEdgeCachePurgePort(config);
const queuePrefix = resolveWorkerQueuePrefix(process.env);
const runtime = new WorkerRuntime({
  queueName: "matchday-foundation",
  redisUrl: config.redisUrl,
  ...(queuePrefix === undefined ? {} : { queuePrefix }),
  metrics,
  hooks: {
    onHealthChange: (health) => logger.info({ health }, "worker health changed"),
    onJobDeadLettered: (event) => {
      logger.error({ event }, "worker job dead-lettered");
      // Dead-lettering happens only after the final retry. The queue event is
      // payload-free by design, so report a synthetic error grouped per job name.
      void errorReporter.reportError(
        new Error(`Job ${event.jobName} failed after ${event.attemptsMade} attempts and was dead-lettered`),
        {
          attributes: { job_name: event.jobName, job_id: event.jobId, attempts_made: event.attemptsMade },
          fingerprint: ["worker-job-dead-lettered", event.jobName],
        },
      );
    },
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
  onError: () => {
    logger.error("email outbox processing error");
  },
});

const stop = createWorkerShutdown({
  stopBackgroundIntake: () => emailWorkerHandle.worker.requestStop(),
  drain: () => runtime.stop(),
  closeBackground: () => emailWorkerHandle.close(),
  telemetry,
});

let shuttingDown = false;
const shutdown = createWorkerSignalShutdown({
  stop: async () => {
    try {
      await stop();
    } finally {
      await errorReporter.flush(2_000);
    }
  },
  deadlineMs: WORKER_WHOLE_PROCESS_SHUTDOWN_DEADLINE_MS,
  onRequested: (signal) => {
    shuttingDown = true;
    logger.info({ signal }, "worker shutdown requested");
  },
  onStopped: () => logger.info("worker stopped"),
  onFailed: () => logger.error("worker shutdown failed; durable leases will govern unresolved work"),
  onDeadlineExceeded: (signal, deadlineMs) =>
    logger.error(
      { signal, deadlineMs },
      "worker shutdown deadline exceeded; terminating with crash-equivalent lease recovery",
    ),
  flushLogger: () => logger.flush(),
  exit: (code) => {
    process.exitCode = code;
    process.exit(code);
  },
});

// Install before either startup await: an initial database claim or SMTP send
// can stall just as an ordinary polling batch can. Repeated signals share the
// same lifecycle rather than reverting to Node's default signal termination.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await startWorkerApplication({
  startRuntime: () => runtime.start(),
  startBackground: () => emailWorkerHandle.worker.start(),
  isStopping: () => shuttingDown,
  waitForShutdown: () => shutdown("SIGTERM"),
});
