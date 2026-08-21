import { edgePurgeIdempotencyKey, type EdgePurgeRequest, type EdgePurgeResult } from "@matchday/edge-cache";
import {
  DurableJobQueue,
  type DurableJobQueueOptions,
  type EnqueuedJob,
  type JobDeadLetteredEvent,
  type JobExecutionContext,
} from "@matchday/jobs";
import { runWithObservabilityContext } from "@matchday/observability";

import type { FoundationProbePayload, FoundationProbeResult, WorkerJobRegistry } from "./jobs.js";

export type WorkerHealthStatus = "starting" | "ready" | "degraded" | "stopping" | "stopped";
export type WorkerConnectionEvent = "closed" | "ready";

export interface WorkerHealth {
  status: WorkerHealthStatus;
  checkedAt: string;
  reason?: string;
}

export interface WorkerMetrics {
  jobStarted(name: string): void;
  jobCompleted(name: string, durationMs: number): void;
  jobFailed(name: string, durationMs: number): void;
  jobDeadLettered(name: string): void;
  activeJobs(delta: 1 | -1): void;
}

export interface WorkerRuntimeHooks {
  onHealthChange?(health: Readonly<WorkerHealth>): void;
  onJobDeadLettered?(event: Readonly<JobDeadLetteredEvent>): void;
}

export interface WorkerRuntimeOptions {
  queueName: string;
  /** Optional BullMQ prefix used only by explicitly isolated local runs. */
  queuePrefix?: string;
  redisUrl: string;
  concurrency?: number;
  hooks?: WorkerRuntimeHooks;
  metrics?: WorkerMetrics;
  queueDefaults?: Pick<DurableJobQueueOptions, "defaultAttempts" | "defaultBackoff">;
  shutdownTimeoutMs?: number;
  handleEdgePurge?(payload: EdgePurgeRequest, context: JobExecutionContext): Promise<EdgePurgeResult>;
  handleProbe?(payload: FoundationProbePayload, context: JobExecutionContext): Promise<FoundationProbeResult>;
}

export class WorkerRuntime {
  readonly #options: WorkerRuntimeOptions;
  readonly #connection: ReturnType<typeof redisConnection>;
  #queue: DurableJobQueue<WorkerJobRegistry> | undefined;
  #health: WorkerHealth = {
    status: "stopped",
    checkedAt: new Date().toISOString(),
  };
  #started = false;

  constructor(options: WorkerRuntimeOptions) {
    this.#options = options;
    this.#connection = redisConnection(options.redisUrl);
  }

  getHealth(): Readonly<WorkerHealth> {
    return this.#health;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.setHealth("starting");
    this.#queue = new DurableJobQueue<WorkerJobRegistry>({
      queueName: this.#options.queueName,
      connection: this.#connection,
      ...(this.#options.queuePrefix === undefined ? {} : { prefix: this.#options.queuePrefix }),
      onFailure: ({ error }) => this.setHealth("degraded", error.message),
      onDeadLettered: (event) => this.handleDeadLettered(event),
      ...this.#options.queueDefaults,
    });
    const worker = this.#queue.createWorker(
      {
        "edge.public-projection.purge": (payload, context) => this.executeEdgePurge(payload, context),
        "foundation.probe": (payload, context) => this.executeProbe(payload, context),
      },
      { concurrency: this.#options.concurrency ?? 4 },
    );
    worker.on("ioredis:close", () => {
      this.applyConnectionEvent("closed");
    });
    worker.on("ready", () => {
      this.applyConnectionEvent("ready");
    });
    try {
      await worker.waitUntilReady();
      this.#started = true;
      this.setHealth("ready");
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.setHealth("degraded", normalized.message);
      await this.#queue.close();
      this.#queue = undefined;
      throw normalized;
    }
  }

  async enqueueProbe(
    payload: FoundationProbePayload,
    idempotencyKey: string,
  ): Promise<EnqueuedJob<"foundation.probe">> {
    if (!this.#started || this.#queue === undefined) {
      throw new Error("Worker runtime must be ready before enqueue");
    }
    return this.#queue.enqueue("foundation.probe", payload, { idempotencyKey });
  }

  async enqueueEdgePurge(payload: EdgePurgeRequest): Promise<EnqueuedJob<"edge.public-projection.purge">> {
    if (!this.#started || this.#queue === undefined) {
      throw new Error("Worker runtime must be ready before enqueue");
    }
    return this.#queue.enqueue("edge.public-projection.purge", payload, {
      idempotencyKey: edgePurgeIdempotencyKey(payload),
    });
  }

  async stop(): Promise<void> {
    if (this.#health.status === "stopping") return;
    if (this.#queue === undefined) return;
    this.setHealth("stopping");
    const queue = this.#queue;
    try {
      await withTimeout(queue.close(), this.#options.shutdownTimeoutMs ?? 30_000, "Worker shutdown timed out");
      this.#queue = undefined;
      this.#started = false;
      this.setHealth("stopped");
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.#queue = undefined;
      this.#started = false;
      this.setHealth("degraded", normalized.message);
      throw normalized;
    }
  }

  private async executeProbe(
    payload: FoundationProbePayload,
    context: JobExecutionContext,
  ): Promise<FoundationProbeResult> {
    const startedAt = performance.now();
    const jobName = "foundation.probe";
    this.callMetric((metrics) => metrics.jobStarted(jobName));
    this.callMetric((metrics) => metrics.activeJobs(1));

    return runWithObservabilityContext({ correlationId: payload.correlationId, jobId: context.jobId }, async () => {
      try {
        const result = this.#options.handleProbe
          ? await this.#options.handleProbe(payload, context)
          : {
              correlationId: payload.correlationId,
              handledAt: new Date().toISOString(),
            };
        this.callMetric((metrics) => metrics.jobCompleted(jobName, performance.now() - startedAt));
        if (this.#health.status === "degraded") this.setHealth("ready");
        return result;
      } catch (error: unknown) {
        this.callMetric((metrics) => metrics.jobFailed(jobName, performance.now() - startedAt));
        throw error;
      } finally {
        this.callMetric((metrics) => metrics.activeJobs(-1));
      }
    });
  }

  private async executeEdgePurge(payload: EdgePurgeRequest, context: JobExecutionContext): Promise<EdgePurgeResult> {
    if (this.#options.handleEdgePurge === undefined) {
      throw new Error("Public edge purge handler is not configured");
    }
    return this.executeObservedJob("edge.public-projection.purge", payload.correlationId, context, () =>
      this.#options.handleEdgePurge!(payload, context),
    );
  }

  private async executeObservedJob<Result>(
    jobName: string,
    correlationId: string,
    context: JobExecutionContext,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const startedAt = performance.now();
    this.callMetric((metrics) => metrics.jobStarted(jobName));
    this.callMetric((metrics) => metrics.activeJobs(1));
    return runWithObservabilityContext({ correlationId, jobId: context.jobId }, async () => {
      try {
        const result = await operation();
        this.callMetric((metrics) => metrics.jobCompleted(jobName, performance.now() - startedAt));
        if (this.#health.status === "degraded") this.setHealth("ready");
        return result;
      } catch (error: unknown) {
        this.callMetric((metrics) => metrics.jobFailed(jobName, performance.now() - startedAt));
        throw error;
      } finally {
        this.callMetric((metrics) => metrics.activeJobs(-1));
      }
    });
  }

  private setHealth(status: WorkerHealthStatus, reason?: string): void {
    this.#health = {
      status,
      checkedAt: new Date().toISOString(),
      ...(reason === undefined ? {} : { reason }),
    };
    try {
      this.#options.hooks?.onHealthChange?.(this.#health);
    } catch {
      // Health observers must not change worker lifecycle behaviour.
    }
  }

  private callMetric(operation: (metrics: WorkerMetrics) => void): void {
    if (this.#options.metrics === undefined) return;
    try {
      operation(this.#options.metrics);
    } catch {
      // Metric exporters must not change job execution behaviour.
    }
  }

  private handleDeadLettered(event: Readonly<JobDeadLetteredEvent>): void {
    this.callMetric((metrics) => metrics.jobDeadLettered(event.jobName));
    this.setHealth("degraded", `Terminal job failure: ${event.jobName}`);
    try {
      this.#options.hooks?.onJobDeadLettered?.(event);
    } catch {
      // Terminal observers must not alter the durable dead-letter outcome.
    }
  }

  private applyConnectionEvent(event: WorkerConnectionEvent): void {
    const transition = connectionHealthTransition(this.#health.status, event, this.#started);
    if (transition === "degraded") {
      this.setHealth("degraded", "Redis connection closed");
    } else if (transition === "ready") {
      this.setHealth("ready");
    }
  }
}

export function connectionHealthTransition(
  current: WorkerHealthStatus,
  event: WorkerConnectionEvent,
  started: boolean,
): "degraded" | "ready" | undefined {
  if (event === "closed") {
    return current === "stopping" || current === "stopped" ? undefined : "degraded";
  }
  return started && current === "degraded" ? "ready" : undefined;
}

function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Worker Redis URL must use redis:// or rediss://");
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("shutdownTimeoutMs must be a positive finite number");
  }
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
