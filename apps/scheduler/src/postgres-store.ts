import type {
  ScheduleAssignment,
  ScheduleJobInput,
  ScheduleJobResult,
  ScheduleQuality,
  ScheduleViolation,
} from "@matchday/contracts";
import postgres from "postgres";

import { SchedulerInvariantError } from "./errors.js";
import type { ScheduleCheckpointResult, ScheduleClaimResult, ScheduleJobState, ScheduleJobStore } from "./ports.js";

type Sql = ReturnType<typeof postgres>;
type JobRow = {
  id: string;
  competition_id: string;
  revision: number;
  status: ScheduleJobState;
  input_snapshot: unknown;
  input_hash: string;
  problem_hash: string;
  correlation_id: string;
  continued_from_job_id: string | null;
  current_best_option_id: string | null;
  fence_token: string | null;
};
type OptionRow = {
  job_id: string;
  result_revision: number;
  solver_iteration: number;
  input_hash: string;
  problem_hash: string;
  quality: unknown;
  assignments: unknown;
  violations: unknown;
  assignment_hash: string;
};

export class PostgresScheduleJobStore implements ScheduleJobStore {
  readonly #sql: Sql;
  readonly #ownsConnection: boolean;
  readonly #revisionsByFence = new Map<string, number>();

  constructor(connection: string | Sql) {
    if (typeof connection === "string") {
      const url = new URL(connection);
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new Error("Scheduler database URL must use postgres:// or postgresql://");
      }
      this.#sql = postgres(connection, { max: 4, onnotice: () => undefined });
      this.#ownsConnection = true;
    } else {
      this.#sql = connection;
      this.#ownsConnection = false;
    }
  }

  async probe(): Promise<boolean> {
    try {
      await this.#sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async claimJob(request: {
    jobId: string;
    workerId: string;
    expectedInputHash: string;
    leaseMs: number;
  }): Promise<ScheduleClaimResult> {
    const leaseSeconds = toLeaseSeconds(request.leaseMs);
    const claimed = await this.#sql<JobRow[]>`
      SELECT * FROM phase4_claim_schedule_job(
        ${request.jobId}::uuid,
        ${request.workerId}::text,
        ${request.expectedInputHash}::text,
        ${leaseSeconds}::integer
      )`;
    const row = claimed[0];
    if (row === undefined || row.id === null) return this.classifyUnclaimed(request.jobId, request.expectedInputHash);
    if (row.input_hash !== request.expectedInputHash || row.fence_token === null) {
      throw new Error("Claimed schedule input does not match the queue reference");
    }
    const input = row.input_snapshot as ScheduleJobInput;
    const option = await this.loadCurrentOrContinuationBest(row);
    if (option !== undefined && option.problem_hash !== row.problem_hash) {
      throw new Error("Continuation result does not match the immutable schedule problem");
    }
    this.#revisionsByFence.set(row.fence_token, row.revision);
    let currentBest = option === undefined ? null : optionToResult(row.id, input.source_revision, option);
    if (option !== undefined && option.job_id !== row.id) {
      const cloned = await this.checkpointBest({
        jobId: row.id,
        workerId: request.workerId,
        fenceToken: row.fence_token,
        expectedInputHash: row.input_hash,
        candidate: currentBest!,
        iteration: option.solver_iteration,
      });
      if (!cloned.accepted || cloned.result === null) throw new Error("Failed to retain continuation current best");
      currentBest = cloned.result;
    }
    return {
      outcome: "claimed",
      job: {
        jobId: row.id,
        competitionId: row.competition_id,
        input,
        inputHash: row.input_hash,
        fenceToken: row.fence_token,
        correlationId: row.correlation_id,
        continuedFromJobId: row.continued_from_job_id,
        continuationIteration: option === undefined ? 0 : option.solver_iteration + 1,
        currentBest,
      },
    };
  }

  async renewLease(request: {
    jobId: string;
    workerId: string;
    fenceToken: string;
    leaseMs: number;
  }): Promise<boolean> {
    try {
      const rows = await this.#sql<JobRow[]>`
        SELECT * FROM phase4_renew_schedule_job_lease(
          ${request.jobId}::uuid,
          ${request.workerId}::text,
          ${request.fenceToken}::uuid,
          ${toLeaseSeconds(request.leaseMs)}::integer
        )`;
      return rows[0]?.id === request.jobId;
    } catch (error: unknown) {
      if (isFenceError(error)) return false;
      throw error;
    }
  }

  async getCancellationStatus(
    jobId: string,
    fenceToken: string,
  ): Promise<{ requested: boolean; requestedAtEpochMs: number | null }> {
    const rows = await this.#sql<{ status: ScheduleJobState; cancellation_requested_at: Date | null }[]>`
      SELECT status,cancellation_requested_at
      FROM schedule_generation_jobs
      WHERE id=${jobId}::uuid AND fence_token=${fenceToken}::uuid`;
    const row = rows[0];
    if (row === undefined) throw new Error("schedule lease fence was lost");
    return {
      requested: row.status === "cancelling" || row.cancellation_requested_at !== null,
      requestedAtEpochMs: row.cancellation_requested_at?.getTime() ?? null,
    };
  }

  async checkpointBest(request: {
    jobId: string;
    workerId: string;
    fenceToken: string;
    expectedInputHash: string;
    candidate: ScheduleJobResult;
    iteration: number;
  }): Promise<ScheduleCheckpointResult> {
    const revision = this.#revisionsByFence.get(request.fenceToken);
    if (revision === undefined) throw new Error("Unknown schedule persistence fence");
    let rows: OptionRow[];
    try {
      rows = await this.#sql<OptionRow[]>`
        SELECT * FROM phase4_checkpoint_schedule_option(
          ${request.jobId}::uuid,
          ${request.workerId}::text,
          ${request.fenceToken}::uuid,
          ${revision}::integer,
          ${request.expectedInputHash}::text,
          ${request.iteration}::integer,
          ${this.#sql.json(request.candidate.quality!)}::jsonb,
          ${this.#sql.json(request.candidate.assignments)}::jsonb,
          ${this.#sql.json(request.candidate.violations)}::jsonb
        )`;
    } catch (error: unknown) {
      if (isCancellationCheckpoint(error)) return { accepted: false, result: null };
      throw error;
    }
    const option = rows[0];
    if (option === undefined) return { accepted: false, result: null };
    this.#revisionsByFence.set(request.fenceToken, revision + 1);
    return {
      accepted: true,
      result: optionToResult(request.jobId, request.candidate.source_revision, option),
    };
  }

  async finishJob(request: {
    jobId: string;
    workerId: string;
    fenceToken: string;
    state: "cancelled" | "completed" | "no_solution" | "stale";
    currentBestRevision: number | null;
  }): Promise<void> {
    await this.#sql`
      SELECT phase4_finish_schedule_job(
        ${request.jobId}::uuid,
        ${request.workerId}::text,
        ${request.fenceToken}::uuid,
        ${request.state}::text,
        NULL::text
      )`;
    this.#revisionsByFence.delete(request.fenceToken);
  }

  async releaseAfterFailure(request: {
    jobId: string;
    workerId: string;
    fenceToken: string;
    failureClass: string;
  }): Promise<void> {
    if (request.failureClass === "ScheduleLeaseLostError") {
      this.#revisionsByFence.delete(request.fenceToken);
      return;
    }
    if (request.failureClass === "SchedulerInvariantError") {
      await this.#sql`
        SELECT phase4_finish_schedule_job(
          ${request.jobId}::uuid,
          ${request.workerId}::text,
          ${request.fenceToken}::uuid,
          'failed'::text,
          'invalid_input'::text
        )`;
    } else {
      const failure = request.failureClass === "SolverYieldDeadlineError" ? "timeout" : "transient";
      await this.#sql`
        SELECT phase4_release_schedule_job_after_failure(
          ${request.jobId}::uuid,
          ${request.workerId}::text,
          ${request.fenceToken}::uuid,
          ${failure}::text
        )`;
    }
    this.#revisionsByFence.delete(request.fenceToken);
  }

  async markDeadLettered(jobId: string, failureClass: string): Promise<void> {
    const normalized = failureClass === "RetryExhausted" ? "transient" : "permanent";
    await this.#sql`
      SELECT phase4_mark_schedule_job_dead_lettered(${jobId}::uuid,${normalized}::text)`;
  }

  async close(): Promise<void> {
    this.#revisionsByFence.clear();
    if (this.#ownsConnection) await this.#sql.end({ timeout: 5 });
  }

  private async classifyUnclaimed(jobId: string, expectedInputHash: string): Promise<ScheduleClaimResult> {
    const rows = await this.#sql<Pick<JobRow, "status" | "current_best_option_id" | "input_hash">[]>`
      SELECT status,current_best_option_id,input_hash FROM schedule_generation_jobs WHERE id=${jobId}::uuid`;
    const row = rows[0];
    if (row === undefined) return { outcome: "missing" };
    if (row.input_hash !== expectedInputHash) {
      throw new SchedulerInvariantError("Schedule queue input hash does not match the immutable job");
    }
    if (["cancelled", "completed", "failed", "no_solution", "stale"].includes(row.status)) {
      const best =
        row.current_best_option_id === null
          ? undefined
          : (
              await this.#sql<Pick<OptionRow, "result_revision">[]>`
                SELECT result_revision FROM schedule_generation_options WHERE id=${row.current_best_option_id}::uuid`
            )[0];
      return {
        outcome: "terminal",
        state: row.status as "cancelled" | "completed" | "failed" | "no_solution" | "stale",
        currentBestRevision: best?.result_revision ?? null,
      };
    }
    return { outcome: "busy" };
  }

  private async loadCurrentOrContinuationBest(row: JobRow): Promise<OptionRow | undefined> {
    const rows = await this.#sql<OptionRow[]>`
      SELECT option_row.job_id,option_row.result_revision,option_row.solver_iteration,
             option_row.input_hash,option_row.problem_hash,option_row.quality,option_row.assignments,
             option_row.violations,option_row.assignment_hash
      FROM schedule_generation_jobs job
      LEFT JOIN schedule_generation_jobs parent ON parent.id=job.continued_from_job_id
      JOIN schedule_generation_options option_row
        ON option_row.id=COALESCE(job.current_best_option_id,parent.current_best_option_id)
      WHERE job.id=${row.id}::uuid`;
    return rows[0];
  }
}

function optionToResult(jobId: string, sourceRevision: number, option: OptionRow): ScheduleJobResult {
  return {
    schema_version: 1,
    job_id: jobId,
    source_revision: sourceRevision,
    result_revision: option.result_revision,
    status: "valid",
    assignments: option.assignments as ScheduleAssignment[],
    violations: option.violations as ScheduleViolation[],
    quality: option.quality as ScheduleQuality,
    assignment_hash: option.assignment_hash,
  };
}

function toLeaseSeconds(leaseMs: number): number {
  const seconds = Math.ceil(leaseMs / 1_000);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) {
    throw new Error("Scheduler lease must be between 5 and 300 seconds");
  }
  return seconds;
}

function isFenceError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("schedule lease fence was lost");
}

function isCancellationCheckpoint(error: unknown): boolean {
  return error instanceof Error && error.message.includes("schedule checkpoint cancelled");
}
