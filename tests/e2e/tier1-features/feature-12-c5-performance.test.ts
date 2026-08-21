import { describe, it, expect } from "vitest";
import { C5_WORKLOAD_OPERATIONS, C5_WORKLOAD_BUDGETS, type C5WorkloadOperation } from "@matchday/observability";
import { calculatePercentile } from "../helpers/test-utils";

describe("Tier 1 - Feature 12: C5 Sustained Performance Benchmarking", () => {
  it("F12-T01: C5_WORKLOAD_OPERATIONS defines all 5 required operations and budgets", () => {
    const requiredOps: C5WorkloadOperation[] = [
      "score_event_acknowledgement",
      "public_result_convergence",
      "public_current_conditional_read",
      "lease_takeover",
      "repair_publication",
    ];

    expect(C5_WORKLOAD_OPERATIONS).toHaveLength(5);
    for (const op of requiredOps) {
      expect(C5_WORKLOAD_OPERATIONS).toContain(op);
      const budget = C5_WORKLOAD_BUDGETS[op];
      expect(budget).toBeDefined();
      expect(budget.maxUnexpectedErrorRate).toBe(0);
    }
  });

  it("F12-T02: p95 latency budget for score_event_acknowledgement is <= 500ms", () => {
    const budget = C5_WORKLOAD_BUDGETS.score_event_acknowledgement;
    expect(budget.maxP95Ms).toBeLessThanOrEqual(500);
  });

  it("F12-T03: p95 latency budget for public_current_conditional_read is <= 500ms", () => {
    const budget = C5_WORKLOAD_BUDGETS.public_current_conditional_read;
    expect(budget.maxP95Ms).toBeLessThanOrEqual(500);
  });

  it("F12-T04: p95 latency budgets for convergence, lease takeover, and repair publication are <= 2,000ms", () => {
    expect(C5_WORKLOAD_BUDGETS.public_result_convergence.maxP95Ms).toBeLessThanOrEqual(2_000);
    expect(C5_WORKLOAD_BUDGETS.lease_takeover.maxP95Ms).toBeLessThanOrEqual(2_000);
    expect(C5_WORKLOAD_BUDGETS.repair_publication.maxP95Ms).toBeLessThanOrEqual(2_000);
  });

  it("F12-T05: percentile calculation correctly computes p95 from synthetic sample distribution", () => {
    const samples = Array.from({ length: 500 }, (_, i) => i + 1); // 1..500
    const p95 = calculatePercentile(samples, 95);
    expect(p95).toBe(475);
  });
});
