import { randomUUID } from "node:crypto";

import type { ScheduleJobResult } from "@matchday/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerRuntime } from "../../src/runtime.js";
import type { ClaimedScheduleJob, ScheduleCandidate, ScheduleJobStore, ScheduleOptimizer } from "../../src/ports.js";
import { candidate, competitionId, jobId, queuePayload, scheduleInput } from "../fixtures.js";

const describeInfra = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;

describeInfra("SchedulerRuntime with Redis", () => {
  const runtimes: SchedulerRuntime[] = [];
  afterEach(async () => Promise.all(runtimes.splice(0).map((runtime) => runtime.stop().catch(() => undefined))));

  it("deduplicates durable enqueue and completes through a fenced checkpoint", async () => {
    const store = new IntegrationStore();
    const runtime = createRuntime(store, new SequenceOptimizer([{ iteration: 0, result: candidate(77) }]));
    runtimes.push(runtime);
    await runtime.start();

    const payload = queuePayload(store.input);
    const first = await runtime.enqueue(payload);
    const duplicate = await runtime.enqueue(payload);
    await waitUntil(() => store.finished?.state === "completed");

    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(store.claims).toBe(1);
    expect(store.currentBest?.quality?.score).toBe(77);
    expect(await runtime.isReady()).toBe(true);
  });

  it("retries safely, retains the prior best and records terminal dead-letter state", async () => {
    const store = new IntegrationStore({ currentBest: candidate(65, 1) });
    const deadLettered = vi.fn();
    const runtime = createRuntime(
      store,
      {
        validateInput: vi.fn(),
        verifyCandidate: vi.fn(async (_input, value) => value),
        optimize: async function* () {
          throw new Error("deterministic test crash");
        },
      },
      { defaultAttempts: 2, defaultBackoff: { type: "fixed", delay: 10 } },
      deadLettered,
    );
    runtimes.push(runtime);
    await runtime.start();
    await runtime.enqueue(queuePayload(store.input));
    await waitUntil(() => deadLettered.mock.calls.length === 1);
    await waitUntil(() => store.deadLettered);

    expect(store.releases).toBe(2);
    expect(store.currentBest?.result_revision).toBe(1);
    expect(store.deadLettered).toBe(true);
    expect(store.deadLetteredJobId).toBe(jobId);
    expect(deadLettered.mock.calls[0]?.[0]).not.toHaveProperty("payload");
  });
});

function createRuntime(
  store: ScheduleJobStore,
  optimizer: ScheduleOptimizer,
  queueDefaults?: { defaultAttempts: number; defaultBackoff: { type: "fixed"; delay: number } },
  onDeadLettered?: (event: unknown) => void,
) {
  return new SchedulerRuntime({
    queueName: `matchday-scheduler-integration-${randomUUID()}`,
    redisUrl: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15",
    workerId: `test-worker-${randomUUID()}`,
    store,
    optimizer,
    concurrency: 2,
    processor: { leaseMs: 5_000, cancellationPollMs: 20, maxYieldIntervalMs: 100 },
    ...(queueDefaults === undefined ? {} : { queueDefaults }),
    ...(onDeadLettered === undefined ? {} : { onDeadLettered }),
  });
}

class SequenceOptimizer implements ScheduleOptimizer {
  constructor(readonly candidates: readonly ScheduleCandidate[]) {}
  validateInput() {}
  async verifyCandidate(_input: unknown, value: ScheduleJobResult) {
    return Promise.resolve(value);
  }
  async *optimize(): AsyncIterable<ScheduleCandidate> {
    for (const value of this.candidates) yield value;
  }
}

class IntegrationStore implements ScheduleJobStore {
  readonly input = scheduleInput();
  readonly inputHash = queuePayload(this.input).inputHash;
  currentBest: ScheduleJobResult | null;
  finished: { state: string } | undefined;
  claims = 0;
  releases = 0;
  deadLettered = false;
  deadLetteredJobId: string | undefined;

  constructor(options: { currentBest?: ScheduleJobResult } = {}) {
    this.currentBest = options.currentBest ?? null;
  }
  async probe() {
    return true;
  }
  async claimJob(): Promise<{ outcome: "claimed"; job: ClaimedScheduleJob }> {
    this.claims += 1;
    return {
      outcome: "claimed",
      job: {
        jobId,
        competitionId,
        input: this.input,
        inputHash: this.inputHash,
        fenceToken: `fence-${this.claims}`,
        correlationId: "request-phase4-schedule",
        continuedFromJobId: null,
        continuationIteration: 0,
        exploredCandidates: 0,
        currentBest: this.currentBest,
      },
    };
  }
  async renewLease() {
    return true;
  }
  async getCancellationStatus() {
    return { requested: false, requestedAtEpochMs: null };
  }
  async checkpointBest(request: { candidate: ScheduleJobResult }) {
    this.currentBest = { ...request.candidate, result_revision: (this.currentBest?.result_revision ?? 0) + 1 };
    return { accepted: true, result: this.currentBest };
  }
  async recordProgress() {}
  async finishJob(request: { state: "cancelled" | "completed" | "no_solution" | "stale" }) {
    this.finished = { state: request.state };
  }
  async releaseAfterFailure() {
    this.releases += 1;
  }
  async markDeadLettered(deadLetteredJobId: string) {
    this.deadLettered = true;
    this.deadLetteredJobId = deadLetteredJobId;
  }
  async close() {}
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for scheduler state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
