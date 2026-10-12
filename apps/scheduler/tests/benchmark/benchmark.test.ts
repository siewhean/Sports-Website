import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { measureScheduleShape } from "@matchday/domain";
import { beforeAll, describe, expect, it } from "vitest";

import {
  formatCheckTimings,
  isHardValid,
  markdownReport,
  runScenario,
  type FormatCheckTiming,
  type ScenarioResult,
} from "./run-benchmark.js";
import { benchmarkScenarios, type BenchmarkScenario } from "./scenarios.js";

// Track R3 targets, asserted on every fixture. `pnpm bench:scheduler` runs this suite and writes
// the report to docs/qa (SCHEDULER_BENCHMARK_REPORT); CI runs it with the scheduler unit tests.
const FORMAT_CHECK_TARGET_MS = 2_000;

const scenarios = benchmarkScenarios();
const results = new Map<string, ScenarioResult>();
let formatChecks: FormatCheckTiming[] = [];

beforeAll(async () => {
  for (const scenario of scenarios) results.set(scenario.id, await runScenario(scenario));
  formatChecks = formatCheckTimings();
  const reportPath = process.env.SCHEDULER_BENCHMARK_REPORT;
  if (reportPath) {
    const base = resolve(reportPath);
    mkdirSync(dirname(base), { recursive: true });
    const ordered = scenarios.map((scenario) => results.get(scenario.id)!);
    const generatedAt = new Date().toISOString();
    writeFileSync(`${base}.md`, markdownReport({ results: ordered, formatChecks, generatedAt }));
    writeFileSync(
      `${base}.json`,
      `${JSON.stringify(
        {
          generatedAt,
          node: process.version,
          results: ordered.map((result) => ({ ...result, assignments: undefined })),
          formatChecks,
        },
        null,
        2,
      )}\n`,
    );
  }
}, 600_000);

const feasible = scenarios.filter(
  (scenario): scenario is BenchmarkScenario & { expectation: { kind: "feasible" } } =>
    scenario.expectation.kind === "feasible",
);
const infeasible = scenarios.filter(
  (scenario): scenario is BenchmarkScenario & { expectation: { kind: "infeasible" } } =>
    scenario.expectation.kind === "infeasible",
);

describe("R3 benchmark: feasible fixtures never return no_solution", () => {
  it.each(feasible.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
    const result = results.get(scenario.id)!;
    expect(result.metrics, `${scenario.id} returned no_solution`).not.toBeNull();
    expect(isHardValid(scenario.problem, result.assignments!)).toBe(true);
    for (const matchId of scenario.expectation.lockedMatchIds ?? []) {
      const locked = scenario.problem.matches.find((match) => match.id === matchId)!.fixedAssignment!;
      expect(result.assignments!.find((assignment) => assignment.matchId === matchId)?.slotId).toBe(locked.slotId);
    }
  });
});

describe("R3 benchmark: job time targets", () => {
  const timed = feasible.filter((scenario) => scenario.expectation.jobTimeTargetMs !== undefined);
  it.each(timed.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
    expect(results.get(scenario.id)!.jobTimeMs).toBeLessThanOrEqual(scenario.expectation.jobTimeTargetMs!);
  });
});

describe("R3 benchmark: back-to-backs", () => {
  const withWitness = feasible.filter((scenario) => scenario.expectation.backToBacks?.kind === "witness");
  it.each(withWitness.map((scenario) => [scenario.id, scenario] as const))(
    "%s: a 0 witness exists, so the job reaches 0",
    (_id, scenario) => {
      const backToBacks = scenario.expectation.backToBacks;
      if (backToBacks?.kind !== "witness") throw new Error("fixture has no witness");
      expect(isHardValid(scenario.problem, backToBacks.witness)).toBe(true);
      expect(measureScheduleShape(scenario.problem, backToBacks.witness).backToBackCount).toBe(0);
      expect(results.get(scenario.id)!.metrics?.backToBacks).toBe(0);
    },
  );

  const impossible = feasible.filter((scenario) => scenario.expectation.backToBacks?.kind === "impossible");
  it.each(impossible.map((scenario) => [scenario.id, scenario] as const))(
    "%s: capacity does not allow 0 (proved in the fixture)",
    (_id, scenario) => {
      expect(results.get(scenario.id)!.metrics?.backToBacks).toBeGreaterThan(0);
    },
  );
});

describe("R3 benchmark: re-planning moves only affected matches", () => {
  const repairs = feasible.filter((scenario) => scenario.expectation.displacedMatchIds !== undefined);
  it.each(repairs.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
    const displaced = scenario.expectation.displacedMatchIds!;
    expect(displaced.length).toBeGreaterThan(0);
    const previous = scenario.problem.constraints.preserveExistingSchedule.value.byMatchId;
    const moved = results
      .get(scenario.id)!
      .assignments!.filter((assignment) => {
        const before = previous[assignment.matchId]!;
        return before.areaId !== assignment.areaId || before.startEpochMs !== assignment.startEpochMs;
      })
      .map((assignment) => assignment.matchId)
      .sort();
    expect(moved).toEqual([...displaced].sort());
  });
});

describe("R3 benchmark: infeasible fixtures name the cause and the fix", () => {
  it.each(infeasible.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
    const result = results.get(scenario.id)!;
    expect(result.metrics).toBeNull();
    const finding = result.diagnostics.find((diagnostic) => diagnostic.code === scenario.expectation.code);
    expect(finding, `${scenario.id}: ${JSON.stringify(result.diagnostics)}`).toBeDefined();
    expect(finding!.message).toMatch(scenario.expectation.fix);
  });
});

describe("R3 benchmark: format suggestion check", () => {
  it("checks five formats per request within the bound", () => {
    expect(formatChecks.length).toBeGreaterThan(0);
    for (const check of formatChecks) expect(check.totalMs, check.id).toBeLessThanOrEqual(FORMAT_CHECK_TARGET_MS);
  });
});
