import type { ScheduleJob, ScheduleOption } from "./phase4-schedule";

/**
 * V1 deliberately generates a single balanced schedule.  The richer optimiser
 * remains available behind the explicit advanced route, but it is not part of
 * the default organiser journey.
 */
export const v1ScheduleObjective = "balanced" as const;

export function v1ScheduleOption(
  options: readonly ScheduleOption[],
  currentBest: ScheduleOption | null,
): ScheduleOption | null {
  if (currentBest?.objective === v1ScheduleObjective) return currentBest;
  return options.find((option) => option.objective === v1ScheduleObjective) ?? null;
}

export function isAdvancedScheduleView(value: string | undefined): boolean {
  return value === "1";
}

export function v1ScheduleProgress(job: ScheduleJob | null): "idle" | "creating" | "ready" | "terminal" {
  if (!job) return "idle";
  if (job.currentBest) return "ready";
  return job.status === "queued" || job.status === "running" || job.status === "cancelling" ? "creating" : "terminal";
}
