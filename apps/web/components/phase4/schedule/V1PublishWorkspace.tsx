"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle, ShieldWarning, WarningCircle } from "@phosphor-icons/react";
import {
  createIdempotencyKey,
  parseSchedulePublishEnvelope,
  phase4ScheduleMachine,
  type ScheduleDocument,
  type ScheduleRevision,
} from "@/lib/phase4-schedule";
import {
  v1ScheduleBlockingConflictMessage,
  v1ScheduleProductionCopy,
  v1SchedulePublishedMessage,
  v1ScheduleRevisionLabel,
} from "@/lib/v1-schedule-production";

export function V1PublishWorkspace({
  document,
  competitionSlug,
}: {
  document: ScheduleDocument;
  competitionSlug: string;
}) {
  const router = useRouter();
  const [revision, setRevision] = useState<ScheduleRevision | null>(document.currentRevision);
  const [canPublish, setCanPublish] = useState(document.canPublish);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const blockingViolations = revision?.violations.filter((violation) => violation.severity !== "preferred") ?? [];
  const published = revision?.status === "published";
  const scheduleHref = `/organiser/competitions/${encodeURIComponent(document.competitionId)}/schedule`;

  async function publish() {
    if (!revision || !canPublish || blockingViolations.length > 0 || busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/phase4/schedule/revisions/${encodeURIComponent(revision.id)}/publish`, {
        method: phase4ScheduleMachine.post,
        headers: { "content-type": phase4ScheduleMachine.json },
        body: JSON.stringify({
          idempotency_key: createIdempotencyKey(phase4ScheduleMachine.publishKey),
          expected_revision: revision.revision,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          response.status === 409
            ? v1ScheduleProductionCopy.stalePublish
            : response.status === 401 || response.status === 403
              ? v1ScheduleProductionCopy.publishPermission
              : v1ScheduleProductionCopy.publishFailed,
        );
        return;
      }
      const parsed = parseSchedulePublishEnvelope(payload);
      if (!parsed) {
        setError(v1ScheduleProductionCopy.malformedPublish);
        return;
      }
      setRevision(parsed.revision);
      setCanPublish(false);
      setMessage(v1SchedulePublishedMessage(parsed.revision.revision));
      router.refresh();
    } catch {
      setError(v1ScheduleProductionCopy.publishUnavailable);
    } finally {
      setBusy(false);
    }
  }

  if (document.state !== "ready" && document.state !== "read-only") {
    return (
      <section className="p2-data-section" data-testid="v1-publish-unavailable">
        <WarningCircle aria-hidden="true" />
        <h2>{v1ScheduleProductionCopy.publicationUnavailableTitle}</h2>
        <p>{v1ScheduleProductionCopy.publicationUnavailableBody}</p>
        <Link className="p2-button p2-button--secondary" href={scheduleHref}>
          {v1ScheduleProductionCopy.openSchedule}
        </Link>
      </section>
    );
  }

  if (!revision) {
    return (
      <section className="p2-data-section" data-testid="v1-publish-empty">
        <ShieldWarning aria-hidden="true" />
        <h2>{v1ScheduleProductionCopy.createScheduleTitle}</h2>
        <p>{v1ScheduleProductionCopy.createScheduleBody}</p>
        <Link className="p2-button p2-button--dark" href={scheduleHref}>
          {v1ScheduleProductionCopy.generateSchedule}
        </Link>
      </section>
    );
  }

  return (
    <div className="p2-publish" data-testid="v1-publish-workspace">
      <section>
        <span className="p2-published-mark" aria-hidden="true">
          {published ? <CheckCircle weight="fill" /> : <ShieldWarning />}
        </span>
        <p>{published ? v1ScheduleProductionCopy.publishedSchedule : v1ScheduleProductionCopy.publicationReview}</p>
        <h2>{v1ScheduleRevisionLabel(revision.revision)}</h2>
        <dl>
          <div>
            <dt>{v1ScheduleProductionCopy.revisionStatus}</dt>
            <dd>{revision.status.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>{v1ScheduleProductionCopy.scheduledFixtures}</dt>
            <dd>{revision.assignments.length}</dd>
          </div>
          <div>
            <dt>{v1ScheduleProductionCopy.blockingConflicts}</dt>
            <dd>{blockingViolations.length}</dd>
          </div>
        </dl>
        {blockingViolations.length > 0 ? (
          <p role="alert">{v1ScheduleBlockingConflictMessage(blockingViolations.length)}</p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {published ? (
          <Link className="p2-button p2-button--dark" href={`/competitions/${competitionSlug}`}>
            {v1ScheduleProductionCopy.openPublicCompetition}
          </Link>
        ) : (
          <button
            className="p2-button p2-button--dark"
            type="button"
            disabled={!canPublish || blockingViolations.length > 0 || busy}
            onClick={() => void publish()}
          >
            {busy ? v1ScheduleProductionCopy.publishing : v1ScheduleProductionCopy.publishSchedule}
          </button>
        )}
        {!published && !canPublish ? <p>{v1ScheduleProductionCopy.notReadyToPublish}</p> : null}
      </section>
      <aside>
        <ShieldWarning aria-hidden="true" />
        <h2>
          {published ? v1ScheduleProductionCopy.immutablePublicTruth : v1ScheduleProductionCopy.publicationChanges}
        </h2>
        <p>
          {published
            ? v1ScheduleProductionCopy.immutablePublicTruthBody
            : v1ScheduleProductionCopy.publicationChangesBody}
        </p>
        <Link className="p2-button p2-button--secondary" href={scheduleHref}>
          {published ? v1ScheduleProductionCopy.openSchedule : v1ScheduleProductionCopy.reviewSchedule}
        </Link>
      </aside>
    </div>
  );
}
