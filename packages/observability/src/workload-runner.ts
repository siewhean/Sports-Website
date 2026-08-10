import {
  assertC5OperationBudget,
  assertC5WorkloadProfile,
  type C5CorrectnessOracle,
  type C5WorkloadOperation,
  type C5WorkloadProfile,
} from "./workload-profile.js";
import { summarizeWorkload, type WorkloadSample, type WorkloadSummary } from "./workload.js";

export type C5WorkloadSchedule =
  | Readonly<{ kind: "cadenced"; minimumIntervalMs: 1_000 }>
  | Readonly<{ kind: "convergence_waves"; waveCount: 2; samplesPerWave: 150 }>;

export type C5WorkloadExecution = Readonly<{
  operation: C5WorkloadOperation;
  profile: C5WorkloadProfile;
  sourceSha: string;
  maximumSamples: number;
  operationTimeoutMs: number;
  schedule: C5WorkloadSchedule;
}>;

export type C5WorkloadInvocation = Readonly<{
  operation: C5WorkloadOperation;
  workerIndex: number;
  sampleIndex: number;
  signal: AbortSignal;
}>;

export type C5WorkloadResult = Readonly<{
  outcome: WorkloadSample["outcome"];
  correctness: C5CorrectnessOracle;
}>;

export type C5WorkloadReceipt = Readonly<{
  operation: C5WorkloadOperation;
  sourceSha: string;
  workerCount: number;
  timeoutCount: number;
  elapsedMs: number;
  scheduledCadenceMs: 1_000 | null;
  convergenceWaveCount: 0 | 2;
  convergenceSamplesPerWave: 0 | 150;
  summary: WorkloadSummary;
  correctness: C5CorrectnessOracle;
}>;

export type C5WorkloadTiming = Readonly<{
  now(): number;
  waitUntil(timestampMs: number): Promise<void>;
  timeoutSignal(timeoutMs: number): AbortSignal;
}>;

export type C5WorkloadExecutor = (invocation: C5WorkloadInvocation) => Promise<C5WorkloadResult>;

export class C5WorkloadFailureError extends Error {
  readonly receipt: C5WorkloadReceipt;

  constructor(cause: unknown, receipt: C5WorkloadReceipt) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "C5WorkloadFailureError";
    this.receipt = receipt;
  }
}

const SOURCE_SHA = /^[a-f0-9]{40}$/u;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const MAX_WORKLOAD_SAMPLES = 1_000_000;
const POST_ABORT_SETTLEMENT_GRACE_MS = 100;
const OUTCOMES = new Set<WorkloadSample["outcome"]>(["success", "expected_failure", "unexpected_failure"]);
const FAILURE_CODE = /^[a-z][a-z0-9_,-]{0,199}$/;

class C5WorkloadTimeoutError extends Error {
  constructor() {
    super("C5 workload operation timed out");
    this.name = "C5WorkloadTimeoutError";
  }
}

class C5WorkloadUnsettledAfterAbortError extends C5WorkloadTimeoutError {
  constructor() {
    super();
    this.name = "C5WorkloadUnsettledAfterAbortError";
    this.message = "C5 workload operation did not settle after abort";
  }
}

function workerCount(profile: C5WorkloadProfile, operation: C5WorkloadOperation): number {
  switch (operation) {
    case "score_event_acknowledgement":
    case "lease_takeover":
      return profile.scorekeeperCount;
    case "public_result_convergence":
    case "public_current_conditional_read":
      return profile.publicReaderCount;
    case "repair_publication":
      return profile.organiserWorkerCount;
  }
}

function assertExecution(execution: C5WorkloadExecution): void {
  assertC5WorkloadProfile(execution.profile);
  if (!SOURCE_SHA.test(execution.sourceSha)) throw new Error("C5 workload requires a full source SHA");
  if (
    !Number.isInteger(execution.maximumSamples) ||
    execution.maximumSamples < 1 ||
    execution.maximumSamples > MAX_WORKLOAD_SAMPLES
  ) {
    throw new Error(`C5 maximumSamples must be an integer from 1 to ${String(MAX_WORKLOAD_SAMPLES)}`);
  }
  if (
    !Number.isInteger(execution.operationTimeoutMs) ||
    execution.operationTimeoutMs < 1 ||
    execution.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS
  ) {
    throw new Error(`C5 operationTimeoutMs must be an integer from 1 to ${String(MAX_OPERATION_TIMEOUT_MS)}`);
  }
  if (execution.operation === "public_result_convergence") {
    if (
      execution.schedule.kind !== "convergence_waves" ||
      execution.schedule.waveCount !== 2 ||
      execution.schedule.samplesPerWave !== 150 ||
      execution.maximumSamples !== 300 ||
      workerCount(execution.profile, execution.operation) !== 150
    ) {
      throw new Error("C5 public convergence requires two waves of 150 isolated publications");
    }
  } else if (execution.schedule.kind !== "cadenced" || execution.schedule.minimumIntervalMs !== 1_000) {
    throw new Error("C5 workload requires a one-second minimum per-worker cadence");
  }
}

function assertResult(result: C5WorkloadResult): void {
  if (!OUTCOMES.has(result.outcome)) throw new Error("C5 workload adapter returned an invalid outcome");
  if (typeof result.correctness?.passed !== "boolean") {
    throw new Error("C5 workload adapter returned an invalid correctness oracle");
  }
  if (
    result.correctness.failureCode !== undefined &&
    (typeof result.correctness.failureCode !== "string" || !FAILURE_CODE.test(result.correctness.failureCode))
  ) {
    throw new Error("C5 workload adapter returned an invalid failure code");
  }
}

async function executeWithTimeout(
  executor: C5WorkloadExecutor,
  invocation: C5WorkloadInvocation,
): Promise<C5WorkloadResult> {
  const operation = executor(invocation);
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    const onAbort = () => {
      timedOut = true;
      reject(new C5WorkloadTimeoutError());
    };
    invocation.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut) {
      const settled = operation.then(
        () => true,
        () => true,
      );
      const settledBeforeGrace = await Promise.race([
        settled,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), POST_ABORT_SETTLEMENT_GRACE_MS)),
      ]);
      if (!settledBeforeGrace) throw new C5WorkloadUnsettledAfterAbortError();
    }
    throw error;
  }
}

const defaultTiming: C5WorkloadTiming = {
  now: () => performance.now(),
  waitUntil: async (timestampMs) => {
    const remainingMs = Math.max(0, timestampMs - performance.now());
    if (remainingMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
  },
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
};

/**
 * Runs bounded, pre-approved C5 traffic. Workers are dispatched in rounds, so
 * a worker can never overlap itself. The next round is scheduled one second
 * after the previous round settles; slow requests therefore never create a
 * catch-up burst.
 */
export async function executeC5Workload(
  execution: C5WorkloadExecution,
  executor: C5WorkloadExecutor,
  timing: C5WorkloadTiming = defaultTiming,
): Promise<C5WorkloadReceipt> {
  assertExecution(execution);
  const workers = workerCount(execution.profile, execution.operation);
  const startedAt = timing.now();
  const deadline = startedAt + execution.profile.durationSeconds * 1_000;
  const samples: WorkloadSample[] = [];
  const correctnessFailures: string[] = [];
  let timeoutCount = 0;
  let nextSampleIndex = 0;

  const invoke = async (workerIndex: number): Promise<void> => {
    const sampleIndex = nextSampleIndex++;
    const sampleStartedAt = timing.now();
    const signal = timing.timeoutSignal(execution.operationTimeoutMs);
    try {
      const result = await executeWithTimeout(executor, {
        operation: execution.operation,
        workerIndex,
        sampleIndex,
        signal,
      });
      assertResult(result);
      samples.push({ durationMs: timing.now() - sampleStartedAt, outcome: result.outcome });
      if (!result.correctness.passed) correctnessFailures.push(result.correctness.failureCode ?? "unspecified");
    } catch (error) {
      samples.push({ durationMs: timing.now() - sampleStartedAt, outcome: "unexpected_failure" });
      correctnessFailures.push(error instanceof Error ? error.name : "unknown_error");
      if (error instanceof C5WorkloadTimeoutError) timeoutCount += 1;
    }
  };

  if (execution.schedule.kind === "convergence_waves") {
    await Promise.all(Array.from({ length: 150 }, (_, workerIndex) => invoke(workerIndex)));
    await timing.waitUntil(deadline);
    await Promise.all(Array.from({ length: 150 }, (_, workerIndex) => invoke(workerIndex)));
  } else {
    while (timing.now() < deadline && nextSampleIndex < execution.maximumSamples) {
      const roundSize = Math.min(workers, execution.maximumSamples - nextSampleIndex);
      await Promise.all(Array.from({ length: roundSize }, (_, workerIndex) => invoke(workerIndex)));
      if (timing.now() < deadline && nextSampleIndex < execution.maximumSamples) {
        await timing.waitUntil(Math.min(deadline, timing.now() + execution.schedule.minimumIntervalMs));
      }
    }
    // Reaching the approved ceiling early must not turn the one-hour operation
    // into a shorter smoke run.
    await timing.waitUntil(deadline);
  }

  if (samples.length === 0) throw new Error("C5 workload completed without a sample");
  const summary = summarizeWorkload(samples);
  const correctness: C5CorrectnessOracle =
    correctnessFailures.length === 0
      ? { passed: true }
      : { passed: false, failureCode: [...new Set(correctnessFailures)].sort().join(",") };
  const receipt: C5WorkloadReceipt = {
    operation: execution.operation,
    sourceSha: execution.sourceSha,
    workerCount: workers,
    timeoutCount,
    elapsedMs: timing.now() - startedAt,
    scheduledCadenceMs: execution.schedule.kind === "cadenced" ? 1_000 : null,
    convergenceWaveCount: execution.schedule.kind === "convergence_waves" ? 2 : 0,
    convergenceSamplesPerWave: execution.schedule.kind === "convergence_waves" ? 150 : 0,
    summary,
    correctness,
  };
  try {
    if (receipt.elapsedMs < execution.profile.durationSeconds * 1_000) {
      throw new Error(`C5 ${execution.operation} did not span the approved duration`);
    }
    assertC5OperationBudget(execution.operation, summary, correctness);
  } catch (error) {
    throw new C5WorkloadFailureError(error, receipt);
  }
  return receipt;
}
