import type { ScheduleJobResult } from "@matchday/contracts";
import { describe, expect, it, vi } from "vitest";

import { SchedulerInvariantError, SolverYieldDeadlineError } from "../../src/errors.js";
import { isStrictImprovement, ScheduleJobProcessor } from "../../src/processor.js";
import type { ClaimedScheduleJob, ScheduleCandidate, ScheduleJobStore, ScheduleOptimizer } from "../../src/ports.js";
import { candidate, competitionId, executionContext, jobId, queuePayload, scheduleInput } from "../fixtures.js";

describe("ScheduleJobProcessor", () => {
  it("checkpoints only strict valid improvements and reports measurable progress", async () => {
    const store = new MemoryStore();
    const optimizer = new SequenceOptimizer([
      { iteration: 0, result: candidate(60) },
      { iteration: 1, result: candidate(55) },
      { iteration: 2, result: candidate(80) },
    ]);
    const context = executionContext();
    const processor = processorWith(store, optimizer);

    const result = await processor.process(queuePayload(store.input), context);

    expect(result).toEqual({
      jobId,
      state: "completed",
      currentBestRevision: 2,
      exploredCandidates: 3,
    });
    expect(store.checkpoints.map(({ candidate }) => candidate.quality?.score)).toEqual([60, 80]);
    expect(context.updateProgress).toHaveBeenLastCalledWith({
      iteration: 2,
      explored_candidates: 3,
      checkpointed_best_revision: 2,
      best_quality_score: 80,
    });
    expect(store.finished).toEqual({ state: "completed", currentBestRevision: 2 });
  });

  it("resumes the exact lineage from the persisted best and next iteration", async () => {
    const store = new MemoryStore({ currentBest: candidate(70, 4), continuationIteration: 9 });
    const optimizer = new SequenceOptimizer([{ iteration: 9, result: candidate(75) }]);

    await processorWith(store, optimizer).process(queuePayload(store.input), executionContext());

    expect(optimizer.request).toMatchObject({ startIteration: 9, seed: { result_revision: 4 } });
    expect(store.checkpoints).toHaveLength(1);
    expect(store.finished).toEqual({ state: "completed", currentBestRevision: 5 });
  });

  it("ranks and checkpoints only the trusted recomputed candidate provenance", async () => {
    const store = new MemoryStore({ currentBest: candidate(50, 1) });
    const optimizer = new SequenceOptimizer([{ iteration: 0, result: candidate(999) }]);
    optimizer.verifyCandidate.mockImplementation(async (_input, value) => ({
      ...value,
      quality: { ...value.quality, score: 10, objective: "balanced", components: [] },
      assignment_hash: "f".repeat(64),
    }));

    const result = await processorWith(store, optimizer).process(queuePayload(store.input), executionContext());

    expect(store.checkpoints).toHaveLength(0);
    expect(result.currentBestRevision).toBe(1);
  });

  it("observes cancellation within the polling bound and preserves its current best", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore({ currentBest: candidate(70, 3) });
      let checks = 0;
      store.getCancellationStatus = vi.fn(
        async (): Promise<{ requested: boolean; requestedAtEpochMs: number | null }> => ({
          requested: ++checks >= 2,
          requestedAtEpochMs: Date.now() - 5,
        }),
      );
      const optimizer: ScheduleOptimizer = {
        validateInput: vi.fn(),
        verifyCandidate: vi.fn(async (_input, value) => value),
        optimize: async function* ({ signal }) {
          let iteration = 0;
          while (!signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield { iteration: iteration++, result: candidate(70) };
          }
        },
      };
      const resultPromise = processorWith(store, optimizer, { cancellationPollMs: 10, maxYieldIntervalMs: 50 }).process(
        queuePayload(store.input),
        executionContext(),
      );

      await vi.advanceTimersByTimeAsync(40);
      const result = await resultPromise;

      expect(result.state).toBe("cancelled");
      expect(result.currentBestRevision).toBe(3);
      expect(store.checkpoints).toHaveLength(0);
      expect(store.finished).toEqual({ state: "cancelled", currentBestRevision: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a failed attempt without deleting a persisted best", async () => {
    const store = new MemoryStore({ currentBest: candidate(68, 2) });
    const optimizer: ScheduleOptimizer = {
      validateInput: vi.fn(),
      verifyCandidate: vi.fn(async (_input, value) => value),
      optimize: async function* () {
        throw new Error("solver crashed");
      },
    };

    await expect(
      processorWith(store, optimizer).process(queuePayload(store.input), executionContext()),
    ).rejects.toThrow("solver crashed");
    expect(store.released).toEqual({ failureClass: "Error", retainedBestRevision: 2 });
    expect(store.finished).toBeUndefined();
  });

  it("rejects a forged persisted input before invoking the optimizer", async () => {
    const store = new MemoryStore();
    const optimizer = new SequenceOptimizer([]);
    store.inputHash = "a".repeat(64);

    await expect(
      processorWith(store, optimizer).process(
        { ...queuePayload(store.input), inputHash: store.inputHash },
        executionContext(),
      ),
    ).rejects.toBeInstanceOf(SchedulerInvariantError);
    expect(optimizer.validateInput).not.toHaveBeenCalled();
    expect(store.released?.failureClass).toBe("SchedulerInvariantError");
  });

  it("classifies strict domain input rejection as permanent invalid input", async () => {
    const store = new MemoryStore();
    const optimizer = new SequenceOptimizer([]);
    optimizer.validateInput.mockImplementation(() => {
      throw new Error("invalid IANA time zone");
    });

    await expect(
      processorWith(store, optimizer).process(queuePayload(store.input), executionContext()),
    ).rejects.toThrow("strict domain validation");
    expect(store.released?.failureClass).toBe("SchedulerInvariantError");
  });

  it("aborts and retries an optimizer that does not yield within its declared bound", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const optimizer: ScheduleOptimizer = {
        validateInput: vi.fn(),
        verifyCandidate: vi.fn(async (_input, value) => value),
        optimize: async function* () {
          await new Promise(() => undefined);
        },
      };
      const result = processorWith(store, optimizer, { cancellationPollMs: 10, maxYieldIntervalMs: 20 }).process(
        queuePayload(store.input),
        executionContext(),
      );
      const rejection = expect(result).rejects.toBeInstanceOf(SolverYieldDeadlineError);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(store.released?.retainedBestRevision).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isStrictImprovement", () => {
  it("uses balanced objective metrics before the stable hash", () => {
    const current = candidate(80);
    const betterMakespan = { ...candidate(80), quality: { ...candidate(80).quality!, makespan_minutes: 90 } };
    expect(isStrictImprovement(betterMakespan, current)).toBe(true);
    const lowerPenalty = {
      ...candidate(80),
      quality: { ...candidate(80).quality!, preferred_penalty: candidate(80).quality!.preferred_penalty - 1 },
    };
    expect(isStrictImprovement(lowerPenalty, current)).toBe(true);
    expect(
      isStrictImprovement(
        { ...candidate(80), assignment_hash: "0".repeat(64) },
        { ...current, assignment_hash: "f".repeat(64) },
      ),
    ).toBe(true);
    expect(isStrictImprovement(current, current)).toBe(false);
    expect(isStrictImprovement(candidate(79), current)).toBe(false);
  });

  it("uses fastest and rest-focused objective tie-breaks before the stable hash", () => {
    const fastest = {
      ...candidate(80),
      assignment_hash: "f".repeat(64),
      quality: { ...candidate(80).quality!, objective: "fastest" as const, makespan_minutes: 100 },
    };
    expect(
      isStrictImprovement(
        {
          ...fastest,
          assignment_hash: "0".repeat(64),
          quality: { ...fastest.quality, makespan_minutes: 110 },
        },
        fastest,
      ),
    ).toBe(false);
    expect(isStrictImprovement({ ...fastest, quality: { ...fastest.quality, makespan_minutes: 90 } }, fastest)).toBe(
      true,
    );

    const rested = {
      ...candidate(80),
      quality: { ...candidate(80).quality!, objective: "rest_focused" as const, minimum_rest_minutes: 30 },
    };
    expect(isStrictImprovement({ ...rested, quality: { ...rested.quality, minimum_rest_minutes: 60 } }, rested)).toBe(
      true,
    );
    expect(isStrictImprovement({ ...rested, quality: { ...rested.quality, minimum_rest_minutes: null } }, rested)).toBe(
      true,
    );
  });

  it("rejects a mismatched objective even when the stable hash sorts first", () => {
    expect(
      isStrictImprovement(
        {
          ...candidate(80),
          assignment_hash: "0".repeat(64),
          quality: { ...candidate(80).quality!, objective: "fastest" },
        },
        { ...candidate(80), assignment_hash: "f".repeat(64) },
      ),
    ).toBe(false);
  });

  it("rejects yield bounds above the one-second cancellation contract", () => {
    expect(
      () =>
        new ScheduleJobProcessor({
          workerId: "scheduler-test-worker",
          store: new MemoryStore(),
          optimizer: new SequenceOptimizer([]),
          leaseMs: 1_000,
          cancellationPollMs: 10,
          maxYieldIntervalMs: 1_001,
        }),
    ).toThrow("maxYieldIntervalMs must be an integer from cancellationPollMs to 1000");
  });
});

class SequenceOptimizer implements ScheduleOptimizer {
  readonly validateInput = vi.fn();
  readonly verifyCandidate = vi.fn(async (_input, value: ScheduleJobResult) => value);
  request: Parameters<ScheduleOptimizer["optimize"]>[0] | undefined;

  constructor(readonly candidates: readonly ScheduleCandidate[]) {}

  async *optimize(request: Parameters<ScheduleOptimizer["optimize"]>[0]): AsyncIterable<ScheduleCandidate> {
    this.request = request;
    for (const next of this.candidates) yield next;
  }
}

class MemoryStore implements ScheduleJobStore {
  readonly input = scheduleInput();
  inputHash = queuePayload(this.input).inputHash;
  readonly checkpoints: { candidate: ScheduleJobResult; iteration: number }[] = [];
  finished: { state: string; currentBestRevision: number | null } | undefined;
  released: { failureClass: string; retainedBestRevision: number | null } | undefined;
  currentBest: ScheduleJobResult | null;
  continuationIteration: number;

  constructor(options: { currentBest?: ScheduleJobResult; continuationIteration?: number } = {}) {
    this.currentBest = options.currentBest ?? null;
    this.continuationIteration = options.continuationIteration ?? 0;
  }

  async probe() {
    return true;
  }
  async claimJob(): Promise<{ outcome: "claimed"; job: ClaimedScheduleJob }> {
    return {
      outcome: "claimed",
      job: {
        jobId,
        competitionId,
        input: this.input,
        inputHash: this.inputHash,
        fenceToken: "fence-1",
        correlationId: "request-phase4-schedule",
        continuedFromJobId: null,
        continuationIteration: this.continuationIteration,
        currentBest: this.currentBest,
      },
    };
  }
  async renewLease() {
    return true;
  }
  getCancellationStatus: ScheduleJobStore["getCancellationStatus"] = vi.fn(async () => ({
    requested: false,
    requestedAtEpochMs: null,
  }));
  async checkpointBest(request: { candidate: ScheduleJobResult; iteration: number }) {
    this.checkpoints.push({ candidate: request.candidate, iteration: request.iteration });
    const result = { ...request.candidate, result_revision: (this.currentBest?.result_revision ?? 0) + 1 };
    this.currentBest = result;
    return { accepted: true, result };
  }
  async finishJob(request: {
    state: "cancelled" | "completed" | "no_solution" | "stale";
    currentBestRevision: number | null;
  }) {
    this.finished = { state: request.state, currentBestRevision: request.currentBestRevision };
  }
  async releaseAfterFailure(request: { failureClass: string }) {
    this.released = {
      failureClass: request.failureClass,
      retainedBestRevision: this.currentBest?.result_revision ?? null,
    };
  }
  async markDeadLettered() {}
  async close() {}
}

function processorWith(
  store: ScheduleJobStore,
  optimizer: ScheduleOptimizer,
  timing: { cancellationPollMs?: number; maxYieldIntervalMs?: number } = {},
) {
  return new ScheduleJobProcessor({
    workerId: "scheduler-test-worker",
    store,
    optimizer,
    leaseMs: 1_000,
    cancellationPollMs: timing.cancellationPollMs ?? 10,
    maxYieldIntervalMs: timing.maxYieldIntervalMs ?? 50,
  });
}
