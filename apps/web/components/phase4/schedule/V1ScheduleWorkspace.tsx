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
import { v1ScheduleProductionCopy, v1ScheduleProductionMachine } from "@/lib/v1-schedule-production";
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
  if (job.status === "no_solution") return v1ScheduleProductionCopy.noSolutionDiagnostic;
  if (job.status !== "failed") return null;
  switch (job.failureClass) {
    case "timeout":
      return v1ScheduleProductionCopy.timeoutDiagnostic;
    case "transient":
      return v1ScheduleProductionCopy.transientDiagnostic;
    case "invalid_input":
      return v1ScheduleProductionCopy.invalidInputDiagnostic;
    case "permanent":
      return v1ScheduleProductionCopy.permanentDiagnostic;
    default:
      return v1ScheduleProductionCopy.failedDiagnostic;
  }
}

function latestComparableJob(value: unknown, document: ScheduleDocument): ScheduleJob | null {
  if (!Array.isArray(value)) return null;
  const jobs: ScheduleJob[] = [];
  for (const candidate of value) {
    const job = parseScheduleJobView(candidate);
    if (job && job.sourceRevision === document.sourceRevision && job.capacityRevision === document.capacityRevision) {
      jobs.push(job);
    }
  }
  jobs.sort((left, right) => {
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return updated || right.id.localeCompare(left.id);
  });
  return jobs[0] ?? null;
}

function newestJob(left: ScheduleJob | null, right: ScheduleJob | null): ScheduleJob | null {
  if (!left) return right;
  if (!right) return left;
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return updated > 0 || (updated === 0 && right.id.localeCompare(left.id) > 0) ? right : left;
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
  const [recoveryState, setRecoveryState] = useState<"idle" | "restoring" | "failed">(
    v1ScheduleProductionMachine.recoveryIdle,
  );
  const [polledJob, setPolledJob] = useState<ScheduleJob | null>(null);
  const observedJob = useMemo(() => newestJob(document.activeJob, polledJob), [document.activeJob, polledJob]);

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
        if (live && latest) setPolledJob(latest);
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

    const option = v1ScheduleOption(
      document.alternatives,
      observedJob?.currentBest ?? document.activeJob?.currentBest ?? null,
    );
    if (!option || !option.quality.valid || option.jobRevision === null) return null;
    return option;
  }, [advanced, document, observedJob]);

  useEffect(() => {
    if (!recoverableOption) return;

    const key = `${recoverableOption.jobId}:${recoverableOption.id}:${recoverableOption.jobRevision}:${assignmentFingerprint(recoverableOption)}`;
    if (attemptedRecoveryRef.current === key) return;
    attemptedRecoveryRef.current = key;

    let live = true;
    setRecoveryState(v1ScheduleProductionMachine.recoveryRestoring);

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
          setRecoveryState(v1ScheduleProductionMachine.recoveryFailed);
          return;
        }

        setRecoveryState(v1ScheduleProductionMachine.recoveryIdle);
        router.refresh();
      } catch {
        if (live) setRecoveryState(v1ScheduleProductionMachine.recoveryFailed);
      }
    })();

    return () => {
      live = false;
    };
  }, [recoverableOption, router]);

  const diagnostic = observedJob ? diagnosticBody(observedJob) : null;
  const diagnosticTitle =
    observedJob?.status === "no_solution"
      ? v1ScheduleProductionCopy.noScheduleFound
      : v1ScheduleProductionCopy.optimisationFailed;

  return (
    <>
      {diagnostic ? (
        <section
          role="alert"
          data-testid="v1-schedule-job-diagnostic"
          aria-label={v1ScheduleProductionCopy.jobDiagnosticLabel}
        >
          <strong>{diagnosticTitle}</strong>
          <p>{diagnostic}</p>
          <p>
            {v1ScheduleProductionCopy.job} <code>{observedJob?.id}</code>
            {observedJob?.failureClass ? (
              <span>
                {" "}
                {v1ScheduleProductionCopy.failureClass} <code>{observedJob.failureClass}</code>
              </span>
            ) : null}
          </p>
        </section>
      ) : null}
      {recoveryState === v1ScheduleProductionMachine.recoveryRestoring ? (
        <p role="status">{v1ScheduleProductionCopy.restoring}</p>
      ) : null}
      {recoveryState === v1ScheduleProductionMachine.recoveryFailed ? (
        <p role="alert">{v1ScheduleProductionCopy.recoveryFailed}</p>
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
