"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  phase4ScheduleMachine,
  type ScheduleDocument,
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

  const recoverableOption = useMemo(() => {
    if (advanced || document.currentRevision || !document.canEdit) return null;
    if (document.activeJob && activeStatuses.has(document.activeJob.status)) return null;

    const option = v1ScheduleOption(document.alternatives, document.activeJob?.currentBest ?? null);
    if (!option || !option.quality.valid || option.jobRevision === null) return null;
    return option;
  }, [advanced, document.activeJob, document.alternatives, document.canEdit, document.currentRevision]);

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

  return (
    <>
      {recoveryState === "restoring" ? (
        <p role="status">Restoring your generated schedule as a saved draft…</p>
      ) : null}
      {recoveryState === "failed" ? (
        <p role="alert">
          A generated schedule is still available, but MATCHDAY could not restore it automatically. Use “Use this schedule” below to save it as a draft.
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
