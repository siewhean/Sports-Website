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

type VerifiedSchedule = {
  validation: ReturnType<typeof validateSchedule>;
  quality: ReturnType<typeof evaluateScheduleQuality>;
};

type GeneratedSchedule = {
  candidate: ReturnType<typeof generateScheduleCandidates>[number];
  backToBackCount: number;
} & VerifiedSchedule;
type GeneratedSchedules = ReadonlyArray<GeneratedSchedule>;

export class DomainScheduleOptimizer implements ScheduleOptimizer {
  readonly #maxIterationsPerRun: number;
  readonly #workerExecArgv: string[] | undefined;
  /** The processor verifies each yielded candidate with the same input object; reuse that job's worker. */
  readonly #activeSessions = new WeakMap<ScheduleJobInput, SolverSession>();

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
    const assignments = candidate.assignments.map(toDomainAssignment);
    const active = this.#activeSessions.get(input);
    const session = active ?? new SolverSession(toProblem(input), this.#workerExecArgv);
    let verified: VerifiedSchedule | null;
    try {
      verified = await session.request<VerifiedSchedule>(
        { operation: "verify", assignments },
        context.signal,
        context.maxYieldIntervalMs,
      );
    } finally {
      if (!active) session.close();
    }
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
    if (request.signal.aborted) return;
    const session = new SolverSession(toProblem(request.input), this.#workerExecArgv);
    this.#activeSessions.set(request.input, session);
    try {
      // Local search is spent only on candidates that beat the best so far (the persisted seed on a
      // continuation), so a job improves the few schedules that can win, deterministically.
      let bestScore = Number.NEGATIVE_INFINITY;
      if (request.seed !== null) {
        const seed = request.seed.assignments.map(toDomainAssignment);
        const verifiedSeed = await session.request<VerifiedSchedule>(
          { operation: "verify", assignments: seed },
          request.signal,
          request.maxYieldIntervalMs,
        );
        if (verifiedSeed === null) return;
        if (!verifiedSeed.validation.valid || !verifiedSeed.quality.valid) {
          throw new Error("Persisted continuation seed is invalid");
        }
        bestScore = verifiedSeed.quality.score;
      }
      const toYield = (generated: GeneratedSchedule) => ({
        iteration: generated.candidate.iteration,
        result: {
          schema_version: 1 as const,
          job_id: request.input.job_id,
          source_revision: request.input.source_revision,
          result_revision: 0,
          status: "valid" as const,
          assignments: generated.candidate.assignments.map(toTransportAssignment),
          violations: generated.validation.violations.map(toTransportViolation),
          quality: toTransportQuality(generated.quality),
          assignment_hash: "0".repeat(64),
        },
      });
      // The rest-aware construction goes first, so on a score tie it is the one kept. Its
      // back-to-back count is then a ceiling: a greedy candidate with more back-to-backs is never
      // offered, so "0 back-to-backs when a witness exists" holds whatever the score weights say.
      let backToBackCeiling = Number.POSITIVE_INFINITY;
      let pending: GeneratedSchedule | null = null;
      const preserving = request.input.constraints.preserve_existing_schedule.mode !== "ignored";
      // The search budget follows the yield deadline (about 20 nodes per millisecond leaves a wide
      // margin on slow runners): 120 000 nodes at the 30 s production default.
      const constructedRestAware = await session.request<GeneratedSchedule | false>(
        {
          operation: "rest_aware",
          iteration: request.startIteration,
          maxNodes: Math.max(1_000, Math.min(120_000, Math.floor(request.maxYieldIntervalMs * 20))),
        },
        request.signal,
        request.maxYieldIntervalMs,
      );
      if (constructedRestAware === null) return;
      let restAware: GeneratedSchedule | false = constructedRestAware;
      if (restAware !== false) {
        const improved = await session.request<GeneratedSchedule>(
          { operation: "improve", iteration: request.startIteration, assignments: restAware.candidate.assignments },
          request.signal,
          request.maxYieldIntervalMs,
        );
        if (improved === null) return;
        if (improved.validation.valid && improved.quality.valid && improved.quality.score >= restAware.quality.score)
          restAware = improved;
      }
      if (restAware !== false && restAware.validation.valid && restAware.quality.valid) {
        backToBackCeiling = restAware.backToBackCount;
        // Held back until the first greedy candidate is scored, so the first schedule offered is
        // already the better of the two. A best that changes moments after it appears makes an
        // organiser's "use schedule" refer to a superseded option.
        if (restAware.quality.score > bestScore) pending = restAware;
      }
      const offerPending = function* () {
        if (pending === null) return;
        if (pending.quality.score > bestScore) bestScore = pending.quality.score;
        const held = pending;
        pending = null;
        yield toYield(held);
      };
      const endIteration = request.startIteration + this.#maxIterationsPerRun;
      for (let iteration = request.startIteration; iteration < endIteration; iteration += 1) {
        if (request.signal.aborted) return;
        const generated = await session.request<GeneratedSchedules>(
          { operation: "generate", iteration },
          request.signal,
          request.maxYieldIntervalMs,
        );
        if (generated === null) return;
        for (const constructed of generated) {
          if (request.signal.aborted) return;
          if (!constructed.validation.valid || !constructed.quality.valid) continue;
          let chosen = constructed;
          if (chosen.quality.score > bestScore) {
            const improved = await session.request<GeneratedSchedule>(
              {
                operation: "improve",
                iteration: chosen.candidate.iteration,
                assignments: chosen.candidate.assignments,
              },
              request.signal,
              request.maxYieldIntervalMs,
            );
            if (improved === null) return;
            if (improved.validation.valid && improved.quality.valid && improved.quality.score >= chosen.quality.score) {
              chosen = improved;
            }
          }
          const beatsPending =
            pending !== null &&
            chosen.backToBackCount <= backToBackCeiling &&
            chosen.quality.score > pending.quality.score;
          if (pending !== null && !beatsPending) {
            // One candidate per iteration: the processor requires strictly increasing iterations,
            // and a greedy candidate that does not beat the rest-aware one cannot win anyway.
            if (chosen.quality.score > bestScore) bestScore = chosen.quality.score;
            yield* offerPending();
            continue;
          }
          pending = null;
          // Raised even when the candidate is not offered, so local search is spent once per
          // score level rather than on every iteration that the ceiling then rejects.
          if (chosen.quality.score > bestScore) bestScore = chosen.quality.score;
          if (chosen.backToBackCount > backToBackCeiling) continue;
          // Without a rest-aware construction, the first schedule offered sets the ceiling, so a
          // later higher-scoring one cannot bring back-to-backs back. Re-planning is exempt:
          // there, keeping matches in place outranks spacing.
          if (backToBackCeiling === Number.POSITIVE_INFINITY && !preserving) backToBackCeiling = chosen.backToBackCount;
          yield toYield(chosen);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // No greedy candidate at all (or none valid): the rest-aware schedule is still offered.
      yield* offerPending();
    } finally {
      if (this.#activeSessions.get(request.input) === session) this.#activeSessions.delete(request.input);
      session.close();
    }
  }
}

/**
 * One long-lived solver thread per job. Starting a worker costs far more than solving one
 * iteration, so the problem is sent once and every generate/verify call is a message. Requests are
 * serialised; each must answer within the yield deadline or the thread is terminated, and an abort
 * terminates it immediately, so a stuck solve can never outlive its job.
 */
class SolverSession {
  readonly #worker: Worker;
  #queue: Promise<unknown> = Promise.resolve();
  #nextId = 0;
  #closed = false;
  #failure: Error | null = null;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(problem: ScheduleProblem, workerExecArgv?: readonly string[]) {
    this.#worker = new Worker(new URL("./solver-thread.mjs", import.meta.url), {
      workerData: { problem },
      ...(workerExecArgv === undefined ? {} : { execArgv: [...workerExecArgv] }),
    });
    this.#worker.unref();
    this.#worker.on("message", (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.ok && message.result !== undefined) pending.resolve(message.result);
      else pending.reject(new SchedulerInvariantError(message.error ?? "Schedule domain worker rejected input"));
    });
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed) this.#fail(new Error(`Schedule solver worker exited with code ${code}`));
    });
  }

  request<Result>(message: Record<string, unknown>, signal: AbortSignal, deadlineMs: number): Promise<Result | null> {
    const next = this.#queue.then(() => this.#send<Result>(message, signal, deadlineMs));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("Schedule solver session closed"));
    this.#pending.clear();
    void this.#worker.terminate();
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #send<Result>(message: Record<string, unknown>, signal: AbortSignal, deadlineMs: number): Promise<Result | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new Error("Schedule solver session closed"));
    const id = this.#nextId++;
    return new Promise<Result | null>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        // Keep the process alive only while a request is in flight.
        if (this.#pending.size === 0) this.#worker.unref();
        operation();
      };
      const onAbort = () =>
        finish(() => {
          this.close();
          resolve(null);
        });
      const timer = setTimeout(
        () =>
          finish(() => {
            this.close();
            reject(new SolverYieldDeadlineError(deadlineMs));
          }),
        deadlineMs,
      );
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => finish(() => resolve(value as Result)),
        reject: (error) => finish(() => reject(error)),
      });
      this.#worker.ref();
      this.#worker.postMessage({ ...message, id });
    });
  }
}

export function toProblem(input: ScheduleJobInput): ScheduleProblem {
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

export function toDomainAssignment(assignment: TransportAssignment): ScheduleAssignment {
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
      if (!["locked", "published_history", "started", "finished"].includes(match.fixed_assignment.reason)) {
        throw new Error(`matches[${index}].fixed_assignment.reason is unsupported`);
      }
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
