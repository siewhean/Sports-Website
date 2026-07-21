import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { Queue, type ConnectionOptions } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";

import { DurableJobQueue, type JobDeadLetteredEvent, type JobDefinition, type JobHandlers } from "../../src/index.js";

type TestJobs = {
  probe: JobDefinition<{ value: number }, number>;
};

const queues: DurableJobQueue<TestJobs>[] = [];

afterEach(async () => {
  const completedQueues = queues.splice(0);
  await Promise.all(completedQueues.map((queue) => queue.close()));
  await Promise.all(
    completedQueues.flatMap((completedQueue) =>
      [completedQueue.queueName, completedQueue.deadLetterQueueName].map(async (queueName) => {
        const cleanupQueue = new Queue(queueName, {
          connection: redisConnection(),
        });
        await cleanupQueue.obliterate({ force: true });
        await cleanupQueue.close();
      }),
    ),
  );
});

describe("DurableJobQueue with Redis", () => {
  it("deduplicates enqueue requests and processes the job once", async () => {
    const queue = makeQueue();
    const first = await queue.enqueue(
      "probe",
      { value: 7 },
      {
        idempotencyKey: "operation-7",
      },
    );
    const duplicate = await queue.enqueue(
      "probe",
      { value: 999 },
      {
        idempotencyKey: "operation-7",
      },
    );
    let calls = 0;
    const worker = queue.createWorker({
      probe: async ({ value }) => {
        calls += 1;
        return value * 2;
      },
    });
    await worker.waitUntilReady();

    await waitUntil(() => calls === 1);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(calls).toBe(1);
  });

  it("retries failures, dead-letters exhaustion, and permits replay", async () => {
    const terminalEvents: JobDeadLetteredEvent[] = [];
    const queue = makeQueue({ onDeadLettered: (event) => terminalEvents.push({ ...event }) });
    let shouldFail = true;
    let calls = 0;
    const worker = queue.createWorker({
      probe: async ({ value }) => {
        calls += 1;
        if (shouldFail) throw new Error("temporary downstream failure");
        return value;
      },
    });
    await worker.waitUntilReady();
    const enqueued = await queue.enqueue(
      "probe",
      { value: 1 },
      {
        idempotencyKey: "retry-me",
        attempts: 2,
        backoff: { type: "fixed", delay: 10 },
      },
    );

    await waitUntil(() => terminalEvents.length === 1);
    await delay(100);
    expect(calls).toBe(2);
    expect(await queue.getDeadLetter(enqueued.id)).toMatchObject({
      sourceJobId: enqueued.id,
      sourceJobName: "probe",
      attemptsMade: 2,
      error: { message: "temporary downstream failure" },
    });
    expect(terminalEvents).toEqual([
      {
        type: "job.dead-lettered",
        queueName: queue.queueName,
        deadLetterQueueName: queue.deadLetterQueueName,
        jobId: enqueued.id,
        jobName: "probe",
        attemptsMade: 2,
        deadLetteredAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(terminalEvents)).not.toContain("temporary downstream failure");
    expect(JSON.stringify(terminalEvents)).not.toContain('"payload"');

    shouldFail = false;
    await expect(queue.retryDeadLetter(enqueued.id)).resolves.toBe(true);
    await waitUntil(() => calls === 3);
    await expect(queue.getDeadLetter(enqueued.id)).resolves.toBeUndefined();
  });

  it("cooperatively cancels active work without retry or dead-letter", async () => {
    const queue = makeQueue();
    let calls = 0;
    let started = false;
    const worker = queue.createWorker({
      probe: async (_payload, context) => {
        calls += 1;
        started = true;
        for (;;) {
          await delay(10);
          await context.throwIfCancellationRequested();
        }
      },
    });
    await worker.waitUntilReady();
    const enqueued = await queue.enqueue(
      "probe",
      { value: 1 },
      {
        idempotencyKey: "cancel-me",
        attempts: 3,
      },
    );
    await waitUntil(() => started);

    await expect(queue.cancel(enqueued.id)).resolves.toBe("cancellation-requested");
    await delay(100);
    expect(calls).toBe(1);
    await expect(queue.getDeadLetter(enqueued.id)).resolves.toBeUndefined();
  });

  it("dead-letters an unregistered job type after retries", async () => {
    const queue = makeQueue();
    const worker = queue.createWorker({} as JobHandlers<TestJobs>);
    await worker.waitUntilReady();
    const enqueued = await queue.enqueue(
      "probe",
      { value: 1 },
      {
        idempotencyKey: "unknown-to-worker",
        attempts: 2,
        backoff: { type: "fixed", delay: 10 },
      },
    );

    await waitUntil(async () => (await queue.getDeadLetter(enqueued.id)) !== undefined);
    await expect(queue.getDeadLetter(enqueued.id)).resolves.toMatchObject({
      sourceJobId: enqueued.id,
      attemptsMade: 2,
      error: { message: "No handler registered for job type probe" },
    });
  });
});

function makeQueue(
  overrides: { onDeadLettered?: (event: Readonly<JobDeadLetteredEvent>) => void } = {},
): DurableJobQueue<TestJobs> {
  const queue = new DurableJobQueue<TestJobs>({
    queueName: `matchday-test-${randomUUID()}`,
    connection: redisConnection(),
    cancellationTtlMs: 5_000,
    ...overrides,
  });
  queues.push(queue);
  return queue;
}

function redisConnection(): ConnectionOptions {
  const url = new URL(process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15");
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    db: Number(url.pathname.slice(1) || "0"),
    ...(url.password.length === 0 ? {} : { password: url.password }),
    maxRetriesPerRequest: null,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for queue state");
    await delay(20);
  }
}
