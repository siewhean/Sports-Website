import { DurableJobQueue, type DurableJobQueueOptions, type EnqueuedJob } from "@matchday/jobs";

import type { ScheduleQueuePayload, ScheduleWorkerJobRegistry } from "./ports.js";

/** API-side adapter. Persist the immutable job transaction first, then enqueue this reference. */
export interface ScheduleEnqueuePort {
  enqueueSchedule(payload: ScheduleQueuePayload): Promise<EnqueuedJob<"schedule.optimize">>;
}

export class ScheduleJobQueue implements ScheduleEnqueuePort {
  readonly #queue: DurableJobQueue<ScheduleWorkerJobRegistry>;

  constructor(options: {
    queueName: string;
    redisUrl: string;
    queueDefaults?: Pick<DurableJobQueueOptions, "defaultAttempts" | "defaultBackoff">;
  }) {
    this.#queue = new DurableJobQueue<ScheduleWorkerJobRegistry>({
      queueName: options.queueName,
      connection: redisConnection(options.redisUrl),
      ...options.queueDefaults,
    });
  }

  enqueueSchedule(payload: ScheduleQueuePayload): Promise<EnqueuedJob<"schedule.optimize">> {
    assertScheduleQueuePayload(payload);
    return this.#queue.enqueue("schedule.optimize", payload, { idempotencyKey: payload.jobId });
  }

  close(): Promise<void> {
    return this.#queue.close();
  }
}

export function schedulerQueueName(environment: string): string {
  if (!/^[a-z0-9_-]+$/.test(environment)) throw new Error("Invalid scheduler environment name");
  return `matchday-scheduler-${environment}`;
}

export function assertScheduleQueuePayload(payload: ScheduleQueuePayload): void {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("Invalid schedule queue payload");
  }
  const keys = Object.keys(payload);
  const expected = ["schemaVersion", "jobId", "competitionId", "inputHash", "correlationId"];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    payload.schemaVersion !== 1 ||
    !uuid.test(payload.jobId) ||
    !uuid.test(payload.competitionId) ||
    !/^[a-f0-9]{64}$/.test(payload.inputHash) ||
    typeof payload.correlationId !== "string" ||
    payload.correlationId.length < 1 ||
    payload.correlationId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(payload.correlationId)
  ) {
    throw new Error("Invalid schedule queue payload");
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
