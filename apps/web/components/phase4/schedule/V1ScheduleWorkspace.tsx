"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  parseScheduleJobView,
  phase4ScheduleMachine,
  type ScheduleDocument,
  type ScheduleJob,
  type ScheduleJobStatus,
  type ScheduleOption,
} from "@/lib/phase4-schedule";
import { v1ScheduleOption } from "@/lib/v1-schedule";
import { ScheduleWorkspace } from "./ScheduleWorkspace";

const activeStatuses = new Set<ScheduleJobStatus>([
  phase4ScheduleMachine.queued,
  phase4ScheduleMachine.running,
  phase4ScheduleMachine.best,
  phase4ScheduleMachine.cancelling,
]);

function assignmentFingerprint(option: ScheduleOption): string {
  return JSON.stringify(
    [...option.assignments]
      .sort((left, right) => left.matchId.localeCompare(right.matchId))
      .map((assignment) => ({
        matchId: assignment.matchId,
        areaId: assignment.areaId,
        slotId: assignment.slotId,
        startsAt: assignment.startsAt,
        endsAt: assignment.endsAt,
      })),
  );
}

function diagnosticBody(job: ScheduleJob): string | null {
  if (job.status === "no_solution") {
    return "No feasible schedule was found for the persisted constraints and capacity. This is a solver outcome, not a scheduler runtime crash.";
  }
  if (job.status !== "failed") return null;
  switch (job.failureClass) {
    case "timeout":
      return "The optimiser exceeded its bounded solver-step deadline. This is a scheduler runtime timeout, not a capacity rejection.";
    case "transient":
      return "The scheduler exhausted its retries after a transient runtime failure. Capacity and format should not be changed to hide this failure.";
    case "invalid_input":
      return "The persisted scheduling input failed strict validation. Review the job input boundary instead of changing capacity.";
    case "permanent":
      return "The scheduler encountered a non-retryable runtime failure.";
    default:
      return "The scheduler failed before it could create a usable schedule revision.";
  }
}

function latestComparableJob(value: unknown, document: ScheduleDocument): ScheduleJob | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((candidate) => parseScheduleJobView(candidate))
    .filter((candidate): candidate is ScheduleJob => candidate !== null)
    .filter(
      (candidate) =>
        candidate.sourceRevision === document.sourceRevision && candidate.capacityRevision === document.capacityRevision,
    )
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id),
    )[0] ?? null;
}

export function V1ScheduleWorkspace({
  advanced = false,
  document,
  initialSelectedMatchId = null,
  initialNotice = null,
}: {
  advanced?: boolean;
  document: ScheduleDocument;
  initialSelectedMatchId?: string | null;
  initialNotice?: typeof phase4ScheduleMachine.moveNotice | null;
}) {
  const router = useRouter();
  const attemptedRecoveryRef = useRef<string | null>(null);
  const [recoveryState, setRecoveryState] = useState<"idle" | "restoring" | "failed">("idle");
  const [observedJob, setObservedJob] = useState<ScheduleJob | null>(document.activeJob);

  useEffect(() => setObservedJob(document.activeJob), [document.activeJob]);

  useEffect(() => {
    if (advanced || document.currentRevision || !document.canEdit) return;
    let live = true;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/phase4/competitions/${encodeURIComponent(document.competitionId)}/schedule/jobs`,
          { cache: phase4ScheduleMachine.noStore },
        );
        if (!live || !response.ok) return;
        const latest = latestComparableJob(await response.json().catch(() => null), document);
        if (live && latest) setObservedJob(latest);
      } catch {
        // The primary schedule workspace owns command/network errors. This
        // secondary read exists only to surface safe terminal diagnostics.
      }
    };
    const timer = window.setInterval(() => void poll(), 1_500);
    void poll();
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [advanced, document]);

  const recoverableOption = useMemo(() => {
    if (advanced || document.currentRevision || !document.canEdit) return null;
    if (observedJob && activeStatuses.has(observedJob.status)) return null;

    const option = v1ScheduleOption(document.alternatives, observedJob?.currentBest ?? document.activeJob?.currentBest ?? null);
    if (!option || !option.quality.valid || option.jobRevision === null) return null;
    return option;
  }, [advanced, document, observedJob]);

  useEffect(() => {
    if (!recoverableOption) return;

    const key = `${recoverableOption.jobId}:${recoverableOption.id}:${recoverableOption.jobRevision}:${assignmentFingerprint(recoverableOption)}`;
    if (attemptedRecoveryRef.current === key) return;
    attemptedRecoveryRef.current = key;

    let live = true;
    setRecoveryState("restoring");

    void (async () => {
      try {
        const response = await fetch(
          `/api/phase4/schedule/jobs/${encodeURIComponent(recoverableOption.jobId)}/options/${encodeURIComponent(recoverableOption.id)}/accept`,
          {
            method: phase4ScheduleMachine.post,
            headers: { "content-type": phase4ScheduleMachine.json },
            body: JSON.stringify({
              idempotency_key: `${phase4ScheduleMachine.acceptKey}:${crypto.randomUUID()}`,
              expected_job_revision: recoverableOption.jobRevision,
            }),
          },
        );

        if (!live) return;
        if (!response.ok) {
          setRecoveryState("failed");
          return;
        }

        setRecoveryState("idle");
        router.refresh();
      } catch {
        if (live) setRecoveryState("failed");
      }
    })();

    return () => {
      live = false;
    };
  }, [recoverableOption, router]);

  const diagnostic = observedJob ? diagnosticBody(observedJob) : null;

  return (
    <>
      {diagnostic ? (
        <section role="alert" data-testid="v1-schedule-job-diagnostic" aria-label="Schedule job diagnostic">
          <strong>{observedJob?.status === "no_solution" ? "No schedule found" : "Schedule optimisation failed"}</strong>
          <p>{diagnostic}</p>
          <p>
            Job <code>{observedJob?.id}</code>
            {observedJob?.failureClass ? (
              <>
                {" "}· failure class <code>{observedJob.failureClass}</code>
              </>
            ) : null}
          </p>
        </section>
      ) : null}
      {recoveryState === "restoring" ? <p role="status">Restoring your generated schedule as a saved draft…</p> : null}
      {recoveryState === "failed" ? (
        <p role="alert">
          A generated schedule is still available, but MATCHDAY could not restore it automatically. Use “Use this
          schedule” below to save it as a draft.
        </p>
      ) : null}
      <ScheduleWorkspace
        advanced={advanced}
        document={document}
        initialSelectedMatchId={initialSelectedMatchId}
        initialNotice={initialNotice}
      />
    </>
  );
}
