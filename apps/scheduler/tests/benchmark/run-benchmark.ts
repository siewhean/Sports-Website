import type { ScheduleJobInput, ScheduleJobResult } from "@matchday/contracts";
import {
  checkFormatScheduleFeasibility,
  createDefaultFormatTemplates,
  createRoundRobinFormatGraph,
  diagnoseScheduleInfeasibility,
  evaluateScheduleQuality,
  measureScheduleShape,
  toScheduleJobInput,
  validateSchedule,
  type DefaultFormatEntryCount,
  type FormatGraph,
  type ScheduleAssignment,
  type ScheduleProblem,
} from "@matchday/domain";

import { DomainScheduleOptimizer, toDomainAssignment } from "../../src/domain-optimizer.js";
import { isStrictImprovement } from "../../src/processor.js";
import { venueSlots, workspaceDefaults, type BenchmarkScenario } from "./scenarios.js";

export type ScheduleMetrics = {
  score: number;
  backToBacks: number;
  minimumRestMinutes: number | null;
  averageRestMinutes: number | null;
  restSpreadMinutes: number;
  /** Per day: first start to last end, local time. */
  days: string;
  totalDayMinutes: number;
  courtLoadSpreadMinutes: number;
  movedMatches: number;
};

export type ScenarioResult = {
  id: string;
  title: string;
  kind: "feasible" | "infeasible";
  matches: number;
  slots: number;
  iterations: number;
  /** Wall clock for the whole job. */
  jobTimeMs: number;
  /**
   * CPU time this test process spent on the job (main thread plus solver thread). Unlike wall
   * clock it does not grow when other suites share the runner, so CI asserts the targets on it.
   */
  jobCpuMs: number;
  /** null: the job found no schedule (no_solution). */
  metrics: ScheduleMetrics | null;
  assignments: readonly ScheduleAssignment[] | null;
  diagnostics: readonly { code: string; message: string }[];
};

const identity = {
  jobId: "7a3e0000-0000-4000-a000-000000000001",
  competitionId: "7a3e0000-0000-4000-a000-000000000002",
  sourceRevision: 1,
  capacityRevision: 1,
  capacityHash: "0".repeat(64),
};

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(Math.round(minute % 60)).padStart(2, "0")}`;

export function scheduleMetrics(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[]): ScheduleMetrics {
  const shape = measureScheduleShape(problem, assignments);
  return {
    score: evaluateScheduleQuality(problem, assignments).score,
    backToBacks: shape.backToBackCount,
    minimumRestMinutes: shape.minimumRestMinutes,
    averageRestMinutes: shape.averageRestMinutes,
    restSpreadMinutes: shape.restSpreadMinutes,
    days: shape.days
      .map((day) => `${day.date.slice(5)} ${clock(day.firstStartLocalMinute)}-${clock(day.lastEndLocalMinute)}`)
      .join(", "),
    totalDayMinutes: shape.days.reduce((total, day) => total + day.lengthMinutes, 0),
    courtLoadSpreadMinutes: shape.courtLoadSpreadMinutes,
    movedMatches: shape.movedMatchCount,
  };
}

/**
 * Runs the scenario as the scheduler job does: one optimiser run of `iterations` iterations in a
 * single solver thread, every yielded candidate re-verified, the best kept by the processor's own
 * strict-improvement rule. The time is the whole job, wall clock, including the thread start.
 */
export async function runScenario(scenario: BenchmarkScenario): Promise<ScenarioResult> {
  // SCHEDULER_BENCHMARK_FULL runs every fixture as a production job (64 iterations).
  const iterations = process.env.SCHEDULER_BENCHMARK_FULL
    ? 64
    : scenario.expectation.kind === "feasible"
      ? scenario.expectation.iterations
      : 4;
  const input = toScheduleJobInput(scenario.problem, identity) as unknown as ScheduleJobInput;
  const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: iterations, workerExecArgv: [] });
  const signal = new AbortController().signal;
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  let best: ScheduleJobResult | null = null;
  let lastIteration = -1;
  for await (const candidate of optimizer.optimize({
    input,
    seed: null,
    startIteration: 0,
    signal,
    maxYieldIntervalMs: 60_000,
  })) {
    // The processor rejects a run whose iterations do not strictly increase.
    if (candidate.iteration <= lastIteration)
      throw new Error(`${scenario.id}: iteration ${candidate.iteration} repeated`);
    lastIteration = candidate.iteration;
    const verified = await optimizer.verifyCandidate(input, candidate.result, { signal, maxYieldIntervalMs: 60_000 });
    if (verified !== null && isStrictImprovement(verified, best)) best = verified;
  }
  const jobTimeMs = Math.round(performance.now() - started);
  const cpu = process.cpuUsage(cpuStart);
  const jobCpuMs = Math.round((cpu.user + cpu.system) / 1000);
  const assignments = best?.assignments.map(toDomainAssignment) ?? null;
  return {
    id: scenario.id,
    title: scenario.title,
    kind: scenario.expectation.kind,
    matches: scenario.problem.matches.length,
    slots: scenario.problem.slots.length,
    iterations,
    jobTimeMs,
    jobCpuMs,
    metrics: assignments ? scheduleMetrics(scenario.problem, assignments) : null,
    assignments,
    diagnostics:
      assignments === null
        ? diagnoseScheduleInfeasibility(scenario.problem).map(({ code, message }) => ({ code, message }))
        : [],
  };
}

export function isHardValid(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[]): boolean {
  return validateSchedule(problem, assignments).valid;
}

export type FormatCheckTiming = { id: string; formats: number; totalMs: number; statuses: string };

/**
 * The recommendation request path: up to five formats checked per request with the API's caps
 * (60 000 matches x slots per solve, 600 matches for diagnostics). Measured without the API's
 * 1.5 s shared budget, so the number is the unbudgeted worst case for these venues.
 */
export function formatCheckTimings(): FormatCheckTiming[] {
  const cases: { id: string; entries: DefaultFormatEntryCount; divisions: number; courts: number; days: number }[] = [
    { id: "S1 badminton 8 entries, 2 courts, 1 day", entries: 8, divisions: 1, courts: 2, days: 1 },
    { id: "S2-like canoe polo 4 x 16 entries, 4 courts, 2 days", entries: 16, divisions: 4, courts: 4, days: 2 },
    { id: "48 entries, 6 courts, 3 days", entries: 48, divisions: 1, courts: 6, days: 3 },
    { id: "4 x 48 entries, 8 courts, 3 days", entries: 48, divisions: 4, courts: 8, days: 3 },
  ];
  return cases.map((testCase) => {
    const templates = createDefaultFormatTemplates(testCase.entries);
    const graphs: FormatGraph[] = [
      ...templates.map((template) => template.graph),
      createRoundRobinFormatGraph(testCase.entries),
    ].slice(0, 5);
    const slots = venueSlots({ days: testCase.days, courts: testCase.courts, slotMinutes: 30 });
    const started = performance.now();
    const statuses = graphs.map(
      (graph) =>
        checkFormatScheduleFeasibility({
          timeZone: "Asia/Singapore",
          slots,
          durationMinutes: 30,
          divisions: Array.from({ length: testCase.divisions }, (_, index) => ({ divisionId: `d${index + 1}`, graph })),
          constraints: workspaceDefaults(),
          deriveDailyLimit: true,
          maxSolveCells: 60_000,
          maxCheckMatches: 600,
        }).status,
    );
    return {
      id: testCase.id,
      formats: graphs.length,
      totalMs: Math.round(performance.now() - started),
      statuses: statuses.join(", "),
    };
  });
}

const cell = (value: number | string | null) => (value === null ? "-" : String(value));

export function markdownReport(input: {
  results: readonly ScenarioResult[];
  formatChecks: readonly FormatCheckTiming[];
  generatedAt: string;
}): string {
  const lines = [
    "# Scheduler benchmark (Track R3)",
    "",
    `Generated ${input.generatedAt} by \`pnpm bench:scheduler\` (apps/scheduler/tests/benchmark).`,
    "Job time is the whole optimiser run (one solver thread, every candidate re-verified), wall clock; CPU is the",
    "process CPU time for the same run, which CI asserts because it does not grow when suites share a runner.",
    "",
    "## Feasible fixtures",
    "",
    "| Fixture | Matches / slots | Iterations | Job time | CPU | Score | Back-to-backs | Min / avg rest | Rest SD | Days | Court spread | Moved |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const result of input.results.filter((item) => item.kind === "feasible")) {
    const metrics = result.metrics;
    lines.push(
      `| ${result.id} | ${result.matches} / ${result.slots} | ${result.iterations} | ${(result.jobTimeMs / 1000).toFixed(2)} s | ${(result.jobCpuMs / 1000).toFixed(2)} s | ` +
        (metrics
          ? `${metrics.score} | ${metrics.backToBacks} | ${cell(metrics.minimumRestMinutes)} / ${cell(metrics.averageRestMinutes)} | ` +
            `${metrics.restSpreadMinutes} | ${metrics.days} | ${metrics.courtLoadSpreadMinutes} | ${metrics.movedMatches} |`
          : "**no_solution** | | | | | | | |"),
    );
  }
  lines.push("", "## Infeasible fixtures", "", "| Fixture | Job time | Diagnostic | Message |", "|---|---|---|---|");
  for (const result of input.results.filter((item) => item.kind === "infeasible")) {
    const first = result.diagnostics[0];
    lines.push(
      `| ${result.id} | ${(result.jobTimeMs / 1000).toFixed(2)} s | ${first?.code ?? "**none**"} | ${(first?.message ?? "").replaceAll("|", "/")} |`,
    );
  }
  lines.push(
    "",
    "## Format suggestion check (request path, five formats, unbudgeted)",
    "",
    "| Venue | Formats | Total | Statuses |",
    "|---|---|---|---|",
  );
  for (const check of input.formatChecks)
    lines.push(`| ${check.id} | ${check.formats} | ${check.totalMs} ms | ${check.statuses} |`);
  return `${lines.join("\n")}\n`;
}
