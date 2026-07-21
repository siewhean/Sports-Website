import { Job, Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";

import { createDeterministicJobId } from "./identity.js";
import type {
  CancellationOutcome,
  DeadLetterEnvelope,
  EnqueuedJob,
  EnqueueOptions,
  JobHandlers,
  JobDeadLetteredEvent,
  JobName,
  JobPayload,
  JobRegistryConstraint,
  QueueFailure,
} from "./types.js";

const DEFAULT_ATTEMPTS = 5;
type Backoff = NonNullable<JobsOptions["backoff"]>;

const DEFAULT_BACKOFF: Backoff = {
  type: "exponential",
  delay: 1_000,
};
const DEFAULT_CANCELLATION_TTL_MS = 24 * 60 * 60 * 1_000;

export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = "JobCancelledError";
  }
}

export interface DurableJobQueueOptions {
  queueName: string;
  connection: ConnectionOptions;
  prefix?: string;
  defaultAttempts?: number;
  defaultBackoff?: Backoff;
  cancellationTtlMs?: number;
  onFailure?: (failure: QueueFailure) => void;
  onDeadLettered?: (event: Readonly<JobDeadLetteredEvent>) => void;
}

export interface WorkerOptions {
  concurrency?: number;
  lockDurationMs?: number;
}

export class DurableJobQueue<Registry extends JobRegistryConstraint<Registry>> {
  readonly queueName: string;
  readonly deadLetterQueueName: string;

  readonly #queue: Queue;
  readonly #deadLetterQueue: Queue<DeadLetterEnvelope>;
  readonly #options: DurableJobQueueOptions & {
    defaultAttempts: number;
    defaultBackoff: Backoff;
    cancellationTtlMs: number;
  };
  readonly #workers = new Set<Worker>();

  constructor(options: DurableJobQueueOptions) {
    this.queueName = options.queueName;
    this.deadLetterQueueName = `${options.queueName}.dead-letter`;
    this.#options = {
      ...options,
      defaultAttempts: options.defaultAttempts ?? DEFAULT_ATTEMPTS,
      defaultBackoff: options.defaultBackoff ?? DEFAULT_BACKOFF,
      cancellationTtlMs: options.cancellationTtlMs ?? DEFAULT_CANCELLATION_TTL_MS,
    };

    const commonOptions = {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    };
    this.#queue = new Queue(options.queueName, commonOptions);
    this.#deadLetterQueue = new Queue<DeadLetterEnvelope>(this.deadLetterQueueName, commonOptions);
  }

  async enqueue<Name extends JobName<Registry>>(
    name: Name,
    payload: JobPayload<Registry, Name>,
    options: EnqueueOptions,
  ): Promise<EnqueuedJob<Name>> {
    const jobId = createDeterministicJobId(name, options.idempotencyKey);
    const existing = await this.#queue.getJob(jobId);
    if (existing !== undefined) {
      return { id: jobId, name, duplicate: true };
    }

    const job = await this.#queue.add(name, payload, {
      jobId,
      attempts: options.attempts ?? this.#options.defaultAttempts,
      backoff: options.backoff ?? this.#options.defaultBackoff,
      removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 25_000 },
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    });

    return { id: job.id ?? jobId, name, duplicate: false };
  }

  async cancel(jobId: string): Promise<CancellationOutcome> {
    const job = await this.#queue.getJob(jobId);
    if (job === undefined) return "not-found";

    const state = await job.getState();
    if (state === "completed" || state === "failed") return "already-finished";

    if (state === "active") {
      await this.setCancellationMarker(jobId);
      return "cancellation-requested";
    }

    await job.remove();
    return "cancelled";
  }

  async getDeadLetter(sourceJobId: string): Promise<DeadLetterEnvelope | undefined> {
    const deadLetter = await this.#deadLetterQueue.getJob(`dead-${sourceJobId}`);
    return deadLetter?.data;
  }

  async getDeadLetterCount(): Promise<number> {
    return this.#deadLetterQueue.getJobCountByTypes("waiting", "active", "delayed", "completed", "failed");
  }

  async retryDeadLetter(sourceJobId: string): Promise<boolean> {
    const [sourceJob, deadLetter] = await Promise.all([
      this.#queue.getJob(sourceJobId),
      this.#deadLetterQueue.getJob(`dead-${sourceJobId}`),
    ]);
    if (sourceJob === undefined || deadLetter === undefined) return false;
    if ((await sourceJob.getState()) !== "failed") return false;

    await sourceJob.retry("failed");
    await deadLetter.remove();
    return true;
  }

  createWorker(handlers: JobHandlers<Registry>, workerOptions: WorkerOptions = {}): Worker {
    const commonOptions = {
      connection: this.#options.connection,
      ...(this.#options.prefix === undefined ? {} : { prefix: this.#options.prefix }),
      concurrency: workerOptions.concurrency ?? 1,
      ...(workerOptions.lockDurationMs === undefined ? {} : { lockDuration: workerOptions.lockDurationMs }),
    };

    const worker = new Worker(
      this.queueName,
      async (job: Job) => {
        const name = job.name as JobName<Registry>;
        const handler = handlers[name];
        if (handler === undefined) {
          throw new Error(`No handler registered for job type ${job.name}`);
        }

        const throwIfCancellationRequested = async (): Promise<void> => {
          if (await this.hasCancellationMarker(job.id ?? "")) {
            job.discard();
            throw new JobCancelledError(job.id ?? "unknown");
          }
        };

        await throwIfCancellationRequested();
        return handler(job.data as JobPayload<Registry, typeof name>, {
          jobId: job.id ?? "unknown",
          attempt: job.attemptsMade + 1,
          isCancellationRequested: () => this.hasCancellationMarker(job.id ?? ""),
          throwIfCancellationRequested,
          updateProgress: (progress) => job.updateProgress(progress),
        });
      },
      commonOptions,
    );

    worker.on("completed", (job) => {
      void this.clearCancellationMarker(job.id ?? "").catch((error: unknown) => this.reportFailure(job.id, error));
    });
    worker.on("failed", (job, error) => {
      if (job === undefined) {
        this.reportFailure(undefined, error);
        return;
      }

      if (error instanceof JobCancelledError) {
        void this.clearCancellationMarker(job.id ?? "").catch((markerError: unknown) =>
          this.reportFailure(job.id, markerError),
        );
        return;
      }

      const configuredAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= configuredAttempts) {
        void this.moveToDeadLetter(job, error).catch((deadLetterError: unknown) =>
          this.reportFailure(job.id, deadLetterError),
        );
      }
    });
    worker.on("error", (error) => this.reportFailure(undefined, error));

    this.#workers.add(worker);
    return worker;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#workers].map((worker) => worker.close()));
    this.#workers.clear();
    await Promise.all([this.#queue.close(), this.#deadLetterQueue.close()]);
  }

  private cancellationKey(jobId: string): string {
    return `matchday:job-cancellation:${this.#options.prefix ?? "bull"}:${this.queueName}:${jobId}`;
  }

  private async setCancellationMarker(jobId: string): Promise<void> {
    const client = await this.#queue.client;
    await client.set(this.cancellationKey(jobId), "1", {
      PX: this.#options.cancellationTtlMs,
    });
  }

  private async hasCancellationMarker(jobId: string): Promise<boolean> {
    if (jobId.length === 0) return false;
    const client = await this.#queue.client;
    return (await client.get(this.cancellationKey(jobId))) !== null;
  }

  private async clearCancellationMarker(jobId: string): Promise<void> {
    if (jobId.length === 0) return;
    const client = await this.#queue.client;
    await client.del(this.cancellationKey(jobId));
  }

  private async moveToDeadLetter(job: Job, error: Error): Promise<void> {
    const sourceJobId = job.id ?? "unknown";
    const deadLetteredAt = new Date().toISOString();
    await this.#deadLetterQueue.add(
      "dead-letter",
      {
        sourceQueue: this.queueName,
        sourceJobId,
        sourceJobName: job.name,
        payload: job.data,
        attemptsMade: job.attemptsMade,
        failedAt: deadLetteredAt,
        error: { name: error.name, message: error.message },
      },
      {
        jobId: `dead-${sourceJobId}`,
        attempts: 10,
        backoff: DEFAULT_BACKOFF,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    try {
      this.#options.onDeadLettered?.({
        type: "job.dead-lettered",
        queueName: this.queueName,
        deadLetterQueueName: this.deadLetterQueueName,
        jobId: sourceJobId,
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        deadLetteredAt,
      });
    } catch (hookError: unknown) {
      this.reportFailure(sourceJobId, hookError);
    }
  }

  private reportFailure(jobId: string | undefined, error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.#options.onFailure?.({
      queueName: this.queueName,
      ...(jobId === undefined ? {} : { jobId }),
      error: normalizedError,
    });
  }
}
