export interface WorkloadSample {
  readonly durationMs: number;
  readonly outcome: "success" | "expected_failure" | "unexpected_failure";
}

export interface WorkloadSummary {
  readonly sampleCount: number;
  readonly successfulCount: number;
  readonly expectedFailureCount: number;
  readonly unexpectedFailureCount: number;
  readonly errorRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

function percentile(sortedValues: readonly number[], percentileRank: number): number {
  const index = Math.ceil((percentileRank / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)]!;
}

/**
 * Produces a nearest-rank latency summary suitable for retained C5 workload
 * receipts. Expected failures remain visible but do not count as successful
 * operations; unexpected failures define the reported error rate.
 */
export function summarizeWorkload(samples: readonly WorkloadSample[]): WorkloadSummary {
  if (samples.length === 0) throw new Error("Workload summary requires at least one sample");
  const durations = samples.map((sample) => {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) {
      throw new Error("Workload sample duration must be a finite non-negative number");
    }
    return sample.durationMs;
  });
  durations.sort((left, right) => left - right);
  const successfulCount = samples.filter((sample) => sample.outcome === "success").length;
  const expectedFailureCount = samples.filter((sample) => sample.outcome === "expected_failure").length;
  const unexpectedFailureCount = samples.length - successfulCount - expectedFailureCount;
  return {
    sampleCount: samples.length,
    successfulCount,
    expectedFailureCount,
    unexpectedFailureCount,
    errorRate: unexpectedFailureCount / samples.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: durations.at(-1)!,
  };
}

export function assertWorkloadBudget(
  summary: WorkloadSummary,
  budget: Readonly<{ maxP95Ms: number; maxUnexpectedErrorRate: number }>,
): void {
  if (!Number.isFinite(budget.maxP95Ms) || budget.maxP95Ms < 0) throw new Error("Invalid p95 budget");
  if (
    !Number.isFinite(budget.maxUnexpectedErrorRate) ||
    budget.maxUnexpectedErrorRate < 0 ||
    budget.maxUnexpectedErrorRate > 1
  ) {
    throw new Error("Invalid unexpected-error-rate budget");
  }
  if (summary.p95Ms > budget.maxP95Ms) {
    throw new Error(`Workload p95 ${String(summary.p95Ms)}ms exceeds ${String(budget.maxP95Ms)}ms budget`);
  }
  if (summary.errorRate > budget.maxUnexpectedErrorRate) {
    throw new Error(
      `Workload unexpected error rate ${String(summary.errorRate)} exceeds ${String(budget.maxUnexpectedErrorRate)} budget`,
    );
  }
}
