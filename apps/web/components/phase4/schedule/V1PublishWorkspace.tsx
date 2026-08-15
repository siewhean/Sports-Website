"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionLink } from "@/components/foundation/Primitives";
import { parseSchedulePublishReceipt, phase4ScheduleMachine, type ScheduleDocument } from "@/lib/phase4-schedule";
import {
  v1ScheduleBlockingConflictMessage,
  v1ScheduleProductionCopy,
  v1SchedulePublishedMessage,
  v1ScheduleRevisionLabel,
} from "@/lib/v1-schedule-production";

export function V1PublishWorkspace({
  document,
  competitionSlug,
}: Readonly<{ document: ScheduleDocument; competitionSlug: string }>) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "publishing" | "published" | "stale" | "failed">("idle");
  const [message, setMessage] = useState("");
  const revision = document.currentRevision;
  const blocking = document.violations.filter(
    (violation) => violation.severity === phase4ScheduleMachine.required || violation.severity === "hard",
  ).length;

  async function publish() {
    if (!revision || !document.canEdit || blocking > 0 || status === "publishing") return;
    setStatus("publishing");
    setMessage("");
    try {
      const response = await fetch(`/api/phase4/schedule/revisions/${encodeURIComponent(revision.id)}/publish`, {
        method: phase4ScheduleMachine.post,
        headers: { "content-type": phase4ScheduleMachine.json },
        body: JSON.stringify({
          idempotency_key: `${phase4ScheduleMachine.publishKey}:${crypto.randomUUID()}`,
          expected_revision: revision.revision,
        }),
      });
      if (response.status === 409) {
        setStatus("stale");
        setMessage(v1ScheduleProductionCopy.stalePublish);
        return;
      }
      if (response.status === 403) {
        setStatus("failed");
        setMessage(v1ScheduleProductionCopy.publishPermission);
        return;
      }
      if (!response.ok) {
        setStatus("failed");
        setMessage(v1ScheduleProductionCopy.publishFailed);
        return;
      }
      const receipt = parseSchedulePublishReceipt(await response.json().catch(() => null));
      if (!receipt) {
        setStatus("failed");
        setMessage(v1ScheduleProductionCopy.malformedPublish);
        return;
      }
      setStatus("published");
      setMessage(v1SchedulePublishedMessage(receipt.publishedRevision));
      router.refresh();
    } catch {
      setStatus("failed");
      setMessage(v1ScheduleProductionCopy.publishUnavailable);
    }
  }

  if (document.state === phase4ScheduleMachine.unavailable || document.state === phase4ScheduleMachine.offline) {
    return (
      <section className="p2-data-section" aria-labelledby="v1-publish-unavailable-title">
        <h2 id="v1-publish-unavailable-title">{v1ScheduleProductionCopy.publicationUnavailableTitle}</h2>
        <p>{v1ScheduleProductionCopy.publicationUnavailableBody}</p>
        <ActionLink href={`/organiser/competitions/${document.competitionId}/schedule`}>
          {v1ScheduleProductionCopy.openSchedule}
        </ActionLink>
      </section>
    );
  }

  if (!revision) {
    return (
      <section className="p2-data-section" aria-labelledby="v1-publish-empty-title">
        <h2 id="v1-publish-empty-title">{v1ScheduleProductionCopy.createScheduleTitle}</h2>
        <p>{v1ScheduleProductionCopy.createScheduleBody}</p>
        <ActionLink href={`/organiser/competitions/${document.competitionId}/schedule`}>
          {v1ScheduleProductionCopy.generateSchedule}
        </ActionLink>
      </section>
    );
  }

  return (
    <section className="p2-data-section" aria-labelledby="v1-publish-title">
      <header>
        <div>
          <p className="p2-eyebrow">{v1ScheduleProductionCopy.publicationReview}</p>
          <h2 id="v1-publish-title">{v1ScheduleProductionCopy.publishTitle}</h2>
        </div>
      </header>
      <dl className="p2-publish">
        <div>
          <dt>{v1ScheduleProductionCopy.revisionStatus}</dt>
          <dd>{v1ScheduleRevisionLabel(revision.revision)}</dd>
        </div>
        <div>
          <dt>{v1ScheduleProductionCopy.scheduledFixtures}</dt>
          <dd>{revision.assignments.length}</dd>
        </div>
        <div>
          <dt>{v1ScheduleProductionCopy.blockingConflicts}</dt>
          <dd>{blocking}</dd>
        </div>
      </dl>
      {blocking > 0 ? <p role="alert">{v1ScheduleBlockingConflictMessage(blocking)}</p> : null}
      {!document.canEdit ? <p role="status">{v1ScheduleProductionCopy.publishPermission}</p> : null}
      {message ? <p role={status === "failed" || status === "stale" ? "alert" : "status"}>{message}</p> : null}
      <div className="p2-section-actions">
        <button
          type="button"
          className="p2-action-primary"
          disabled={!document.canEdit || blocking > 0 || status === "publishing"}
          onClick={() => void publish()}
        >
          {status === "publishing" ? v1ScheduleProductionCopy.publishing : v1ScheduleProductionCopy.publishSchedule}
        </button>
        <ActionLink href={`/organiser/competitions/${document.competitionId}/schedule`} tone="light">
          {v1ScheduleProductionCopy.reviewSchedule}
        </ActionLink>
        <Link href={`/competitions/${competitionSlug}`} className="p2-action-link">
          {v1ScheduleProductionCopy.openPublicCompetition}
        </Link>
      </div>
    </section>
  );
}
