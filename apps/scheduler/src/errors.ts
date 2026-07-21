export class SchedulerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerInvariantError";
  }
}

export class ScheduleJobBusyError extends Error {
  constructor(jobId: string) {
    super(`Schedule job ${jobId} could not acquire its competition fence`);
    this.name = "ScheduleJobBusyError";
  }
}

export class ScheduleLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Schedule job ${jobId} lost its persistence fence`);
    this.name = "ScheduleLeaseLostError";
  }
}

export class SolverYieldDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`Schedule optimizer did not yield within ${deadlineMs}ms`);
    this.name = "SolverYieldDeadlineError";
  }
}
