import type { ScheduleJobInput, ScheduleJobResult } from "@matchday/contracts";

export type ScheduleJobState =
  | "queued"
  | "running"
  | "valid_best_found"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "no_solution"
  | "stale";

export type ScheduleQueuePayload = Readonly<{
  schemaVersion: 1;
  jobId: string;
  competitionId: string;
  inputHash: string;
  correlationId: string;
}>;

export type ScheduleQueueResult = Readonly<{
  jobId: string;
  state: Extract<ScheduleJobState, "cancelled" | "completed" | "failed" | "no_solution" | "stale">;
  currentBestRevision: number | null;
  exploredCandidates: number;
}>;

export type ScheduleWorkerJobRegistry = {
  "schedule.optimize": {
    payload: ScheduleQueuePayload;
    result: ScheduleQueueResult;
  };
};

export type ClaimedScheduleJob = Readonly<{
  jobId: string;
  competitionId: string;
  input: ScheduleJobInput;
  inputHash: string;
  fenceToken: string;
  correlationId: string;
  continuedFromJobId: string | null;
  continuationIteration: number;
  currentBest: ScheduleJobResult | null;
}>;

export type ScheduleClaimResult =
  | Readonly<{ outcome: "claimed"; job: ClaimedScheduleJob }>
  | Readonly<{
      outcome: "terminal";
      state: Extract<ScheduleJobState, "cancelled" | "completed" | "failed" | "no_solution" | "stale">;
      currentBestRevision: number | null;
    }>
  | Readonly<{ outcome: "busy" }>
  | Readonly<{ outcome: "missing" }>;

export type ScheduleCheckpointResult = Readonly<{
  accepted: boolean;
  result: ScheduleJobResult | null;
}>;

/**
 * Fenced persistence boundary implemented by the PostgreSQL adapter. Every
 * mutation after claim carries the opaque fence token so an expired worker can
 * never overwrite a newer attempt.
 */
export interface ScheduleJobStore {
  probe(): Promise<boolean>;
  claimJob(request: {
    jobId: string;
    workerId: string;
    expectedInputHash: string;
    leaseMs: number;
  }): Promise<ScheduleClaimResult>;
  renewLease(request: { jobId: string; workerId: string; fenceToken: string; leaseMs: number }): Promise<boolean>;
  getCancellationStatus(
    jobId: string,
    fenceToken: string,
  ): Promise<{ requested: boolean; requestedAtEpochMs: number | null }>;
  checkpointBest(request: {
    jobId: string;
    workerId: string;
    fenceToken: string;
    expectedInputHash: string;
    candidate: ScheduleJobResult;
    iteration: number;
  }): Promise<ScheduleCheckpointResult>;
  finishJob(request: {
    jobId: string;
    workerId: string;
    fenceToken: string;
    state: Extract<ScheduleJobState, "cancelled" | "completed" | "no_solution" | "stale">;
    currentBestRevision: number | null;
  }): Promise<void>;
  releaseAfterFailure(request: {
    jobId: string;
    workerId: string;
    fenceToken: string;
    failureClass: string;
  }): Promise<void>;
  markDeadLettered(jobId: string, failureClass: string): Promise<void>;
  close(): Promise<void>;
}

export type ScheduleCandidate = Readonly<{
  iteration: number;
  result: ScheduleJobResult;
}>;

export interface ScheduleOptimizer {
  /** Validate immutable input before any solving or persistence mutation. */
  validateInput(input: ScheduleJobInput): void;
  /** Independent validation plus canonical quality/violation recomputation. */
  verifyCandidate(
    input: ScheduleJobInput,
    candidate: ScheduleJobResult,
    context: { signal: AbortSignal; maxYieldIntervalMs: number },
  ): Promise<ScheduleJobResult | null>;
  /**
   * Yield deterministic candidates in increasing iteration order. Implementors
   * must observe signal and yield at least once per maxYieldIntervalMs.
   */
  optimize(request: {
    input: ScheduleJobInput;
    seed: ScheduleJobResult | null;
    startIteration: number;
    signal: AbortSignal;
    maxYieldIntervalMs: number;
  }): AsyncIterable<ScheduleCandidate>;
}

export interface SchedulerMetrics {
  jobStarted(objective: string): void;
  candidateExplored(objective: string): void;
  bestCheckpointed(objective: string): void;
  jobFinished(state: ScheduleJobState, durationMs: number): void;
  jobFailed(failureClass: string, durationMs: number): void;
  jobDeadLettered(): void;
  cancellationObserved(latencyMs: number): void;
  activeJobs(delta: 1 | -1): void;
}
