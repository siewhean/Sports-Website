import {
  DurableJobQueue,
  type DurableJobQueueOptions,
  type EnqueuedJob,
  type JobDeadLetteredEvent,
} from "@matchday/jobs";
import { runWithObservabilityContext } from "@matchday/observability";

import { ScheduleJobProcessor, type ScheduleProcessorOptions } from "./processor.js";
import type {
  ScheduleJobStore,
  ScheduleOptimizer,
  ScheduleQueuePayload,
  ScheduleWorkerJobRegistry,
  SchedulerMetrics,
} from "./ports.js";

export type SchedulerHealthStatus = "starting" | "ready" | "degraded" | "stopping" | "stopped";
export type SchedulerHealth = Readonly<{ status: SchedulerHealthStatus; checkedAt: string; reason?: string }>;

export interface SchedulerRuntimeOptions {
  queueName: string;
  redisUrl: string;
  workerId: string;
  store: ScheduleJobStore;
  optimizer: ScheduleOptimizer;
  metrics?: SchedulerMetrics;
  concurrency?: number;
  processor?: Pick<ScheduleProcessorOptions, "leaseMs" | "cancellationPollMs" | "maxYieldIntervalMs">;
  queueDefaults?: Pick<DurableJobQueueOptions, "defaultAttempts" | "defaultBackoff">;
  shutdownTimeoutMs?: number;
  onHealthChange?(health: SchedulerHealth): void;
  onDeadLettered?(event: Readonly<JobDeadLetteredEvent>): void;
}

export class SchedulerRuntime {
  readonly #options: SchedulerRuntimeOptions;
  readonly #connection: ReturnType<typeof redisConnection>;
  readonly #businessJobIds = new Map<string, string>();
  #queue: DurableJobQueue<ScheduleWorkerJobRegistry> | undefined;
  #health: SchedulerHealth = { status: "stopped", checkedAt: new Date().toISOString() };
  #started = false;

  constructor(options: SchedulerRuntimeOptions) {
    this.#options = options;
    this.#connection = redisConnection(options.redisUrl);
  }

  getHealth(): SchedulerHealth {
    return this.#health;
  }

  async isReady(): Promise<boolean> {
    return this.#started && this.#health.status === "ready" && (await this.#options.store.probe());
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.setHealth("starting");
    if (!(await this.#options.store.probe())) {
      this.setHealth("degraded", "PostgreSQL scheduler store is unavailable");
      throw new Error("PostgreSQL scheduler store is unavailable");
    }
    const processor = new ScheduleJobProcessor({
      workerId: this.#options.workerId,
      store: this.#options.store,
      optimizer: this.#options.optimizer,
      ...(this.#options.metrics === undefined ? {} : { metrics: this.#options.metrics }),
      ...this.#options.processor,
    });
    this.#queue = new DurableJobQueue<ScheduleWorkerJobRegistry>({
      queueName: this.#options.queueName,
      connection: this.#connection,
      ...this.#options.queueDefaults,
      onFailure: ({ error }) => this.setHealth("degraded", error.name),
      onDeadLettered: (event) => this.handleDeadLetter(event),
    });
    const worker = this.#queue.createWorker(
      {
        "schedule.optimize": (payload, context) => {
          this.#businessJobIds.set(context.jobId, payload.jobId);
          const expiry = setTimeout(() => this.#businessJobIds.delete(context.jobId), 24 * 60 * 60 * 1_000);
          expiry.unref();
          return runWithObservabilityContext({ correlationId: payload.correlationId, jobId: context.jobId }, () =>
            processor.process(payload, context),
          );
        },
      },
      { concurrency: this.#options.concurrency ?? 1 },
    );
    worker.on("ioredis:close", () => this.setHealth("degraded", "Redis connection closed"));
    worker.on("ready", () => {
      if (this.#started && this.#health.status === "degraded") this.setHealth("ready");
    });
    try {
      await worker.waitUntilReady();
      this.#started = true;
      this.setHealth("ready");
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.setHealth("degraded", normalized.name);
      await this.#queue.close();
      this.#queue = undefined;
      throw normalized;
    }
  }

  async enqueue(payload: ScheduleQueuePayload): Promise<EnqueuedJob<"schedule.optimize">> {
    if (!this.#started || this.#queue === undefined) throw new Error("Scheduler runtime is not ready");
    return this.#queue.enqueue("schedule.optimize", payload, {
      idempotencyKey: payload.jobId,
    });
  }

  async stop(): Promise<void> {
    if (this.#health.status === "stopping" || this.#health.status === "stopped") return;
    this.setHealth("stopping");
    const queue = this.#queue;
    try {
      if (queue !== undefined) {
        await withTimeout(queue.close(), this.#options.shutdownTimeoutMs ?? 30_000, "Scheduler shutdown timed out");
      }
      await this.#options.store.close();
      this.#queue = undefined;
      this.#started = false;
      this.setHealth("stopped");
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.#queue = undefined;
      this.#started = false;
      this.setHealth("degraded", normalized.name);
      throw normalized;
    }
  }

  private handleDeadLetter(event: Readonly<JobDeadLetteredEvent>): void {
    this.#options.metrics?.jobDeadLettered();
    this.setHealth("degraded", "Schedule job dead-lettered");
    const businessJobId = this.#businessJobIds.get(event.jobId);
    this.#businessJobIds.delete(event.jobId);
    if (businessJobId !== undefined) {
      void this.#options.store.markDeadLettered(businessJobId, "RetryExhausted").catch(() => undefined);
    }
    try {
      this.#options.onDeadLettered?.(event);
    } catch {
      // Observers cannot alter the durable dead-letter outcome.
    }
  }

  private setHealth(status: SchedulerHealthStatus, reason?: string): void {
    this.#health = { status, checkedAt: new Date().toISOString(), ...(reason === undefined ? {} : { reason }) };
    try {
      this.#options.onHealthChange?.(this.#health);
    } catch {
      // Health observers cannot change worker lifecycle behaviour.
    }
  }
}

function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Scheduler Redis URL must use redis:// or rediss://");
  }
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    db: Number(url.pathname.slice(1) || "0"),
    ...(url.username.length === 0 ? {} : { username: url.username }),
    ...(url.password.length === 0 ? {} : { password: url.password }),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

async function withTimeout<Result>(operation: Promise<Result>, timeoutMs: number, message: string): Promise<Result> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("shutdownTimeoutMs must be a positive integer");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
