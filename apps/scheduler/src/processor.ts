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
const DEFAULT_MAX_YIELD_INTERVAL_MS = 1_000;

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
      maxYieldIntervalMs > 1_000
    ) {
      throw new Error("maxYieldIntervalMs must be an integer from cancellationPollMs to 1000");
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

  private callMetric(operation: (metrics: SchedulerMetrics) => void): void {
    if (this.#options.metrics === undefined) return;
    try {
      operation(this.#options.metrics);
    } catch {
      // Exporter failures cannot change persisted scheduler outcomes.
    }
  }
}

function validateClaim(payload: ScheduleQueuePayload, claim: ClaimedScheduleJob): void {
  if (
    claim.jobId !== payload.jobId ||
    claim.competitionId !== payload.competitionId ||
    claim.input.job_id !== payload.jobId ||
    claim.input.competition_id !== payload.competitionId ||
    claim.inputHash !== payload.inputHash ||
    deterministicJsonHash(claim.input) !== claim.inputHash
  ) {
    throw new SchedulerInvariantError("Persisted schedule input does not match its immutable queue identity");
  }
  if (!Number.isInteger(claim.continuationIteration) || claim.continuationIteration < 0 || !claim.fenceToken) {
    throw new SchedulerInvariantError("Invalid schedule persistence claim");
  }
}

function normalizeCandidate(candidate: ScheduleCandidate, claim: ClaimedScheduleJob): ScheduleCandidate {
  if (!Number.isInteger(candidate.iteration) || candidate.iteration < 0) {
    throw new SchedulerInvariantError("Schedule candidate iteration must be a non-negative integer");
  }
  if (
    candidate.result.schema_version !== 1 ||
    candidate.result.job_id !== claim.jobId ||
    candidate.result.source_revision !== claim.input.source_revision ||
    candidate.result.status !== "valid" ||
    candidate.result.quality?.valid !== true
  ) {
    throw new SchedulerInvariantError("Optimizer yielded a candidate with mismatched identity or invalid status");
  }
  const assignmentIds = candidate.result.assignments.map((assignment) => assignment.match_id);
  if (new Set(assignmentIds).size !== assignmentIds.length) {
    throw new SchedulerInvariantError("Optimizer yielded duplicate match assignments");
  }
  const normalizedResult: ScheduleJobResult = {
    ...candidate.result,
    result_revision: 0,
    assignment_hash: deterministicJsonHash(candidate.result.assignments),
  };
  return { iteration: candidate.iteration, result: normalizedResult };
}

export function isStrictImprovement(candidate: ScheduleJobResult, current: ScheduleJobResult | null): boolean {
  if (candidate.status !== "valid" || candidate.quality?.valid !== true) return false;
  if (current === null || current.quality === null) return true;
  if (candidate.quality.score !== current.quality.score) {
    return candidate.quality.score > current.quality.score;
  }
  if (candidate.quality.preferred_penalty !== current.quality.preferred_penalty) {
    return candidate.quality.preferred_penalty < current.quality.preferred_penalty;
  }
  if (candidate.quality.objective !== current.quality.objective) return false;
  switch (candidate.quality.objective) {
    case "fastest":
      if (candidate.quality.makespan_minutes !== current.quality.makespan_minutes) {
        return candidate.quality.makespan_minutes < current.quality.makespan_minutes;
      }
      break;
    case "rest_focused": {
      const candidateRest = candidate.quality.minimum_rest_minutes ?? Number.POSITIVE_INFINITY;
      const currentRest = current.quality.minimum_rest_minutes ?? Number.POSITIVE_INFINITY;
      if (candidateRest !== currentRest) return candidateRest > currentRest;
      break;
    }
    case "balanced": {
      if (candidate.quality.maximum_matches_per_entry_day !== current.quality.maximum_matches_per_entry_day) {
        return candidate.quality.maximum_matches_per_entry_day < current.quality.maximum_matches_per_entry_day;
      }
      const candidateFinalDelta = candidate.quality.preferred_final_delta_minutes ?? Number.NEGATIVE_INFINITY;
      const currentFinalDelta = current.quality.preferred_final_delta_minutes ?? Number.NEGATIVE_INFINITY;
      if (candidateFinalDelta !== currentFinalDelta) return candidateFinalDelta < currentFinalDelta;
      if (candidate.quality.makespan_minutes !== current.quality.makespan_minutes) {
        return candidate.quality.makespan_minutes < current.quality.makespan_minutes;
      }
      break;
    }
  }
  return candidate.assignment_hash.localeCompare(current.assignment_hash) < 0;
}

async function nextWithDeadline(
  iterator: AsyncIterator<ScheduleCandidate>,
  timeoutMs: number,
  abort: AbortController,
): Promise<IteratorResult<ScheduleCandidate>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SolverYieldDeadlineError(timeoutMs);
      abort.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([iterator.next(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
