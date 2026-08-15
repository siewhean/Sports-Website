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
            ? "This schedule changed before publication. Reload the latest revision and review it again."
            : response.status === 401 || response.status === 403
              ? "You do not have permission to publish this competition."
              : "The schedule could not be published. No public revision was changed.",
        );
        return;
      }
      const parsed = parseSchedulePublishEnvelope(payload);
      if (!parsed) {
        setError("The publish response was malformed. Reload before trying another publication action.");
        return;
      }
      setRevision(parsed.revision);
      setCanPublish(false);
      setMessage(`Schedule revision ${parsed.revision.revision} is now public.`);
      router.refresh();
    } catch {
      setError("The publishing service is unavailable. No public revision was changed.");
    } finally {
      setBusy(false);
    }
  }

  if (document.state !== "ready" && document.state !== "read-only") {
    return (
      <section className="p2-data-section" data-testid="v1-publish-unavailable">
        <WarningCircle aria-hidden="true" />
        <h2>Publication status is unavailable</h2>
        <p>Reload the competition when the schedule service is available. Existing public information is unchanged.</p>
        <Link className="p2-button p2-button--secondary" href={scheduleHref}>
          Open schedule
        </Link>
      </section>
    );
  }

  if (!revision) {
    return (
      <section className="p2-data-section" data-testid="v1-publish-empty">
        <ShieldWarning aria-hidden="true" />
        <h2>Create a schedule before publishing</h2>
        <p>
          There is no saved schedule revision to publish. Generate the balanced schedule, save the valid option, then
          return here to publish it.
        </p>
        <Link className="p2-button p2-button--dark" href={scheduleHref}>
          Generate schedule
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
        <p>{published ? "Published schedule" : "Publication review"}</p>
        <h2>Schedule revision {revision.revision}</h2>
        <dl>
          <div>
            <dt>Revision status</dt>
            <dd>{revision.status.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Scheduled fixtures</dt>
            <dd>{revision.assignments.length}</dd>
          </div>
          <div>
            <dt>Blocking conflicts</dt>
            <dd>{blockingViolations.length}</dd>
          </div>
        </dl>
        {blockingViolations.length > 0 ? (
          <p role="alert">
            Resolve {blockingViolations.length} blocking schedule conflict{blockingViolations.length === 1 ? "" : "s"}
            before publishing.
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {published ? (
          <Link className="p2-button p2-button--dark" href={`/competitions/${competitionSlug}`}>
            Open public competition
          </Link>
        ) : (
          <button
            className="p2-button p2-button--dark"
            type="button"
            disabled={!canPublish || blockingViolations.length > 0 || busy}
            onClick={() => void publish()}
          >
            {busy ? "Publishing…" : "Publish schedule"}
          </button>
        )}
        {!published && !canPublish ? (
          <p>This revision is not ready for publication yet. Review and save the valid schedule first.</p>
        ) : null}
      </section>
      <aside>
        <ShieldWarning aria-hidden="true" />
        <h2>{published ? "Public truth is immutable" : "What publication changes"}</h2>
        <p>
          {published
            ? "Future schedule changes require a new revision; the published revision remains an auditable public record."
            : "Publishing makes this schedule the public competition schedule. Results can then update independently as matches are finalised."}
        </p>
        <Link className="p2-button p2-button--secondary" href={scheduleHref}>
          {published ? "Open schedule" : "Review schedule"}
        </Link>
      </aside>
    </div>
  );
}
