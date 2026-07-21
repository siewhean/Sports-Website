import type { JobsOptions } from "bullmq";

export interface JobDefinition<Payload, Result = void> {
  payload: Payload;
  result: Result;
}

export type JobRegistryConstraint<Registry> = {
  [Name in keyof Registry]: JobDefinition<unknown, unknown>;
};

export type JobName<Registry> = Extract<keyof Registry, string>;

export type JobPayload<Registry, Name extends JobName<Registry>> =
  Registry[Name] extends JobDefinition<infer Payload, unknown> ? Payload : never;

export type JobResult<Registry, Name extends JobName<Registry>> =
  Registry[Name] extends JobDefinition<unknown, infer Result> ? Result : never;

export interface EnqueueOptions {
  /** Stable business-operation identifier, not a random request identifier. */
  idempotencyKey: string;
  delayMs?: number;
  priority?: number;
  attempts?: number;
  backoff?: JobsOptions["backoff"];
}

export interface EnqueuedJob<Name extends string> {
  id: string;
  name: Name;
  duplicate: boolean;
}

export type CancellationOutcome = "cancelled" | "cancellation-requested" | "already-finished" | "not-found";

export interface JobExecutionContext {
  readonly jobId: string;
  readonly attempt: number;
  isCancellationRequested(): Promise<boolean>;
  throwIfCancellationRequested(): Promise<void>;
  updateProgress(progress: number | Record<string, number>): Promise<void>;
}

export interface DeadLetterEnvelope {
  sourceQueue: string;
  sourceJobId: string;
  sourceJobName: string;
  payload: unknown;
  attemptsMade: number;
  failedAt: string;
  error: {
    name: string;
    message: string;
  };
}

export interface QueueFailure {
  queueName: string;
  jobId?: string;
  error: Error;
}

/** Payload-free signal emitted after a terminal job has been persisted to the dead-letter queue. */
export interface JobDeadLetteredEvent {
  type: "job.dead-lettered";
  queueName: string;
  deadLetterQueueName: string;
  jobId: string;
  jobName: string;
  attemptsMade: number;
  deadLetteredAt: string;
}

export type JobHandlers<Registry> = {
  [Name in JobName<Registry>]: (
    payload: JobPayload<Registry, Name>,
    context: JobExecutionContext,
  ) => Promise<JobResult<Registry, Name>>;
};
