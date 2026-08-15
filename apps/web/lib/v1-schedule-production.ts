import type { ScheduleDocument, ScheduleJob } from "./phase4-schedule";

export const v1ScheduleProductionMachine = {
  publishSection: "publish",
  terminalStatuses: new Set<ScheduleJob["status"]>(["completed", "no_solution", "cancelled", "failed"]),
} as const;

export const v1ScheduleProductionCopy = {
  diagnosticsTitle: "Schedule diagnostics",
  diagnosticsIntro: "The latest schedule run is retained here so a failed optimisation can be investigated after reload.",
  jobReference: "Job reference",
  failureClass: "Failure class",
  noFailureClass: "No failure class reported",
  retrySchedule: "Return to Schedule",
  publishTitle: "Publish schedule",
  publishIntro: "Publish the current saved schedule revision when it is ready for officials and the public page.",
  noScheduleRevision: "No saved schedule revision yet",
  noScheduleBody: "Generate and use a schedule before publishing. A generated option is not public until it is saved as the current revision.",
  blockingViolations: "Resolve required schedule violations before publishing.",
  publishCurrent: "Publish current schedule",
  publishing: "Publishing schedule…",
  published: "Schedule published",
  publishedBody: "The current schedule revision is now the public schedule.",
  stale: "The saved schedule changed before publication. Reload and review the latest revision before publishing again.",
  unavailable: "Schedule publication is temporarily unavailable.",
  readOnly: "This schedule can be reviewed here, but this session cannot publish it.",
  openPublic: "Open public competition",
} as const;

export function latestComparableScheduleJob(
  jobs: readonly ScheduleJob[],
  sourceRevision: number,
  capacityRevision: number,
): ScheduleJob | null {
  return (
    [...jobs]
      .filter((job) => job.sourceRevision === sourceRevision && job.capacityRevision === capacityRevision)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0] ?? null
  );
}

export function isTerminalScheduleJob(job: ScheduleJob): boolean {
  return v1ScheduleProductionMachine.terminalStatuses.has(job.status);
}

export function safeScheduleFailureDiagnostic(job: ScheduleJob): string | null {
  if (job.status !== "failed") return null;
  const failureClass = job.failureClass ?? v1ScheduleProductionCopy.noFailureClass;
  return `${failureClass} · ${job.id}`;
}

export function scheduleHasBlockingViolations(document: ScheduleDocument): boolean {
  return document.violations.some((violation) => violation.severity === "required" || violation.severity === "hard");
}

export function v1ScheduleRevisionLabel(revision: number): string {
  return `Revision ${revision}`;
}
