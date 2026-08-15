import type { ScheduleJobResult } from "@matchday/contracts";
import type { JobExecutionContext } from "@matchday/jobs";

import { deterministicJsonHash } from "./canonical.js";
import {
  ScheduleJobBusyError,
  ScheduleLeaseLostError,
  SchedulerInvariantError,
  SolverYieldDeadlineError,
} from "./errors.js";
import type {
  ClaimedScheduleJob,
  ScheduleCandidate,
  ScheduleJobStore,
  ScheduleOptimizer,
  ScheduleQueuePayload,
  ScheduleQueueResult,
  SchedulerMetrics,
} from "./ports.js";
import { assertScheduleQueuePayload } from "./queue.js";

export type ScheduleProcessorOptions = Readonly<{
  workerId: string;
  store: ScheduleJobStore;
  optimizer: ScheduleOptimizer;
  metrics?: SchedulerMetrics;
  leaseMs?: number;
  cancellationPollMs?: number;
  maxYieldIntervalMs?: number;
}>;

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_CANCELLATION_POLL_MS = 250;
// Dense but valid V1 schedules can legitimately need more than one second for
// a solver worker operation on shared production compute. Cancellation remains
// independently polled and aborts the worker thread immediately, so this bound
// protects against runaway solver work without making cancellation wait 5s.
const DEFAULT_MAX_YIELD_INTERVAL_MS = 5_000;
const MAX_YIELD_INTERVAL_MS = 10_000;

export class ScheduleJobProcessor {
  readonly #options: Required<Pick<ScheduleProcessorOptions, "leaseMs" | "cancellationPollMs" | "maxYieldIntervalMs">> &
    Omit<ScheduleProcessorOptions, "leaseMs" | "cancellationPollMs" | "maxYieldIntervalMs">;

  constructor(options: ScheduleProcessorOptions) {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const cancellationPollMs = options.cancellationPollMs ?? DEFAULT_CANCELLATION_POLL_MS;
    const maxYieldIntervalMs = options.maxYieldIntervalMs ?? DEFAULT_MAX_YIELD_INTERVAL_MS;
    if (!options.workerId) throw new Error("Scheduler workerId is required");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error("leaseMs must be an integer of at least 1000");
    if (!Number.isInteger(cancellationPollMs) || cancellationPollMs < 10 || cancellationPollMs > 1_000) {
      throw new Error("cancellationPollMs must be an integer from 10 to 1000");
    }
    if (
      !Number.isInteger(maxYieldIntervalMs) ||
      maxYieldIntervalMs < cancellationPollMs ||
      maxYieldIntervalMs > MAX_YIELD_INTERVAL_MS
    ) {
      throw new Error(`maxYieldIntervalMs must be an integer from cancellationPollMs to ${MAX_YIELD_INTERVAL_MS}`);
    }
    this.#options = { ...options, leaseMs, cancellationPollMs, maxYieldIntervalMs };
  }

  async process(payload: ScheduleQueuePayload, context: JobExecutionContext): Promise<ScheduleQueueResult> {
    assertScheduleQueuePayload(payload);
    const startedAt = performance.now();
    let claim: ClaimedScheduleJob | undefined;
    let best: ScheduleJobResult | null = null;
    let exploredCandidates = 0;
    let lastIteration = -1;
    let cancelled = false;
    let backgroundError: Error | undefined;
    const abort = new AbortController();
    let cancellationTimer: NodeJS.Timeout | undefined;
    let leaseTimer: NodeJS.Timeout | undefined;
    let metricsActive = false;

    try {
      const outcome = await this.#options.store.claimJob({
        jobId: payload.jobId,
        workerId: this.#options.workerId,
        expectedInputHash: payload.inputHash,
        leaseMs: this.#options.leaseMs,
      });
      if (outcome.outcome === "missing") throw new SchedulerInvariantError("Schedule job does not exist");
      if (outcome.outcome === "busy") throw new ScheduleJobBusyError(payload.jobId);
      if (outcome.outcome === "terminal") {
        return {
          jobId: payload.jobId,
          state: outcome.state,
          currentBestRevision: outcome.currentBestRevision,
          exploredCandidates: 0,
        };
      }
      const claimed = outcome.job;
      claim = claimed;
      validateClaim(payload, claimed);
      try {
        this.#options.optimizer.validateInput(claimed.input);
      } catch {
        throw new SchedulerInvariantError("Persisted schedule input failed strict domain validation");
      }
      best = claimed.currentBest;
      exploredCandidates = claimed.exploredCandidates;
      lastIteration = claimed.continuationIteration - 1;
      this.callMetric((metrics) => metrics.jobStarted(claimed.input.objective));
      this.callMetric((metrics) => metrics.activeJobs(1));
      metricsActive = true;

      const pollCancellation = async (): Promise<void> => {
        if (cancelled || backgroundError !== undefined) return;
        try {
          const [queueRequested, persisted] = await Promise.all([
            context.isCancellationRequested(),
            this.#options.store.getCancellationStatus(claimed.jobId, claimed.fenceToken),
          ]);
          if (queueRequested || persisted.requested) {
            cancelled = true;
            abort.abort(new Error("Schedule cancellation requested"));
            if (persisted.requestedAtEpochMs !== null) {
              this.callMetric((metrics) =>
                metrics.cancellationObserved(Math.max(0, Date.now() - persisted.requestedAtEpochMs!)),
              );
            }
          }
        } catch (error: unknown) {
          backgroundError = normalizeError(error);
          abort.abort(backgroundError);
        }
      };
      const renewLease = async (): Promise<void> => {
        if (cancelled || backgroundError !== undefined) return;
        try {
          const renewed = await this.#options.store.renewLease({
            jobId: claimed.jobId,
            workerId: this.#options.workerId,
            fenceToken: claimed.fenceToken,
            leaseMs: this.#options.leaseMs,
          });
          if (!renewed) {
            backgroundError = new ScheduleLeaseLostError(claimed.jobId);
            abort.abort(backgroundError);
          }
        } catch (error: unknown) {
          backgroundError = normalizeError(error);
          abort.abort(backgroundError);
        }
      };
      cancellationTimer = setInterval(() => void pollCancellation(), this.#options.cancellationPollMs);
      cancellationTimer.unref();
      leaseTimer = setInterval(() => void renewLease(), Math.floor(this.#options.leaseMs / 3));
      leaseTimer.unref();
      await pollCancellation();

      const iterator = this.#options.optimizer
        .optimize({
          input: claimed.input,
          seed: best,
          startIteration: claimed.continuationIteration,
          signal: abort.signal,
          maxYieldIntervalMs: this.#options.maxYieldIntervalMs,
        })
        [Symbol.asyncIterator]();
      try {
        while (!cancelled) {
          if (backgroundError !== undefined) throw backgroundError;
          const next = await nextWithDeadline(iterator, this.#options.maxYieldIntervalMs, abort);
          if (next.done) break;
          const candidate = normalizeCandidate(next.value, claimed);
          if (candidate.iteration <= lastIteration) {
            throw new SchedulerInvariantError("Optimizer iterations must be strictly increasing");
          }
          lastIteration = candidate.iteration;
          exploredCandidates += 1;
          this.callMetric((metrics) => metrics.candidateExplored(claimed.input.objective));
          const verified = await this.#options.optimizer.verifyCandidate(claimed.input, candidate.result, {
            signal: abort.signal,
            maxYieldIntervalMs: this.#options.maxYieldIntervalMs,
          });
          const verifiedResult =
            verified === null
              ? null
              : normalizeCandidate({ iteration: candidate.iteration, result: verified }, claimed).result;
          let progressCheckpointed = false;
          if (verifiedResult !== null && isStrictImprovement(verifiedResult, best)) {
            const checkpoint = await this.#options.store.checkpointBest({
              jobId: claimed.jobId,
              workerId: this.#options.workerId,
              fenceToken: claimed.fenceToken,
              expectedInputHash: claimed.inputHash,
              candidate: verifiedResult,
              iteration: candidate.iteration,
              exploredCandidates,
            });
            if (checkpoint.accepted) {
              if (checkpoint.result === null) {
                throw new SchedulerInvariantError("Accepted checkpoint did not return its persisted result");
              }
              best = checkpoint.result;
              progressCheckpointed = true;
              this.callMetric((metrics) => metrics.bestCheckpointed(claimed.input.objective));
            }
          }
          if (!progressCheckpointed) {
            await this.#options.store.recordProgress({
              jobId: claimed.jobId,
              workerId: this.#options.workerId,
              fenceToken: claimed.fenceToken,
              iteration: candidate.iteration,
              exploredCandidates,
            });
          }
          await context.updateProgress({
            iteration: candidate.iteration,
            explored_candidates: exploredCandidates,
            checkpointed_best_revision: best?.result_revision ?? 0,
            ...(best?.quality === null || best?.quality === undefined
              ? {}
              : { best_quality_score: best.quality.score }),
          });
          await pollCancellation();
        }
      } finally {
        if (abort.signal.aborted) {
          void iterator.return?.();
        } else {
          await iterator.return?.();
        }
      }

      if (backgroundError !== undefined && !cancelled) throw backgroundError;
      const state = cancelled ? "cancelled" : best === null ? "no_solution" : "completed";
      await this.#options.store.finishJob({
        jobId: claimed.jobId,
        workerId: this.#options.workerId,
        fenceToken: claimed.fenceToken,
        state,
        currentBestRevision: best?.result_revision ?? null,
      });
      this.callMetric((metrics) => metrics.jobFinished(state, performance.now() - startedAt));
      return {
        jobId: claimed.jobId,
        state,
        currentBestRevision: best?.result_revision ?? null,
        exploredCandidates,
      };
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      this.callMetric((metrics) => metrics.jobFailed(normalized.name, performance.now() - startedAt));
      if (claim !== undefined) {
        await this.#options.store
          .releaseAfterFailure({
            jobId: claim.jobId,
            workerId: this.#options.workerId,
            fenceToken: claim.fenceToken,
            failureClass: normalized.name,
          })
          .catch(() => undefined);
      }
      throw normalized;
    } finally {
      abort.abort();
      if (cancellationTimer !== undefined) clearInterval(cancellationTimer);
      if (leaseTimer !== undefined) clearInterval(leaseTimer);
      if (metricsActive) this.callMetric((metrics) => metrics.activeJobs(-1));
    }
  }

  private callMetric(callback: (metrics: SchedulerMetrics) => void) {
    if (this.#options.metrics) callback(this.#options.metrics);
  }
}

export function isStrictImprovement(candidate: ScheduleJobResult, current: ScheduleJobResult | null): boolean {
  if (candidate.status !== "valid" || candidate.quality === null || !candidate.quality.valid) return false;
  if (current === null || current.quality === null || !current.quality.valid) return true;
  if (candidate.quality.objective !== current.quality.objective) return false;
  const candidateKey = qualityKey(candidate);
  const currentKey = qualityKey(current);
  for (let index = 0; index < candidateKey.length; index += 1) {
    if (candidateKey[index]! < currentKey[index]!) return true;
    if (candidateKey[index]! > currentKey[index]!) return false;
  }
  return candidate.assignment_hash < current.assignment_hash;
}

function qualityKey(result: ScheduleJobResult): number[] {
  const quality = result.quality!;
  if (quality.objective === "fastest") {
    return [quality.makespan_minutes, quality.preferred_penalty, -quality.minimum_rest_minutes!];
  }
  if (quality.objective === "rest_focused") {
    return [-quality.minimum_rest_minutes!, quality.makespan_minutes, quality.preferred_penalty];
  }
  return [quality.preferred_penalty, quality.makespan_minutes, -quality.minimum_rest_minutes!];
}

function normalizeCandidate(candidate: ScheduleCandidate, claimed: ClaimedScheduleJob): ScheduleCandidate {
  const result = candidate.result;
  if (result.schema_version !== 1 || result.job_id !== claimed.jobId || result.source_revision !== claimed.input.source_revision) {
    throw new SchedulerInvariantError("Optimizer candidate provenance does not match the claimed job");
  }
  if (result.status !== "valid" || result.quality === null || !result.quality.valid) {
    throw new SchedulerInvariantError("Optimizer produced an invalid checkpoint candidate");
  }
  if (result.quality.objective !== claimed.input.objective) {
    throw new SchedulerInvariantError("Optimizer candidate objective does not match the claimed job");
  }
  return {
    iteration: candidate.iteration,
    result: {
      ...result,
      assignment_hash: deterministicJsonHash(result.assignments),
    },
  };
}

function validateClaim(payload: ScheduleQueuePayload, claimed: ClaimedScheduleJob): void {
  if (
    claimed.jobId !== payload.jobId ||
    claimed.competitionId !== payload.competitionId ||
    claimed.inputHash !== payload.inputHash ||
    claimed.correlationId !== payload.correlationId ||
    claimed.input.job_id !== payload.jobId ||
    claimed.input.competition_id !== payload.competitionId
  ) {
    throw new SchedulerInvariantError("Claimed schedule job does not match queue payload");
  }
  const expectedInputHash = deterministicJsonHash(claimed.input);
  if (expectedInputHash !== claimed.inputHash) {
    throw new SchedulerInvariantError("Persisted schedule input hash does not match canonical input");
  }
}

async function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  deadlineMs: number,
  abort: AbortController,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new SolverYieldDeadlineError(deadlineMs);
          abort.abort(error);
          reject(error);
        }, deadlineMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
