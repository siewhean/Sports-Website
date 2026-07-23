import type {
  ScheduleAssignment as TransportAssignment,
  ScheduleJobInput,
  ScheduleJobResult,
  ScheduleQuality as TransportQuality,
  ScheduleViolation as TransportViolation,
} from "@matchday/contracts";
import {
  evaluateScheduleQuality,
  generateScheduleCandidates,
  validateSchedule,
  type ConstraintSetting,
  type ScheduleAssignment,
  type ScheduleProblem,
  type SchedulingConstraints,
} from "@matchday/domain";
import { Worker } from "node:worker_threads";

import { SchedulerInvariantError, SolverYieldDeadlineError } from "./errors.js";
import type { ScheduleOptimizer } from "./ports.js";

export class DomainScheduleOptimizer implements ScheduleOptimizer {
  readonly #maxIterationsPerRun: number;
  readonly #workerExecArgv: string[] | undefined;

  constructor(options: { maxIterationsPerRun?: number; workerExecArgv?: readonly string[] } = {}) {
    this.#maxIterationsPerRun = options.maxIterationsPerRun ?? 64;
    this.#workerExecArgv = options.workerExecArgv ? [...options.workerExecArgv] : undefined;
    if (
      !Number.isInteger(this.#maxIterationsPerRun) ||
      this.#maxIterationsPerRun < 1 ||
      this.#maxIterationsPerRun > 256
    ) {
      throw new Error("maxIterationsPerRun must be an integer from 1 to 256");
    }
  }

  validateInput(input: ScheduleJobInput): void {
    assertExactScheduleJobInput(input);
    toProblem(input);
  }

  async verifyCandidate(
    input: ScheduleJobInput,
    candidate: ScheduleJobResult,
    context: { signal: AbortSignal; maxYieldIntervalMs: number } = {
      signal: new AbortController().signal,
      maxYieldIntervalMs: 1_000,
    },
  ): Promise<ScheduleJobResult | null> {
    const problem = toProblem(input);
    const assignments = candidate.assignments.map(toDomainAssignment);
    const verified = await runSolverThread<{
      validation: ReturnType<typeof validateSchedule>;
      quality: ReturnType<typeof evaluateScheduleQuality>;
    }>({ operation: "verify", problem, assignments }, context.signal, context.maxYieldIntervalMs, this.#workerExecArgv);
    if (verified === null) return null;
    const { validation, quality } = verified;
    if (!validation.valid || !quality.valid) return null;
    return {
      ...candidate,
      violations: validation.violations.map(toTransportViolation),
      quality: toTransportQuality(quality),
    };
  }

  async *optimize(request: Parameters<ScheduleOptimizer["optimize"]>[0]) {
    const problem = toProblem(request.input);
    if (request.seed !== null) {
      const seed = request.seed.assignments.map(toDomainAssignment);
      const verifiedSeed = await runSolverThread<{
        validation: ReturnType<typeof validateSchedule>;
        quality: ReturnType<typeof evaluateScheduleQuality>;
      }>(
        { operation: "verify", problem, assignments: seed },
        request.signal,
        request.maxYieldIntervalMs,
        this.#workerExecArgv,
      );
      if (verifiedSeed === null) return;
      if (!verifiedSeed.validation.valid || !verifiedSeed.quality.valid) {
        throw new Error("Persisted continuation seed is invalid");
      }
    }
    const endIteration = request.startIteration + this.#maxIterationsPerRun;
    for (let iteration = request.startIteration; iteration < endIteration; iteration += 1) {
      if (request.signal.aborted) return;
      const generated = await runSolverThread<
        ReadonlyArray<{
          candidate: ReturnType<typeof generateScheduleCandidates>[number];
          validation: ReturnType<typeof validateSchedule>;
          quality: ReturnType<typeof evaluateScheduleQuality>;
        }>
      >(
        { operation: "generate", problem, iteration },
        request.signal,
        request.maxYieldIntervalMs,
        this.#workerExecArgv,
      );
      if (generated === null) return;
      for (const { candidate, validation, quality } of generated) {
        if (request.signal.aborted) return;
        if (!validation.valid || !quality.valid) continue;
        yield {
          iteration: candidate.iteration,
          result: {
            schema_version: 1 as const,
            job_id: request.input.job_id,
            source_revision: request.input.source_revision,
            result_revision: 0,
            status: "valid" as const,
            assignments: candidate.assignments.map(toTransportAssignment),
            violations: validation.violations.map(toTransportViolation),
            quality: toTransportQuality(quality),
            assignment_hash: "0".repeat(64),
          },
        };
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

async function runSolverThread<Result>(
  workerData: Record<string, unknown>,
  signal: AbortSignal,
  deadlineMs: number,
  workerExecArgv?: readonly string[],
): Promise<Result | null> {
  if (signal.aborted) return null;
  return new Promise<Result | null>((resolve, reject) => {
    const worker = new Worker(new URL("./solver-thread.mjs", import.meta.url), {
      workerData,
      ...(workerExecArgv === undefined ? {} : { execArgv: [...workerExecArgv] }),
    });
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () =>
      finish(() => {
        void worker.terminate();
        resolve(null);
      });
    const timer = setTimeout(
      () =>
        finish(() => {
          void worker.terminate();
          reject(new SolverYieldDeadlineError(deadlineMs));
        }),
      deadlineMs,
    );
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: { ok: boolean; result?: Result; error?: string }) => {
      finish(() => {
        void worker.terminate();
        if (message.ok && message.result !== undefined) resolve(message.result);
        else reject(new SchedulerInvariantError(message.error ?? "Schedule domain worker rejected input"));
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`Schedule solver worker exited with code ${code}`)));
    });
  });
}

function toProblem(input: ScheduleJobInput): ScheduleProblem {
  const constraints: SchedulingConstraints = {
    minimumRest: setting(input.constraints.minimum_rest, { minutes: input.constraints.minimum_rest.value.minutes }),
    maximumMatchesPerDay: setting(input.constraints.maximum_matches_per_day, {
      matches: input.constraints.maximum_matches_per_day.value.matches,
    }),
    preferredFinalTime: setting(input.constraints.preferred_final_time, {
      targetStartEpochMs: input.constraints.preferred_final_time.value.target_start_epoch_ms,
      toleranceMinutes: input.constraints.preferred_final_time.value.tolerance_minutes,
    }),
    entryUnavailable: setting(input.constraints.entry_unavailable, {
      byEntryId: Object.fromEntries(
        Object.entries(input.constraints.entry_unavailable.value.by_entry_id).map(([id, intervals]) => [
          id,
          intervals.map((interval) => ({
            startEpochMs: interval.start_epoch_ms,
            endEpochMs: interval.end_epoch_ms,
          })),
        ]),
      ),
    }),
    officialAvailability: setting(input.constraints.official_availability, {
      byOfficialId: Object.fromEntries(
        Object.entries(input.constraints.official_availability.value.by_official_id).map(([id, intervals]) => [
          id,
          intervals.map((interval) => ({
            startEpochMs: interval.start_epoch_ms,
            endEpochMs: interval.end_epoch_ms,
          })),
        ]),
      ),
    }),
    featuredPlayingArea: setting(input.constraints.featured_playing_area, {
      areaId: input.constraints.featured_playing_area.value.area_id,
      matchIds: input.constraints.featured_playing_area.value.match_ids,
    }),
    avoidConsecutiveMatches: setting(input.constraints.avoid_consecutive_matches, {
      minutes: input.constraints.avoid_consecutive_matches.value.minutes,
    }),
    balanceEarlyMatches: setting(input.constraints.balance_early_matches, {
      beforeLocalTime: input.constraints.balance_early_matches.value.before_local_time,
    }),
    balanceLateMatches: setting(input.constraints.balance_late_matches, {
      atOrAfterLocalTime: input.constraints.balance_late_matches.value.at_or_after_local_time,
    }),
    keepDivisionTogether: setting(input.constraints.keep_division_together, {
      maximumAreaCount: input.constraints.keep_division_together.value.maximum_area_count,
    }),
    preserveExistingSchedule: setting(input.constraints.preserve_existing_schedule, {
      maximumShiftMinutes: input.constraints.preserve_existing_schedule.value.maximum_shift_minutes,
      byMatchId: Object.fromEntries(
        Object.entries(input.constraints.preserve_existing_schedule.value.by_match_id).map(([id, assignment]) => [
          id,
          { areaId: assignment.area_id, startEpochMs: assignment.start_epoch_ms },
        ]),
      ),
    }),
  };
  return {
    timeZone: input.time_zone,
    objective: input.objective,
    matches: input.matches.map((match) => ({
      id: match.match_id,
      divisionId: match.division_id,
      durationMinutes: match.duration_minutes,
      dependencyMatchIds: match.dependency_match_ids,
      possibleEntryIds: match.possible_entry_ids,
      officialIds: match.official_ids,
      isChampionshipFinal: match.is_championship_final,
      ...(match.fixed_assignment === undefined
        ? {}
        : {
            fixedAssignment: {
              reason: match.fixed_assignment.reason,
              areaId: match.fixed_assignment.area_id,
              slotId: match.fixed_assignment.slot_id,
              startEpochMs: match.fixed_assignment.start_epoch_ms,
              endEpochMs: match.fixed_assignment.end_epoch_ms,
            },
          }),
    })),
    slots: input.slots.map((slot) => ({
      id: slot.slot_id,
      intervalId: slot.interval_id,
      areaId: slot.area_id,
      startEpochMs: slot.start_epoch_ms,
      endEpochMs: slot.end_epoch_ms,
    })),
    constraints,
  };
}

function setting<Input, Output>(
  input: { mode: Input extends never ? never : "required" | "preferred" | "ignored"; weight?: number },
  value: Output,
): ConstraintSetting<Output> {
  return { mode: input.mode, value, ...(input.weight === undefined ? {} : { weight: input.weight }) };
}

function toDomainAssignment(assignment: TransportAssignment): ScheduleAssignment {
  return {
    matchId: assignment.match_id,
    divisionId: assignment.division_id,
    areaId: assignment.area_id,
    intervalId: assignment.interval_id,
    slotId: assignment.slot_id,
    startEpochMs: assignment.start_epoch_ms,
    endEpochMs: assignment.end_epoch_ms,
    fixed: assignment.fixed,
  };
}

function toTransportAssignment(assignment: ScheduleAssignment): TransportAssignment {
  return {
    match_id: assignment.matchId,
    division_id: assignment.divisionId,
    area_id: assignment.areaId,
    interval_id: assignment.intervalId,
    slot_id: assignment.slotId,
    start_epoch_ms: assignment.startEpochMs,
    end_epoch_ms: assignment.endEpochMs,
    fixed: assignment.fixed,
  };
}

function toTransportViolation(
  violation: ReturnType<typeof validateSchedule>["violations"][number],
): TransportViolation {
  return {
    code: violation.code,
    severity: violation.severity,
    match_ids: violation.matchIds,
    message: violation.message,
    ...(violation.amount === undefined ? {} : { amount: violation.amount }),
  };
}

function toTransportQuality(quality: ReturnType<typeof evaluateScheduleQuality>): TransportQuality {
  return {
    score: quality.score,
    objective: quality.objective,
    valid: quality.valid,
    makespan_minutes: quality.makespanMinutes,
    minimum_rest_minutes: quality.minimumRestMinutes,
    maximum_matches_per_entry_day: quality.maximumMatchesPerEntryDay,
    preferred_final_delta_minutes: quality.preferredFinalDeltaMinutes,
    required_violation_count: quality.requiredViolationCount,
    preferred_penalty: quality.preferredPenalty,
    components: quality.components.map((component) => ({ ...component })),
  };
}

function assertExactScheduleJobInput(input: ScheduleJobInput): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    input.schema_version !== 1 ||
    !uuid.test(input.job_id) ||
    !uuid.test(input.competition_id) ||
    !Number.isSafeInteger(input.source_revision) ||
    input.source_revision <= 0 ||
    !Number.isSafeInteger(input.capacity_revision) ||
    input.capacity_revision <= 0 ||
    !/^[a-f0-9]{64}$/.test(input.capacity_hash) ||
    !Array.isArray(input.matches) ||
    input.matches.length === 0 ||
    !Array.isArray(input.slots) ||
    input.slots.length === 0
  ) {
    throw new Error("Schedule input identity, version, revision, matches, or slots are invalid");
  }
  exact(
    input,
    [
      "schema_version",
      "job_id",
      "competition_id",
      "source_revision",
      "capacity_revision",
      "capacity_hash",
      "time_zone",
      "objective",
      "matches",
      "slots",
      "constraints",
    ],
    "input",
  );
  for (const [index, match] of input.matches.entries()) {
    exact(
      match,
      [
        "match_id",
        "division_id",
        "duration_minutes",
        "dependency_match_ids",
        "possible_entry_ids",
        "official_ids",
        "is_championship_final",
      ],
      `matches[${index}]`,
      ["fixed_assignment"],
    );
    if (match.fixed_assignment !== undefined) {
      exact(
        match.fixed_assignment,
        ["reason", "area_id", "slot_id", "start_epoch_ms", "end_epoch_ms"],
        `matches[${index}].fixed_assignment`,
      );
    }
  }
  for (const [index, slot] of input.slots.entries()) {
    exact(slot, ["slot_id", "interval_id", "area_id", "start_epoch_ms", "end_epoch_ms"], `slots[${index}]`);
  }
  exact(
    input.constraints,
    [
      "minimum_rest",
      "maximum_matches_per_day",
      "preferred_final_time",
      "entry_unavailable",
      "official_availability",
      "featured_playing_area",
      "avoid_consecutive_matches",
      "balance_early_matches",
      "balance_late_matches",
      "keep_division_together",
      "preserve_existing_schedule",
    ],
    "constraints",
  );
  const settings = Object.entries(input.constraints);
  for (const [name, settingValue] of settings)
    exact(settingValue, ["mode", "value"], `constraints.${name}`, ["weight"]);
  exact(input.constraints.minimum_rest.value, ["minutes"], "constraints.minimum_rest.value");
  exact(input.constraints.maximum_matches_per_day.value, ["matches"], "constraints.maximum_matches_per_day.value");
  exact(
    input.constraints.preferred_final_time.value,
    ["target_start_epoch_ms", "tolerance_minutes"],
    "constraints.preferred_final_time.value",
  );
  exact(input.constraints.entry_unavailable.value, ["by_entry_id"], "constraints.entry_unavailable.value");
  exact(input.constraints.official_availability.value, ["by_official_id"], "constraints.official_availability.value");
  exact(
    input.constraints.featured_playing_area.value,
    ["area_id", "match_ids"],
    "constraints.featured_playing_area.value",
  );
  exact(input.constraints.avoid_consecutive_matches.value, ["minutes"], "constraints.avoid_consecutive_matches.value");
  exact(
    input.constraints.balance_early_matches.value,
    ["before_local_time"],
    "constraints.balance_early_matches.value",
  );
  exact(
    input.constraints.balance_late_matches.value,
    ["at_or_after_local_time"],
    "constraints.balance_late_matches.value",
  );
  exact(
    input.constraints.keep_division_together.value,
    ["maximum_area_count"],
    "constraints.keep_division_together.value",
  );
  exact(
    input.constraints.preserve_existing_schedule.value,
    ["maximum_shift_minutes", "by_match_id"],
    "constraints.preserve_existing_schedule.value",
  );
  for (const [id, intervals] of Object.entries(input.constraints.entry_unavailable.value.by_entry_id)) {
    intervals.forEach((interval, index) =>
      exact(interval, ["start_epoch_ms", "end_epoch_ms"], `entry_unavailable.${id}[${index}]`),
    );
  }
  for (const [id, intervals] of Object.entries(input.constraints.official_availability.value.by_official_id)) {
    intervals.forEach((interval, index) =>
      exact(interval, ["start_epoch_ms", "end_epoch_ms"], `official_availability.${id}[${index}]`),
    );
  }
  for (const [id, assignment] of Object.entries(input.constraints.preserve_existing_schedule.value.by_match_id)) {
    exact(assignment, ["area_id", "start_epoch_ms"], `preserve_existing_schedule.${id}`);
  }
}

function exact(value: object, required: readonly string[], path: string, optional: readonly string[] = []): void {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${path} does not match the strict schedule schema`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${path} does not match the strict schedule schema`);
  }
}
