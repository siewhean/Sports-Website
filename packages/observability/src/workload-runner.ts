import {
  assertC5OperationBudget,
  assertC5WorkloadProfile,
  type C5CorrectnessOracle,
  type C5WorkloadOperation,
  type C5WorkloadProfile,
} from "./workload-profile.js";
import { summarizeWorkload, type WorkloadSample, type WorkloadSummary } from "./workload.js";

export type C5WorkloadExecution = Readonly<{
  operation: C5WorkloadOperation;
  profile: C5WorkloadProfile;
  maximumSamples: number;
  operationTimeoutMs: number;
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
  workerCount: number;
  timeoutCount: number;
  summary: WorkloadSummary;
  correctness: C5CorrectnessOracle;
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

/**
 * Runs only bounded, pre-approved C5 traffic. The adapter owns authenticated
 * HTTP traffic; this primitive owns worker allocation, timeouts, accounting,
 * and the fail-closed latency/correctness conclusion.
 */
export async function executeC5Workload(
  execution: C5WorkloadExecution,
  executor: C5WorkloadExecutor,
  now: () => number = () => performance.now(),
): Promise<C5WorkloadReceipt> {
  assertExecution(execution);
  const workers = workerCount(execution.profile, execution.operation);
  const deadline = now() + execution.profile.durationSeconds * 1_000;
  const samples: WorkloadSample[] = [];
  const correctnessFailures: string[] = [];
  let timeoutCount = 0;
  let nextSampleIndex = 0;

  const runWorker = async (workerIndex: number): Promise<void> => {
    while (now() < deadline) {
      const sampleIndex = nextSampleIndex;
      nextSampleIndex += 1;
      if (sampleIndex >= execution.maximumSamples) return;
      const startedAt = now();
      const signal = AbortSignal.timeout(execution.operationTimeoutMs);
      try {
        const result = await executeWithTimeout(executor, {
          operation: execution.operation,
          workerIndex,
          sampleIndex,
          signal,
        });
        assertResult(result);
        samples.push({ durationMs: now() - startedAt, outcome: result.outcome });
        if (!result.correctness.passed) correctnessFailures.push(result.correctness.failureCode ?? "unspecified");
      } catch (error) {
        samples.push({ durationMs: now() - startedAt, outcome: "unexpected_failure" });
        correctnessFailures.push(error instanceof Error ? error.name : "unknown_error");
        if (error instanceof C5WorkloadTimeoutError) timeoutCount += 1;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, (_, index) => runWorker(index)));
  if (samples.length === 0) throw new Error("C5 workload completed without a sample");
  const summary = summarizeWorkload(samples);
  const correctness: C5CorrectnessOracle =
    correctnessFailures.length === 0
      ? { passed: true }
      : { passed: false, failureCode: [...new Set(correctnessFailures)].sort().join(",") };
  const receipt = { operation: execution.operation, workerCount: workers, timeoutCount, summary, correctness };
  try {
    assertC5OperationBudget(execution.operation, summary, correctness);
  } catch (error) {
    throw new C5WorkloadFailureError(error, receipt);
  }
  return receipt;
}
