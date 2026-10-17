export const v1ScheduleProductionMachine = {
  publishSection: "publish",
  recoveryIdle: "idle",
  recoveryRestoring: "restoring",
  recoveryFailed: "failed",
} as const;

export const v1ScheduleProductionCopy = {
  noScheduleRevision: "No schedule version",
  noSolutionDiagnostic:
    "No schedule fits the saved rules and playing times. Add playing time or change the format, then try again.",
  timeoutDiagnostic:
    "The scheduler ran out of time before it finished. Your playing times are not the problem. Try again.",
  transientDiagnostic:
    "The scheduler exhausted its retries after a transient runtime failure. Capacity and format should not be changed to hide this failure.",
  invalidInputDiagnostic:
    "The persisted scheduling input failed strict validation. Review the job input boundary instead of changing capacity.",
  permanentDiagnostic: "The scheduler encountered a non-retryable runtime failure.",
  failedDiagnostic: "The scheduler failed before it could create a usable schedule version.",
  noScheduleFound: "No schedule found",
  optimisationFailed: "Schedule optimisation failed",
  jobDiagnosticLabel: "Schedule job diagnostic",
  job: "Job",
  failureClass: "· failure class",
  restoring: "Restoring your generated schedule as a saved draft…",
  recoveryFailed:
    "A generated schedule is still available, but MATCHDAY could not restore it automatically. Use “Use this schedule” below to save it as a draft.",
  stalePublish: "This schedule changed before publication. Reload the latest version and review it again.",
  publishPermission: "You do not have permission to publish this competition.",
  publishFailed: "The schedule could not be published. No public version was changed.",
  malformedPublish: "The publish response was malformed. Reload before trying another publication action.",
  publishUnavailable: "The publishing service is unavailable. No public version was changed.",
  publicationUnavailableTitle: "Publication status is unavailable",
  publicationUnavailableBody:
    "Reload the competition when the schedule service is available. Existing public information is unchanged.",
  openSchedule: "Open schedule",
  createScheduleTitle: "Create a schedule before publishing",
  createScheduleBody:
    "There is no saved schedule version to publish. Generate the balanced schedule, save the valid option, then return here to publish it.",
  generateSchedule: "Generate schedule",
  publishedSchedule: "Published schedule",
  publicationReview: "Publication review",
  publicationVersion: "Publication version",
  publishedRevision: "Published version {revision}",
  revisionStatus: "Version status",
  scheduledFixtures: "Scheduled fixtures",
  blockingConflicts: "Blocking conflicts",
  openPublicCompetition: "Open public competition",
  publishing: "Publishing…",
  publishSchedule: "Publish schedule",
  notReadyToPublish: "This version is not ready for publication yet. Review and save the valid schedule first.",
  immutablePublicTruth: "Public truth is immutable",
  publicationChanges: "What publication changes",
  immutablePublicTruthBody:
    "Future schedule changes require a new version; the published version remains an auditable public record.",
  publicationChangesBody:
    "Publishing makes this schedule the public competition schedule. Results can then update independently as matches are finalised.",
  reviewSchedule: "Review schedule",
} as const;

export function v1ScheduleRevisionLabel(revision: number): string {
  return `Schedule version ${revision}`;
}

export function v1SchedulePublishedMessage(revision: number): string {
  return `Schedule version ${revision} is now public.`;
}

export function v1ScheduleBlockingConflictMessage(count: number): string {
  return `Resolve ${count} blocking schedule conflict${count === 1 ? "" : "s"} before publishing.`;
}
